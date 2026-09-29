// 船内时间工具：全船统一使用「船内时间」，允许相对系统时钟设置偏移（跨时区航行时调整）。

/** 当前船内时间（系统时间 + 偏移分钟） */
export function shipNow(offsetMin: number): Date {
  return new Date(Date.now() + offsetMin * 60000);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

export function fmtDateTimeSec(d: Date): string {
  return `${fmtDateTime(d)}:${pad(d.getSeconds())}`;
}

/** 把 Date 截断到分钟，得到记录时刻 "YYYY-MM-DD HH:mm" */
export function toMinute(d: Date): string {
  return fmtDateTime(d);
}

/** 班次：00-04 / 04-08 / 08-12 / 12-16 / 16-20 / 20-24，每 4 小时一班 */
export const WATCH_SLOTS = [0, 4, 8, 12, 16, 20] as const;

export function shiftIndex(hour: number): number {
  return Math.floor(hour / 4);
}

/** 班次编号 YYYYMMDD#HH，字典序即时间序 */
export function shiftIdOf(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}#${pad(
    shiftIndex(d.getHours()) * 4
  )}`;
}

export function shiftIdFromRecordedAt(recordedAt: string): string {
  const [date, time] = recordedAt.split(" ");
  const hour = Number((time ?? "00:00").slice(0, 2));
  return `${date.replaceAll("-", "")}#${pad(shiftIndex(hour) * 4)}`;
}

export function shiftLabel(id: string): string {
  const y = id.slice(0, 4);
  const m = id.slice(4, 6);
  const d = id.slice(6, 8);
  const h = Number(id.slice(9, 11));
  return `${y}-${m}-${d} ${pad(h)}:00–${pad((h + 4) % 24)}:00`;
}

/** 下一班编号（按 UTC 计算，避免本地时区换算误差） */
export function nextShiftId(id: string): string {
  const y = Number(id.slice(0, 4));
  const m = Number(id.slice(4, 6));
  const d = Number(id.slice(6, 8));
  const h = Number(id.slice(9, 11));
  const t = Date.UTC(y, m - 1, d, h + 4);
  const nd = new Date(t);
  return `${nd.getUTCFullYear()}${pad(nd.getUTCMonth() + 1)}${pad(nd.getUTCDate())}#${pad(
    nd.getUTCHours()
  )}`;
}

/** 班次起始时刻 "YYYY-MM-DD HH:mm" */
export function shiftStartAt(id: string): string {
  return `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)} ${id.slice(9, 11)}:00`;
}
