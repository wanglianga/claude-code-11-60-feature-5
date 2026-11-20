// 时间工具：统一使用 'YYYY-MM-DD HH:mm:ss' 本地时间与 epoch 毫秒互转。
// 关键约束：所有先后/重叠判断一律基于绝对毫秒，绝不按“当日时刻”比较，
// 因此跨午夜区间（如 23:50 -> 次日 00:20）不会被误判为日期倒序。

const FMT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function parseTs(s: string): number {
  if (!FMT.test(s)) throw new Error(`非法时间格式: ${s}`);
  return new Date(s.replace(' ', 'T')).getTime();
}

export function fmtTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export const MIN = 60_000;

export function minutesBetween(aMs: number, bMs: number): number {
  return (bMs - aMs) / MIN;
}

/** 区间重叠判断（绝对毫秒，跨午夜安全）：[s1,e1) 与 [s2,e2) */
export function intervalsOverlap(s1: number, e1: number, s2: number, e2: number): boolean {
  return s1 < e2 && s2 < e1;
}
