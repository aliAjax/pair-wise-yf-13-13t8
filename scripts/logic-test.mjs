// 临时逻辑测试：用 esbuild 把 TSX 编译到 Node，直接驱动 reducer。
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const reactStub = `
const ReactNS = {
  createContext: (v) => ({ Provider: () => null, _default: v }),
  useContext: () => null,
  useEffect: () => undefined,
  useMemo: (v) => v(),
  useReducer: () => [null, () => {}],
  useRef: (v) => ({ current: v }),
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
};
export default ReactNS;
export const createContext = ReactNS.createContext;
export const useContext = ReactNS.useContext;
export const useEffect = ReactNS.useEffect;
export const useMemo = ReactNS.useMemo;
export const useReducer = ReactNS.useReducer;
export const useRef = ReactNS.useRef;
export const useState = ReactNS.useState;
`;
writeFileSync("/tmp/_react_stub.cjs", reactStub);
writeFileSync(
  "/tmp/_react_jsx_stub.cjs",
  `module.exports = { jsx: (t, p) => [t, p], jsxs: (t, p) => [t, p], Fragment: "Fragment" };`
);

const result = await build({
  entryPoints: ["src/core/store.tsx"],
  bundle: true,
  format: "cjs",
  write: false,
  alias: {
    react: "/tmp/_react_stub.cjs",
    "react/jsx-runtime": "/tmp/_react_jsx_stub.cjs",
  },
  logLevel: "silent",
});
writeFileSync("/tmp/store.cjs", result.outputFiles[0].text);

// --- 浏览器环境桩 ---
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
globalThis.navigator = { onLine: true };
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn) => setTimeout(fn, 0),
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
};
let uuidCnt = 0;
Object.defineProperty(globalThis, "crypto", {
  value: { randomUUID: () => `uuid-${++uuidCnt}` },
  configurable: true,
});

const { reducer, initState, verifyAuditChain, signatureOf } = require("/tmp/store.cjs");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✔", msg);
  else {
    console.log("  ✗", msg);
    failures++;
  }
}
function run(state, action) {
  return reducer(state, action);
}

// ===== 1. 迁移：逐行、幂等、断点续传 =====
console.log("\n[1] 旧样例迁移");
let s = initState();
assert(s.migration.phase === "running" && s.migration.done.length === 0, "初始为迁移中、进度 0");
assert(mem.has("hxy62001:legacy-snapshot:v1"), "原数据已另存快照");
s = run(s, { type: "migration-tick" });
assert(s.migration.done.length === 1 && s.records.length === 1, "迁移第 1 行进台账");
const idAfter1 = s.records[0].id;
// 模拟中途被关掉：重开（从 localStorage 重新加载的语义用同一 state），再 tick 一行
s = run(s, { type: "migration-pause" });
assert(s.migration.phase === "paused", "暂停后状态为 paused");
s = run(s, { type: "migration-resume" });
s = run(s, { type: "migration-tick" });
s = run(s, { type: "migration-tick" });
assert(s.migration.phase === "done" && s.records.length === 3, "续传后 3 行全部迁完");
// 再来一轮 tick + 重置迁移列表去重：即使重复执行迁移步骤也不能重复
const ids = s.records.map((r) => r.id);
assert(new Set(ids).size === 3, "无重复记录（稳定编号）");
assert(s.records.every((r) => r.id.startsWith("lg-")), "迁移记录带确定性编号 lg-");
// 手动再 tick 不再产生任何东西
const before = s.records.length;
s = run(s, { type: "migration-tick" });
assert(s.records.length === before, "迁移完成后 tick 无副作用");
assert(verifyAuditChain(s.audit).ok, "审计链完整");

// 解析正确性抽查
const r0 = s.records.find((r) => r.equipment === "主机");
assert(r0.readings.some((x) => x.name === "主机转速" && x.value === "82"), "主机转速 82 解析正确");
assert(r0.status === "ok", "正常巡检状态 ok");
const r1 = s.records.find((r) => r.equipment === "发电机#2");
assert(r1.abnormality === "冷却水温偏高" && r1.status === "open" && r1.carryOver, "异常行进入待处理且标记遗留");
const r2 = s.records.find((r) => r.equipment === "舱底水");
assert(r2.status === "open" && r2.carryOver, "液位警戒行标记交班遗留");

