import { useState } from "react";
import type { Role } from "../types";
import { ROLE_LABEL } from "../types";
import { useStore } from "../core/store";
import { fmtAuditAt, useToast } from "./ui";
import { fmtDateTime } from "../core/time";

function MigrationCard() {
  const { state, dispatch } = useStore();
  const m = state.migration;
  const pct = Math.round((m.done.length / m.total) * 100);

  return (
    <section className="panel">
      <p>数据治理</p>
      <h3>旧样例自动迁移</h3>
      <p className="small muted">
        旧轮机页样例没有稳定编号，系统按行内容指纹生成确定性 ID 后逐行迁入。迁移中途被关闭时，原数据另存不动、已完成行保留；重开后从未完成行继续，已完成行按编号去重，绝不出现重复记录。
      </p>
      <div className="progress">
        <div className="progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <p className="small">
        进度 {m.done.length}/{m.total}（{pct}%）· 状态：
        {m.phase === "running" ? "迁移中" : m.phase === "paused" ? "已中断（可续传）" : "已完成"}
      </p>
      <p className="small muted">
        迁移锚点船内日期：{m.anchorDate} · 原数据封存于 {fmtAuditAt(m.legacyPreservedAt)}
      </p>
      <div className="form-actions">
        {m.phase === "running" && (
          <button onClick={() => dispatch({ type: "migration-pause" })}>模拟中途关闭（暂停）</button>
        )}
        {m.phase === "paused" && (
          <button className="primary" onClick={() => dispatch({ type: "migration-resume" })}>
            重开后续传
          </button>
        )}
        {m.phase === "done" && <span className="ok-text">✔ 全部迁移完成，可在历史记录中查看（标记「旧样例迁移」）</span>}
      </div>
      <details className="legacy-raw">
        <summary>查看旧台账原样副本（只读）</summary>
        <table className="audit-table">
          <thead>
            <tr>
              <th>原班次</th>
              <th>设备</th>
              <th>记录内容</th>
              <th>处理</th>
              <th>迁移指纹</th>
            </tr>
          </thead>
          <tbody>
            {m.legacy.map((row, i) => (
              <tr key={i} className={i < m.done.length ? "row-done" : ""}>
                {row.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
                <td>
                  <code>{i < m.done.length ? m.done[i].slice(0, 12) : "待迁移"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

export default function SettingsPage() {
  const { state, dispatch, now } = useStore();
  const toast = useToast();
  const [role, setRole] = useState<Role>(state.role);
  const [name, setName] = useState(state.userName);
  const [offset, setOffset] = useState(String(state.clockOffsetMin));
  const [confirmReset, setConfirmReset] = useState(false);

  function saveIdentity() {
    if (!name.trim()) return toast("请输入值班人姓名", "warn");
    dispatch({ type: "set-identity", role, name });
    toast("值班身份已切换");
  }

  function saveOffset() {
    const n = Number(offset);
    if (!Number.isFinite(n) || Math.abs(n) > 720) return toast("偏移需在 -720 ~ 720 分钟之间", "warn");
    dispatch({ type: "set-offset", minutes: n });
    toast("船内时间已调整（只影响之后的记录时刻）");
  }

  function exportAll() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ledger-${state.voyageId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="settings-grid">
      <div className="stack">
        <section className="panel">
          <p>值班身份</p>
          <h3>角色与签名</h3>
          <label className="block-label">
            <span>角色</span>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="leader">{ROLE_LABEL.leader}：可裁决复核、可修订封存记录</option>
              <option value="engineer">{ROLE_LABEL.engineer}：可记录、仅能对记录补说明</option>
            </select>
          </label>
          <label className="block-label">
            <span>姓名 / 工号</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="form-actions">
            <button className="primary" onClick={saveIdentity}>
              切换身份
            </button>
          </div>
        </section>

        <section className="panel">
          <p>船内时间</p>
          <h3>时钟与时区</h3>
          <p className="small">当前船内时间：<b>{fmtDateTime(now)}</b></p>
          <label className="block-label">
            <span>相对系统时钟的偏移（分钟，跨时区航行时调整）</span>
            <input type="number" value={offset} onChange={(e) => setOffset(e.target.value)} />
          </label>
          <div className="form-actions">
            <button className="primary" onClick={saveOffset}>
              调整船钟
            </button>
          </div>
          <p className="small muted">调整后只影响之后新增记录的时刻与班次归属，历史记录不回改，调整动作入审计。</p>
        </section>
      </div>

      <div className="stack">
        <MigrationCard />

        <section className="panel">
          <p>航次与数据</p>
          <h3>台账信息</h3>
          <ul className="info-list">
            <li>航次编号：{state.voyageId}</li>
            <li>本机台账客户端：<code>{state.clientId.slice(0, 16)}…</code></li>
            <li>当前班次：{state.currentShiftId}</li>
            <li>正式记录：{state.records.length} 条 · 复核项：{state.conflicts.length} 条</li>
            <li>审计事件：{state.audit.length} 条（只增）</li>
          </ul>
          <div className="form-actions">
            <button onClick={exportAll}>导出台账 JSON</button>
            {!confirmReset ? (
              <button className="link-danger-btn" onClick={() => setConfirmReset(true)}>
                重置演示数据
              </button>
            ) : (
              <>
                <button
                  className="danger"
                  onClick={() => {
                    dispatch({ type: "reset-demo" });
                    setConfirmReset(false);
                    toast("已重置，迁移将重新执行（旧原数据仍在）");
                  }}
                >
                  确认重置（清空本地台账）
                </button>
                <button onClick={() => setConfirmReset(false)}>取消</button>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
