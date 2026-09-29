// jsdom 渲染冒烟：挂载 App，等待自动迁移，验证关键 UI 出现
import { JSDOM } from "jsdom";
import Module from "node:module";

// tsx 环境下把 CSS 导入打为空模块
(Module as unknown as { _extensions: Record<string, (m: unknown, f: string) => void> })._extensions[".css"] = (
  mod
) => {
  (mod as { exports: Record<string, string> }).exports = {};
};

async function main() {
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost:62001/#engine",
  pretendToBeVisual: true,
});

const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.localStorage = dom.window.localStorage;
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
g.cancelAnimationFrame = (id: number) => clearTimeout(id);

const errors: unknown[] = [];
dom.window.addEventListener("error", (e) => errors.push(e.error));
const originalConsoleError = console.error;
(g as { console?: unknown }).console = {
  ...console,
  error: (...a: unknown[]) => {
    originalConsoleError("[console.error]", ...a);
    errors.push(a.map(String).join(" "));
  },
};

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { default: App } = await import("../src/App.tsx");

const root = createRoot(dom.window.document.getElementById("root")!);
root.render(React.createElement(App));

await new Promise((r) => setTimeout(r, 1500)); // 等待迁移 2 行

const text = dom.window.document.body.textContent ?? "";
const checks = [
  "双岗离线值班台账",
  "机舱值班页",
  "交接班摘要",
  "待复核",
  "旧轮机页样例迁移",
  "不可改写审计记录",
  "主机转速",
  "燃油消耗",
];
for (const c of checks) {
  if (!text.includes(c)) throw new Error(`渲染结果缺少: ${c}`);
}
if (errors.length > 0) {
  console.error(errors);
  throw new Error("渲染过程有报错");
}

// 迁移进度应已推进
const dbRaw = dom.window.localStorage.getItem("dlw.db.engine")!;
const db = JSON.parse(dbRaw);
if (db.migration.nextIndex < 2) throw new Error("自动迁移未推进");

console.log("✔ React 渲染冒烟通过，关键区块齐全，迁移自动续跑正常");
root.unmount();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
