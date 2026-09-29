export type Station = "bridge" | "engine";
export type Role = "leader" | "engineer";
export type EntryType = "parameter" | "anomaly" | "handling";
export type EntryStatus = "recorded" | "sealed" | "superseded" | "void";
export type Severity = "watch" | "critical";

export interface Addendum {
  id: string;
  by: string;
  role: Role;
  at: string;
  text: string;
}

export interface LegacyMeta {
  runId: string;
  rowIndex: number;
  raw: string;
}

export interface Entry {
  id: string;
  station: Station;
  entryType: EntryType;
  shiftId: string;
  device: string;
  recordedAt: string; // 船内时间，精确到分 YYYY-MM-DDTHH:mm
  createdAt: string; // 实际写入时刻 ISO
  createdBy: string;
  status: EntryStatus;
  addenda: Addendum[];
  note?: string;
  // 参数读数
  metric?: string;
  value?: number;
  unit?: string;
  isCumulative?: boolean;
  // 异常
  description?: string;
  severity?: Severity;
  resolved?: boolean;
  resolvedBy?: string;
  // 处理结果
  handlingResult?: string;
  resolvesAnomalyId?: string;
  // 修订链 / 旧台账
  revisionOf?: string;
  legacy?: LegacyMeta;
}

export interface CumulativeCarry {
  key: string;
  device: string;
  metric: string;
  unit: string;
  value: number;
  entryId: string;
  recordedAt: string;
}

export interface PendingItem {
  id: string;
  device: string;
  description: string;
  severity?: Severity;
  recordedAt: string;
  fromShift: string;
}

export interface Shift {
  id: string; // YYYY-MM-DD/08
  start: string; // 船内时间
  end: string;
  sealed: boolean;
  sealedAt?: string;
  sealedBy?: string;
  sealedRole?: Role;
  carry: CumulativeCarry[];
  pending: PendingItem[];
}

export interface ConflictResolution {
  key: string;
  chosenId: string;
  memberIds: string[];
  by: string;
  at: string;
  note?: string;
}

export interface MigrationState {
  status: "idle" | "running" | "done";
  runId: string;
  anchorDate: string;
  total: number;
  nextIndex: number;
  startedAt?: string;
  finishedAt?: string;
  snapshot: { savedAt: string; source: string; rows: string[][] } | null;
}

export interface DB {
  entries: Record<string, Entry>;
  shifts: Record<string, Shift>;
  resolutions: Record<string, ConflictResolution>;
  appliedOpIds: string[];
  migration: MigrationState;
}

export interface AuditEvent {
  id: string;
  at: string;
  shipTime: string;
  actor: string;
  role: Role;
  station: Station | "local";
  action: string;
  targetId?: string;
  synced?: boolean;
  detail?: unknown;
}

export interface OutOp {
  opId: string;
  station: Station;
  actor: string;
  role: Role;
  at: string;
  shipTime: string;
  action:
    | "INSERT_ENTRY"
    | "ADD_ADDENDUM"
    | "RESOLVE_ANOMALY"
    | "RESOLVE_CONFLICT"
    | "REVISE_ENTRY"
    | "VOID_ENTRY"
    | "SEAL_SHIFT";
  payload: Record<string, unknown>;
}

export interface Session {
  clientId: string;
  actor: string;
  role: Role;
  offsetMin: number;
  online: Record<Station, boolean>;
}
