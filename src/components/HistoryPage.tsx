import { useMemo, useState } from "react";
import type { AbnStatus, Delta, LedgerRecord, RevData } from "../types";
import { CUMULATIVES } from "../types";
import { isSealed, useStore } from "../core/store";
import { fmtAuditAt, Empty, Modal, PostTag, StatusTag, useToast } from "./ui";
import { shiftLabel } from "../core/time";

function RevEditor({ record, onClose }: { record: LedgerRecord; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [data, setData] = useState<RevData>({
    readings: record.readings.map((r) => ({ ...r })),
    abnormality: record.abnormality,
    handling: record.handling,
    status: record.status,
    deltas: record.deltas.map((d) => ({ ...d })),
    carryOver: record.carryOver,
  });
  const [reason, setReason] = useState("");

  const setReading = (i: number, key: "value" | "name" | "unit", v: string) =>
    setData((d) => ({
      ...d,
      readings: d.readings.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)),
    }));

  const addReading = () =>
    setData((d) => ({ ...d, readings: [...d.readings, { name: "", value: "", unit: "" }] }));
  const delReading = (i: number) =>
    setData((d) => ({ ...d, readings: d.readings.filter((_, idx) => idx !== i) }));

  const deltaAmount = (name: string) =>
    String(data.deltas.find((d) => d.name === name)?.amount ?? "");
  const setDelta = (name: string, amount: string, unit: string) =>
    setData((d) => {
      const rest = d.deltas.filter((x) => x.name !== name);
      const n = Number(amount);
      return {
        ...d,
        deltas: amount && Number.isFinite(n) && n > 0 ? [...rest, { name, amount: n, unit } as Delta] : rest,
      };
    });

  function save() {
    if (!reason.trim()) return toast("修订已封存记录必须填写复核原因", "warn");
    if (data.readings.some((r) => !r.name.trim() || !r.value.trim())) {
      return toast("读数行的名称和值不能为空（空行请删除）", "warn");
    }
    dispatch({ type: "revise-record", id: record.id, after: data, reason });
    toast("修订已生效，原值与原因已写入审计链与版本历史");
    onClose();
  }

  return (
    <div className="stack">
      {isSealed(record, state) && (
        <p className="small warn-text">该记录已封存：仅值班领导可修订，原内容将完整保留在版本历史中。</p>
      )}
      <div className="rev-readings">
        {data.readings.map((r, i) => (
          <div key={i} className="reading-edit-row">
            <input value={r.name} onChange={(e) => setReading(i, "name", e.target.value)} placeholder="参数名" />
            <input value={r.value} onChange={(e) => setReading(i, "value", e.target.value)} placeholder="数值" />
            <input value={r.unit} onChange={(e) => setReading(i, "unit", e.target.value)} placeholder="单位" />
            <button className="link-danger" onClick={() => delReading(i)}>
              删
            </button>
          </div>
        ))}
        <button onClick={addReading}>+ 增加读数行</button>
      </div>

      <label className="block-label">
        <span>异常描述</span>
        <textarea rows={2} value={data.abnormality} onChange={(e) => setData((d) => ({ ...d, abnormality: e.target.value }))} />
      </label>
      <label className="block-label">
        <span>处理结果</span>
        <textarea rows={2} value={data.handling} onChange={(e) => setData((d) => ({ ...d, handling: e.target.value }))} />
      </label>
      <div className="form-row">
        <label>
          <span>状态</span>
          <select value={data.status} onChange={(e) => setData((d) => ({ ...d, status: e.target.value as AbnStatus }))}>
            <option value="ok">正常</option>
            <option value="open">异常待处理</option>
            <option value="done">已处理</option>
          </select>
        </label>
        <label className="check-line">
          <input type="checkbox" checked={data.carryOver} onChange={(e) => setData((d) => ({ ...d, carryOver: e.target.checked }))} />
          <span>列入遗留</span>
        </label>
      </div>
      <div className="reading-grid">
        {CUMULATIVES.map((c) => (
          <label key={c.name}>
            <span>
              {c.name}（{c.unit}）
            </span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={deltaAmount(c.name)}
              onChange={(e) => setDelta(c.name, e.target.value, c.unit)}
            />
          </label>
        ))}
      </div>
      <label className="block-label">
        <span>复核 / 修订原因（必填）</span>
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如 复查温度表，原读数为手抄笔误" />
      </label>
      <div className="form-actions">
        <button className="primary" onClick={save}>
          提交修订
        </button>
        <button onClick={onClose}>取消</button>
      </div>
    </div>
  );
}

// 补充说明：任何角色都可追加，但只有领导能改正文

