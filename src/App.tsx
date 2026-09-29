import { useState } from "react";
import { StoreProvider, useStore } from "./core/store";
import { ToastHost, RoleTag } from "./components/ui";
import WatchPage from "./components/WatchPage";
import ReviewPage from "./components/ReviewPage";
import HandoverPage from "./components/HandoverPage";
import HistoryPage from "./components/HistoryPage";
import AuditPage from "./components/AuditPage";
import SettingsPage from "./components/SettingsPage";
import { fmtDateTime } from "./core/time";

type Tab = "bridge" | "engine" | "review" | "handover" | "history" | "audit" | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "bridge", label: "驾驶台值班页" },
  { key: "engine", label: "机舱值班页" },
  { key: "review", label: "同步 / 待复核" },
  { key: "handover", label: "交接班" },
  { key: "history", label: "台账历史" },
  { key: "audit", label: "审计记录" },
  { key: "settings", label: "设置 / 迁移" },
];

function Shell() {
  const { state, dispatch, now } = useStore();
  const [tab, setTab] = useState<Tab>("engine");

  const pendingCount = state.conflicts.filter((c) => c.status === "pending").length;
  const unsynced = state.outbox.bridge.length + state.outbox.engine.length;
  const migrating = state.migration.phase !== "done";

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <h1>船舶双岗值班离线台账</h1>
          <p>驾驶台 × 机舱 · 断网双记 · 同步合并 · 复核拦截交班</p>
        </div>
        <div className="topbar-right">
          <div className="clock">
            <span>船内时间</span>
            <b>{fmtDateTime(now)}</b>
          </div>
          <button
            className={`net-switch ${state.online ? "is-online" : "is-offline"}`}
            onClick={() => dispatch({ type: "set-online", online: !state.online })}
            title="点击模拟断网 / 恢复联网"
          >
            <i className={`net-light ${state.online ? "online" : "offline"}`} />
            {state.online ? "链路在线" : "断网中"}
          </button>
          <div className="identity">
            <RoleTag role={state.role} />
            <span>{state.userName}</span>
          </div>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => {
          const badge =
            t.key === "review"
              ? pendingCount
              : (t.key === "bridge" || t.key === "engine")
                ? state.outbox[t.key].length
                : t.key === "settings"
                  ? migrating
                    ? "…"
                    : 0
                  : 0;
          return (
            <button
              key={t.key}
              className={`tab ${tab === t.key ? "active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {badge ? <span className="tab-badge">{badge}</span> : null}
              {t.key === "review" && pendingCount > 0 && <i className="tab-dot" />}
            </button>
          );
        })}
      </nav>

      {unsynced > 0 && (
        <div className="unsynced-strip">
          有 {unsynced} 条记录积压在岗位待发箱（断网双记中），恢复联网后按设备与记录时刻自动合并
        </div>
      )}

      <div className="tab-body">
        {tab === "bridge" && <WatchPage post="bridge" goPending={() => setTab("review")} />}
        {tab === "engine" && <WatchPage post="engine" goPending={() => setTab("review")} />}
        {tab === "review" && (
          <ReviewPage
            manualSync={() => {
              dispatch({ type: "sync" });
            }}
          />
        )}
        {tab === "handover" && <HandoverPage goReview={() => setTab("review")} />}
        {tab === "history" && <HistoryPage />}
        {tab === "audit" && <AuditPage />}
        {tab === "settings" && <SettingsPage />}
      </div>

      <footer className="footer">
        hxyfront-62001 · 数据仅存于本浏览器（localStorage）· 审计事件只增且带哈希链 · 后续可扩展船队统一同步
      </footer>
    </main>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <ToastHost>
        <Shell />
      </ToastHost>
    </StoreProvider>
  );
}
