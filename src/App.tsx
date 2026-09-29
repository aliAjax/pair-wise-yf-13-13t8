import { useCallback, useEffect, useMemo, useState } from "react";
import "./styles.css";
import type { AuditEvent, DB, Station } from "./types";
import {
  buildSummary,
  findConflicts,
  loadAudit,
  loadDB,
  loadOutbox,
  loadSession,
  migrateOneRow,
  queueStats,
  saveSession,
  syncStations,
} from "./store";
import { shipNow, shiftIdAt, shiftLabel } from "./time";
import { EntryForm, stationName, type OpenAnomaly } from "./ui";
import { AuditTrail, ConflictZone, currentShiftId, EntryList, HandoverCard, MigrationBanner } from "./panels";

function initialStation(): Station {
  return window.location.hash === "#bridge" ? "bridge" : "engine";
}

export default function App() {
  const [station, setStation] = useState<Station>(initialStation);
  const session = loadSession();
  const [tick, setTick] = useState(0);
  const [autoMigrate, setAutoMigrate] = useState(true);
  const [syncMsg, setSyncMsg] = useState<string>("");
  const [shiftSel, setShiftSel] = useState<string>("");
  const [presetAnomaly, setPresetAnomaly] = useState<string | undefined>(undefined);

  const bump = useCallback(() => setTick((t) => t + 1), []);

  // 船内时钟节拍
  useEffect(() => {
    const timer = window.setInterval(bump, 15000);
    return () => window.clearInterval(timer);
  }, [bump]);

  // 对端标签页写入 localStorage 时即时反映（模拟链路事件）
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith("dlw.")) bump();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [bump]);

  // 路由式标签：#bridge / #engine，可在两个浏览器标签页同时打开模拟双岗
  useEffect(() => {
    const onHash = () => setStation(initialStation());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const db: DB = useMemo(() => loadDB(station), [station, tick]);
  const audits: AuditEvent[] = useMemo(() => loadAudit(station), [station, tick]);
  const q = queueStats(station);
  const nowShip = shipNow(session.offsetMin);
  const curShift = shiftIdAt(nowShip);
  const shiftId = shiftSel || curShift;

  // 迁移自动续跑（仅机舱侧执行，避免双端同时迁；同步后驾驶台获得同一份结果）
  useEffect(() => {
    if (station !== "engine" || !autoMigrate) return;
    const m = loadDB("engine").migration;
    if (m.status === "done") return;
    const timer = window.setTimeout(() => {
      const s = loadSession();
      const done = migrateOneRow("engine", {
        station: "engine",
        actor: s.profiles.engine.actor || "李轮机",
        role: s.profiles.engine.role,
        offsetMin: s.offsetMin,
      });
      if (done) bump();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [station, autoMigrate, tick, bump]);

  const ctx = {
    station,
    actor: session.profiles[station].actor || (station === "bridge" ? "张驾驶" : "李轮机"),
    role: session.profiles[station].role,
    offsetMin: session.offsetMin,
  };

  const conflicts = findConflicts(db);
  const summary = buildSummary(db, shiftId);
  const shiftExists = !!db.shifts[shiftId];

  const openAnomalies: OpenAnomaly[] = useMemo(
    () =>
      Object.values(db.entries)
        .filter((e) => e.entryType === "anomaly" && !e.resolved && e.status !== "void")
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
        .map((e) => ({
          id: e.id,
          station: e.station,
          device: e.device,
          description: e.description ?? "",
          recordedAt: e.recordedAt,
        })),
    [db]
  );

  function doSync() {
    if (!session.online.bridge || !session.online.engine) {
      setSyncMsg("⛔ 任一岗位断网，无法同步；两边继续各自离线记录，恢复后再合并。");
      return;
    }
    const r = syncStations();
    setSyncMsg(
      `✅ 同步合并完成：本岗并入 ${station === "engine" ? r.appliedHere : r.appliedThere} 条对端操作，共回放 ${r.mergedOps} 条，按 设备/参数/时刻 合并出 ${findConflicts(loadDB(station)).length} 组待复核。`
    );
    bump();
  }

  function patchProfile(patch: Partial<{ actor: string; role: "leader" | "engineer" }>) {
    saveSession({ profiles: { ...session.profiles, [station]: { ...session.profiles[station], ...patch } } });
    bump();
  }

  function toggleOnline(s: Station) {
    const next = !session.online[s];
    saveSession({ online: { ...session.online, [s]: next } });
    setSyncMsg(next ? `${stationName(s)} 已恢复在线，可执行同步合并。` : `${stationName(s)} 已断网，记录进入本地离线台账。`);
    bump();
  }

  function setOffset(v: number) {
    saveSession({ offsetMin: v });
    bump();
  }

  const knownShifts = useMemo(() => {
    const set = new Set<string>([curShift]);
    Object.keys(db.shifts).forEach((s) => set.add(s));
    Object.values(db.entries).forEach((e) => set.add(e.shiftId));
    return [...set].sort();
  }, [db, curShift]);

  const badgeFor = (s: Station): string => {
    const sdb = loadDB(s);
    const c = findConflicts(sdb).length;
    const pending = loadOutbox(s).filter((i) => !i.synced).length;
    return [c > 0 ? `复核${c}` : "", pending > 0 ? `待同步${pending}` : ""].filter(Boolean).join(" · ");
  };

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="kicker">双岗离线值班台账 · 驾驶台 × 机舱</p>
          <h1>船舶轮机值班记录</h1>
        </div>
        <div className="clock">
          <span>船内时间</span>
          <strong>{nowShip.replace("T", " ")}</strong>
          <label>
            时区修正
            <input
              type="number"
              step={30}
              value={session.offsetMin}
              onChange={(e) => setOffset(Number(e.target.value))}
            />
            分钟
          </label>
        </div>
      </header>

      <nav className="station-tabs">
        {(["bridge", "engine"] as Station[]).map((s) => (
          <a
            key={s}
            href={`#${s}`}
            className={s === station ? "tab-on" : ""}
            onClick={() => setShiftSel("")}
          >
            {stationName(s)}值班页
            {badgeFor(s) && <em className="tab-badge">{badgeFor(s)}</em>}
          </a>
        ))}
        <div className="net-controls">
          {(["bridge", "engine"] as Station[]).map((s) => (
            <button
              key={s}
              className={session.online[s] ? "net-on" : "net-off"}
              onClick={() => toggleOnline(s)}
              title="点击切换断网/联网"
            >
              {stationName(s)} {session.online[s] ? "🟢 在线" : "🔴 断网"}
            </button>
          ))}
          <button className="primary" onClick={doSync}>
            恢复在线 · 同步合并
          </button>
        </div>
      </nav>

      {syncMsg && <div className="sync-msg" onClick={() => setSyncMsg("")}>{syncMsg}（点击关闭）</div>}

      <section className="station-meta panel">
        <div>
          <span className="muted">当前值班员</span>
          <input value={session.profiles[station].actor} onChange={(e) => patchProfile({ actor: e.target.value })} />
        </div>
        <div>
          <span className="muted">权限角色</span>
          <select
            value={session.profiles[station].role}
            onChange={(e) => patchProfile({ role: e.target.value as "leader" | "engineer" })}
          >
            <option value="engineer">普通轮机员（仅可补说明）</option>
            <option value="leader">领导（复核后可修订封存记录）</option>
          </select>
        </div>
        <div className="queue-info">
          <span className="muted">出站队列</span>
          <b>{q.pending}</b> 条待同步 · <b>{q.synced}</b> 条已同步留底
          {!session.online[station] && <em className="offline-tag">本岗断网中，数据只写本地</em>}
        </div>
        <a className="open-tab" href={station === "engine" ? "#bridge" : "#engine"}>
          在另一标签页打开{stationName(station === "engine" ? "bridge" : "engine")}页 ↗
        </a>
      </section>

      <div className="shift-bar">
        <label>
          查看班次
          <select value={shiftId} onChange={(e) => setShiftSel(e.target.value)}>
            {knownShifts.map((s) => (
              <option key={s} value={s}>
                {s} {shiftLabel(s)}
                {db.shifts[s]?.sealed ? "（已封存）" : s === curShift ? "（当前班）" : ""}
              </option>
            ))}
          </select>
        </label>
        {shiftExists && <span className="sealed-chip">封存快照：累计 {db.shifts[shiftId].carry.length} 项 · 遗留 {db.shifts[shiftId].pending.length} 项</span>}
      </div>

      {station === "engine" && (
        <MigrationBanner
          station="engine"
          ctx={ctx}
          auto={autoMigrate}
          onToggleAuto={setAutoMigrate}
          onChanged={bump}
        />
      )}

      <HandoverCard db={db} summary={summary} ctx={ctx} onChanged={bump} />

      <ConflictZone db={db} ctx={ctx} conflicts={conflicts} onChanged={bump} />

      <section className="panel">
        <div className="heading">
          <div>
            <p>{stationName(station)}新增</p>
            <h2>参数 / 异常 / 处理结果</h2>
          </div>
        </div>
        <EntryForm
          ctx={ctx}
          shiftId={shiftId}
          shiftSealed={!!db.shifts[shiftId]?.sealed}
          onChanged={bump}
          presetAnomaly={presetAnomaly}
          openAnomalies={openAnomalies}
        />
      </section>

      {openAnomalies.length > 0 && (
        <section className="panel tone-danger">
          <div className="heading">
            <div>
              <p>未闭环异常（遗留事项，换班继续衔接）</p>
              <h2>{openAnomalies.length} 项待处理</h2>
            </div>
          </div>
          <div className="open-anoms">
            {openAnomalies.slice(0, 8).map((a) => (
              <button
                key={a.id}
                className="anom-chip"
                onClick={() => {
                  setPresetAnomaly(a.id);
                  document.querySelector(".entry-form")?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                {a.device}：{a.description} <small>（{a.recordedAt.replace("T", " ")}）→ 记处理结果</small>
              </button>
            ))}
          </div>
        </section>
      )}

      <EntryList db={db} ctx={ctx} onChanged={bump} />
      <AuditTrail audits={audits} />

      <footer className="foot-note">
        数据保存于浏览器本地（localStorage）。两岗断网各自记录、恢复在线后按操作日志全序合并；同设备/参数/同时刻两个读数进待复核区，
        未裁决前交班被拦住；封存记录仅领导可修订，轮机员只能补说明；每次变化均产生 append-only 审计。
        <button onClick={() => setTick((t) => t + 1)} hidden />
        <span className="mono">currentShift={currentShiftId(session.offsetMin)}</span>
      </footer>
    </main>
  );
}
