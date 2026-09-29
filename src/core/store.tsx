import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import type {
  AuditActor,
  Conflict,
  Delta,
  Explanation,
  LedgerRecord,
  OutboxItem,
  Post,
  RevData,
  Role,
  ShiftSnapshot,
  SideSnapshot,
  State,
  ResolutionChoice,
} from "../types";
import { CUMULATIVES } from "../types";
import { fingerprint, hash32, stableJSON, uuid } from "./hash";
import { LEGACY_ROWS, migrationAnchor, parseLegacyRow } from "./legacy";
import {
  nextShiftId,
  shiftIdFromRecordedAt,
  shiftIdOf,
  shiftStartAt,
  shipNow,
  toMinute,
} from "./time";

const STORAGE_KEYS = {
  state: "hxy62001:ledger:v2",
  legacySnapshot: "hxy62001:legacy-snapshot:v1",
} as const;

// ---------------------------------------------------------------------------
// 审计：只增事件 + prevHash 链
// ---------------------------------------------------------------------------

function nowIso(offset: number): string {
  return shipNow(offset).toISOString();
}

function appendEvent(
  audit: State["audit"],
  seqRef: { value: number },
  actor: AuditActor,
  action: string,
  at: string,
  extra?: { target?: string; detail?: unknown }
) {
  const seq = seqRef.value;
  const prevHash = audit.length ? audit[audit.length - 1].hash : "GENESIS";
  const body = stableJSON({
    seq,
    at,
    actor,
    action,
    target: extra?.target,
    detail: extra?.detail,
    prevHash,
  });
  audit.push({
    seq,
    at,
    actor: { ...actor },
    action,
    target: extra?.target,
    detail: extra?.detail,
    prevHash,
    hash: hash32(body),
  });
  seqRef.value += 1;
}

export function verifyAuditChain(audit: State["audit"]): { ok: boolean; brokenAt?: number } {
  let prev = "GENESIS";
  for (const ev of audit) {
    if (ev.prevHash !== prev) return { ok: false, brokenAt: ev.seq };
    const body = stableJSON({
      seq: ev.seq,
      at: ev.at,
      actor: ev.actor,
      action: ev.action,
      target: ev.target,
      detail: ev.detail,
      prevHash: ev.prevHash,
    });
    if (hash32(body) !== ev.hash) return { ok: false, brokenAt: ev.seq };
    prev = ev.hash;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 初始状态 / 旧样例自举
// ---------------------------------------------------------------------------

function initState(): State {
  const offset = 0;
  const now = shipNow(offset);
  const anchor = migrationAnchor(toMinute(now).slice(0, 10));
  const voyageId = `V${now.toISOString().slice(0, 10).replaceAll("-", "")}-001`;
  const audit: State["audit"] = [];
  const seqRef = { value: 1 };
  const actor: AuditActor = { role: "leader", name: "值班领导" };

  // 旧台账原样另存：迁移期间原数据保留不动
  let legacyPreservedAt = nowIso(offset);
  try {
    const existing = localStorage.getItem(STORAGE_KEYS.legacySnapshot);
    if (existing) {
      legacyPreservedAt =
        (JSON.parse(existing) as { preservedAt?: string }).preservedAt ?? legacyPreservedAt;
    } else {
      localStorage.setItem(
        STORAGE_KEYS.legacySnapshot,
        JSON.stringify({ preservedAt: legacyPreservedAt, rows: LEGACY_ROWS })
      );
    }
  } catch {
    // 存储不可用时退化为仅内存，功能逻辑不受影响
  }

  const state: State = {
    version: 2,
    seq: 2,
    clientId: uuid(),
    role: "leader",
    userName: "值班领导",
    clockOffsetMin: offset,
    online: typeof navigator === "undefined" || navigator.onLine,
    voyageId,
    currentShiftId: shiftIdOf(now),
    shifts: [],
    records: [],
    conflicts: [],
    outbox: { bridge: [], engine: [] },
    migration: {
      phase: "running",
      total: LEGACY_ROWS.length,
      done: [],
      startedAt: nowIso(offset),
      updatedAt: nowIso(offset),
      anchorDate: anchor,
      legacy: LEGACY_ROWS.map((r) => [...r]),
      legacyPreservedAt,
    },
    audit,
  };

  appendEvent(audit, seqRef, actor, "system.bootstrap", nowIso(offset), {
    detail: { voyageId, clientId: state.clientId, legacyRows: LEGACY_ROWS.length },
  });
  state.seq = seqRef.value;
  return state;
}

function loadState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.state);
    if (raw) {
      const parsed = JSON.parse(raw) as State;
      parsed.online = typeof navigator === "undefined" || navigator.onLine;
      return parsed;
    }
  } catch {
    // 落盘损坏则重新自举
  }
  return initState();
}

