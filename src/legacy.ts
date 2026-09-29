// 旧轮机页样例（无稳定编号），迁移时按 runId+行号幂等入册
export interface LegacyRow {
  shiftLabel: string;
  device: string;
  reading: string;
  anomaly: string;
}

export const LEGACY_ROWS: LegacyRow[] = [
  { shiftLabel: "08-12班", device: "主机", reading: "转速82rpm，滑油压力0.42MPa", anomaly: "正常巡检" },
  { shiftLabel: "12-16班", device: "发电机#2", reading: "冷却水温偏高", anomaly: "已安排复查" },
  { shiftLabel: "16-20班", device: "舱底水", reading: "液位接近警戒线", anomaly: "已记录交班" },
];

// 旧班次标签 → 船内时间锚点（日期取迁移运行日，时刻取班次中点）
export const SHIFT_LABELS = ["00-04", "04-08", "08-12", "12-16", "16-20", "20-24"] as const;

export function shiftLabelToStart(label: string): number {
  const m = label.match(/^(\d{2})-\d{2}/);
  return m ? Number(m[1]) : 0;
}

export const DEVICES = ["主机", "主机#2", "发电机#1", "发电机#2", "泵组", "舱底水"];
export const METRICS: { name: string; unit: string; cumulative?: boolean }[] = [
  { name: "主机转速", unit: "rpm" },
  { name: "滑油压力", unit: "MPa" },
  { name: "冷却水温", unit: "℃" },
  { name: "燃油消耗", unit: "t", cumulative: true },
];