// ===== 2. 离线双记 + 同步合并 =====
console.log("\n[2] 离线记录与同步合并");
s = run(s, { type: "set-online", online: false });
const t = "2099-01-01 10:00"; // 未来时刻，落在当前班次（手动指定时刻）
const itemBase = {
  author: "张三",
  role: "engineer",
  equipment: "舵机",
  recordedAt: t,
  abnormality: "",
  handling: "",
  status: "ok",
  carryOver: false,
  deltas: [],
};
s = run(s, { type: "add", item: { ...itemBase, post: "bridge", readings: [{ name: "舵角", value: "5", unit: "°" }] } });
s = run(s, { type: "add", item: { ...itemBase, post: "engine", readings: [{ name: "舵角", value: "5", unit: "°" }] } });
assert(s.outbox.bridge.length === 1 && s.outbox.engine.length === 1, "断网时两边都进了待发箱");
assert(s.records.length === 3, "离线期间正式台账不增加");
s = run(s, { type: "set-online", online: true });
assert(s.outbox.bridge.length === 0 && s.outbox.engine.length === 0, "联网后自动补传、清空待发箱");
const merged = s.records.find((r) => r.equipment === "舵机" && r.recordedAt === t);
assert(merged && merged.sources.length === 2, "同设备同时刻同读数 → 合并成一条，双来源");
assert(s.conflicts.length === 0, "一致读数不进待复核区");

// 同一条 outbox 被二次同步（模拟重放）：不会重复
s = run(s, { type: "set-online", online: false });
s = run(s, { type: "add", item: { ...itemBase, post: "bridge", readings: [{ name: "舵角", value: "5", unit: "°" }] } });
const replayId = s.outbox.bridge[0].id;
s = run(s, { type: "set-online", online: true });
assert(s.records.filter((r) => r.equipment === "舵机").length === 1, "再次同步同内容仍只有一条");
assert(
  s.records.find((r) => r.equipment === "舵机" && r.recordedAt === t).sources.find((x) => x.ref === replayId),
  "重复重放被来源去重吸收"
);

// ===== 3. 同一时点两个读数 → 待复核 =====
console.log("\n[3] 读数分歧 → 待复核 → 裁决");
s = run(s, { type: "set-online", online: false });
const t2 = "2099-01-01 10:04";
s = run(s, {
  type: "add",
  item: { ...itemBase, equipment: "主机", recordedAt: t2, post: "bridge", readings: [{ name: "主机转速", value: "80", unit: "rpm" }] },
});
s = run(s, {
  type: "add",
  item: { ...itemBase, equipment: "主机", recordedAt: t2, post: "engine", readings: [{ name: "主机转速", value: "86", unit: "rpm" }] },
});
s = run(s, { type: "set-online", online: true });
assert(s.conflicts.length === 1 && s.conflicts[0].status === "pending", "分歧进入待复核区");
const cid = s.conflicts[0].id;
// 轮机员不能裁决
s = run(s, { type: "set-identity", role: "engineer", name: "小李" });
const sDenied = run(s, { type: "resolve-conflict", id: cid, choice: "b", basis: "测试" });
assert(sDenied === s || sDenied.conflicts[0].status === "pending", "普通轮机员裁决被拒绝");
// 领导 avg 裁决
s = run(s, { type: "set-identity", role: "leader", name: "王船长" });
s = run(s, { type: "resolve-conflict", id: cid, choice: "avg", basis: "取双方平均值，已核对仪表" });
assert(s.conflicts[0].status === "resolved", "领导裁决后复核项关闭");
const fixed = s.records.find((r) => r.equipment === "主机" && r.recordedAt === t2);
assert(fixed.readings[0].value === "83", "平均裁决读数 83");
assert(fixed.sources.length === 2, "裁决后双来源都保留");

// 未填依据不能裁决：再造一个冲突
s = run(s, { type: "set-online", online: false });
const t3 = "2099-01-01 10:08";
s = run(s, { type: "add", item: { ...itemBase, equipment: "泵组", recordedAt: t3, post: "bridge", readings: [{ name: "压力", value: "0.4", unit: "MPa" }] } });
s = run(s, { type: "add", item: { ...itemBase, equipment: "泵组", recordedAt: t3, post: "engine", readings: [{ name: "压力", value: "0.5", unit: "MPa" }] } });
s = run(s, { type: "set-online", online: true });
const cid2 = s.conflicts.find((c) => c.status === "pending").id;
const noBasis = run(s, { type: "resolve-conflict", id: cid2, choice: "a", basis: "  " });
assert(noBasis.conflicts.find((c) => c.id === cid2).status === "pending", "复核依据必填");
s = run(s, { type: "resolve-conflict", id: cid2, choice: "a", basis: "以驾驶台船钟记录为准" });

