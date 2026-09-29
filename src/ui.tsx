import { useState } from "react";
import type { Entry, EntryType, Role, Station, Severity } from "./types";
import { DEVICES, METRICS } from "./legacy";
import { shipNow } from "./time";
import { commitLocal, LocalContext, makeEntry } from "./store";

interface PanelProps {
  title: string;
  hint?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  tone?: "default" | "danger" | "ok";
}

export function Panel({ title, hint, children, right, tone = "default" }: PanelProps) {
  return (
    <section className={`panel tone-${tone}`}>
      <div className="heading">
        <div>
          {hint && <p>{hint}</p>}
          <h2>{title}</h2>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function stationName(s: Station): string {
  return s === "bridge" ? "驾驶台" : "机舱";
}

export function typeLabel(t: EntryType): string {
  return t === "parameter" ? "参数读数" : t === "anomaly" ? "异常" : "处理结果";
}

export function statusBadge(e: Entry): { text: string; cls: string } {
  switch (e.status) {
    case "sealed":
      return { text: "已封存", cls: "badge-sealed" };
    case "superseded":
      return { text: "已被修订", cls: "badge-superseded" };
    case "void":
      return { text: "已作废", cls: "badge-void" };
    default:
      return { text: "本班", cls: "badge-live" };
  }
}

// ---------- 新增记录（参数 / 异常 / 处理结果 三类） ----------

interface EntryFormProps {
  ctx: LocalContext;
  shiftId: string;
  shiftSealed: boolean;
  onChanged: () => void;
  presetAnomaly?: string;
  openAnomalies: OpenAnomaly[];
}

export interface OpenAnomaly {
  id: string;
  station: Station;
  device: string;
  description: string;
  recordedAt: string;
}

export function EntryForm({ ctx, shiftId, shiftSealed, onChanged, presetAnomaly, openAnomalies }: EntryFormProps) {
  const [kind, setKind] = useState<EntryType>(presetAnomaly ? "handling" : "parameter");
  const now = shipNow(ctx.offsetMin);
  const [recordedAt, setRecordedAt] = useState(now);
  const [device, setDevice] = useState(DEVICES[0]);
  const [metricName, setMetricName] = useState(METRICS[0].name);
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("watch");
  const [result, setResult] = useState("");
  const [resolvesId, setResolvesId] = useState(presetAnomaly ?? "");
  const [note, setNote] = useState("");

  const metricDef = METRICS.find((m) => m.name === metricName);

  function submit() {
    if (shiftSealed) {
      alert("该班次已封存，不能再新增记录；领导可对封存记录修订，其他人员只能补说明。");
      return;
    }
    if (kind === "parameter") {
      const num = Number(value);
      if (!value || Number.isNaN(num)) return alert("请填写有效数值读数");
      const e = makeEntry(
        {
          station: ctx.station,
          entryType: "parameter",
          shiftId,
          device,
          recordedAt,
          createdBy: ctx.actor,
          metric: metricName,
          value: num,
          unit: metricDef?.unit ?? "",
          isCumulative: !!metricDef?.cumulative,
          note: note || undefined,
        },
        ctx
      );
      commitLocal(ctx, "INSERT_ENTRY", { entry: e });
      setValue("");
    } else if (kind === "anomaly") {
      if (!description.trim()) return alert("请填写异常描述");
      const e = makeEntry(
        {
          station: ctx.station,
          entryType: "anomaly",
          shiftId,
          device,
          recordedAt,
          createdBy: ctx.actor,
          description: description.trim(),
          severity,
          resolved: false,
          note: note || undefined,
        },
        ctx
      );
      commitLocal(ctx, "INSERT_ENTRY", { entry: e });
      setDescription("");
    } else {
      if (!result.trim()) return alert("请填写处理结果");
      if (!resolvesId) return alert("请选择要闭环的异常记录");
      commitLocal(ctx, "RESOLVE_ANOMALY", { anomalyId: resolvesId });
      const e = makeEntry(
        {
          station: ctx.station,
          entryType: "handling",
          shiftId,
          device,
          recordedAt,
          createdBy: ctx.actor,
          handlingResult: result.trim(),
          resolvesAnomalyId: resolvesId,
          note: note || undefined,
        },
        ctx
      );
      commitLocal(ctx, "INSERT_ENTRY", { entry: e });
      setResult("");
      setResolvesId(presetAnomaly ?? "");
    }
    setNote("");
    onChanged();
  }

  return (
    <div className="entry-form">
      <div className="seg">
        {(["parameter", "anomaly", "handling"] as EntryType[]).map((t) => (
          <button key={t} className={kind === t ? "seg-on" : ""} onClick={() => setKind(t)}>
            {typeLabel(t)}
          </button>
        ))}
      </div>

      <div className="field-grid">
        <label>
          <span>记录时刻（船内时间）</span>
          <input
            type="datetime-local"
            value={recordedAt}
            onChange={(ev) => setRecordedAt(ev.target.value)}
          />
        </label>
        <label>
          <span>设备</span>
          <select value={device} onChange={(ev) => setDevice(ev.target.value)}>
            {DEVICES.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>

        {kind === "parameter" && (
          <>
            <label>
              <span>参数</span>
              <select value={metricName} onChange={(ev) => setMetricName(ev.target.value)}>
                {METRICS.map((m) => (
                  <option key={m.name}>
                    {m.name}
                    {m.cumulative ? "（累计值）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>读数（{metricDef?.unit}）</span>
              <input
                type="number"
                step="0.01"
                value={value}
                onChange={(ev) => setValue(ev.target.value)}
                placeholder="数值读数"
              />
            </label>
          </>
        )}

        {kind === "anomaly" && (
          <>
            <label>
              <span>异常描述</span>
              <input value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder="如：冷却水温偏高" />
            </label>
            <label>
              <span>等级</span>
              <select value={severity} onChange={(ev) => setSeverity(ev.target.value as Severity)}>
                <option value="watch">一般关注</option>
                <option value="critical">紧急</option>
              </select>
            </label>
          </>
        )}

        {kind === "handling" && (
          <label className="wide">
            <span>处理结果（闭环所选异常）</span>
            <input value={result} onChange={(ev) => setResult(ev.target.value)} placeholder="如：已切换备用泵，复查正常" />
          </label>
        )}
        <label className="wide">
          <span>备注</span>
          <input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="选填" />
        </label>
      </div>

      {kind === "handling" && (
        <label className="wide">
          <span>对应异常</span>
          <select value={resolvesId} onChange={(ev) => setResolvesId(ev.target.value)}>
            <option value="">— 选择未闭环异常 —</option>
            {openAnomalies.map((o) => (
              <option key={o.id} value={o.id}>
                [{o.recordedAt.slice(5, 16).replace("T", "")}] {o.device}：{o.description}
                {o.station === "bridge" ? "（驾）" : "（机）"}
              </option>
            ))}
          </select>
        </label>
      )}

      {shiftSealed && (
        <div className="block-banner">该班次已封存：新增入口关闭；领导可修订封存记录，普通轮机员仅可对既有记录补说明。</div>
      )}
      <button className="primary" onClick={submit} disabled={shiftSealed}>
        记入{stationName(ctx.station)}值班页
      </button>
    </div>
  );
}

// ---------- 补充说明 / 领导修订 ----------

interface RowActionsProps {
  entry: Entry;
  ctx: LocalContext;
  onChanged: () => void;
}

export function RowActions({ entry, ctx, onChanged }: RowActionsProps) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [revising, setRevising] = useState(false);
  const [val, setVal] = useState(String(entry.value ?? ""));
  const [desc, setDesc] = useState(entry.description ?? "");

  const sealed = entry.status === "sealed";

  function addNote() {
    if (!text.trim()) return;
    commitLocal(ctx, "ADD_ADDENDUM", {
      targetId: entry.id,
      addendum: {
        id: `add_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        by: ctx.actor,
        role: ctx.role,
        at: new Date().toISOString(),
        text: text.trim(),
      },
    });
    setText("");
    setAdding(false);
    onChanged();
  }

  function revise() {
    // 仅领导可修订已封存记录；普通轮机员只能补说明
    if (ctx.role !== "leader") return alert("已封存记录仅领导复核后可修订，您可以补充说明。");
    const next = makeEntry(
      {
        station: entry.station,
        entryType: entry.entryType,
        shiftId: entry.shiftId,
        device: entry.device,
        recordedAt: entry.recordedAt,
        createdBy: `${ctx.actor}（领导复核修订）`,
        note: `领导复核修订，原记录 ${entry.id}`,
        revisionOf: entry.id,
        metric: entry.metric,
        unit: entry.unit,
        isCumulative: entry.isCumulative,
        value: entry.entryType === "parameter" ? Number(val) : entry.value,
        description: entry.entryType === "anomaly" ? desc : entry.description,
        severity: entry.severity,
        resolved: entry.resolved,
        resolvedBy: entry.resolvedBy,
        handlingResult: entry.handlingResult,
        resolvesAnomalyId: entry.resolvesAnomalyId,
        legacy: entry.legacy,
      },
      ctx
    );
    commitLocal(ctx, "REVISE_ENTRY", { originalId: entry.id, entry: next });
    setRevising(false);
    onChanged();
  }

  return (
    <div className="row-actions">
      <button onClick={() => setAdding((v) => !v)}>{ctx.role === "leader" && sealed ? "补说明 / 修订" : "补说明"}</button>
      {sealed && ctx.role === "leader" && (
        <button className="danger-btn" onClick={() => setRevising((v) => !v)}>
          领导修订
        </button>
      )}
      {adding && (
        <div className="inline-edit">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="补充说明（普通轮机员仅可补说明）" />
          <button className="primary" onClick={addNote}>
            追加
          </button>
        </div>
      )}
      {revising && (
        <div className="inline-edit">
          {entry.entryType === "parameter" ? (
            <input type="number" step="0.01" value={val} onChange={(e) => setVal(e.target.value)} />
          ) : (
            <input value={desc} onChange={(e) => setDesc(e.target.value)} />
          )}
          <button className="primary" onClick={revise}>
            确认修订（留审计）
          </button>
        </div>
      )}
    </div>
  );
}

export function roleName(role: Role): string {
  return role === "leader" ? "领导" : "轮机员";
}
