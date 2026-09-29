// 双岗离线台账端到端逻辑模拟（不依赖浏览器）
import assert from "node:assert";

async function main() {
  // ---- localStorage polyfill ----
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => void mem.delete(k),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
  };

  const store = await import("../src/store.ts");
  const {
    buildSummary,
    commitLocal,
    ensureLegacySnapshot,
    findConflicts,
    liveCarry,
    loadAudit,
    loadDB,
    migrateOneRow,
    migrationProgress,
    pendingForShift,
    syncStations,
  } = store;
  const { shiftIdAt, shiftWindow, shipNow } = await import("../src/time.ts");
  const { LEGACY_ROWS } = await import("../src/legacy.ts");

  const engineCtx = { station: "engine" as const, actor: "李轮机", role: "engineer" as const, offsetMin: 0 };
  const bridgeCtx = { station: "bridge" as const, actor: "张驾驶", role: "engineer" as const, offsetMin: 0 };
  const leaderCtx = { station: "engine" as const, actor: "王领导", role: "leader" as const, offsetMin: 0 };
  void liveCarry;

  // ========== 1. 迁移：逐行、中断、续跑、不重复 ==========
  {
    ensureLegacySnapshot();
    // 迁 1 行后"关闭"
    migrateOneRow("engine", engineCtx);
    const after1 = migrationProgress("engine");
    assert.equal(after1.nextIndex, 1, "迁移游标推进到1");
    const entriesAfter1 = Object.keys(loadDB("engine").entries).length;
    assert.ok(entriesAfter1 >= 1, "已完成部分已落库");

    // 重开后重复推进行（幂等：同 runId、确定性 opId，不应重复）
    migrateOneRow("engine", engineCtx);
    migrateOneRow("engine", engineCtx);
    const beforeClose = migrationProgress("engine");
    void beforeClose;
    const idsMid = Object.keys(loadDB("engine").entries);

    // 模拟再次打开页面：状态完全从 localStorage 恢复，继续迁完
    for (let i = 0; i < 10; i++) migrateOneRow("engine", engineCtx);
    const done = migrationProgress("engine");
    assert.equal(done.status, "done", "三行旧样例全部迁完");
    assert.equal(done.nextIndex, LEGACY_ROWS.length);

    const dbE = loadDB("engine");
    const allIds = Object.keys(dbE.entries);
    assert.equal(new Set(allIds).size, allIds.length, "无重复记录ID");
    idsMid.forEach((id) => assert.ok(dbE.entries[id], "中断前已完成数据保留"));
    const rpm = Object.values(dbE.entries).find((x) => x.legacy?.rowIndex === 0 && x.metric === "主机转速");
    assert.ok(rpm && rpm.value === 82, "旧样例转速82rpm正确迁移");
    assert.ok(done.snapshot && done.snapshot.rows.length === 3, "原始样例快照未改动并保留");
    console.log("✔ 迁移：断点续跑、幂等不重复、原件快照保留");
  }

  // ========== 2. 断网双岗各自记录 → 同步合并 → 冲突进待复核 ==========
  {
    const ship = shipNow(0);
    const shiftId = shiftIdAt(ship);
    const recordedAt = ship.slice(0, 14) + "05";

    commitLocal(engineCtx, "INSERT_ENTRY", {
      entry: {
        id: "e_rpm_82",
        station: "engine",
        entryType: "parameter",
        shiftId,
        device: "主机",
        recordedAt,
        createdAt: new Date().toISOString(),
        createdBy: "李轮机",
        status: "recorded",
        addenda: [],
        metric: "主机转速",
        value: 82,
        unit: "rpm",
        isCumulative: false,
      },
    });
    commitLocal(bridgeCtx, "INSERT_ENTRY", {
      entry: {
        id: "b_rpm_86",
        station: "bridge",
        entryType: "parameter",
        shiftId,
        device: "主机",
        recordedAt,
        createdAt: new Date().toISOString(),
        createdBy: "张驾驶",
        status: "recorded",
        addenda: [],
        metric: "主机转速",
        value: 86,
        unit: "rpm",
        isCumulative: false,
      },
    });

    assert.equal(findConflicts(loadDB("engine")).length, 0, "同步前机舱只有自己的读数");
    assert.equal(findConflicts(loadDB("bridge")).length, 0, "同步前驾驶台只有自己的读数");

    const rep = syncStations();
    assert.ok(rep.mergedOps >= 5, "双方操作全序合并");
    const dbAfter = loadDB("engine");
    assert.ok(dbAfter.entries["e_rpm_82"] && dbAfter.entries["b_rpm_86"], "两边记录都在，无丢失");

    const conf = findConflicts(dbAfter);
    assert.equal(conf.length, 1, "同一时点两个读数进入待复核区");
    assert.equal(conf[0].members.length, 2);

    commitLocal(engineCtx, "INSERT_ENTRY", {
      entry: {
        id: "e_oil_1",
        station: "engine",
        entryType: "parameter",
        shiftId,
        device: "主机",
        recordedAt,
        createdAt: new Date().toISOString(),
        createdBy: "李轮机",
        status: "recorded",
        addenda: [],
        metric: "滑油压力",
        value: 0.42,
        unit: "MPa",
        isCumulative: false,
      },
    });
    syncStations();
    assert.equal(findConflicts(loadDB("engine")).length, 1, "同刻但参数不同（转速vs油压）不算冲突");
    console.log("✔ 断网双记 → 同步按设备/参数/时刻合并，重复读数进待复核区");
  }

  // ========== 3. 未处理冲突拦住交班 ==========
  {
    const db = loadDB("engine");
    const shiftId = shiftIdAt(shipNow(0));
    let sum = buildSummary(db, shiftId);
    assert.equal(sum.incomplete, true, "摘要标出不完整");
    assert.ok(sum.reasons[0].includes("待复核"), "原因写明待复核未裁决");

    const conf = findConflicts(db)[0];
    commitLocal(leaderCtx, "RESOLVE_CONFLICT", {
      resolution: {
        key: conf.key,
        chosenId: "e_rpm_82",
        memberIds: ["e_rpm_82", "b_rpm_86"],
        by: "王领导",
        at: new Date().toISOString(),
        note: "以机舱集控仪表为准",
      },
    });
    syncStations();
    const db2 = loadDB("engine");
    assert.equal(db2.entries["b_rpm_86"].status, "superseded", "未采用读数标记为已被修订替代");
    assert.equal(findConflicts(db2).length, 0, "裁决后待复核清空");

    sum = buildSummary(db2, shiftId);
    assert.equal(sum.incomplete, false, "裁决后摘要完整，可以交班");
    console.log("✔ 待复核未处理前拦住交班，裁决后放行");
  }

  // ========== 4. 封存交班 + 累计值/遗留按船内时间衔接 ==========
  {
    const ship = shipNow(0);
    const shiftId = shiftIdAt(ship);
    commitLocal(engineCtx, "INSERT_ENTRY", {
      entry: {
        id: "e_fuel_32",
        station: "engine",
        entryType: "parameter",
        shiftId,
        device: "主机",
        recordedAt: ship.slice(0, 14) + "10",
        createdAt: new Date().toISOString(),
        createdBy: "李轮机",
        status: "recorded",
        addenda: [],
        metric: "燃油消耗",
        value: 32.5,
        unit: "t",
        isCumulative: true,
      },
    });
    commitLocal(engineCtx, "INSERT_ENTRY", {
      entry: {
        id: "e_anom_1",
        station: "engine",
        entryType: "anomaly",
        shiftId,
        device: "舱底水",
        recordedAt: ship.slice(0, 14) + "12",
        createdAt: new Date().toISOString(),
        createdBy: "李轮机",
        status: "recorded",
        addenda: [],
        description: "液位接近警戒线",
        severity: "critical",
        resolved: false,
      },
    });
    syncStations();

    const db = loadDB("engine");
    const s = buildSummary(db, shiftId);
    const [sStart, sEnd] = shiftWindow(shiftId);
    commitLocal(leaderCtx, "SEAL_SHIFT", {
      shiftId,
      start: sStart,
      end: sEnd,
      carry: s.carry,
      pending: s.pending,
    });
    syncStations();

    const db2 = loadDB("engine");
    assert.equal(db2.shifts[shiftId].sealed, true, "班次已封存");
    assert.equal(db2.entries["e_fuel_32"].status, "sealed", "班内记录随之封存");
    assert.ok(db2.shifts[shiftId].carry.some((c) => c.value === 32.5), "封存快照含累计值");
    assert.ok(db2.shifts[shiftId].pending.some((p) => p.id === "e_anom_1"), "封存快照含遗留异常");

    const [, endIso] = shiftWindow(shiftId);
    const nextShift = shiftIdAt(endIso + "01");
    const carryNext = liveCarry(db2, nextShift);
    assert.ok(carryNext.some((c) => c.metric === "燃油消耗" && c.value === 32.5), "换班后累计值按船内时间续上");
    const pendNext = pendingForShift(db2, nextShift);
    assert.ok(pendNext.some((p) => p.id === "e_anom_1"), "换班后遗留异常继续挂账");

    commitLocal(engineCtx, "RESOLVE_ANOMALY", { anomalyId: "e_anom_1" });
    commitLocal(engineCtx, "INSERT_ENTRY", {
      entry: {
        id: "e_handle_1",
        station: "engine",
        entryType: "handling",
        shiftId: nextShift,
        device: "舱底水",
        recordedAt: endIso + "10",
        createdAt: new Date().toISOString(),
        createdBy: "李轮机",
        status: "recorded",
        addenda: [],
        handlingResult: "启动舱底泵排水，液位回落",
        resolvesAnomalyId: "e_anom_1",
      },
    });
    syncStations();
    const db3 = loadDB("engine");
    assert.equal(db3.entries["e_anom_1"].resolved, true, "遗留异常在下一班闭环");
    assert.equal(pendingForShift(db3, nextShift).some((p) => p.id === "e_anom_1"), false, "闭环后不再挂遗留");
    console.log("✔ 封存交班：累计值与遗留事项按船内时间在下一班衔接、可闭环");
  }

  // ========== 5. 权限：轮机员补说明，领导修订封存，审计不可改写 ==========
  {
    const db0 = loadDB("engine");
    const sealedEntry = Object.values(db0.entries).find(
      (e) => e.status === "sealed" && e.entryType === "parameter" && e.id === "e_fuel_32"
    )!;
    assert.ok(sealedEntry, "存在已封存记录");

    commitLocal(engineCtx, "ADD_ADDENDUM", {
      targetId: sealedEntry.id,
      addendum: {
        id: "add_test_1",
        by: "李轮机",
        role: "engineer",
        at: new Date().toISOString(),
        text: "交班后复查仪表一致",
      },
    });
    syncStations();
    const db1 = loadDB("engine");
    assert.equal(db1.entries[sealedEntry.id].value, sealedEntry.value, "补说明不改原读数");
    assert.ok(db1.entries[sealedEntry.id].addenda.some((a) => a.id === "add_test_1"), "说明已追加");

    commitLocal(leaderCtx, "REVISE_ENTRY", {
      originalId: sealedEntry.id,
      entry: {
        ...db1.entries[sealedEntry.id],
        id: "rev_1",
        createdAt: new Date().toISOString(),
        addenda: [],
        value: 33.1,
        status: "recorded",
        createdBy: "王领导（复核修订）",
        note: "领导复核修订",
        revisionOf: sealedEntry.id,
      },
    });
    syncStations();
    const db2 = loadDB("engine");
    assert.equal(db2.entries[sealedEntry.id].status, "superseded", "原封存记录被标记替代（不删除）");
    assert.equal(db2.entries["rev_1"].status, "sealed", "修订版进入封存状态");
    assert.equal(db2.entries["rev_1"].revisionOf, sealedEntry.id, "修订链可追溯");

    const aud = loadAudit("engine");
    const actions = aud.map((a) => a.action);
    assert.ok(actions.includes("领导修订已封存记录"), "修订有审计");
    assert.ok(actions.includes("补充说明"), "补说明有审计");
    assert.ok(actions.includes("班次封存交班"), "封存交班有审计");
    assert.ok(actions.includes("待复核读数裁决"), "冲突裁决有审计");
    assert.ok(aud.every((a) => !!a.id && !!a.at && !!a.actor), "每条审计要素完整");
    console.log("✔ 权限分层 + 修订链 + append-only 审计齐全");
  }

  // ========== 6. 同步幂等：重复同步不产生重复 ==========
  {
    const before = Object.keys(loadDB("engine").entries).length;
    syncStations();
    syncStations();
    const after = Object.keys(loadDB("engine").entries).length;
    assert.equal(before, after, "多次同步不产生重复记录");
    const ops = loadDB("engine").appliedOpIds;
    assert.equal(new Set(ops).size, ops.length, "appliedOpIds 无重复");
    console.log("✔ 同步合并天然幂等");
  }

  console.log("\n全部场景通过 ✅");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
