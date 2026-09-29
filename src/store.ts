import type {
  AuditEvent,
  ConflictResolution,
  DB,
  Entry,
  OutOp,
  Shift,
  Station,
  Role,
  PendingItem,
  CumulativeCarry,
} from "./types";
import { LEGACY_ROWS, shiftLabelToStart } from "./legacy";
import { inShift, pad2, shiftIdAt, shiftWindow, shipNow, uid } from "./time";

const DB_KEY = (s: Station) => `dlw.db.${s}`;
const OUT_KEY = (s: Station) => `dlw.outbox.${s}`;
const AUDIT_KEY = (s: Station) => `dlw.audit.${s}`;
const SESSION_KEY = "dlw.session";
const LEGACY_SNAPSHOT_KEY = "dlw.legacySnapshot.v1";

export interface OutItem {
  op: OutOp;
  synced: boolean;
}

// ---------- 基础存取 ----------

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function emptyDB(): DB {
  return {
    entries: {},
    shifts: {},
    resolutions: {},
    appliedOpIds: [],
    migration: { status: "idle", runId: "", anchorDate: "", total: LEGACY_ROWS.length, nextIndex: 0, snapshot: null },
  };
}

export function loadDB(station: Station): DB {
  const db = read<DB | null>(DB_KEY(station), null);
  if (!db) {
    const fresh = emptyDB();
    write(DB_KEY(station), fresh);
    return fresh;
  }
  return db;
}

export function saveDB(station: Station, db: DB): void {
  write(DB_KEY(station), db);
}

export function loadOutbox(station: Station): OutItem[] {
  return read<OutItem[]>(OUT_KEY(station), []);
}

export function loadAudit(station: Station): AuditEvent[] {
  return read<AuditEvent[]>(AUDIT_KEY(station), []);
}

export interface Profile {
  actor: string;
  role: Role;
}
export interface SessionData {
  clientId: string;
  profiles: Record<Station, Profile>;
  offsetMin: number;
  online: Record<Station, boolean>;
}

export function loadSession(): SessionData {
  const s = read<SessionData | null>(SESSION_KEY, null);
  if (s && s.profiles) return s;
  const fresh: SessionData = {
    clientId: uid("cli"),
    profiles: {
      bridge: { actor: "张驾驶", role: "engineer" },
      engine: { actor: "李轮机", role: "engineer" },
    },
    offsetMin: 0,
    online: { bridge: true, engine: true },
  };
  write(SESSION_KEY, fresh);
  return fresh;
}

export function saveSession(patch: Partial<SessionData>): void {
  write(SESSION_KEY, { ...loadSession(), ...patch });
}

// 旧样例原件：首次进入即冻结存档，迁移过程中任何中断都不改动它
export function ensureLegacySnapshot(): { savedAt: string; source: string; rows: string[][] } {
  const exist = read<{ savedAt: string; source: string; rows: string[][] } | null>(LEGACY_SNAPSHOT_KEY, null);
  if (exist) return exist;
  const snap = {
    savedAt: new Date().toISOString(),
    source: "src/App.tsx project.records（旧轮机页样例）",
    rows: LEGACY_ROWS.map((r) => [r.shiftLabel, r.device, r.reading, r.anomaly]),
  };
  write(LEGACY_SNAPSHOT_KEY, snap);
  return snap;
}

// ---------- 操作回放（幂等） ----------

function cloneDB(db: DB): DB {
  return JSON.parse(JSON.stringify(db)) as DB;
}

/**
 * 把一条操作应用到台账。同 opId 绝不重复生效；
 * 操作顺序按 at 排序后回放，中断/重放结果一致。
 */
