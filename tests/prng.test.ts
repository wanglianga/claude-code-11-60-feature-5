import { describe, it, expect } from 'vitest';
import { mulberry32, sampleHist, sampleMix } from '../src/domain/prng';

describe('确定性随机数', () => {
  it('同一种子产生同一序列', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
  it('不同种子序列不同', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });
  it('直方图抽样落在桶范围内', () => {
    const rng = mulberry32(7);
    const hist = { edges: [0, 5, 10, 20], counts: [5, 10, 3] };
    for (let i = 0; i < 200; i++) {
      const v = sampleHist(rng, hist);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(20);
    }
  });
  it('分布抽样覆盖所有类别', () => {
    const rng = mulberry32(9);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(sampleMix(rng, { A: 0.5, B: 0.3, C: 0.2 }));
    expect(seen).toEqual(new Set(['A', 'B', 'C']));
  });
});