function ExplainBox({ record }: { record: LedgerRecord }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);

  function add() {
    if (!text.trim()) return toast("说明内容不能为空", "warn");
    dispatch({ type: "explain-record", id: record.id, text });
    setText("");
    setOpen(false);
    toast("补充说明已附加（正文不可由轮机员修改）");
  }

  return (
    <div className="explain-box">
      {record.explanations.length > 0 && (
        <ul className="explain-list">
          {record.explanations.map((e) => (
            <li key={e.id}>
              <span className={`tag tag-role-${e.role}`}>{e.author}</span>
              <span className="muted small">{fmtAuditAt(e.at)}</span>
              <div>{e.text}</div>
            </li>
          ))}
        </ul>
      )}
      {!open ? (
        <button onClick={() => setOpen(true)}>
          {state.role === "leader" ? "补充说明" : "轮机员补说明（仅追加）"}
        </button>
      ) : (
        <div className="form-row">
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="对该记录的补充说明，提交后不可改写" />
          <div className="form-actions">
            <button className="primary" onClick={add}>
              提交说明
            </button>
            <button onClick={() => setOpen(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RecordCard({ record }: { record: LedgerRecord }) {
  const { state } = useStore();
  const [showRev, setShowRev] = useState(false);
  const sealed = isSealed(record, state);

  return (
    <article className="panel rec-card">
      <div className="rec-head">
        <div>
          <h3>
            {record.equipment} <span className="muted">@ {record.recordedAt}</span>
          </h3>
          <p className="small muted">
            {shiftLabel(record.shiftId)} · 来源：
            {record.sources.map((s) => (
              <PostTag key={s.ref} post={s.post} />
            ))}
            {record.legacy && <span className="tag tag-legacy">旧样例迁移</span>}
            {sealed && <span className="tag tag-sealed">已封存</span>}
            {record.rev > 1 && <span className="tag tag-rev">v{record.rev}</span>}
          </p>
        </div>
        <div className="rec-actions">
          <StatusTag status={record.status} />
          {record.carryOver && <span className="tag tag-carry">遗留</span>}
          {state.role === "leader" && (
            <button onClick={() => setShowRev(true)}>
              {sealed ? "领导修订封存记录" : "修订"}
            </button>
          )}
        </div>
      </div>

      <ul className="reading-list inline">
        {record.readings.map((r) => (
          <li key={r.name}>
            {r.name}：<b>{r.value}</b> <span className="muted">{r.unit}</span>
          </li>
        ))}
      </ul>
      {record.abnormality && <p className="small">异常：{record.abnormality}</p>}
      {record.handling && <p className="small">处理：{record.handling}</p>}
      {record.deltas.length > 0 && (
        <p className="small muted">
          累计增量：{record.deltas.map((d) => `${d.name}+${d.amount}${d.unit}`).join("，")}
        </p>
      )}
      {record.legacy && (
        <p className="small muted">
          原始行（只读保留）：{record.legacy.raw.join(" | ")}
        </p>
      )}

      {record.revisions.length > 0 && (
        <details className="rev-history">
          <summary>版本历史（{record.revisions.length} 次修订）</summary>
          {record.revisions.map((rv) => (
            <div key={rv.rev} className="rev-row">
              <p className="small">
                v{rv.rev} · {rv.by} · {fmtAuditAt(rv.at)} · 原因：{rv.reason}
              </p>
              <p className="small muted">
                原读数：
                {rv.before.readings.map((r) => `${r.name}${r.value}${r.unit}`).join("，") || "—"}
                {rv.before.abnormality && `；原异常：${rv.before.abnormality}`}
              </p>
              <p className="small muted">
                修订后：
                {rv.after.readings.map((r) => `${r.name}${r.value}${r.unit}`).join("，") || "—"}
                {rv.after.abnormality && `；异常：${rv.after.abnormality}`}
              </p>
            </div>
          ))}
        </details>
      )}

      <ExplainBox record={record} />
      {showRev && (
        <Modal title={`修订记录 · ${record.equipment} @ ${record.recordedAt}`} onClose={() => setShowRev(false)} wide>
          <RevEditor record={record} onClose={() => setShowRev(false)} />
        </Modal>
      )}
    </article>
  );
}

export default function HistoryPage() {
  const { state } = useStore();
  const [equipment, setEquipment] = useState("all");
  const [shift, setShift] = useState("all");
  const [status, setStatus] = useState<"all" | AbnStatus>("all");
  const [keyword, setKeyword] = useState("");

  const equipments = useMemo(
    () => Array.from(new Set(state.records.map((r) => r.equipment))).sort(),
    [state.records]
  );
  const shifts = useMemo(
    () => Array.from(new Set(state.records.map((r) => r.shiftId))).sort().reverse(),
    [state.records]
  );

  const list = useMemo(() => {
    return state.records
      .filter((r) => equipment === "all" || r.equipment === equipment)
      .filter((r) => shift === "all" || r.shiftId === shift)
      .filter((r) => status === "all" || r.status === status)
      .filter(
        (r) =>
          !keyword.trim() ||
          r.equipment.includes(keyword.trim()) ||
          r.abnormality.includes(keyword.trim()) ||
          r.handling.includes(keyword.trim()) ||
          r.readings.some((x) => x.name.includes(keyword.trim()))
      )
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }, [state.records, equipment, shift, status, keyword]);

  return (
    <div className="stack">
      <section className="panel filter-bar">
        <label>
          <span>设备</span>
          <select value={equipment} onChange={(e) => setEquipment(e.target.value)}>
            <option value="all">全部设备</option>
            {equipments.map((eq) => (
              <option key={eq}>{eq}</option>
            ))}
          </select>
        </label>
        <label>
          <span>班次</span>
          <select value={shift} onChange={(e) => setShift(e.target.value)}>
            <option value="all">全部班次</option>
            {shifts.map((s) => (
              <option key={s} value={s}>
                {shiftLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>状态</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as "all" | AbnStatus)}>
            <option value="all">全部</option>
            <option value="ok">正常</option>
            <option value="open">异常待处理</option>
            <option value="done">已处理</option>
          </select>
        </label>
        <label className="grow">
          <span>关键词</span>
          <input placeholder="设备 / 参数 / 异常 / 处理" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </label>
      </section>

      {list.length === 0 ? (
        <section className="panel">
          <Empty text="没有符合条件的记录" />
        </section>
      ) : (
        list.map((r) => <RecordCard key={r.id} record={r} />)
      )}
    </div>
  );
}
