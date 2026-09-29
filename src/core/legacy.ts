// 旧样例迁移：旧台账是无稳定编号的字符串数组，这里把每行归一化成新台账结构。
// 关键约束：
//  1. 行指纹稳定 —— 同一行永远算出同一个新记录 ID，中断重开不会产生重复记录；
//  2. 原数据整体另存（见 STORAGE_KEYS.legacySnapshot），迁移过程中绝不删改。

import type { AbnStatus, Reading } from "../types";
import { fingerprint } from "./hash";
import { shiftIdFromRecordedAt } from "./time";

/** 现有轮机页里的旧样例（原样保留，仅作为迁移源） */
export const LEGACY_ROWS: string[][] = [
  ["08-12班", "主机", "转速82rpm，滑油压力0.42MPa", "正常巡检"],
  ["12-16班", "发电机#2", "冷却水温偏高", "已安排复查"],
  ["16-20班", "舱底水", "液位接近警戒线", "已记录交班"],
];

const METRIC_PATTERNS: { name: string; unit: string; re: RegExp }[] = [
  { name: "主机转速", unit: "rpm", re: /转速\s*([\d.]+)\s*(?:rpm|r\/min)/i },
  { name: "滑油压力", unit: "MPa", re: /滑油压力\s*([\d.]+)\s*(mpa|kpa)/i },
  { name: "冷却水温", unit: "℃", re: /冷却水温\s*([\d.]+)\s*℃?/i },
  { name: "排气温度", unit: "℃", re: /排气温度\s*([\d.]+)\s*℃?/i },
  { name: "舱底水液位", unit: "m", re: /液位\s*([\d.]+)\s*m?/i },
  { name: "航速", unit: "kn", re: /航速\s*([\d.]+)\s*kn?/i },
];

const ABNORMAL_KEYWORDS = /偏|警戒|报警|异常|高|低|漏|泄|震|响|烟|故障/;

function parseReadings(text: string): Reading[] {
  const out: Reading[] = [];
  for (const p of METRIC_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      out.push({ name: p.name, value: m[1], unit: p.unit });
    }
  }
  return out;
}

function parseStatus(handling: string): { status: AbnStatus; carryOver: boolean } {
  if (/正常|巡检|已消除|已处理|恢复/.test(handling)) {
    return { status: /正常|巡检/.test(handling) ? "ok" : "done", carryOver: false };
  }
  return {
    status: "open",
    carryOver: /交班|遗留|复查|待|跟进|未/.test(handling),
  };
}

export interface ParsedLegacyRow {
  id: string;
  rowHash: string;
  equipment: string;
  recordedAt: string;
  shiftId: string;
  readings: Reading[];
  abnormality: string;
  handling: string;
  status: AbnStatus;
  carryOver: boolean;
}

/** 迁移锚定日期：旧样例没有日期，统一落在当前船内日期的前两天（属于已封存在班） */
function anchorDate(nowShipDate: string): string {
  const d = new Date(`${nowShipDate}T00:00:00`);
  d.setDate(d.getDate() - 2);
  return d.toISOString().slice(0, 10);
}

export function parseLegacyRow(row: string[], anchor: string): ParsedLegacyRow | null {
  if (row.length < 3) return null;
  const [shiftLabelRaw, equipment, text = "", handling = ""] = row;
  if (!equipment || !text) return null;

  const slot = /(\d{1,2})\s*-\s*\d{1,2}/.exec(shiftLabelRaw ?? "");
  const hour = slot ? Number(slot[1]) : 8;
  const recordedAt = `${anchor} ${String(hour).padStart(2, "0")}:30`;

  const readings = parseReadings(text);
  const abnormality = readings.length === 0 && ABNORMAL_KEYWORDS.test(text) ? text : "";
  const { status, carryOver } = parseStatus(handling);

  const rowHash = fingerprint({ row });
  return {
    id: `lg-${rowHash}`,
    rowHash,
    equipment,
    recordedAt,
    shiftId: shiftIdFromRecordedAt(recordedAt),
    readings,
    abnormality,
    handling,
    status,
    carryOver,
  };
}

export function migrationAnchor(nowShipDate: string): string {
  return anchorDate(nowShipDate);
}