// ===== 4. 待复核未处理 → 交班拦截 =====
console.log("\n[4] 交班拦截与接续");
// 测试记录都落在 2099-01-01 上午班次：把当前班次指到该班，交班才有遗留/增量语义
s = { ...s, currentShiftId: "20990101#08" };
// 再造一个不裁决冲突 + 把当前班次设为冲突所在班次
s = run(s, { type: "set-online", online: false });
const t4 = "2099-01-01 10:12";
s = run(s, { type: "add", item: { ...itemBase, equipment: "罗经", recordedAt: t4, post: "bridge", readings: [{ name: "航向", value: "90", unit: "°" }] } });
s = run(s, { type: "add", item: { ...itemBase, equipment: "罗经", recordedAt: t4, post: "engine", readings: [{ name: "航向", value: "95", unit: "°" }] } });
s = run(s, { type: "set-online", online: true });
const pendingBefore = s.conflicts.filter((c) => c.status === "pending").length;
assert(pendingBefore === 1, "存在 1 项未处理复核");
const blocked = run(s, { type: "handover", note: "" });
assert(blocked === s && blocked.shifts.length === s.shifts.length, "有待复核时交班被拦住");
s = run(s, { type: "blocked-handover" });
assert(s.audit.some((e) => e.action === "shift.handover-blocked"), "拦截动作写入审计");
// 离线未同步也拦
s = run(s, { type: "set-online", online: false });
s = run(s, { type: "add", item: { ...itemBase, equipment: "雷达/ARPA", recordedAt: "2099-01-01 10:16", post: "bridge", readings: [{ name: "航速", value: "12", unit: "kn" }] } });
const blockedOffline = run(s, { type: "handover", note: "" });
assert(blockedOffline === s, "有未同步记录时交班也被拦住");
s = run(s, { type: "set-online", online: true });
// 清掉冲突后交班成功：遗留事项 + 累计值衔接
const pcid = s.conflicts.find((c) => c.status === "pending").id;
s = run(s, { type: "resolve-conflict", id: pcid, choice: "b", basis: "以机舱复核为准" });
// 给本班加一条遗留 + 累计增量
s = run(s, {
  type: "add",
  item: {
    ...itemBase,
    equipment: "发电机#1",
    recordedAt: "2099-01-01 10:20",
    post: "engine",
    readings: [{ name: "冷却水温", value: "92", unit: "℃" }],
    abnormality: "冷却水温偏高",
    handling: "已安排复查",
    status: "open",
    carryOver: true,
    deltas: [{ name: "燃油消耗", amount: 120, unit: "kg" }],
  },
});
const shiftIdBefore = s.currentShiftId;
s = run(s, { type: "handover", note: "能见度下降，加强瞭望" });
assert(s.shifts.length === 1 && s.currentShiftId !== shiftIdBefore, "无阻塞时交班成功并进入下一班");
const snap = s.shifts[0];
assert(snap.counters["燃油消耗"] === 120, "班次快照累计值=120kg");
assert(snap.carried.length >= 1 && snap.carried.some((c) => c.equipment === "发电机#1"), "遗留事项进快照");
assert(verifyAuditChain(s.audit).ok, "交班后审计链仍完整");

// ===== 5. 权限：封存记录领导可改、轮机员只能补说明 =====
console.log("\n[5] 封存记录权限");
const legacy = s.records.find((r) => r.id === idAfter1);
s = run(s, { type: "set-identity", role: "engineer", name: "小李" });
const revDenied = run(s, {
  type: "revise-record",
  id: legacy.id,
  after: { ...legacy, readings: [{ name: "主机转速", value: "99", unit: "rpm" }] },
  reason: "乱改",
});
assert(revDenied === s || revDenied.records.find((r) => r.id === legacy.id).readings[0].value === "82", "轮机员不能修订");
s = run(s, { type: "explain-record", id: legacy.id, text: "现场补充：当时负荷平稳" });
const afterExplain = s.records.find((r) => r.id === legacy.id);
assert(afterExplain.explanations.length === 1 && afterExplain.readings[0].value === "82", "轮机员只能追加说明，读数不变");
s = run(s, { type: "set-identity", role: "leader", name: "王船长" });
const noReason = run(s, {
  type: "revise-record",
  id: legacy.id,
  after: {
    readings: [{ name: "主机转速", value: "83", unit: "rpm" }],
    abnormality: "",
    handling: "",
    status: "ok",
    deltas: [],
    carryOver: false,
  },
  reason: "  ",
});
assert(noReason.records.find((r) => r.id === legacy.id).rev === 1, "无修订原因被拒绝");
s = run(s, {
  type: "revise-record",
  id: legacy.id,
  after: {
    readings: [{ name: "主机转速", value: "83", unit: "rpm" }],
    abnormality: "",
    handling: "",
    status: "ok",
    deltas: [],
    carryOver: false,
  },
  reason: "复查仪表，原记录笔误",
});
const revised = s.records.find((r) => r.id === legacy.id);
assert(revised.rev === 2 && revised.readings[0].value === "83", "领导修订成功 v2");
assert(revised.revisions[0].before.readings[0].value === "82", "原值 82 保留在修订历史");
assert(revised.revisions[0].reason === "复查仪表，原记录笔误", "修订原因留痕");
assert(verifyAuditChain(s.audit).ok, "全部操作后审计链仍完整");
assert(s.audit.every((e, i, arr) => i === 0 || e.prevHash === arr[i - 1].hash), "prevHash 逐条链接");

// ===== 6. 审计链防篡改 =====
console.log("\n[6] 审计防篡改");
const tampered = { ...s, audit: s.audit.map((e, i) => (i === 3 ? { ...e, action: "evil" } : e)) };
const v = verifyAuditChain(tampered.audit);
assert(!v.ok && v.brokenAt === tampered.audit[3].seq, "改写任一历史事件 → 校验在该条断裂");

console.log(`\n${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
