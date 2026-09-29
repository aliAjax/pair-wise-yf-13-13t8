import { useMemo, useState } from "react";
import type { AuditEvent, DB, Entry, Station } from "./types";
import {
  buildSummary,
  commitLocal,
  conflictKey,
  type ConflictGroup,
  type HandoverSummary,
  liveEntries,
  loadDB,
  LocalContext,
  migrationProgress,
  migrateOneRow,
} from "./store";
import { shiftIdAt, shiftLabel, shiftWindow, shipNow } from "./time";
import { Panel, RowActions, stationName, statusBadge, typeLabel } from "./ui";

// ---------- 待复核区 ----------

interface ConflictZoneProps {
  db: DB;
  ctx: LocalContext;
  conflicts: ConflictGroup[];
  onChanged: () => void;
  compact?: boolean;
}

export function ConflictZone({ db, ctx, conflicts, onChanged, compact }: ConflictZoneProps) {
  if (conflicts.length === 0) return null;
  return (
    <Panel title={`待复核区 · ${conflicts.length} 组同一时点重复读数`} hint="同步后按设备/参数/时刻合并" tone="danger">
      <div className="conflict-list">
        {conflicts.map((c) => (
          <ConflictRow key={c.key} db={db} group={c} ctx={ctx} onChanged={onChanged} compact={compact} />
        ))}
      </div>
    </Panel>
  );
}

function ConflictRow({
  group,
  ctx,
  onChanged,
  compact,
}: {
  db: DB;
  group: ConflictGroup;
  ctx: LocalContext;
  onChanged: () => void;
  compact?: boolean;
}) {
  const [chosen, setChosen] = useState(group.members[0]?.id ?? "");
  const [note, setNote] = useState("");

  function resolve() {
    commitLocal(ctx, "RESOLVE_CONFLICT", {
      resolution: {
        key: conflictKey(group.device, group.members[0].metric, group.recordedAt),
        chosenId: chosen,
        memberIds: group.members.map((m) => m.id),
        by: `${ctx.actor}（${ctx.role === "leader" ? "领导" : "值班员复核"}）`,
        at: new Date().toISOString(),
        note: note.trim() || undefined,
      },
    });
    setNote("");
    onChanged();
  }

  return (
    <article className="conflict-card">
      <header>
        <b>{group.device}</b>
        <span>{group.members[0].metric}</span>
        <time>{group.recordedAt.replace("T", " ")}</time>
        {!compact && <em>两岗读数不一致，未裁决前不得交班</em>}
      </header>
      <div className="conflict-members">
        {group.members.map((m) => (
          <label key={m.id} className={chosen === m.id ? "picked" : ""}>
            <input type="radio" name={group.key} checked={chosen === m.id} onChange={() => setChosen(m.id)} />
            <strong>
              {m.value}
              {m.unit}
            </strong>
            <span>
              {stationName(m.station)} · {m.createdBy} · 写入 {m.createdAt.slice(5, 16).replace("T", " ")}
            </span>
          </label>
        ))}
      </div>
      <div className="conflict-foot">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="裁决依据（留审计）" />
        <button className="primary" onClick={resolve}>
          确认采用该读数
        </button>
      </div>
    </article>
  );
}

// ---------- 交接班摘要 ----------

