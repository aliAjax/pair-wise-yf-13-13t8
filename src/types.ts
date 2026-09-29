// 双岗离线台账的数据模型。所有业务数据只保存在浏览器本地（localStorage）。

export type Post = "bridge" | "engine"; // 驾驶台 / 机舱
export type Role = "leader" | "engineer"; // 值班领导 / 普通轮机员
export type AbnStatus = "ok" | "open" | "done"; // 正常 / 异常待处理 / 已处理

/** 一条参数读数 */
export interface Reading {
  name: string;
  value: string;
  unit: string;
}

/** 累计值增量（燃油消耗、运行工时等，换班后继续累加） */
export interface Delta {
  name: string;
  amount: number;
  unit: string;
}

/** 普通轮机员对已封存记录只能补说明 */
export interface Explanation {
  id: string;
  author: string;
  role: Role;
  text: string;
  at: string;
}

/** 可修订的数据部分（读数 / 异常 / 处理结果等） */
export interface RevData {
  readings: Reading[];
  abnormality: string;
  handling: string;
  status: AbnStatus;
  deltas: Delta[];
  carryOver: boolean;
}

export interface Revision {
  rev: number;
  at: string;
  by: string;
  reason: string;
  before: RevData;
  after: RevData;
}

/** 断网期间各岗位暂存在本机 outbox 的记录 */
export interface OutboxItem {
  id: string;
  post: Post;
  author: string;
  role: Role;
  equipment: string;
  /** 船内时间，精确到分钟：YYYY-MM-DD HH:mm */
  recordedAt: string;
  readings: Reading[];
  abnormality: string;
  handling: string;
  status: AbnStatus;
  deltas: Delta[];
  carryOver: boolean;
  createdAt: string;
}

/** 同步合并后的正式台账记录 */
export interface LedgerRecord extends RevData {
  id: string;
  equipment: string;
  recordedAt: string;
  /** YYYYMMDD#HH，字典序即时间序 */
  shiftId: string;
  /** 合并来源（可能双岗各一条） */
  sources: { post: Post; ref: string; author: string }[];
  /** 由无稳定编号的旧样例迁移而来 */
  legacy?: { shiftLabel: string; raw: string[] };
  explanations: Explanation[];
  revisions: Revision[];
  rev: number;
  createdAt: string;
  updatedAt: string;
}

/** 待复核区内一侧的读数快照 */
export interface SideSnapshot extends RevData {
  post: Post;
  ref: string;
  author: string;
}

export type ResolutionChoice = "a" | "b" | "avg" | "custom";

export interface Conflict {
  id: string;
  equipment: string;
  recordedAt: string;
  shiftId: string;
  a: SideSnapshot; // 先进入台账的一侧（合并基准）
  b: SideSnapshot; // 对碰出不同读数的另一侧
  status: "pending" | "resolved";
  resolution?: {
    at: string;
    by: string;
    choice: ResolutionChoice;
    basis: string;
    recordId: string;
  };
  createdAt: string;
}

export interface CarriedItem {
  id: string;
  equipment: string;
  text: string;
}

/** 交班时刻封存的班次快照（累计值与遗留事项据此衔接） */
export interface ShiftSnapshot {
  id: string;
  label: string;
  startAt: string;
  endAt: string;
  note: string;
  by: string;
  counters: Record<string, number>;
  carried: CarriedItem[];
}

export interface AuditActor {
  role: Role;
  name: string;
}

/** 只增审计事件，带 prevHash 哈希链，改写任一条都会导致校验断裂 */
export interface AuditEvent {
  seq: number;
  at: string;
  actor: AuditActor;
  action: string;
  target?: string;
  detail?: unknown;
  prevHash: string;
  hash: string;
}

export interface MigrationState {
  phase: "running" | "paused" | "done";
  total: number;
  /** 已迁移行的内容指纹（即新记录的稳定编号），断点续传 + 去重都靠它 */
  done: string[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** 迁移锚定的船内日期（旧样例没有日期，统一落在当前船内日期前两天） */
  anchorDate: string;
  /** 旧台账原样副本，迁移期间永不删除、不改写 */
  legacy: string[][];
  legacyPreservedAt: string;
}

export interface State {
  version: 2;
  seq: number;
  clientId: string;
  role: Role;
  userName: string;
  clockOffsetMin: number;
  online: boolean;
  voyageId: string;
  currentShiftId: string;
  shifts: ShiftSnapshot[];
  records: LedgerRecord[];
  conflicts: Conflict[];
  outbox: Record<Post, OutboxItem[]>;
  migration: MigrationState;
  audit: AuditEvent[];
}

export interface PostMeta {
  label: string;
  equipment: string[];
  metrics: { name: string; unit: string }[];
}

export const POST_META: Record<Post, PostMeta> = {
  bridge: {
    label: "驾驶台",
    equipment: ["车钟", "舵机", "罗经", "雷达/ARPA", "航行信号灯"],
    metrics: [
      { name: "航速", unit: "kn" },
      { name: "航向", unit: "°" },
      { name: "舵角", unit: "°" },
      { name: "车令", unit: "" },
      { name: "风速", unit: "kn" },
      { name: "风向", unit: "°" },
    ],
  },
  engine: {
    label: "机舱",
    equipment: ["主机", "发电机#1", "发电机#2", "泵组", "舱底水"],
    metrics: [
      { name: "主机转速", unit: "rpm" },
      { name: "滑油压力", unit: "MPa" },
      { name: "冷却水温", unit: "℃" },
      { name: "排气温度", unit: "℃" },
      { name: "舱底水液位", unit: "m" },
    ],
  },
};

/** 累计量口径：换班后按船内时间继续衔接 */
export const CUMULATIVES: { name: string; unit: string }[] = [
  { name: "燃油消耗", unit: "kg" },
  { name: "滑油消耗", unit: "L" },
  { name: "主机运行工时", unit: "h" },
];

export const ROLE_LABEL: Record<Role, string> = {
  leader: "值班领导",
  engineer: "普通轮机员",
};