// ---------------------------------------------------------------------------
// 合并 / 冲突判定
// ---------------------------------------------------------------------------

export function signatureOf(data: RevData): string {
  return fingerprint({
    readings: data.readings.map((r) => `${r.name}=${r.value}${r.unit}`).sort(),
    abnormality: data.abnormality.trim(),
    handling: data.handling.trim(),
    status: data.status,
  });
}

export function isSealed(rec: LedgerRecord, state: State): boolean {
  if (state.shifts.some((s) => s.id === rec.shiftId)) return true;
  return rec.shiftId < state.currentShiftId;
}

function mergeKey(equipment: string, recordedAt: string): string {
  return `${equipment}@@${recordedAt}`;
}

function sideOf(item: OutboxItem): SideSnapshot {
  return {
    post: item.post,
    ref: item.id,
    author: item.author,
    readings: item.readings.map((r) => ({ ...r })),
    abnormality: item.abnormality,
    handling: item.handling,
    status: item.status,
    deltas: item.deltas.map((d) => ({ ...d })),
    carryOver: item.carryOver,
  };
}

function baseSide(rec: LedgerRecord): SideSnapshot {
  return {
    post: rec.sources[0]?.post ?? "engine",
    ref: rec.sources[0]?.ref ?? rec.id,
    author: rec.sources[0]?.author ?? rec.id,
    readings: rec.readings.map((r) => ({ ...r })),
    abnormality: rec.abnormality,
    handling: rec.handling,
    status: rec.status,
    deltas: rec.deltas.map((d) => ({ ...d })),
    carryOver: rec.carryOver,
  };
}