export function HandoverCard({
  db,
  summary,
  ctx,
  onChanged,
}: {
  db: DB;
  summary: HandoverSummary;
  ctx: LocalContext;
  onChanged: () => void;
}) {
  const sealed = db.shifts[summary.shiftId]?.sealed;
  return (
    <Panel
      title={`交接班摘要 · ${shiftLabel(summary.shiftId)}（${summary.shiftId.slice(0, 10)}）`}
      hint={sealed ? "已封存 · 累计值与遗留事项按船内时间转入下一班" : "未封存"}
      tone={summary.incomplete ? "danger" : sealed ? "ok" : "default"}
    >
      {summary.incomplete && (
        <div className="block-banner">
          ⛔ 摘要不完整：{summary.reasons.join("；")}。<b>已拦住交班</b>，请先到待复核区裁决。
        </div>
      )}
      <div className="summary-grid">
        <div>
          <h3>累计值衔接（船内时间）</h3>
          {summary.carry.length === 0 && <p className="muted">暂无累计参数</p>}
          <ul className="carry-list">
            {summary.carry.map((c) => (
              <li key={c.key}>
                {c.device} · {c.metric}：<b>{c.value}</b>
                {c.unit}
                <span>截至 {c.recordedAt.replace("T", " ")}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>遗留事项{summary.pending.length > 0 && `（${summary.pending.length}）`}</h3>
          {summary.pending.length === 0 && <p className="muted">无未闭环异常</p>}
          <ul className="pending-list">
            {summary.pending.map((p) => (
              <li key={p.id} className={p.severity === "critical" ? "crit" : ""}>
                <b>{p.device}</b>
                {p.description}
                <span>
                  {p.recordedAt.replace("T", " ")} 起于 {shiftLabel(p.fromShift)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="seal-row">
        {sealed ? (
          <p className="muted">
            本班由 {db.shifts[summary.shiftId].sealedBy} 于{" "}
            {db.shifts[summary.shiftId].sealedAt?.slice(5, 16).replace("T", " ")} 封存；封存后仅领导可修订。
          </p>
        ) : (
          <>
            <SealButton db={db} summary={summary} ctx={ctx} onChanged={onChanged} />
          </>
        )}
      </div>
    </Panel>
  );
}

function SealButton({
  summary,
  ctx,
  onChanged,
}: {
  db: DB;
  summary: HandoverSummary;
  ctx: LocalContext;
  onChanged: () => void;
}) {
  function seal() {
    if (summary.incomplete) return alert("摘要不完整：" + summary.reasons.join("；"));
    const guard = buildSummary(loadDB(ctx.station), summary.shiftId);
    if (guard.incomplete) return alert("刚刚出现新的待复核读数，请先裁决再交班。");
    const [s, e] = shiftWindow(summary.shiftId);
    commitLocal(ctx, "SEAL_SHIFT", {
      shiftId: summary.shiftId,
      start: s,
      end: e,
      carry: summary.carry,
      pending: summary.pending,
    });
    onChanged();
  }
  return (
    <button className="primary big" disabled={summary.incomplete} onClick={seal}>
      {summary.incomplete ? "存在未复核读数，禁止交班" : "确认无误 · 封存交班"}
    </button>
  );
}

// ---------- 旧台账迁移 ----------

export function MigrationBanner({
  station,
  ctx,
  auto,
  onToggleAuto,
  onChanged,
}: {
  station: Station;
  ctx: LocalContext;
  auto: boolean;
  onToggleAuto: (v: boolean) => void;
  onChanged: () => void;
}) {
  const m = migrationProgress(station);
  if (m.status === "done" && m.nextIndex >= m.total) {
    return (
      <Panel title="旧样例迁移已完成" hint="断点续跑 · 幂等">
        <p className="muted">
          共 {m.total} 行旧样例已全部迁入新台账（运行 {m.runId}，完成于 {m.finishedAt?.slice(0, 19).replace("T", " ")}）。
          原始样例快照保留在本地，未做任何改动；无稳定编号的旧记录均按 运行号+行号 生成确定性编号，重放不重复。
        </p>
      </Panel>
    );
  }
  return (
    <Panel title="旧轮机页样例迁移" hint="无稳定编号 · 自动续跑" tone={m.status === "running" ? "danger" : "default"}>
      <p className="muted">
        旧样例原件已先冻结快照保存，再逐行迁入双岗台账；中途关闭页面只保留原件与已完成部分，重开后从第 {m.nextIndex + 1}{" "}
        行继续，不会出现重复记录。
      </p>
      <div className="mig-bar">
        <div style={{ width: `${m.percent}%` }} />
      </div>
      <div className="mig-foot">
        <span>
          进度 {m.nextIndex}/{m.total}（{m.percent}%） · 运行 {m.runId || "尚未开始"}
        </span>
        <label className="inline-check">
          <input type="checkbox" checked={auto} onChange={(e) => onToggleAuto(e.target.checked)} />
          自动续跑
        </label>
        <button
          onClick={() => {
            migrateOneRow(station, ctx);
            onChanged();
          }}
        >
          推进行
        </button>
      </div>
    </Panel>
  );
}

// ---------- 审计记录（只追加） ----------

export function AuditTrail({ audits }: { audits: AuditEvent[] }) {
  const [show, setShow] = useState(false);
  const rows = useMemo(() => [...audits].reverse().slice(0, 60), [audits]);
  return (
    <Panel title={`不可改写审计记录 · 共 ${audits.length} 条`} hint="append-only" right={<button onClick={() => setShow((v) => !v)}>{show ? "收起" : "查看"}</button>}>
      {show && (
        <table className="audit-table">
          <thead>
            <tr>
              <th>船内时间</th>
              <th>操作人</th>
              <th>岗位</th>
              <th>动作</th>
              <th>对象</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{a.shipTime.replace("T", " ").slice(0, 16)}</td>
                <td>
                  {a.actor}
                  <small>（{a.role === "leader" ? "领导" : "轮机员"}）</small>
                </td>
                <td>{a.station === "local" ? "—" : stationName(a.station)}</td>
                <td>{a.action}</td>
                <td className="mono">{a.targetId}</td>
                <td>{a.synced ? "对端同步" : "本岗"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ---------- 记录列表 ----------

export function EntryList({
  db,
  ctx,
  onChanged,
}: {
  db: DB;
  ctx: LocalContext;
  onChanged: () => void;
}) {
  const [device, setDevice] = useState("全部");
  const [kind, setKind] = useState<"all" | Entry["entryType"]>("all");
  const [station, setStation] = useState<"all" | Station>("all");
  const [showDead, setShowDead] = useState(false);

  const all = liveEntries(db).filter((e) => {
    if (!showDead && (e.status === "superseded" || e.status === "void")) return false;
    if (device !== "全部" && e.device !== device) return false;
    if (kind !== "all" && e.entryType !== kind) return false;
    if (station !== "all" && e.station !== station) return false;
    return true;
  });

  const devices = ["全部", ...new Set(Object.values(db.entries).map((e) => e.device))];

  return (
    <Panel title={`台账明细 · ${all.length} 条`} hint="按设备筛选 · 两岗合并视图">
      <div className="filters">
        <select value={device} onChange={(e) => setDevice(e.target.value)}>
          {devices.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="all">全部类型</option>
          <option value="parameter">参数读数</option>
          <option value="anomaly">异常</option>
          <option value="handling">处理结果</option>
        </select>
        <select value={station} onChange={(e) => setStation(e.target.value as typeof station)}>
          <option value="all">两岗全部</option>
          <option value="bridge">驾驶台</option>
          <option value="engine">机舱</option>
        </select>
        <label className="inline-check">
          <input type="checkbox" checked={showDead} onChange={(e) => setShowDead(e.target.checked)} />
          含已修订/作废
        </label>
      </div>
      <div className="ledger">
        {all.map((e) => {
          const badge = statusBadge(e);
          return (
            <article key={e.id} className={`ledger-row status-${e.status}`}>
              <div className="ledger-main">
                <div className="ledger-tags">
                  <span className="tag-type">{typeLabel(e.entryType)}</span>
                  <span className="tag-station">{stationName(e.station)}</span>
                  <span className={badge.cls}>{badge.text}</span>
                  {e.entryType === "anomaly" && (
                    <span className={e.resolved ? "ok-pill" : "open-pill"}>{e.resolved ? "已闭环" : "未闭环"}</span>
                  )}
                </div>
                <h3>
                  {e.device} · {e.recordedAt.replace("T", " ")}
                </h3>
                {e.entryType === "parameter" && (
                  <p>
                    {e.metric}：<b>{e.value}</b>
                    {e.unit}
                    {e.isCumulative && <small>（累计值，换班继续衔接）</small>}
                  </p>
                )}
                {e.entryType === "anomaly" && (
                  <p>
                    {e.severity === "critical" ? "【紧急】" : ""}
                    {e.description}
                  </p>
                )}
                {e.entryType === "handling" && <p>处理结果：{e.handlingResult}</p>}
                {e.note && <p className="muted">备注：{e.note}</p>}
                {e.addenda.length > 0 && (
                  <ul className="addenda">
                    {e.addenda.map((a) => (
                      <li key={a.id}>
                        补充说明 · {a.by}（{a.role === "leader" ? "领导" : "轮机员"}）：{a.text}
                      </li>
                    ))}
                  </ul>
                )}
                {e.revisionOf && <p className="muted mono">修订自 {e.revisionOf}</p>}
              </div>
              <RowActions entry={e} ctx={ctx} onChanged={onChanged} />
            </article>
          );
        })}
        {all.length === 0 && <p className="muted">暂无记录</p>}
      </div>
    </Panel>
  );
}

// 供表单默认班次使用
export function currentShiftId(offsetMin: number): string {
  return shiftIdAt(shipNow(offsetMin));
}
