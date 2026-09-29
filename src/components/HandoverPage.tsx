import { useState } from "react";
import { CUMULATIVES } from "../types";
import { shiftTotals, totalsFor, useStore } from "../core/store";
import { fmtAuditAt, Empty, useToast } from "./ui";
import { shiftLabel } from "../core/time";

export default function HandoverPage({ goReview }: { goReview: () => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [note, setNote] = useState("");

  const pending = state.conflicts.filter((c) => c.status === "pending");
  const unsynced = state.outbox.bridge.length + state.outbox.engine.length;
  const blocked = pending.length > 0 || unsynced > 0;

  const currentRecords = state.records.filter((r) => r.shiftId === state.currentShiftId);
  const openItems = currentRecords.filter((r) => r.status === "open" || r.carryOver);
  const voyageTotals = totalsFor(state.records);
  const watchTotals = shiftTotals(state.records, state.currentShiftId);
  const previous = state.shifts[state.shifts.length - 1];

  function doHandover() {
    if (blocked) {
      dispatch({ type: "blocked-handover" });
      toast("交班被拦截：交接摘要不完整", "err");
      return;
    }
    dispatch({ type: "handover", note });
    setNote("");
    toast("交班完成，累计值与遗留事项已按船内时间转入下一班");
  }

  return (
    <div className="stack">
      {blocked && (
        <section className="panel block-banner">
          <div>
            <h3>⛔ 交接摘要不完整，禁止交班</h3>
            <ul className="block-list">
              {pending.length > 0 && (
                <li>
                  待复核区有 <b>{pending.length}</b> 项双岗读数分歧尚未由领导裁决：
                  {pending.map((c) => (
                    <span key={c.id} className="chip-warn">
                      {c.equipment}@{c.recordedAt.slice(11)}
                    </span>
                  ))}
                </li>
              )}
              {unsynced > 0 && (
                <li>
                  尚有 <b>{unsynced}</b> 条离线记录未同步合并（请恢复联网后再交班）
                </li>
              )}
            </ul>
          </div>
          <button className="btn-warn" onClick={goReview}>
            前往待复核区处理
          </button>
        </section>
      )}

      <section className="panel">
        <div className="heading">
          <div>
            <p>交接摘要</p>
            <h2>{shiftLabel(state.currentShiftId)}</h2>
          </div>
          <span className={`tag ${blocked ? "tag-status-warn" : "tag-status-ok"}`}>
            {blocked ? "摘要不完整" : "可以交班"}
          </span>
        </div>

        {previous && (
          <div className="carry-box">
            <h4>上一班接续（{shiftLabel(previous.id)}，{previous.by} 交班）</h4>
            <p className="small muted">备注：{previous.note || "（无）"}</p>
            {previous.carried.length === 0 ? (
              <p className="small">无遗留事项</p>
            ) : (
              <ul className="carry-list">
                {previous.carried.map((c) => (
                  <li key={c.id}>{c.text}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <h4>本班遗留事项（{openItems.length}）</h4>
        {openItems.length === 0 ? (
          <Empty text="本班无异常待处理 / 遗留事项" />
        ) : (
          <ul className="carry-list">
            {openItems.map((r) => (
              <li key={r.id}>
                <b>{r.equipment}</b> · {r.recordedAt.slice(5)}
                {r.status === "open" && <span className="tag tag-status-warn">待处理</span>}
                {r.carryOver && <span className="tag tag-carry">遗留</span>}
                <div className="small muted">
                  {r.abnormality && <>异常：{r.abnormality}；</>}
                  {r.handling || "尚无处理记录"}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="total-grid">
          {CUMULATIVES.map((c) => (
            <div key={c.name} className="total-cell">
              <small>{c.name}</small>
              <strong>
                {Math.round(watchTotals[c.name] * 100) / 100}
                <span className="muted"> / 航次累计 {Math.round(voyageTotals[c.name] * 100) / 100} {c.unit}</span>
              </strong>
            </div>
          ))}
        </div>

        <label className="block-label">
          <span>交班备注（将随班次快照封存）</span>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如 海面能见度下降，已通知加强瞭望"
          />
        </label>

        <div className="form-actions">
          <button className="danger" disabled={blocked} onClick={doHandover}>
            {blocked ? "交班已被拦截" : "确认交班，封存本班"}
          </button>
          {blocked && (
            <button onClick={goReview}>先去处理待复核项</button>
          )}
        </div>
        <p className="small muted">
          交班后：本班记录封存；累计值以快照形式衔接下一班；遗留事项自动出现在下一班摘要中。
        </p>
      </section>

      <section className="panel">
        <h3>已封存班次（{state.shifts.length}）</h3>
        {state.shifts.length === 0 ? (
          <Empty text="还没有完成过交班" />
        ) : (
          <div className="shift-history">
            {[...state.shifts].reverse().map((s) => (
              <details key={s.id} className="shift-row">
                <summary>
                  {shiftLabel(s.id)} · {s.by} · 遗留 {s.carried.length} 项 ·{" "}
                  <span className="muted">{fmtAuditAt(s.endAt)} 封存</span>
                </summary>
                <div className="shift-detail">
                  <p className="small">交班备注：{s.note || "（无）"}</p>
                  <div className="total-grid compact">
                    {CUMULATIVES.map((c) => (
                      <div key={c.name} className="total-cell">
                        <small>{c.name}</small>
                        <strong>
                          {Math.round(s.counters[c.name] * 100) / 100} {c.unit}
                        </strong>
                      </div>
                    ))}
                  </div>
                  {s.carried.length > 0 && (
                    <ul className="carry-list">
                      {s.carried.map((c) => (
                        <li key={c.id}>{c.text}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