export function applyOp(db: DB, op: OutOp): boolean {
  if (db.appliedOpIds.includes(op.opId)) return false;
  const p = op.payload;

  switch (op.action) {
    case "INSERT_ENTRY": {
      const e = p.entry as Entry;
      if (!db.entries[e.id]) {
        const shift = db.shifts[e.shiftId];
        e.status = shift?.sealed ? "sealed" : "recorded";
        db.entries[e.id] = e;
      }
      break;
    }
    case "ADD_ADDENDUM": {
      const e = db.entries[p.targetId as string];
      if (e && !e.addenda.some((a) => a.id === (p.addendum as { id: string }).id)) {
        e.addenda.push(p.addendum as Entry["addenda"][number]);
      }
      break;
    }
    case "RESOLVE_ANOMALY": {
      const e = db.entries[p.anomalyId as string];
      if (e) {
        e.resolved = true;
        e.resolvedBy = op.actor;
      }
      break;
    }
    case "RESOLVE_CONFLICT": {
      const r = p.resolution as ConflictResolution;
      db.resolutions[r.key] = r;
      r.memberIds.forEach((id) => {
        if (id !== r.chosenId && db.entries[id] && db.entries[id].status !== "void") {
          db.entries[id].status = "superseded";
        }
      });
      break;
    }
    case "REVISE_ENTRY": {
      const rev = p.entry as Entry;
      const orig = db.entries[p.originalId as string];
      if (orig) {
        const wasSealed = orig.status === "sealed";
        orig.status = "superseded";
        const shift = db.shifts[orig.shiftId];
        rev.status = shift?.sealed || wasSealed ? "sealed" : "recorded";
        if (!db.entries[rev.id]) db.entries[rev.id] = rev;
      }
      break;
    }
    case "VOID_ENTRY": {
      const e = db.entries[p.targetId as string];
      if (e) {
        e.status = "void";
        e.note = p.reason as string;
      }
      break;
    }
    case "SEAL_SHIFT": {
      const shiftId = p.shiftId as string;
      const prev = db.shifts[shiftId];
      const shift: Shift = {
        id: shiftId,
        start: p.start as string,
        end: p.end as string,
        sealed: true,
        sealedAt: op.at,
        sealedBy: op.actor,
        sealedRole: op.role,
        carry: (p.carry as CumulativeCarry[]) ?? [],
        pending: (p.pending as PendingItem[]) ?? [],
      };
      db.shifts[shiftId] = shift;
      Object.values(db.entries).forEach((e) => {
        if (e.shiftId === shiftId && e.status === "recorded") e.status = "sealed";
      });
      void prev;
      break;
    }
  }
  db.appliedOpIds.push(op.opId);
  return true;
}

function auditFor(op: OutOp, synced: boolean): AuditEvent {
  const detailMap: Record<OutOp["action"], string> = {
    INSERT_ENTRY: "新增记录",
    ADD_ADDENDUM: "补充说明",
    RESOLVE_ANOMALY: "异常处理闭环",
    RESOLVE_CONFLICT: "待复核读数裁决",
    REVISE_ENTRY: "领导修订已封存记录",
    VOID_ENTRY: "作废记录",
    SEAL_SHIFT: "班次封存交班",
  };
  const p = op.payload;
  return {
    id: uid("aud"),
    at: op.at,
    shipTime: op.shipTime,
    actor: op.actor,
    role: op.role,
    station: op.station,
    action: detailMap[op.action],
    targetId:
      (p.targetId as string) ||
      (p.anomalyId as string) ||
      (p.originalId as string) ||
      ((p.entry as Entry | undefined)?.id) ||
      (p.shiftId as string),
    synced,
    detail: { opId: op.opId, ...p },
  };
}

// ---------- 本地写入（带审计 + 出站队列） ----------

export interface LocalContext {
  station: Station;
  actor: string;
  role: Role;
  offsetMin: number;
}

function nextOpId(): string {
  return uid("op");
}

// 同一毫秒内连续提交时保证操作时间戳单调递增（插入先于处理等引用关系）
let lastIssued = 0;
function orderedNow(): string {
  let t = Date.now();
  if (t <= lastIssued) t = lastIssued + 1;
  lastIssued = t;
  return new Date(t).toISOString();
}

export function makeEntry(
  partial: Omit<Entry, "id" | "createdAt" | "addenda" | "status">,
  ctx: LocalContext
): Entry {
  return {
    ...partial,
    id: uid("ent"),
    createdAt: new Date().toISOString(),
    addenda: [],
    status: "recorded",
  };
}