function sameRevData(x: RevData, y: RevData): boolean {
  return signatureOf(x) === signatureOf(y);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { type: "add"; item: Omit<OutboxItem, "id" | "createdAt"> }
  | { type: "discard-outbox"; post: Post; id: string }
  | { type: "sync" }
  | {
      type: "resolve-conflict";
      id: string;
      choice: ResolutionChoice;
      basis: string;
      custom?: RevData;
    }
  | { type: "revise-record"; id: string; after: RevData; reason: string }
  | { type: "explain-record"; id: string; text: string }
  | { type: "handover"; note: string }
  | { type: "blocked-handover" }
  | { type: "set-online"; online: boolean }
  | { type: "set-offset"; minutes: number }
  | { type: "set-identity"; role: Role; name: string }
  | { type: "migration-tick" }
  | { type: "migration-pause" }
  | { type: "migration-resume" }
  | { type: "reset-demo" };

function reducer(prev: State, action: Action): State {
  // 浅层复制 + 数组克隆，保证 reducer 纯净（StrictMode 双调用安全）
  const state: State = {
    ...prev,
    shifts: prev.shifts,
    records: prev.records,
    conflicts: prev.conflicts,
    audit: [...prev.audit],
    outbox: prev.outbox,
    migration: prev.migration,
  };
  const seqRef = { value: prev.seq };
  const add = (name: string, extra?: { target?: string; detail?: unknown }, at?: string) =>
    appendEvent(
      state.audit,
      seqRef,
      { role: state.role, name: state.userName },
      name,
      at ?? nowIso(state.clockOffsetMin),
      extra
    );

  switch (action.type) {
    // 断网也能记：先进本岗位 outbox，等待同步
    case "add": {
      const id = uuid();
      const item: OutboxItem = { ...action.item, id, createdAt: nowIso(state.clockOffsetMin) };
      state.outbox = { ...state.outbox, [item.post]: [...state.outbox[item.post], item] };
      add("record.add", {
        target: id,
        detail: { post: item.post, equipment: item.equipment, recordedAt: item.recordedAt },
      });
      // 在线时立即同步；离线则留在 outbox（先把序号写回，避免递归调用审计撞号）
      if (state.online) {
        state.seq = seqRef.value;
        return reducer(state, { type: "sync" });
      }
      state.seq = seqRef.value;
      return state;
    }

    case "discard-outbox": {
      const item = state.outbox[action.post].find((i) => i.id === action.id);
      if (!item) return prev;
      state.outbox = {
        ...state.outbox,
        [action.post]: state.outbox[action.post].filter((i) => i.id !== action.id),
      };
      add("record.discard-unsynced", {
        target: action.id,
        detail: { post: action.post, equipment: item.equipment, recordedAt: item.recordedAt },
      });
      state.seq = seqRef.value;
      return state;
    }

    // 同步：把双岗 outbox 按「设备 + 记录时刻」并入正式台账
    case "sync": {
      if (!state.online) return prev;
      const queue = [...state.outbox.bridge, ...state.outbox.engine].sort((a, b) =>
        a.recordedAt === b.recordedAt
          ? a.createdAt.localeCompare(b.createdAt)
          : a.recordedAt.localeCompare(b.recordedAt)
      );
      if (queue.length === 0) return prev;

      const records = [...state.records];
      const conflicts = [...state.conflicts];
      const consumed = new Set<string>();
      let merged = 0;
      let duplicated = 0;
      let clashed = 0;

      const keyIndex = new Map(records.map((r, i) => [mergeKey(r.equipment, r.recordedAt), i]));
      const queuedByKey = new Map<string, OutboxItem[]>();
      for (const item of queue) {
        const k = mergeKey(item.equipment, item.recordedAt);
        queuedByKey.set(k, [...(queuedByKey.get(k) ?? []), item]);
      }

      for (const item of queue) {
        if (consumed.has(item.id)) continue;
        const k = mergeKey(item.equipment, item.recordedAt);
        const group = (queuedByKey.get(k) ?? []).filter((g) => !consumed.has(g.id));
        let base: LedgerRecord;
        let others: OutboxItem[];

        const baseIdx = keyIndex.get(k);
        if (baseIdx === undefined) {
          // 台账首次出现该（设备，时刻）：同组第一条成为基准，其余与它对碰
          const [first, ...rest] = group;
          const ts = nowIso(state.clockOffsetMin);
          base = {
            id: uuid(),
            equipment: first.equipment,
            recordedAt: first.recordedAt,
            shiftId: shiftIdFromRecordedAt(first.recordedAt),
            readings: first.readings.map((r) => ({ ...r })),
            abnormality: first.abnormality,
            handling: first.handling,
            status: first.status,
            deltas: first.deltas.map((d) => ({ ...d })),
            carryOver: first.carryOver,
            sources: [{ post: first.post, ref: first.id, author: first.author }],
            explanations: [],
            revisions: [],
            rev: 1,
            createdAt: ts,
            updatedAt: ts,
          };
          records.push(base);
          keyIndex.set(k, records.length - 1);
          consumed.add(first.id);
          others = rest;
        } else {
          // 复制基准记录，避免原地改写
          const copy: LedgerRecord = { ...records[baseIdx], sources: [...records[baseIdx].sources] };
          records[baseIdx] = copy;
          base = copy;
          others = group;
        }

        for (const other of others) {
          consumed.add(other.id);
          const otherData: RevData = {
            readings: other.readings,
            abnormality: other.abnormality,
            handling: other.handling,
            status: other.status,
            deltas: other.deltas,
            carryOver: other.carryOver,
          };
          if (base.sources.some((s) => s.ref === other.id)) {
            duplicated++;
            continue;
          }
          if (sameRevData(base, otherData)) {
            // 同设备同时点同读数：合并为一条正式记录
            base.sources.push({ post: other.post, ref: other.id, author: other.author });
            merged++;
          } else {
            // 同一时点两个读数不同：进入待复核区，第二份暂不并入正式台账
            conflicts.push({
              id: uuid(),
              equipment: other.equipment,
              recordedAt: other.recordedAt,
              shiftId: base.shiftId,
              a: baseSide(base),
              b: sideOf(other),
              status: "pending",
              createdAt: nowIso(state.clockOffsetMin),
            });
            clashed++;
          }
        }
      }

      // 只有成功并入（或进入待复核）的条目才清出 outbox，失败不丢数据
      state.records = records;
      state.conflicts = conflicts;
      state.outbox = {
        bridge: state.outbox.bridge.filter((i) => !consumed.has(i.id)),
        engine: state.outbox.engine.filter((i) => !consumed.has(i.id)),
      };
      add("sync.completed", {
        detail: {
          processed: consumed.size,
          merged,
          duplicated,
          conflict: clashed,
          remaining: state.outbox.bridge.length + state.outbox.engine.length,
        },
      });
      state.seq = seqRef.value;
      return state;
    }

    // 领导在待复核区裁决；普通轮机员无此操作入口（UI 与 reducer 双重拦截）
    case "resolve-conflict": {
      if (state.role !== "leader") return prev;
      const idx = state.conflicts.findIndex((c) => c.id === action.id);
      if (idx < 0) return prev;
      const conflict = state.conflicts[idx];
      if (conflict.status !== "pending") return prev;

      let chosen: RevData;
      if (action.choice === "a") chosen = conflict.a;
      else if (action.choice === "b") chosen = conflict.b;
      else if (action.custom) chosen = action.custom;
      else {
        // avg：同口径数值读数取平均，其余保留 a 侧
        chosen = {
          ...conflict.a,
          readings: conflict.a.readings.map((r, i) => {
            const peer = conflict.b.readings[i];
            const va = Number.parseFloat(r.value);
            const vb = peer ? Number.parseFloat(peer.value) : NaN;
            if (
              peer &&
              r.name === peer.name &&
              r.unit === peer.unit &&
              Number.isFinite(va) &&
              Number.isFinite(vb)
            ) {
              const avg = (va + vb) / 2;
              return { ...r, value: String(Math.round(avg * 100) / 100) };
            }
            return { ...r };
          }),
        };
      }
      if (!action.basis.trim()) return prev;

      const k = mergeKey(conflict.equipment, conflict.recordedAt);
      const recIdx = state.records.findIndex(
        (r) => mergeKey(r.equipment, r.recordedAt) === k
      );
      const ts = nowIso(state.clockOffsetMin);
      let recordId: string;
      const records = [...state.records];

      if (recIdx >= 0) {
        const rec: LedgerRecord = {
          ...records[recIdx],
          readings: chosen.readings.map((r) => ({ ...r })),
          abnormality: chosen.abnormality,
          handling: chosen.handling,
          status: chosen.status,
          deltas: chosen.deltas.map((d) => ({ ...d })),
          carryOver: chosen.carryOver,
          sources: [
            ...records[recIdx].sources,
            { post: conflict.b.post, ref: conflict.b.ref, author: conflict.b.author },
          ],
          updatedAt: ts,
        };
        records[recIdx] = rec;
        recordId = rec.id;
      } else {
        const rec: LedgerRecord = {
          id: uuid(),
          equipment: conflict.equipment,
          recordedAt: conflict.recordedAt,
          shiftId: conflict.shiftId,
          readings: chosen.readings.map((r) => ({ ...r })),
          abnormality: chosen.abnormality,
          handling: chosen.handling,
          status: chosen.status,
          deltas: chosen.deltas.map((d) => ({ ...d })),
          carryOver: chosen.carryOver,
          sources: [
            { post: conflict.a.post, ref: conflict.a.ref, author: conflict.a.author },
            { post: conflict.b.post, ref: conflict.b.ref, author: conflict.b.author },
          ],
          explanations: [],
          revisions: [],
          rev: 1,
          createdAt: ts,
          updatedAt: ts,
        };
        records.push(rec);
        recordId = rec.id;
      }

      const resolved: Conflict = {
        ...conflict,
        status: "resolved",
        resolution: {
          at: ts,
          by: state.userName,
          choice: action.choice,
          basis: action.basis.trim(),
          recordId,
        },
      };
      state.records = records;
      state.conflicts = state.conflicts.map((c, i) => (i === idx ? resolved : c));
      add("conflict.resolve", {
        target: conflict.id,
        detail: {
          equipment: conflict.equipment,
          recordedAt: conflict.recordedAt,
          choice: action.choice,
          basis: action.basis.trim(),
          recordId,
        },
      });
      state.seq = seqRef.value;
      return state;
    }

    // 领导复核后可修订已封存记录：原值留痕、版本号递增
    case "revise-record": {
      if (state.role !== "leader") return prev;
      const idx = state.records.findIndex((r) => r.id === action.id);
      if (idx < 0) return prev;
      const rec = state.records[idx];
      if (!action.reason.trim()) return prev;

      const clone = (d: RevData): RevData => ({
        readings: d.readings.map((r) => ({ ...r })),
        abnormality: d.abnormality,
        handling: d.handling,
        status: d.status,
        deltas: d.deltas.map((x) => ({ ...x })),
        carryOver: d.carryOver,
      });
      const before = clone(rec);
      const after = clone(action.after);
      const ts = nowIso(state.clockOffsetMin);
      const updated: LedgerRecord = {
        ...rec,
        ...after,
        rev: rec.rev + 1,
        revisions: [
          ...rec.revisions,
          { rev: rec.rev + 1, at: ts, by: state.userName, reason: action.reason.trim(), before, after },
        ],
        updatedAt: ts,
      };
      state.records = state.records.map((r, i) => (i === idx ? updated : r));
      add("record.revise", {
        target: rec.id,
        detail: {
          shiftId: rec.shiftId,
          sealed: isSealed(rec, state),
          reason: action.reason.trim(),
          before,
          after,
        },
      });
      state.seq = seqRef.value;
      return state;
    }

    // 普通轮机员只能补说明（不改正文）；领导也可补充说明
    case "explain-record": {
      if (!action.text.trim()) return prev;
      const idx = state.records.findIndex((r) => r.id === action.id);
      if (idx < 0) return prev;
      const rec = state.records[idx];
      const explanation: Explanation = {
        id: uuid(),
        author: state.userName,
        role: state.role,
        text: action.text.trim(),
        at: nowIso(state.clockOffsetMin),
      };
      const updated: LedgerRecord = {
        ...rec,
        explanations: [...rec.explanations, explanation],
        updatedAt: nowIso(state.clockOffsetMin),
      };
      state.records = state.records.map((r, i) => (i === idx ? updated : r));
      add("record.explain", {
        target: rec.id,
        detail: { shiftId: rec.shiftId, sealed: isSealed(rec, state), text: explanation.text },
      });
      state.seq = seqRef.value;
      return state;
    }

    // 交接：有待复核未裁决（或离线未同步）时摘要不完整，拦住交班
    case "handover": {
      const pending = state.conflicts.filter((c) => c.status === "pending").length;
      const unsynced = state.outbox.bridge.length + state.outbox.engine.length;
      if (pending > 0 || unsynced > 0) return prev;

      const endAt = nowIso(state.clockOffsetMin);
      const carried = state.records
        .filter(
          (r) => r.shiftId === state.currentShiftId && (r.status === "open" || r.carryOver)
        )
        .map((r) => ({
          id: r.id,
          equipment: r.equipment,
          text:
            r.status === "open"
              ? `${r.recordedAt.slice(5)} ${r.equipment}：${r.abnormality || "异常未处理"}（${r.handling || "无处理记录"}）`
              : `${r.recordedAt.slice(5)} ${r.equipment}：${r.handling || r.abnormality}（遗留跟进）`,
        }));

      const snapshot: ShiftSnapshot = {
        id: state.currentShiftId,
        label: state.currentShiftId,
        startAt: shiftStartAt(state.currentShiftId),
        endAt,
        note: action.note.trim(),
        by: state.userName,
        counters: totalsFor(state.records),
        carried,
      };
      state.shifts = [...state.shifts, snapshot];
      state.currentShiftId = nextShiftId(state.currentShiftId);
      add("shift.handover", {
        target: snapshot.id,
        detail: { note: snapshot.note, counters: snapshot.counters, carried: carried.length },
      });
      state.seq = seqRef.value;
      return state;
    }

    case "blocked-handover": {
      const pending = state.conflicts.filter((c) => c.status === "pending").length;
      const unsynced = state.outbox.bridge.length + state.outbox.engine.length;
      if (pending === 0 && unsynced === 0) return prev;
      add("shift.handover-blocked", {
        detail: {
          pendingConflicts: pending,
          unsynced,
          reason: pending > 0 ? "待复核项未处理，交接摘要不完整" : "尚有未同步记录",
        },
      });
      state.seq = seqRef.value;
      return state;
    }

    case "set-online": {
      if (state.online === action.online) return prev;
      state.online = action.online;
      // 断/联网是通道状态，不写业务审计噪音；恢复联网后自动补传
      if (action.online) return reducer(state, { type: "sync" });
      return state;
    }

    // 船内时钟调整只影响之后的记录时刻，不改写既有记录
    case "set-offset": {
      if (action.minutes === state.clockOffsetMin || !Number.isFinite(action.minutes)) return prev;
      const oldOffset = state.clockOffsetMin;
      state.clockOffsetMin = Math.round(action.minutes);
      add("clock.offset-change", { detail: { oldMin: oldOffset, newMin: state.clockOffsetMin } });
      state.seq = seqRef.value;
      return state;
    }

    case "set-identity": {
      if (!action.name.trim()) return prev;
      const before = { role: state.role, name: state.userName };
      state.role = action.role;
      state.userName = action.name.trim();
      add("identity.change", {
        detail: { before, after: { role: action.role, name: state.userName } },
      });
      state.seq = seqRef.value;
      return state;
    }

    // 断点续传：每次只迁移一行；已完成行（稳定编号）跳过，保证不重复
    case "migration-tick": {
      const mig = state.migration;
      if (mig.phase !== "running" || mig.done.length >= mig.total) return prev;
      const row = mig.legacy[mig.done.length];
      if (!row) return prev;
      const parsed = parseLegacyRow(row, mig.anchorDate);
      const ts = nowIso(state.clockOffsetMin);

      let updatedMig = {
        ...mig,
        done: [...mig.done, parsed ? parsed.rowHash : fingerprint({ row })],
        updatedAt: ts,
      };

      if (!parsed) {
        add("migration.skip-row", { detail: { row, reason: "行内容无法解析" } });
      } else if (state.records.some((r) => r.id === parsed.id)) {
        // 幂等：同稳定编号已存在直接跳过（中断重开或重复执行都不会产生重复记录）
        add("migration.dedup-skip", { target: parsed.id, detail: { equipment: parsed.equipment } });
      } else {
        const rec: LedgerRecord = {
          id: parsed.id,
          equipment: parsed.equipment,
          recordedAt: parsed.recordedAt,
          shiftId: parsed.shiftId,
          readings: parsed.readings,
          abnormality: parsed.abnormality,
          handling: parsed.handling,
          status: parsed.status,
          deltas: [],
          carryOver: parsed.carryOver,
          sources: [{ post: "engine", ref: `legacy:${parsed.rowHash}`, author: "旧台账" }],
          legacy: { shiftLabel: row[0] ?? "", raw: [...row] },
          explanations: [],
          revisions: [],
          rev: 1,
          createdAt: ts,
          updatedAt: ts,
        };
        state.records = [...state.records, rec];
        add("migration.import-row", {
          target: parsed.id,
          detail: {
            equipment: parsed.equipment,
            recordedAt: parsed.recordedAt,
            legacyShift: row[0],
            rowHash: parsed.rowHash,
          },
        });
      }

      if (updatedMig.done.length >= mig.total) {
        updatedMig = { ...updatedMig, phase: "done", finishedAt: ts };
        add("migration.complete", { detail: { total: mig.total } });
      }
      state.migration = updatedMig;
      state.seq = seqRef.value;
      return state;
    }

    case "migration-pause": {
      // 模拟迁移过程被关掉：已完成的行与原数据都保留，重开后接着完成
      if (state.migration.phase !== "running") return prev;
      state.migration = {
        ...state.migration,
        phase: "paused",
        updatedAt: nowIso(state.clockOffsetMin),
      };
      add("migration.pause", {
        detail: { done: state.migration.done.length, total: state.migration.total },
      });
      state.seq = seqRef.value;
      return state;
    }

    case "migration-resume": {
      if (state.migration.phase !== "paused") return prev;
      state.migration = {
        ...state.migration,
        phase: "running",
        updatedAt: nowIso(state.clockOffsetMin),
      };
      add("migration.resume", {
        detail: { done: state.migration.done.length, total: state.migration.total },
      });
      state.seq = seqRef.value;
      return state;
    }

    case "reset-demo": {
      try {
        localStorage.removeItem(STORAGE_KEYS.state);
        localStorage.removeItem(STORAGE_KEYS.legacySnapshot);
      } catch {
        // ignore
      }
      const fresh = initState();
      const seqRef2 = { value: fresh.seq };
      appendEvent(
        fresh.audit,
        seqRef2,
        { role: state.role, name: state.userName },
        "demo.reset",
        nowIso(fresh.clockOffsetMin),
        { detail: { by: state.userName } }
      );
      fresh.seq = seqRef2.value;
      return fresh;
    }

    default:
      return prev;
  }
}

// ---------------------------------------------------------------------------
// 汇总选择器
// ---------------------------------------------------------------------------

/** 航次累计值（按记录内容现算，修订后自动重算；换班快照保证班次间衔接可追溯） */
export function totalsFor(records: LedgerRecord[]): Record<string, number> {
  const totals: Record<string, number> = Object.fromEntries(
    CUMULATIVES.map((c) => [c.name, 0])
  );
  for (const r of records) {
    for (const d of r.deltas as Delta[]) {
      if (d.name in totals) totals[d.name] += Number(d.amount) || 0;
    }
  }
  return totals;
}

export function shiftTotals(records: LedgerRecord[], shiftId: string): Record<string, number> {
  return totalsFor(records.filter((r) => r.shiftId === shiftId));
}

// ---------------------------------------------------------------------------
// Store Provider
// ---------------------------------------------------------------------------

interface StoreCtx {
  state: State;
  dispatch: Dispatch<Action>;
  now: Date;
}

const Ctx = createContext<StoreCtx | null>(null);

export function useShipNow(offsetMin: number): Date {
  const [now, setNow] = useState(() => shipNow(offsetMin));
  useEffect(() => {
    setNow(shipNow(offsetMin));
    const t = window.setInterval(() => setNow(shipNow(offsetMin)), 20000);
    return () => window.clearInterval(t);
  }, [offsetMin]);
  return now;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);

  // 持久化：任何变化都落盘（中断/关页面后已完成部分与原数据都在）
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.state, JSON.stringify(state));
    } catch {
      // 存储不可用时仅内存运行
    }
  }, [state]);

  // 迁移循环：running 时一行一行迁移，随时可被打断，重开自动续传
  useEffect(() => {
    if (state.migration.phase !== "running") return;
    const t = window.setTimeout(() => dispatch({ type: "migration-tick" }), 650);
    return () => window.clearTimeout(t);
  }, [state.migration]);

  // 浏览器真实联网状态（也可在页头手动模拟断网）
  useEffect(() => {
    const on = () => dispatch({ type: "set-online", online: navigator.onLine });
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);

  const now = useShipNow(state.clockOffsetMin);
  const value = useMemo(() => ({ state, dispatch, now }), [state, now]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): StoreCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("StoreProvider missing");
  return ctx;
}

export { reducer, initState };
