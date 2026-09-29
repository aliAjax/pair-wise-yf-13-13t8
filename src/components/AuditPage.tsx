import { useMemo, useState } from "react";
import { useStore, verifyAuditChain } from "../core/store";
import { Empty, fmtAuditAt, RoleTag, useToast } from "./ui";

const ACTION_LABEL: Record<string, string> = {
  "system.bootstrap": "系统建账",
  "record.add": "新增值班记录",
  "record.discard-unsynced": "丢弃未同步记录",
  "sync.completed": "同步合并",
  "conflict.resolve": "待复核裁决",
  "record.revise": "领导修订记录",
  "record.explain": "补充说明",
  "shift.handover": "完成交班",
  "shift.handover-blocked": "交班被拦截",
  "clock.offset-change": "船内时钟调整",
  "identity.change": "值班身份切换",
  "migration.import-row": "旧台账行迁入",
  "migration.dedup-skip": "迁移去重跳过",
  "migration.skip-row": "迁移跳过坏行",
  "migration.complete": "旧台账迁移完成",
  "migration.pause": "迁移中断（暂停）",
  "migration.resume": "迁移续传",
  "demo.reset": "演示数据重置",
};

const DETAIL_KEYS: Record<string, string> = {
  post: "岗位",
  equipment: "设备",
  recordedAt: "记录时刻",
  processed: "已处理",
  merged: "自动合并",
  duplicated: "重复跳过",
  conflict: "进入复核",
  remaining: "仍积压",
  choice: "裁决",
  basis: "依据",
  reason: "原因",
  pendingConflicts: "待复核",
  unsynced: "未同步",
  shiftId: "班次",
  sealed: "封存记录",
  legacyShift: "原班次",
  total: "总数",
  done: "已完成",
  oldMin: "原偏移(分)",
  newMin: "新偏移(分)",
};

function DetailView({ detail }: { detail: unknown }) {
  if (detail === undefined || detail === null) return null;
  if (typeof detail !== "object") return <span>{String(detail)}</span>;
  const entries = Object.entries(detail as Record<string, unknown>);
  return (
    <span className="audit-detail">
      {entries.map(([k, v]) => {
        if (v === undefined || v === null) return null;
        let text: string;
        if (typeof v === "object") text = JSON.stringify(v);
        else text = String(v);
        if (text.length > 160) text = text.slice(0, 160) + "…";
        return (
          <em key={k}>
            {DETAIL_KEYS[k] ?? k}：{text}
          </em>
        );
      })}
    </span>
  );
}

export default function AuditPage() {
  const { state } = useStore();
  const toast = useToast();
  const [filter, setFilter] = useState("all");
  const chain = useMemo(() => verifyAuditChain(state.audit), [state.audit]);

  const actions = useMemo(
    () => Array.from(new Set(state.audit.map((e) => e.action))),
    [state.audit]
  );
  const list = useMemo(
    () =>
      state.audit
        .filter((e) => filter === "all" || e.action === filter)
        .slice()
        .reverse(),
    [state.audit, filter]
  );

  function exportAudit() {
    const blob = new Blob([JSON.stringify(state.audit, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${state.voyageId}-${new Date().toISOString().slice(0, 19).replaceAll(":", "")}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("审计链已导出为 JSON（仅追加、含哈希链）");
  }

  return (
    <div className="stack">
      <section className={`panel chain-banner ${chain.ok ? "" : "chain-broken"}`}>
        <div>
          <h3>{chain.ok ? "🔒 审计链校验通过" : "⚠️ 审计链被破坏"}</h3>
          <p className="small muted">
            所有变化按时间顺序追加，事件之间以 prevHash 链接；界面不提供任何修改/删除入口。
            {!chain.ok && <> 断裂位置：事件 #{chain.brokenAt}</>}
          </p>
        </div>
        <button className="primary" onClick={exportAudit}>
          导出审计记录
        </button>
      </section>

      <section className="panel filter-bar">
        <label>
          <span>事件类型（共 {state.audit.length} 条）</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">全部事件</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a] ?? a}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel">
        {list.length === 0 ? (
          <Empty text="暂无审计事件" />
        ) : (
          <table className="audit-table">
            <thead>
              <tr>
                <th>#</th>
                <th>船内时刻</th>
                <th>操作人</th>
                <th>动作</th>
                <th>对象 / 明细</th>
                <th>哈希</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td className="nowrap">{fmtAuditAt(e.at)}</td>
                  <td>
                    <RoleTag role={e.actor.role} /> {e.actor.name}
                  </td>
                  <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td>
                    {e.target && <code className="target-code">{e.target.slice(0, 18)}</code>}
                    <DetailView detail={e.detail} />
                  </td>
                  <td className="nowrap">
                    <code>{e.hash.slice(0, 10)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