export function commitLocal(ctx: LocalContext, action: OutOp["action"], payload: Record<string, unknown>): void {
  const db = loadDB(ctx.station);
  const at = orderedNow();
  const op: OutOp = {
    opId: nextOpId(),
    station: ctx.station,
    actor: ctx.actor,
    role: ctx.role,
    at,
    shipTime: shipNow(ctx.offsetMin),
    action,
    payload,
  };
  if (applyOp(db, op)) {
    saveDB(ctx.station, db);
    const out = loadOutbox(ctx.station);
    out.push({ op, synced: false });
    write(OUT_KEY(ctx.station), out);
    const audits = loadAudit(ctx.station);
    audits.push(auditFor(op, false));
    write(AUDIT_KEY(ctx.station), audits);
  }
}

// ---------- 双岗同步合并 ----------

export interface SyncReport {
  appliedHere: number;
  appliedThere: number;
  mergedOps: number;
}

/**
 * 两岗台账合并：
 * 1) 收集两边全部操作（含已同步留底），按时刻全序回放，opId 天然去重；
 * 2) 记录实体做并集兜底，任何一边的记录都不会丢；
 * 3) 迁移进度取更靠前者；
 * 4) 新落到对端的操作写入双方审计（标记 synced）。
 */
export function syncStations(): SyncReport {
  const stations: Station[] = ["bridge", "engine"];
  const dbs = Object.fromEntries(stations.map((s) => [s, loadDB(s)])) as Record<Station, DB>;
  const outs = Object.fromEntries(stations.map((s) => [s, loadOutbox(s)])) as Record<Station, OutItem[]>;
  const audits = Object.fromEntries(stations.map((s) => [s, loadAudit(s)])) as Record<Station, AuditEvent[]>;

  const opMap = new Map<string, OutOp>();
  stations.forEach((s) => outs[s].forEach((item) => opMap.set(item.op.opId, item.op)));
  const actionOrder: Record<OutOp["action"], number> = {
    INSERT_ENTRY: 0,
    ADD_ADDENDUM: 1,
    RESOLVE_ANOMALY: 1,
    RESOLVE_CONFLICT: 2,
    REVISE_ENTRY: 2,
    VOID_ENTRY: 2,
    SEAL_SHIFT: 3,
  };
  const allOps = [...opMap.values()].sort((a, b) =>
    a.at === b.at
      ? actionOrder[a.action] - actionOrder[b.action] || a.opId.localeCompare(b.opId)
      : a.at.localeCompare(b.at)
  );

  const merged = emptyDB();
  allOps.forEach((op) => applyOp(merged, op));

  // 实体并集兜底（例如不经操作日志的历史导入）
  stations.forEach((s) => {
    Object.entries(dbs[s].entries).forEach(([id, e]) => {
      if (!merged.entries[id]) merged.entries[id] = e;
    });
    Object.entries(dbs[s].shifts).forEach(([id, sh]) => {
      if (!merged.shifts[id]) merged.shifts[id] = sh;
    });
    Object.entries(dbs[s].resolutions).forEach(([k, r]) => {
      if (!merged.resolutions[k]) merged.resolutions[k] = r;
    });
  });
  merged.appliedOpIds = [...new Set(allOps.map((o) => o.opId).concat(...stations.map((s) => dbs[s].appliedOpIds)))];

  // 迁移进度合并：done 优先，其次 nextIndex 更大、快照更完整
  const migs = stations.map((s) => dbs[s].migration);
  const better = migs
    .filter((m) => m.status !== "idle" || m.nextIndex > 0)
    .sort((a, b) => {
      const score = (m: DB["migration"]) => (m.status === "done" ? 1000 : m.nextIndex);
      return score(b) - score(a) || (b.snapshot ? 1 : 0) - (a.snapshot ? 1 : 0);
    })[0];
  if (better) merged.migration = JSON.parse(JSON.stringify(better));

  const report: SyncReport = { appliedHere: 0, appliedThere: 0, mergedOps: allOps.length };

  stations.forEach((s) => {
    const before = new Set(dbs[s].appliedOpIds);
    const fresh = allOps.filter((op) => !before.has(op.opId));
    if (s === "bridge") report.appliedThere = fresh.length;
    else report.appliedHere = fresh.length;
    fresh.forEach((op) => audits[s].push(auditFor(op, true)));
    saveDB(s, merged);
    write(AUDIT_KEY(s), audits[s]);
    // 全部操作此刻双方均已持有
    outs[s].forEach((item) => {
      item.synced = true;
    });
    write(OUT_KEY(s), outs[s]);
  });

  return report;
}

