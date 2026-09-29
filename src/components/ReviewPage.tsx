import { useState } from "react";
import type { Conflict, ResolutionChoice, RevData } from "../types";
import { POST_META } from "../types";
import { useStore } from "../core/store";
import { Empty, PostTag, StatusTag, useToast } from "./ui";
import { shiftLabel } from "../core/time";

function ReadingsView({ data }: { data: RevData }) {
  return (
    <div className="cmp-body">
      <ul className="reading-list">
        {data.readings.length === 0 && <li className="muted">无参数读数</li>}
        {data.readings.map((r) => (
          <li key={r.name}>
            {r.name}：<b>{r.value}</b>
            <span className="muted"> {r.unit}</span>
          </li>
        ))}
      </ul>
      <div className="small">
        <StatusTag status={data.status} />
        {data.carryOver && <span className="tag tag-carry">遗留</span>}
      </div>
      {data.abnormality && <p className="small">异常：{data.abnormality}</p>}
      {data.handling && <p className="small">处理：{data.handling}</p>}
    </div>
  );
}

function CustomEditor({ initial, onCommit }: { initial: RevData; onCommit: (d: RevData) => void }) {
  const [text, setText] = useState(
    JSON.stringify(
      {
        readings: initial.readings,
        abnormality: initial.abnormality,
        handling: initial.handling,
        status: initial.status,
        deltas: initial.deltas,
        carryOver: initial.carryOver,
      },
      null,
      2
    )
  );
  const [err, setErr] = useState("");
  const toast = useToast();

  function apply() {
    try {
      const parsed = JSON.parse(text) as RevData;
      if (!Array.isArray(parsed.readings) || !["ok", "open", "done"].includes(parsed.status)) {
        throw new Error("字段不完整");
      }
      onCommit(parsed);
    } catch (e) {
      setErr("JSON 格式有误：" + (e instanceof Error ? e.message : String(e)));
      toast("自定义内容解析失败", "err");
    }
  }

  return (
    <div className="custom-edit">
      <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} />
      {err && <p className="small err-text">{err}</p>}
      <button className="btn-warn" onClick={apply}>
        载入自定义裁决
      </button>
    </div>
  );
}

function ConflictRow({ conflict }: { conflict: Conflict }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [choice, setChoice] = useState<ResolutionChoice>("a");
  const [basis, setBasis] = useState("");
  const [custom, setCustom] = useState<RevData | null>(null);
  const pending = conflict.status === "pending";
  const isLeader = state.role === "leader";

  function resolve() {
    if (!basis.trim()) return toast("必须填写复核依据 / 说明", "warn");
    dispatch({ type: "resolve-conflict", id: conflict.id, choice, basis, custom: custom ?? undefined });
    toast("已裁决并并入正式台账");
  }

  return (
    <article className={`panel conflict ${pending ? "conflict-pending" : "conflict-resolved"}`}>
      <div className="conflict-head">
        <div>
          <h3>
            {conflict.equipment} <span className="muted">@ {conflict.recordedAt}</span>
          </h3>
          <p className="small muted">
            {shiftLabel(conflict.shiftId)} · 同一时点出现两个读数
            {pending ? "" : ` · 已于 ${new Date(conflict.resolution!.at).toLocaleString()} 由 ${conflict.resolution!.by} 裁决`}
          </p>
        </div>
        <span className={`tag ${pending ? "tag-status-warn" : "tag-status-ok"}`}>
          {pending ? "待复核" : "已裁决"}
        </span>
      </div>

      <div className="cmp-grid">
        <div className="cmp-side">
          <p>
            <PostTag post={conflict.a.post} /> A 侧 · {conflict.a.author}
          </p>
          <ReadingsView data={conflict.a} />
        </div>
        <div className="cmp-side">
          <p>
            <PostTag post={conflict.b.post} /> B 侧 · {conflict.b.author}
          </p>
          <ReadingsView data={conflict.b} />
        </div>
      </div>

      {pending &&
        (isLeader ? (
          <div className="resolve-box">
            <div className="choice-row">
              <span>裁决：</span>
              {(
                [
                  ["a", `采用${POST_META[conflict.a.post].label}（A）`],
                  ["b", `采用${POST_META[conflict.b.post].label}（B）`],
                  ["avg", "数值取平均"],
                  ["custom", "自定义修订"],
                ] as [ResolutionChoice, string][]
              ).map(([v, label]) => (
                <label key={v} className="radio-line">
                  <input
                    type="radio"
                    name={`choice-${conflict.id}`}
                    checked={choice === v}
                    onChange={() => setChoice(v)}
                  />
                  {label}
                </label>
              ))}
            </div>
            {choice === "custom" && (
              <CustomEditor initial={conflict.a} onCommit={(d) => setCustom(d)} />
            )}
            {custom && choice === "custom" && (
              <p className="small ok-text">已载入自定义内容，提交后生效并留痕</p>
            )}
            <div className="form-row">
              <label className="grow">
                <span>复核依据（必填，进入不可改写审计）</span>
                <input
                  placeholder="例如 经核车钟记录与转速表，采用机舱实测值"
                  value={basis}
                  onChange={(e) => setBasis(e.target.value)}
                />
              </label>
              <button className="primary align-end" onClick={resolve}>
                完成复核
              </button>
            </div>
          </div>
        ) : (
          <p className="warn-text small">普通轮机员无权裁决，请由值班领导复核处理；在此之前交班将被拦截。</p>
        ))}

      {!pending && conflict.resolution && (
        <p className="small muted">
          裁决方式：{({ a: "采用 A", b: "采用 B", avg: "数值平均", custom: "自定义" } as const)[
            conflict.resolution.choice
          ]}
          ；依据：{conflict.resolution.basis}
        </p>
      )}
    </article>
  );
}

export default function ReviewPage({ manualSync }: { manualSync: () => void }) {
  const { state } = useStore();
  const pending = state.conflicts.filter((c) => c.status === "pending");
  const resolved = state.conflicts.filter((c) => c.status === "resolved");
  const unsynced = state.outbox.bridge.length + state.outbox.engine.length;

  return (
    <div className="stack">
      <section className="panel sync-banner">
        <div>
          <h2>同步合并与待复核区</h2>
          <p className="small muted">
            恢复联网后按「设备 + 记录时刻（船内时间，精确到分钟）」自动合并：读数一致合为一条，读数不同进入待复核区。
          </p>
        </div>
        <div className="sync-stats">
          <div>
            <b>{unsynced}</b>
            <span>待同步</span>
          </div>
          <div>
            <b className="warn-text">{pending.length}</b>
            <span>待复核</span>
          </div>
          <div>
            <b>{resolved.length}</b>
            <span>已裁决</span>
          </div>
          <button className="primary" onClick={manualSync} disabled={unsynced === 0}>
            立即同步
          </button>
        </div>
      </section>

      {pending.length === 0 ? (
        <section className="panel">
          <Empty text="没有待复核项，双岗同一时点读数一致（或尚无对碰记录）" />
        </section>
      ) : (
        pending.map((c) => <ConflictRow key={c.id} conflict={c} />)
      )}

      {resolved.length > 0 && (
        <section className="panel">
          <h3>已裁决历史（{resolved.length}）</h3>
          {resolved.map((c) => (
            <ConflictRow key={c.id} conflict={c} />
          ))}
        </section>
      )}
    </div>
  );
}
