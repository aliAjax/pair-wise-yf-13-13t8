// 稳定编号与哈希链工具。
// FNV-1a 64bit（高/低 32 位拼接）用于旧样例行生成确定性 ID；
// 审计事件同样用它做哈希链（防篡改证据链，密码学级不可抵赖需后端 WORM 存储配合）。

/** 稳定序列化：对象键排序后输出，保证同一内容永远得到同一字符串 */
export function stableJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJSON(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJSON(obj[k])}`)
    .join(",")}}`;
}

const fnv1a = (str: string, offset: number, prime: number): number => {
  let h = offset >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, prime);
  }
  return h >>> 0;
};

/** FNV-1a 32bit */
export function hash32(input: string): string {
  return fnv1a(input, 0x811c9dc5, 0x01000193).toString(16).padStart(8, "0");
}

/** FNV-1a 64bit（两个 32 位用不同偏移，模拟 64 位哈希，足够本台账去重） */
export function hash64(input: string): string {
  const hi = fnv1a(input, 0x811c9dc5, 0x01000193);
  const lo = fnv1a(input, 0xcbf29ce4, 0x0000010b);
  return `${hi.toString(16).padStart(8, "0")}${lo.toString(16).padStart(8, "0")}`;
}

/** 内容指纹：旧样例行 / 同步对碰都按归一化内容计算 */
export function fingerprint(value: unknown): string {
  return hash64(stableJSON(value));
}

export function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