export function queueStats(station: Station): { pending: number; synced: number } {
  const out = loadOutbox(station);
  return { pending: out.filter((i) => !i.synced).length, synced: out.filter((i) => i.synced).length };
}

// ---------- 查询与汇总 ----------

export function liveEntries(db: DB): Entry[] {
  return Object.values(db.entries)
    .filter((e) => e.status !== "void")
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.createdAt.localeCompare(b.createdAt));
}

export interface ConflictGroup {
  key: string;
  device: string;
  recordedAt: string;
  members: Entry[];
  resolution?: ConflictResolution;
}

export function conflictKey(device: string, metric: string | undefined, recordedAt: string): string {
  return `${device}|${metric ?? ""}@${recordedAt}`;
}

/** 按 设备 + 参数 + 记录时刻 合并；同一时点出现两个有效读数即进入待复核区 */
export function findConflicts(db: DB): ConflictGroup[] {
  const groups = new Map<string, Entry[]>();
  Object.values(db.entries).forEach((e) => {
    if (e.entryType !== "parameter" || (e.status !== "recorded" && e.status !== "sealed")) return;
    const key = conflictKey(e.device, e.metric, e.recordedAt);
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  });
  const result: ConflictGroup[] = [];
  groups.forEach((members, key) => {
    if (members.length < 2) return;
    const resolution = db.resolutions[key];
    // 裁决必须覆盖当前全部成员，否则新增读数后冲突重新出现
    const covered = resolution && members.every((m) => resolution.memberIds.includes(m.id));
    if (!covered) {
      result.push({
        key,
        device: members[0].device,
        recordedAt: members[0].recordedAt,
        members: members.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        resolution: covered ? resolution : undefined,
      });
    }
  });
  return result.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

export function shiftConflicts(db: DB, shiftId: string): ConflictGroup[] {
  return findConflicts(db).filter((c) => inShift(c.recordedAt, shiftId));
}

/** 累计值：取该累计参数时刻最新的有效读数 */
export function liveCarry(db: DB, shiftId: string): CumulativeCarry[] {
  const [, end] = shiftWindow(shiftId);
  const byKey = new Map<string, Entry>();
  Object.values(db.entries).forEach((e) => {
    if (e.entryType !== "parameter" || !e.isCumulative || e.value == null) return;
    if (e.status === "void" || e.status === "superseded") return;
    if (e.recordedAt >= end) return;
    const key = `${e.device}|${e.metric}`;
    const cur = byKey.get(key);
    if (!cur || e.recordedAt > cur.recordedAt) byKey.set(key, e);
  });
  return [...byKey.values()].map((e) => ({
    key: `${e.device}|${e.metric}`,
    device: e.device,
    metric: e.metric ?? "",
    unit: e.unit ?? "",
    value: e.value ?? 0,
    entryId: e.id,
    recordedAt: e.recordedAt,
  }));
}

/** 遗留事项：班次时点仍未闭环的异常（含往班遗留），换班后继续衔接 */
export function pendingForShift(db: DB, shiftId: string): PendingItem[] {
  const [, end] = shiftWindow(shiftId);
  return Object.values(db.entries)
    .filter((e) => e.entryType === "anomaly" && !e.resolved && e.status !== "void")
    .filter((e) => e.recordedAt < end)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .map((e) => ({
      id: e.id,
      device: e.device,
      description: e.description ?? "",
      severity: e.severity,
      recordedAt: e.recordedAt,
      fromShift: shiftIdAt(e.recordedAt),
    }));
}

export interface HandoverSummary {
  shiftId: string;
  conflicts: ConflictGroup[];
  carry: CumulativeCarry[];
  pending: PendingItem[];
  incomplete: boolean;
  reasons: string[];
}

export function buildSummary(db: DB, shiftId: string): HandoverSummary {
  const conflicts = shiftConflicts(db, shiftId);
  const carry = liveCarry(db, shiftId);
  const pending = pendingForShift(db, shiftId);
  const reasons: string[] = [];
  if (conflicts.length > 0) reasons.push(`待复核区有 ${conflicts.length} 组同一时点重复读数尚未裁决`);
  return { shiftId, conflicts, carry, pending, incomplete: reasons.length > 0, reasons };
}

// ---------- 旧台账迁移（断点续跑、幂等） ----------

function legacyTimestamps(label: string, anchorDate: string): string {
  const startH = shiftLabelToStart(label);
  return `${anchorDate}T${pad2(startH + 2)}:00`;
}

/** 迁移一个旧样例行；返回 true 表示本次实际推进了进度 */
export function migrateOneRow(station: Station, ctx: LocalContext): boolean {
  const db0 = loadDB(station);
  const mig = db0.migration;
  if (mig.status === "done" || mig.nextIndex >= LEGACY_ROWS.length) return false;

  // 首次启动：生成 runId 与船内锚点日期并立即落盘（中断后沿用）
  if (mig.status === "idle" || !mig.runId) {
    const snap = ensureLegacySnapshot();
    db0.migration = {
      ...mig,
      status: "running",
      runId: uid("run"),
      anchorDate: shipNow(ctx.offsetMin).slice(0, 10),
      nextIndex: 0,
      startedAt: new Date().toISOString(),
      snapshot: { savedAt: snap.savedAt, source: snap.source, rows: snap.rows },
    };
    saveDB(station, db0);
  }

  const m = loadDB(station).migration;
  const row = LEGACY_ROWS[m.nextIndex];
  if (!row) return false;
  const recordedAt = legacyTimestamps(row.shiftLabel, m.anchorDate);
  const shiftId = shiftIdAt(recordedAt);

  const base = {
    station,
    shiftId,
    device: row.device,
    recordedAt,
    createdBy: "旧台账自动迁移",
    note: `迁移自旧样例第 ${m.nextIndex + 1} 行（${row.shiftLabel}）`,
  };

  interface Planned {
    opId: string;
    action: OutOp["action"];
    payload: Record<string, unknown>;
  }
  const planned: Planned[] = [];

  // 读数列：能解析出数值的转参数读数，其余作为异常/备注
  const rpm = row.reading.match(/转速\s*([\d.]+)\s*rpm/);
  const oil = row.reading.match(/滑油压力\s*([\d.]+)\s*MPa/);
  const temp = row.reading.match(/水温[^\d]*([\d.]+)\s*℃?/);

  if (rpm) {
    planned.push({
      opId: `oplg_${m.runId}_${m.nextIndex}_rpm`,
      action: "INSERT_ENTRY",
      payload: {
        entry: {
          ...base,
          id: `lg_${m.runId}_${m.nextIndex}_rpm`,
          entryType: "parameter",
          metric: "主机转速",
          value: Number(rpm[1]),
          unit: "rpm",
          isCumulative: false,
          note: oil ? `${base.note}；另载滑油压力见同条原始文本` : base.note,
          createdAt: new Date().toISOString(),
          addenda: [],
          status: "recorded",
          legacy: { runId: m.runId, rowIndex: m.nextIndex, raw: row.reading },
        } satisfies Entry,
      },
    });
  }
  if (oil) {
    planned.push({
      opId: `oplg_${m.runId}_${m.nextIndex}_oil`,
      action: "INSERT_ENTRY",
      payload: {
        entry: {
          ...base,
          id: `lg_${m.runId}_${m.nextIndex}_oil`,
          entryType: "parameter",
          metric: "滑油压力",
          value: Number(oil[1]),
          unit: "MPa",
          isCumulative: false,
          createdAt: new Date().toISOString(),
          addenda: [],
          status: "recorded",
          legacy: { runId: m.runId, rowIndex: m.nextIndex, raw: row.reading },
        } satisfies Entry,
      },
    });
  }
  if (temp) {
    planned.push({
      opId: `oplg_${m.runId}_${m.nextIndex}_temp`,
      action: "INSERT_ENTRY",
      payload: {
        entry: {
          ...base,
          id: `lg_${m.runId}_${m.nextIndex}_temp`,
          entryType: "parameter",
          metric: "冷却水温",
          value: Number(temp[1]),
          unit: "℃",
          isCumulative: false,
          createdAt: new Date().toISOString(),
          addenda: [],
          status: "recorded",
          legacy: { runId: m.runId, rowIndex: m.nextIndex, raw: row.reading },
        } satisfies Entry,
      },
    });
  }

  const abnormalText = temp ? row.reading : rpm || oil ? "" : row.reading;
  if (abnormalText && abnormalText !== "正常巡检") {
    planned.push({
      opId: `oplg_${m.runId}_${m.nextIndex}_an`,
      action: "INSERT_ENTRY",
      payload: {
        entry: {
          ...base,
          id: `lg_${m.runId}_${m.nextIndex}_an`,
          entryType: "anomaly",
          description: abnormalText,
          severity: abnormalText.includes("警戒") ? "critical" : "watch",
          resolved: false,
          createdAt: new Date().toISOString(),
          addenda: [],
          status: "recorded",
          legacy: { runId: m.runId, rowIndex: m.nextIndex, raw: `${row.reading} / ${row.anomaly}` },
        } satisfies Entry,
      },
    });
  }

  // 处理状态列：作为补充说明挂在第一条记录上（旧数据不能伪造闭环）
  if (row.anomaly && row.anomaly !== "正常巡检") {
    const anchorId = planned[0] ? ((planned[0].payload.entry as Entry).id) : `lg_${m.runId}_${m.nextIndex}_note`;
    if (!planned[0]) {
      planned.push({
        opId: `oplg_${m.runId}_${m.nextIndex}_note`,
        action: "INSERT_ENTRY",
        payload: {
          entry: {
            ...base,
            id: anchorId,
            entryType: "anomaly",
            description: row.reading,
            severity: "watch",
            resolved: false,
            createdAt: new Date().toISOString(),
            addenda: [],
            status: "recorded",
            legacy: { runId: m.runId, rowIndex: m.nextIndex, raw: `${row.reading} / ${row.anomaly}` },
          } satisfies Entry,
        },
      });
    }
    planned.push({
      opId: `oplg_${m.runId}_${m.nextIndex}_add`,
      action: "ADD_ADDENDUM",
      payload: {
        targetId: anchorId,
        addendum: {
          id: `lga_${m.runId}_${m.nextIndex}`,
          by: "旧台账自动迁移",
          role: "engineer",
          at: new Date().toISOString(),
          text: `旧样例处理状态：${row.anomaly}（未经当班人确认，不作闭环）`,
        },
      },
    });
  }

  // 逐条幂等落库 + 出站队列（确定性 opId，关掉重开/双端重复执行都不会重复）
  const db = loadDB(station);
  const out = loadOutbox(station);
  const audits = loadAudit(station);
  let appliedAny = false;
  planned.forEach((pl) => {
    if (db.appliedOpIds.includes(pl.opId)) return;
    const op: OutOp = {
      opId: pl.opId,
      station,
      actor: "旧台账自动迁移",
      role: "engineer",
      at: new Date().toISOString(),
      shipTime: recordedAt,
      action: pl.action,
      payload: pl.payload,
    };
    if (applyOp(db, op)) {
      out.push({ op, synced: false });
      audits.push(auditFor(op, false));
      appliedAny = true;
    }
  });

  // 整行完成才推进游标，保证“已完成部分”与“续跑位置”一致
  db.migration = {
    ...db.migration,
    status: db.migration.nextIndex + 1 >= LEGACY_ROWS.length ? "done" : "running",
    nextIndex: db.migration.nextIndex + 1,
    finishedAt: db.migration.nextIndex + 1 >= LEGACY_ROWS.length ? new Date().toISOString() : db.migration.finishedAt,
  };
  saveDB(station, db);
  write(OUT_KEY(station), out);
  write(AUDIT_KEY(station), audits);
  return appliedAny || true;
}

export function migrationProgress(station: Station): DB["migration"] & { percent: number } {
  const m = loadDB(station).migration;
  return { ...m, percent: Math.round((m.nextIndex / Math.max(1, m.total)) * 100) };
}
