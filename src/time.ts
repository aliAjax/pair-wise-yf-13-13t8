// 船内时钟：全船统一使用船内时间记录，跨时区只调整 offsetMin，历史时刻不改写
export const SHIFT_SLOTS = [0, 4, 8, 12, 16, 20];

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatShipTime(date: Date, offsetMin: number): string {
  const t = new Date(date.getTime() + offsetMin * 60000);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}T${pad2(
    t.getUTCHours()
  )}:${pad2(t.getUTCMinutes())}`;
}

export function shipNow(offsetMin: number): string {
  return formatShipTime(new Date(), offsetMin);
}

// YYYY-MM-DD
export function shipDate(shipIso: string): string {
  return shipIso.slice(0, 10);
}

export function slotIndexAt(shipIso: string): number {
  const h = Number(shipIso.slice(11, 13));
  return Math.min(5, Math.floor(h / 4));
}

export function shiftIdAt(shipIso: string): string {
  return `${shipDate(shipIso)}/${slotIndexAt(shipIso)}`;
}

export function shiftLabel(shiftId: string): string {
  const slot = Number(shiftId.split("/")[1]);
  const start = SHIFT_SLOTS[slot];
  return `${pad2(start)}-${pad2((start + 4) % 24)}班`;
}

// [船内起, 船内止)，20-24 班止为次日 00:00
export function shiftWindow(shiftId: string): [string, string] {
  const [date, slotRaw] = shiftId.split("/");
  const slot = Number(slotRaw);
  const startH = SHIFT_SLOTS[slot];
  const start = `${date}T${pad2(startH)}:00`;
  const endD = new Date(`${date}T00:00:00Z`);
  endD.setUTCDate(endD.getUTCDate() + (startH === 20 ? 1 : 0));
  const end = `${endD.toISOString().slice(0, 10)}T${pad2((startH + 4) % 24)}:00`;
  return [start, end];
}

export function inShift(shipIso: string, shiftId: string): boolean {
  const [start, end] = shiftWindow(shiftId);
  return shipIso >= start && shipIso < end;
}

export function uid(prefix = "id"): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}
