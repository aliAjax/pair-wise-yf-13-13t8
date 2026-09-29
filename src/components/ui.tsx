import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { AbnStatus, Post } from "../types";
import { POST_META, ROLE_LABEL } from "../types";
import type { Role } from "../types";

// ---------------------------------------------------------------------------
// 轻提示
// ---------------------------------------------------------------------------

type ToastKind = "ok" | "warn" | "err";
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

const ToastCtx = createContext<(text: string, kind?: ToastKind) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

let toastSeq = 1;

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: ToastKind = "ok") => {
    const id = toastSeq++;
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// 通用展示件
// ---------------------------------------------------------------------------

export function PostTag({ post }: { post: Post }) {
  return <span className={`tag tag-${post}`}>{POST_META[post].label}</span>;
}

const STATUS: Record<AbnStatus, { text: string; cls: string }> = {
  ok: { text: "正常", cls: "ok" },
  open: { text: "异常待处理", cls: "warn" },
  done: { text: "已处理", cls: "ok" },
};

export function StatusTag({ status }: { status: AbnStatus }) {
  const s = STATUS[status];
  return <span className={`tag tag-status-${s.cls}`}>{s.text}</span>;
}

export function RoleTag({ role }: { role: Role }) {
  return <span className={`tag tag-role-${role}`}>{ROLE_LABEL[role]}</span>;
}

export function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className={`modal${wide ? " modal-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function fmtAuditAt(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}
