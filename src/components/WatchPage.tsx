import { useMemo, useState } from "react";
import { CUMULATIVES, POST_META, type AbnStatus, type Delta, type Post, type Reading } from "../types";
import { shiftLabel, toMinute } from "../core/time";
import { useStore } from "../core/store";
import { Empty, PostTag, StatusTag, useToast } from "./ui";

interface Draft {
  equipment: string;
  customEquipment: string;
  values: Record<string, string>;
  abnormality: string;
  handling: string;
  status: AbnStatus;
  deltas: Record<string, string>;
  carryOver: boolean;
  manualTime: string;
  useManualTime: boolean;
}

function initDraft(post: Post): Draft {
  return {
    equipment: POST_META[post].equipment[0],
    customEquipment: "",
    values: Object.fromEntries(POST_META[post].metrics.map((m) => [m.name, ""])),
    abnormality: "",
    handling: "",
    status: "ok",
    deltas: Object.fromEntries(CUMULATIVES.map((c) => [c.name, ""])),
    carryOver: false,
    manualTime: "",
    useManualTime: false,
  };
}

export default function WatchPage({ post, goPending }: { post: Post; goPending: () => void }) {
  const { state, dispatch, now } = useStore();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => initDraft(post));
  const meta = POST_META[post];
  const outbox = state.outbox[post];
  const otherPost: Post = post === "bridge" ? "engine" : "bridge";
  const otherPending = state.conflicts.filter(
    (c) => c.status === "pending" && (c.a.post === post || c.b.post === post)
  ).length;

  const equipment = draft.customEquipment.trim() || draft.equipment;

  const readings = useMemo<Reading[]>(
    () =>
      meta.metrics
        .filter((m) => draft.values[m.name]?.trim() !== "")
        .map((m) => ({ name: m.name, value: draft.values[m.name].trim(), unit: m.unit })),
    [draft.values, meta.metrics]
  );

  const deltas = useMemo<Delta[]>(
    () =>
      CUMULATIVES.filter((c) => draft.deltas[c.name]?.trim() !== "" && Number(draft.deltas[c.name]) > 0).map(
        (c) => ({ name: c.name, amount: Number(draft.deltas[c.name]), unit: c.unit })
      ),
    [draft.deltas]
  );

  const setV = (name: string, value: string) =>
    setDraft((d) => ({ ...d, values: { ...d.values, [name]: value } }));
  const setDelta = (name: string, value: string) =>
    setDraft((d) => ({ ...d, deltas: { ...d.deltas, [name]: value } }));

  function submit() {
    if (!equipment.trim()) return toast("请选择或填写设备名称", "warn");
    if (readings.length === 0 && !draft.abnormality.trim()) {
      return toast("至少填写一项参数读数或异常描述", "warn");
    }
    if (draft.status !== "ok" && !draft.abnormality.trim()) {
      return toast("状态为异常时必须填写异常描述", "warn");
    }
    const recordedAt = draft.useManualTime && draft.manualTime ? draft.manualTime : toMinute(now);

    dispatch({
      type: "add",
      item: {
        post,
        author: state.userName,
        role: state.role,
        equipment: equipment.trim(),
        recordedAt,
        readings,
        abnormality: draft.abnormality.trim(),
        handling: draft.handling.trim(),
        status: draft.status,
        deltas,
        carryOver: draft.carryOver,
      },
    });

    toast(
      state.online
        ? `已记录并同步合并：${equipment} @ ${recordedAt.slice(11)}`
        : `已保存在${meta.label}本机待发箱（离线），联网后补传`,
      state.online ? "ok" : "warn"
    );
    setDraft({ ...initDraft(post), manualTime: draft.manualTime, useManualTime: draft.useManualTime });
  }

  return (
    <div className="watch-grid">
      <section className="panel">
        <div className="heading">
          <div>
            <p>
              <PostTag post={post} />
            </p>
            <h2>{meta.label}值班记录</h2>
          </div>
          <div className={`net-dot ${state.online ? "online" : "offline"}`}>
            {state.online ? "链路在线 · 实时同步" : "断网 · 本机暂存"}
          </div>
        </div>

        <div className="form-row">
          <label className="grow">
            <span>设备名称</span>
            <select
              value={draft.equipment}
              onChange={(e) => setDraft((d) => ({ ...d, equipment: e.target.value }))}
            >
              {meta.equipment.map((eq) => (
                <option key={eq}>{eq}</option>
              ))}
            </select>
          </label>
          <label className="grow">
            <span>或手填设备（不在清单时）</span>
            <input
              placeholder="例如 分油机#1"
              value={draft.customEquipment}
              onChange={(e) => setDraft((d) => ({ ...d, customEquipment: e.target.value }))}
            />
          </label>
        </div>

        <div className="form-row">
          <label className="check-line">
            <input
              type="checkbox"
              checked={draft.useManualTime}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  useManualTime: e.target.checked,
                  manualTime: d.manualTime || toMinute(now),
                }))
              }
            />
            <span>手动指定记录时刻（默认船内当前时刻）</span>
          </label>
          {draft.useManualTime && (
            <input
              type="datetime-local"
              value={draft.manualTime.replace(" ", "T")}
              onChange={(e) =>
                setDraft((d) => ({ ...d, manualTime: e.target.value.replace("T", " ") }))
              }
            />
          )}
        </div>

        <h3 className="sub-h">参数读数</h3>
        <div className="reading-grid">
          {meta.metrics.map((m) => (
            <label key={m.name}>
              <span>
                {m.name}
                {m.unit ? `（${m.unit}）` : ""}
              </span>
              <input
                inputMode="decimal"
                placeholder="读数"
                value={draft.values[m.name]}
                onChange={(e) => setV(m.name, e.target.value)}
              />
            </label>
          ))}
        </div>

        <h3 className="sub-h">异常与处理结果</h3>
        <div className="form-row">
          <label className="check-line">
            <span>巡检状态</span>
            <select
              value={draft.status}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as AbnStatus }))}
            >
              <option value="ok">正常巡检</option>
              <option value="open">异常待处理</option>
              <option value="done">异常已处理</option>
            </select>
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={draft.carryOver}
              onChange={(e) => setDraft((d) => ({ ...d, carryOver: e.target.checked }))}
            />
            <span>列入交接遗留事项</span>
          </label>
        </div>
        <div className="form-row">
          <label className="grow">
            <span>异常描述</span>
            <textarea
              rows={2}
              placeholder="无异常可留空"
              value={draft.abnormality}
              onChange={(e) => setDraft((d) => ({ ...d, abnormality: e.target.value }))}
            />
          </label>
          <label className="grow">
            <span>处理结果 / 已采取措施</span>
            <textarea
              rows={2}
              placeholder="例如 已降速运行并报告轮机长"
              value={draft.handling}
              onChange={(e) => setDraft((d) => ({ ...d, handling: e.target.value }))}
            />
          </label>
        </div>

        <h3 className="sub-h">本班累计增量（换班后继续累加）</h3>
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
                placeholder="本班新增量"
                value={draft.deltas[c.name]}
                onChange={(e) => setDelta(c.name, e.target.value)}
              />
            </label>
          ))}
        </div>

        <div className="form-actions">
          <button className="primary" onClick={submit}>
            保存记录{state.online ? "并同步" : "（离线暂存）"}
          </button>
          <button onClick={() => setDraft(initDraft(post))}>清空表单</button>
        </div>
      </section>

      <aside className="side-stack">
        <section className="panel mini">
          <h3>本岗待发箱（{outbox.length}）</h3>
          {outbox.length === 0 ? (
            <Empty text={state.online ? "没有积压，记录已实时并入台账" : "断网期间记录会暂存在这里"} />
          ) : (
            <div className="outbox-list">
              {outbox.map((o) => (
                <div key={o.id} className="outbox-item">
                  <div>
                    <b>{o.equipment}</b>
                    <span className="muted"> @ {o.recordedAt.slice(5)}</span>
                  </div>
                  <div className="muted small">
                    {o.readings.map((r) => `${r.name}${r.value}`).join("，") || o.abnormality || "—"}
                  </div>
                  <button
                    className="link-danger"
                    onClick={() => dispatch({ type: "discard-outbox", post, id: o.id })}
                  >
                    丢弃
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel mini">
          <h3>本班 / 对账提示</h3>
          <p className="small muted">当前班次：{shiftLabel(state.currentShiftId)}</p>
          {otherPending > 0 ? (
            <button className="btn-warn block" onClick={goPending}>
              {otherPost === "engine" ? "机舱" : "驾驶台"}对碰出 {otherPending} 项待复核，去处理
            </button>
          ) : (
            <p className="small ok-text">双岗读数暂无对碰分歧</p>
          )}
          {!state.online && (
            <p className="small warn-text">
              当前离线，{POST_META[otherPost].label}的记录恢复联网后按设备+时刻自动合并
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
