// 确定性伪随机数生成器（mulberry32）+ 采样助手
// 同一种子产生同一序列，保证运行可复现。

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** 按权重抽样，weights 与 items 等长 */
export function weighted<T>(rng: Rng, items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** 从 {值: 概率} 分布抽样 */
export function sampleMix(rng: Rng, mix: Record<string, number>): string {
  const keys = Object.keys(mix);
  return weighted(rng, keys, keys.map((k) => mix[k]));
}

/** 直方图抽样：按桶计数选桶，桶内均匀 */
export function sampleHist(rng: Rng, hist: { edges: number[]; counts: number[] }): number {
  const { edges, counts } = hist;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return edges[0];
  let r = rng() * total;
  let idx = 0;
  for (let i = 0; i < counts.length; i++) {
    r -= counts[i];
    if (r <= 0) { idx = i; break; }
    idx = i;
  }
  const lo = edges[idx];
  const hi = edges[idx + 1] ?? edges[idx] + 1;
  return lo + rng() * (hi - lo);
}

/** 正态（Box-Muller），用于时间抖动 */
export function gaussian(rng: Rng, mean: number, sd: number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
