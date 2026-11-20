// 两条估计路径，估计同一个量：训练安排（交叉随机 vs 重复场景）
// 对“未见场景处置正确率”的影响（百分点，varied − repeat）。
//
// 路径 1 配对估计：在随机交叉数据上，对同一学员“练习场景家族 + 未见迁移题”
//   组成的成对练习，按场景家族分层做加权对比；学员必须完成成对记录才进入样本，
//   未完成成对练习会直接减少可用样本。假设少、口径直观，但一次只能吸收一个匹配层，
//   难以同时分离多个场景属性。
// 路径 2 层级反应模型：
//   logit(正确) = α + θ_i − b_f + β·varied + δ·transfer + γ·transfer·varied
//   θ_i 学员基线、b_f 场景难度带岭先验；β 为安排主效应（吸收练习阶段
//   因“重复记忆”造成的系统性差异）；δ 为迁移阶段主效应；
//   训练安排对未见场景正确率的总效应 = β + γ（同一学员在迁移阶段的差异）。
//   可处理不平衡与部分缺测，联合估计学员基线、场景难度与迁移表现，
//   但依赖模型结构，需做敏感性检查。始终按学员聚类。

import type {
  ArrangementPrediction,
  CalibrationDataset,
  CalibrationExclusions,
  CalibrationReport,
  EffectEstimate,
  EstimatorPath,
  ObservedAttempt,
  ScenarioCalibrationRow,
  SensitivityRow
} from './types';
import { ARRANGEMENT_LABELS } from './types';
import {
  buildIndex,
  buildObservations,
  computeDiagnostics,
  computeExclusions,
  isEligibleTransfer,
  traineeTransferMeans
} from './data';
import { hashObject } from '../hash';
import { mulberry32, type Rng } from '../prng';

const PAIRED_BOOTSTRAP = 400;
const HIER_BOOTSTRAP = 80;
const HIER_ITERS = 360;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}
function logit(p: number): number {
  const c = Math.min(0.999, Math.max(0.001, p));
  return Math.log(c / (1 - c));
}
function pct(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[idx];
}

// ============================================================
// 配对估计
// ============================================================

interface PairedUnit {
  traineeId: string;
  arrangement: 'varied' | 'repeat';
  familyKey: string;
  correctness: number; // 该学员在该家族的迁移正确率（0..1）
}

/**
 * 构建成对单元：只保留“练习过该家族 + 有可用未见迁移题”的学员，
 * 每个 (学员, 场景家族) 一个单元，迁移题多次作答先按学员聚合。
 */
function pairedUnits(obs: ObservedAttempt[], epoch: string): PairedUnit[] {
  const practiceFamilies = new Map<string, Set<string>>();
  for (const o of obs) {
    if (o.phase !== 'practice' || o.epoch !== epoch) continue;
    const set = practiceFamilies.get(o.traineeId) ?? new Set<string>();
    set.add(o.familyKey);
    practiceFamilies.set(o.traineeId, set);
  }
  const grouped = new Map<string, ObservedAttempt[]>();
  for (const o of obs) {
    if (o.epoch !== epoch || !isEligibleTransfer(o)) continue;
    if (!practiceFamilies.get(o.traineeId)?.has(o.familyKey)) continue; // 未完成成对练习
    const key = `${o.traineeId}|${o.familyKey}`;
    const arr = grouped.get(key) ?? [];
    arr.push(o);
    grouped.set(key, arr);
  }
  const out: PairedUnit[] = [];
  for (const arr of grouped.values()) {
    out.push({
      traineeId: arr[0].traineeId,
      arrangement: arr[0].arrangement,
      familyKey: arr[0].familyKey,
      correctness: mean(arr.map((o) => (o.correct ? 1 : 0)))
    });
  }
  return out;
}

function pairedEffectFromUnits(
  units: PairedUnit[],
  families: { varied: Set<string>; repeat: Set<string> },
  picks?: { varied: string[]; repeat: string[] }
): { effect: number; usedFamilies: number } | null {
  const variedIds = new Set(picks?.varied ?? [...families.varied]);
  const repeatIds = new Set(picks?.repeat ?? [...families.repeat]);
  const byFam = new Map<string, { v: number[]; r: number[] }>();
  for (const u of units) {
    if (u.arrangement === 'varied' && !variedIds.has(u.traineeId)) continue;
    if (u.arrangement === 'repeat' && !repeatIds.has(u.traineeId)) continue;
    const g = byFam.get(u.familyKey) ?? { v: [], r: [] };
    if (u.arrangement === 'varied') g.v.push(u.correctness);
    else g.r.push(u.correctness);
    byFam.set(u.familyKey, g);
  }
  let num = 0;
  let den = 0;
  let used = 0;
  for (const g of byFam.values()) {
    if (g.v.length === 0 || g.r.length === 0) continue;
    const w = (g.v.length * g.r.length) / (g.v.length + g.r.length);
    num += w * (mean(g.v) - mean(g.r));
    den += w;
    used++;
  }
  if (den === 0) return null;
  return { effect: (num / den) * 100, usedFamilies: used };
}

function estimatePaired(
  dataset: CalibrationDataset,
  obs: ObservedAttempt[],
  epoch: string,
  seedBase: number
): { estimate: EffectEstimate; units: PairedUnit[] } {
  const units = pairedUnits(obs, epoch);
  const families = { varied: new Set<string>(), repeat: new Set<string>() };
  for (const u of units) {
    if (u.arrangement === 'varied') families.varied.add(u.traineeId);
    else families.repeat.add(u.traineeId);
  }
  const traineeIds = new Set([...families.varied, ...families.repeat]);
  const base = pairedEffectFromUnits(units, families);
  const usedObs = obs.filter(
    (o) => o.epoch === epoch && isEligibleTransfer(o) && traineeIds.has(o.traineeId)
  ).length;

  if (!base) {
    return {
      estimate: {
        path: 'paired',
        epoch,
        effectPP: NaN,
        ci95: [NaN, NaN],
        ciMethod: `学员聚类自助法 ${PAIRED_BOOTSTRAP} 次（无可用成对单元）`,
        logitEffect: null,
        oddsRatio: null,
        nTrainees: traineeIds.size,
        nObservations: usedObs,
        independence: '以学员为独立单位；重复尝试先聚合',
        note: '两侧缺少同场景家族的成对练习，无法给出配对估计'
      },
      units
    };
  }

  // 学员聚类自助法：在每个安排组内重抽学员（保留其全部家族单元）。
  // 对被重复抽中的学员做克隆重命名，确保每次抽取都作为独立聚类计数。
  const rng = mulberry32((seedBase ^ 0xa5a5) >>> 0);
  const variedIds = [...families.varied];
  const repeatIds = [...families.repeat];
  const unitsByTrainee = new Map<string, PairedUnit[]>();
  for (const u of units) {
    const arr = unitsByTrainee.get(u.traineeId) ?? [];
    arr.push(u);
    unitsByTrainee.set(u.traineeId, arr);
  }
  const draw = (ids: string[], tag: string): { units: PairedUnit[]; ids: Set<string> } => {
    const out: PairedUnit[] = [];
    const outIds = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[Math.floor(rng() * ids.length)];
      const clone = `${id}#${tag}${i}`;
      outIds.add(clone);
      for (const u of unitsByTrainee.get(id) ?? []) out.push({ ...u, traineeId: clone });
    }
    return { units: out, ids: outIds };
  };
  const reps: number[] = [];
  if (variedIds.length >= 2 && repeatIds.length >= 2) {
    for (let b = 0; b < PAIRED_BOOTSTRAP; b++) {
      const dv = draw(variedIds, 'v');
      const dr = draw(repeatIds, 'r');
      const res = pairedEffectFromUnits([...dv.units, ...dr.units], { varied: dv.ids, repeat: dr.ids });
      if (res) reps.push(res.effect);
    }
  }
  const valid = reps.length >= Math.max(40, PAIRED_BOOTSTRAP * 0.6);
  const ci: [number, number] = valid ? [pct(reps, 0.025), pct(reps, 0.975)] : [NaN, NaN];

  return {
    estimate: {
      path: 'paired',
      epoch,
      effectPP: base.effect,
      ci95: ci,
      ciMethod: valid
        ? `学员聚类自助法 ${PAIRED_BOOTSTRAP} 次（百分位 95% 区间）`
        : `自助法有效重抽不足（${reps.length}/${PAIRED_BOOTSTRAP}），区间不可靠`,
      logitEffect: null,
      oddsRatio: null,
      nTrainees: traineeIds.size,
      nObservations: usedObs,
      independence: '以学员为独立单位：同一学员多次作答先聚合，成对单元再按场景家族加权',
      note: `按场景家族分层的加权配对对比；有效场景家族 ${base.usedFamilies} 个；未完成成对练习的学员不进入样本`
    },
    units
  };
}

// ============================================================
// 层级反应模型
// ============================================================

interface LogitObs {
  trainee: number;
  family: number;
  transfer: number;
  varied: number;
  y: number;
}

interface FitResult {
  alpha: number;
  beta: number;
  delta: number;
  gamma: number;
  theta: number[];
  b: number[];
  nTrainees: number;
  nFamilies: number;
}

function fitHierarchical(params: LogitObs[], nTrainees: number, nFamilies: number, lambda: number, iters = HIER_ITERS): FitResult {
  const theta = new Array(nTrainees).fill(0);
  const b = new Array(nFamilies).fill(0);
  let alpha = 0;
  let beta = 0;
  let delta = 0;
  let gamma = 0;
  // Adam
  const mT = new Array(nTrainees).fill(0), vT = new Array(nTrainees).fill(0);
  const mB = new Array(nFamilies).fill(0), vB = new Array(nFamilies).fill(0);
  let mA = 0, vA = 0, mBe = 0, vBe = 0, mD = 0, vD = 0, mG = 0, vG = 0;
  const lr = 0.08, beta1 = 0.9, beta2 = 0.999, eps = 1e-8;
  const N = Math.max(1, params.length);
  // 弱正则只作用于总体效应，避免把练习/迁移差异直接吸进随机效应
  const weak = 1e-4;
  for (let t = 1; t <= iters; t++) {
    const gT = new Array(nTrainees).fill(0);
    const gB = new Array(nFamilies).fill(0);
    let gA = 0, gBe = 0, gD = 0, gG = 0;
    for (const o of params) {
      const z = alpha + theta[o.trainee] - b[o.family] + beta * o.varied + delta * o.transfer + gamma * o.transfer * o.varied;
      const g = sigmoid(z) - o.y;
      gT[o.trainee] += g;
      gB[o.family] -= g;
      gA += g;
      gBe += g * o.varied;
      if (o.transfer) { gD += g; gG += g * o.varied; }
    }
    // 平均似然梯度 + 岭先验；岭惩罚按“求和尺度”折算为 /N，
    // 避免在均值似然下惩罚过强、把场景难度过度收缩到 0。
    for (let i = 0; i < nTrainees; i++) gT[i] = gT[i] / N + (lambda / N) * theta[i];
    for (let f = 0; f < nFamilies; f++) gB[f] = gB[f] / N + (lambda / N) * b[f];
    gA /= N;
    gBe = gBe / N + weak * beta;
    gD = gD / N + weak * delta;
    gG = gG / N + weak * gamma;

    const b1c = 1 - Math.pow(beta1, t);
    const b2c = 1 - Math.pow(beta2, t);
    const step = (m: number, v: number, g: number) => {
      const mm = beta1 * m + (1 - beta1) * g;
      const vv = beta2 * v + (1 - beta2) * g * g;
      const upd = lr * (mm / b1c) / (Math.sqrt(vv / b2c) + eps);
      return { m: mm, v: vv, upd };
    };
    for (let i = 0; i < nTrainees; i++) {
      const s = step(mT[i], vT[i], gT[i]); mT[i] = s.m; vT[i] = s.v; theta[i] -= s.upd;
    }
    for (let f = 0; f < nFamilies; f++) {
      const s = step(mB[f], vB[f], gB[f]); mB[f] = s.m; vB[f] = s.v; b[f] -= s.upd;
    }
    let s = step(mA, vA, gA); mA = s.m; vA = s.v; alpha -= s.upd;
    s = step(mBe, vBe, gBe); mBe = s.m; vBe = s.v; beta -= s.upd;
    s = step(mD, vD, gD); mD = s.m; vD = s.v; delta -= s.upd;
    s = step(mG, vG, gG); mG = s.m; vG = s.v; gamma -= s.upd;

    // 可识别性约束：θ 与 b 分别零均值（α 吸收平移）
    const mt = mean(theta);
    if (mt !== 0) for (let i = 0; i < nTrainees; i++) theta[i] -= mt;
    const mb = mean(b);
    if (mb !== 0) for (let f = 0; f < nFamilies; f++) b[f] -= mb;
  }
  return { alpha, beta, delta, gamma, theta, b, nTrainees, nFamilies };
}

interface Encoded {
  params: LogitObs[];
  traineeIndex: Map<string, number>;
  familyIndex: Map<string, number>;
  traineeIds: string[];
  familyKeys: string[];
}

function encode(obs: ObservedAttempt[], opts: { includeLeaked?: boolean; includeSeen?: boolean; completeCaseOnly?: boolean } = {}): Encoded {
  const filtered = obs.filter((o) => {
    if (o.phase === 'practice') return true;
    if (o.answerExposed && !opts.includeLeaked) return false;
    if (o.instanceSeen && !opts.includeSeen) return false;
    if (o.withdrew) return false;
    return true;
  });
  let rows = filtered;
  if (opts.completeCaseOnly) {
    const hasPractice = new Set(filtered.filter((o) => o.phase === 'practice').map((o) => o.traineeId));
    const hasTransfer = new Set(filtered.filter((o) => o.phase === 'transfer').map((o) => o.traineeId));
    const keep = new Set([...hasPractice].filter((id) => hasTransfer.has(id)));
    rows = filtered.filter((o) => keep.has(o.traineeId));
  }
  const traineeIds = [...new Set(rows.map((o) => o.traineeId))];
  const familyKeys = [...new Set(rows.map((o) => o.familyKey))];
  const ti = new Map(traineeIds.map((id, i) => [id, i]));
  const fi = new Map(familyKeys.map((k, i) => [k, i]));
  const params: LogitObs[] = rows.map((o) => ({
    trainee: ti.get(o.traineeId)!,
    family: fi.get(o.familyKey)!,
    transfer: o.phase === 'transfer' ? 1 : 0,
    varied: o.arrangement === 'varied' ? 1 : 0,
    y: o.correct ? 1 : 0
  }));
  return { params, traineeIndex: ti, familyIndex: fi, traineeIds, familyKeys };
}

/** 平均边际效应：对每位学员 × 每个场景家族，比较 varied 与 repeat 的预测正确率 */
function modelEffectPP(fit: FitResult, enc: Encoded, epochFamilies: string[], epochTrainees: string[]): number {
  const fams = epochFamilies.map((k) => enc.familyIndex.get(k)).filter((x): x is number => x !== undefined);
  const trs = epochTrainees.map((id) => enc.traineeIndex.get(id)).filter((x): x is number => x !== undefined);
  if (!fams.length || !trs.length) return NaN;
  let sum = 0;
  let n = 0;
  for (const i of trs) {
    for (const f of fams) {
      const zr = fit.alpha + fit.theta[i] - fit.b[f] + fit.delta;
      const zv = zr + fit.beta + fit.gamma;
      sum += sigmoid(zv) - sigmoid(zr);
      n++;
    }
  }
  return n ? (sum / n) * 100 : NaN;
}

function arrangementMeans(
  fit: FitResult,
  enc: Encoded,
  epochFamilies: string[],
  epochTrainees: string[]
): { varied: number; repeat: number } {
  const fams = epochFamilies.map((k) => enc.familyIndex.get(k)).filter((x): x is number => x !== undefined);
  const trs = epochTrainees.map((id) => enc.traineeIndex.get(id)).filter((x): x is number => x !== undefined);
  if (!fams.length || !trs.length) return { varied: NaN, repeat: NaN };
  let sv = 0, sr = 0, n = 0;
  for (const i of trs) {
    for (const f of fams) {
      const z = fit.alpha + fit.theta[i] - fit.b[f] + fit.delta;
      sr += sigmoid(z);
      sv += sigmoid(z + fit.beta + fit.gamma);
      n++;
    }
  }
  return { varied: (sv / n) * 100, repeat: (sr / n) * 100 };
}

function estimateHierarchical(
  dataset: CalibrationDataset,
  obs: ObservedAttempt[],
  epoch: string,
  lambda: number,
  seedBase: number,
  variant: { includeLeaked?: boolean; includeSeen?: boolean; completeCaseOnly?: boolean; boot?: boolean } = {}
): { estimate: EffectEstimate; fit: FitResult; enc: Encoded; ciPredictions: { varied: number[]; repeat: number[] } } {
  const epObs = obs.filter((o) => o.epoch === epoch);
  const enc = encode(epObs, variant);
  const fit = fitHierarchical(enc.params, enc.traineeIds.length, enc.familyKeys.length, lambda);
  const epochFamilies = dataset.families.filter((f) => f.epoch === epoch).map((f) => f.key);
  const epochTrainees = [...new Set(epObs.map((o) => o.traineeId))];
  const effect = modelEffectPP(fit, enc, epochFamilies, epochTrainees);
  const means = arrangementMeans(fit, enc, epochFamilies, epochTrainees);

  // 学员聚类自助法
  const rng: Rng = mulberry32((seedBase ^ 0x51ed) >>> 0);
  const reps: number[] = [];
  const pv: number[] = [];
  const pr: number[] = [];
  const transferTrainees = epochTrainees.filter((id) =>
    epObs.some((o) => o.traineeId === id && (o.phase === 'practice' || isEligibleTransfer(o)))
  );
  const canBoot = (variant.boot ?? true) && transferTrainees.length >= 4;
  if (canBoot) {
    for (let r = 0; r < HIER_BOOTSTRAP; r++) {
      const picked: string[] = [];
      for (let i = 0; i < transferTrainees.length; i++) picked.push(transferTrainees[Math.floor(rng() * transferTrainees.length)]);
      const idMap = new Map<string, string>();
      picked.forEach((id, i) => idMap.set(id, `${id}#${i}`));
      const bootObs: ObservedAttempt[] = [];
      for (const id of picked) {
        const clone = idMap.get(id)!;
        for (const o of epObs) {
          if (o.traineeId !== id) continue;
          bootObs.push({ ...o, traineeId: clone });
        }
      }
      const bootEnc = encode(bootObs, variant);
      if (!bootEnc.params.length) continue;
      const bfit = fitHierarchical(bootEnc.params, bootEnc.traineeIds.length, bootEnc.familyKeys.length, lambda, Math.max(160, HIER_ITERS / 2));
      const e = modelEffectPP(bfit, bootEnc, epochFamilies, [...new Set(bootObs.map((o) => o.traineeId))]);
      if (Number.isFinite(e)) reps.push(e);
      const m = arrangementMeans(bfit, bootEnc, epochFamilies, [...new Set(bootObs.map((o) => o.traineeId))]);
      if (Number.isFinite(m.varied)) { pv.push(m.varied); pr.push(m.repeat); }
    }
  }
  const valid = reps.length >= Math.max(30, HIER_BOOTSTRAP * 0.6);
  const ci: [number, number] = valid ? [pct(reps, 0.025), pct(reps, 0.975)] : [NaN, NaN];

  return {
    estimate: {
      path: 'hierarchical',
      epoch,
      effectPP: effect,
      ci95: ci,
      ciMethod: valid ? `学员聚类自助法 ${HIER_BOOTSTRAP} 次（百分位 95% 区间）` : `自助法有效重抽不足（${reps.length}/${HIER_BOOTSTRAP}）`,
      logitEffect: fit.beta + fit.gamma,
      oddsRatio: Math.exp(fit.beta + fit.gamma),
      nTrainees: enc.traineeIds.length,
      nObservations: enc.params.length,
      independence: '以学员为聚类单位（θ_i 随机效应）；同一学员重复尝试不视为独立样本',
      note: `联合估计学员基线、场景难度与迁移项；正则 λ=${lambda}；${means.varied.toFixed(1)}% vs ${means.repeat.toFixed(1)}%（模型平均未见场景正确率）`
    },
    fit,
    enc,
    ciPredictions: { varied: pv, repeat: pr }
  };
}

// ============================================================
// 场景校准：难度与区分度
// ============================================================

function familyAccuracy(obs: ObservedAttempt[], epoch: string, familyKey: string, phase?: 'practice' | 'transfer'): number {
  const byT = new Map<string, number[]>();
  for (const o of obs) {
    if (o.epoch !== epoch || o.familyKey !== familyKey) continue;
    if (phase && o.phase !== phase) continue;
    if (o.phase === 'transfer' && !isEligibleTransfer(o)) continue;
    const arr = byT.get(o.traineeId) ?? [];
    arr.push(o.correct ? 1 : 0);
    byT.set(o.traineeId, arr);
  }
  return mean([...byT.values()].map(mean));
}

/** 区分度：该家族得分与学员其余家族得分（总分的留一法）的 Pearson 相关 */
function discriminationFor(obs: ObservedAttempt[], epoch: string, familyKey: string): number | null {
  // 以场景家族为条目、学员为观测：条目得分 = 该学员在该家族的平均正确率，
  // 与“该学员其余家族的平均得分”（留一法）求相关，即区分度。
  const perTrainee = new Map<string, Map<string, number[]>>();
  for (const o of obs) {
    if (o.epoch !== epoch) continue;
    if (o.phase === 'transfer' && !isEligibleTransfer(o)) continue;
    const m = perTrainee.get(o.traineeId) ?? new Map<string, number[]>();
    const arr = m.get(o.familyKey) ?? [];
    arr.push(o.correct ? 1 : 0);
    m.set(o.familyKey, arr);
    perTrainee.set(o.traineeId, m);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const m of perTrainee.values()) {
    const itemVals = m.get(familyKey);
    if (!itemVals) continue;
    const others: number[] = [];
    for (const [k, v] of m) if (k !== familyKey) others.push(mean(v));
    if (others.length === 0) continue;
    xs.push(mean(itemVals));
    ys.push(mean(others));
  }
  if (xs.length < 4 || sd(xs) === 0 || sd(ys) === 0) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function buildScenarioRows(
  dataset: CalibrationDataset,
  obs: ObservedAttempt[],
  mainPath: EstimatorPath,
  hierFits: Map<string, { fit: FitResult; enc: Encoded }>,
  seedBase: number
): ScenarioCalibrationRow[] {
  const rows: ScenarioCalibrationRow[] = [];
  for (const ep of dataset.epochs) {
    const h = hierFits.get(ep.key);
    for (const f of dataset.families.filter((x) => x.epoch === ep.key)) {
      const practiceAcc = familyAccuracy(obs, ep.key, f.key, 'practice');
      const practiceByT = new Set(
        obs.filter((o) => o.epoch === ep.key && o.familyKey === f.key && o.phase === 'practice').map((o) => o.traineeId)
      );
      const transferItems = new Set(
        obs.filter((o) => o.epoch === ep.key && o.familyKey === f.key && isEligibleTransfer(o)).map((o) => o.scenarioId)
      ).size;
      const repeated = obs.filter((o) => o.epoch === ep.key && o.familyKey === f.key && o.phase === 'practice').length -
        new Set(obs.filter((o) => o.epoch === ep.key && o.familyKey === f.key && o.phase === 'practice').map((o) => `${o.traineeId}|${o.scenarioId}`)).size;
      let difficulty: number;
      let source: EstimatorPath = mainPath;
      if (mainPath === 'hierarchical' && h) {
        const fi = h.enc.familyIndex.get(f.key);
        difficulty = fi !== undefined ? h.fit.b[fi] : logit(1 - practiceAcc);
      } else if (practiceByT.size >= 2) {
        difficulty = logit(1 - practiceAcc);
        source = 'paired';
      } else {
        difficulty = NaN;
        source = 'paired';
      }
      const discrimination = discriminationFor(obs, ep.key, f.key);
      let identifiability: ScenarioCalibrationRow['identifiability'];
      if (practiceByT.size < 2) identifiability = transferItems > 0 ? '仅迁移观测' : '样本不足';
      else if (practiceByT.size < 5 || (discrimination === null && transferItems < 5)) identifiability = '样本不足';
      else identifiability = '可估';
      rows.push({
        epoch: ep.key,
        familyKey: f.key,
        label: f.label,
        eventType: f.feature.eventType,
        chainPattern: f.feature.chainPattern,
        accuracy: practiceAcc,
        difficulty,
        discrimination,
        practiceTrainees: practiceByT.size,
        transferItems,
        repeatedAttempts: repeated,
        identifiability,
        source
      });
    }
  }
  return rows;
}

// ============================================================
// 敏感性检查
// ============================================================

function sensitivityForEpoch(
  dataset: CalibrationDataset,
  obs: ObservedAttempt[],
  epoch: string,
  lambda: number,
  seedBase: number,
  paired: { estimate: EffectEstimate; units: PairedUnit[] }
): SensitivityRow[] {
  const rows: SensitivityRow[] = [];
  const epObs = obs.filter((o) => o.epoch === epoch);
  const variants: { variant: string; opts: { includeLeaked?: boolean; includeSeen?: boolean; completeCaseOnly?: boolean }; finding: string }[] = [
    { variant: '含答案泄漏的迁移题', opts: { includeLeaked: true }, finding: '泄漏题不是泛化证据；若纳入会抬高效应，应排除' },
    { variant: '含练习过的迁移实例（非未见）', opts: { includeSeen: true }, finding: '练习过的实例测的是记忆，不是迁移；应排除' },
    { variant: '仅完整配对学员（有练习+迁移）', opts: { completeCaseOnly: true }, finding: '完整案例可减少缺测偏差，但样本更少、区间更宽' },
    { variant: '强正则（λ×4，压缩学员/场景随机效应）', opts: {}, finding: '区间稳定性检查；强正则下若效应显著收缩，说明依赖小样本随机效应' }
  ];
  for (const v of variants) {
    const lam = v.variant.startsWith('强正则') ? lambda * 4 : lambda;
    const r = estimateHierarchical(dataset, obs, epoch, lam, seedBase, { ...v.opts, boot: false });
    rows.push({
      variant: v.variant,
      path: 'hierarchical',
      epoch,
      effectPP: r.estimate.effectPP,
      ci95: r.estimate.ci95,
      nTrainees: r.estimate.nTrainees,
      nObservations: r.estimate.nObservations,
      finding: v.finding
    });
  }
  // 配对路径：不匹配场景（朴素两组均值差），展示混淆
  const eligible = epObs.filter(isEligibleTransfer);
  const means = traineeTransferMeans(eligible);
  const arrOf = new Map(dataset.trainees.map((t) => [t.id, t.arrangement]));
  const v = [...means].filter(([id]) => arrOf.get(id) === 'varied').map(([, x]) => x);
  const r = [...means].filter(([id]) => arrOf.get(id) === 'repeat').map(([, x]) => x);
  rows.push({
    variant: '配对路径：不按场景匹配（直接比较两组迁移均值）',
    path: 'unadjusted',
    epoch,
    effectPP: v.length && r.length ? (mean(v) - mean(r)) * 100 : null,
    ci95: null,
    nTrainees: v.length + r.length,
    nObservations: eligible.length,
    finding: '未控制场景难度；若两组练习的场景构成不同，均值差会被难度混淆。这也是需要配对/分层的原因'
  });
  rows.push({
    variant: '配对路径：按场景家族分层加权（主估计）',
    path: 'paired',
    epoch,
    effectPP: paired.estimate.effectPP,
    ci95: paired.estimate.ci95,
    nTrainees: paired.estimate.nTrainees,
    nObservations: paired.estimate.nObservations,
    finding: paired.estimate.note ?? ''
  });
  return rows;
}

// ============================================================
// 主入口
// ============================================================

export async function runCalibration(dataset: CalibrationDataset): Promise<CalibrationReport> {
  const index = buildIndex(dataset);
  const obs = buildObservations(dataset, index);
  const diagnostics = computeDiagnostics(dataset, obs, index);
  const exclusions = computeExclusions(dataset, obs, diagnostics);
  const mainPath = diagnostics.recommendation.method;
  const lambda = 0.6;
  const seedBase = dataset.seed >>> 0;

  const effects: EffectEstimate[] = [];
  const sensitivity: SensitivityRow[] = [];
  const predictions: ArrangementPrediction[] = [];
  const hierFits = new Map<string, { fit: FitResult; enc: Encoded }>();

  for (const ep of dataset.epochs) {
    const paired = estimatePaired(dataset, obs, ep.key, seedBase + ep.packageVersion * 7919);
    effects.push(paired.estimate);
    const hier = estimateHierarchical(dataset, obs, ep.key, lambda, seedBase + ep.packageVersion * 104729);
    effects.push(hier.estimate);
    hierFits.set(ep.key, { fit: hier.fit, enc: hier.enc });
    sensitivity.push(...sensitivityForEpoch(dataset, obs, ep.key, lambda, seedBase + ep.packageVersion * 15485863, paired));

    // 不同训练安排对未见场景正确率的估计（用主路径）
    let pred: ArrangementPrediction[];
    if (mainPath === 'paired') {
      const units = paired.units;
      const byArr = (arr: 'varied' | 'repeat') => {
        const byT = new Map<string, number[]>();
        for (const u of units) {
          if (u.arrangement !== arr) continue;
          const a = byT.get(u.traineeId) ?? [];
          a.push(u.correctness);
          byT.set(u.traineeId, a);
        }
        return [...byT.values()].map(mean);
      };
      const vv = byArr('varied');
      const rr = byArr('repeat');
      const rng = mulberry32((seedBase ^ 0xbeef) >>> 0);
      const vReps: number[] = [], rReps: number[] = [];
      if (vv.length >= 2 && rr.length >= 2) {
        for (let b = 0; b < PAIRED_BOOTSTRAP; b++) {
          const pick = (xs: number[]) => {
            let s = 0;
            for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rng() * xs.length)];
            return s / xs.length;
          };
          vReps.push(pick(vv) * 100);
          rReps.push(pick(rr) * 100);
        }
      }
      pred = ([
        { arrangement: 'varied' as const, value: mean(vv), reps: vReps, n: vv.length },
        { arrangement: 'repeat' as const, value: mean(rr), reps: rReps, n: rr.length }
      ]).map((x) => ({
        epoch: ep.key,
        arrangement: x.arrangement,
        unseenCorrectness: x.value * 100,
        ci95: (x.reps.length ? [pct(x.reps, 0.025), pct(x.reps, 0.975)] : [NaN, NaN]) as [number, number],
        nTrainees: x.n
      }));
    } else {
      const m = arrangementMeans(hier.fit, hier.enc,
        dataset.families.filter((f) => f.epoch === ep.key).map((f) => f.key),
        [...new Set(obs.filter((o) => o.epoch === ep.key).map((o) => o.traineeId))]);
      pred = [
        {
          epoch: ep.key, arrangement: 'varied' as const, unseenCorrectness: m.varied,
          ci95: hier.ciPredictions.varied.length ? [pct(hier.ciPredictions.varied, 0.025), pct(hier.ciPredictions.varied, 0.975)] : [NaN, NaN],
          nTrainees: hier.estimate.nTrainees
        },
        {
          epoch: ep.key, arrangement: 'repeat' as const, unseenCorrectness: m.repeat,
          ci95: hier.ciPredictions.repeat.length ? [pct(hier.ciPredictions.repeat, 0.025), pct(hier.ciPredictions.repeat, 0.975)] : [NaN, NaN],
          nTrainees: hier.estimate.nTrainees
        }
      ];
    }
    predictions.push(...pred);
  }

  const scenarios = buildScenarioRows(dataset, obs, mainPath, hierFits, seedBase);
  const warnings = buildWarnings(dataset, diagnostics, exclusions, obs);
  const limitations = buildLimitations(diagnostics, mainPath);

  const body = {
    datasetId: dataset.id,
    datasetName: dataset.name,
    datasetSeed: dataset.seed,
    createdAt: new Date().toISOString(),
    methodRecommended: mainPath,
    recommendationReason: diagnostics.recommendation.reason,
    diagnostics,
    effects,
    scenarios,
    sensitivity,
    predictions,
    exclusions,
    limitations,
    warnings,
    noRankingStatement:
      '本报告只估计训练安排与场景特征的平均效应，不生成个人能力排名；学员编号为本地匿名标识，不可回溯到个人。'
  };
  const hash = await hashObject(body);
  return {
    id: `CAL-${dataset.id}`,
    ...body,
    hash
  };
}

function buildWarnings(
  dataset: CalibrationDataset,
  diagnostics: ReturnType<typeof computeDiagnostics>,
  ex: CalibrationExclusions,
  obs: ObservedAttempt[]
): string[] {
  const w: string[] = [];
  if (ex.leakedTransferItems > 0) {
    w.push(`${ex.leakedTransferItems} 条迁移作答的答案在迁移测验前泄漏，已排除为泛化证据（不等同于删除记录，仅不计入未见场景估计）。`);
  }
  if (ex.seenInstanceItems > 0) {
    w.push(`${ex.seenInstanceItems} 条迁移题使用了该学员练习过的具体实例，按“未见场景”要求排除。`);
  }
  if (ex.withdrawnTransferAttempts > 0) {
    w.push(`${diagnostics.totals.withdrewTrainees} 名学员中途退出，已产生的可用记录保留，减少的记录形成可用性缺口（不做插补）。`);
  }
  if (diagnostics.totals.versionSwitchedTrainees > 0) {
    w.push(`${diagnostics.totals.versionSwitchedTrainees} 名学员更换了演练包版本；各规则/包版本分别估计，不跨版本合并。`);
  }
  if (diagnostics.totals.repeatedAttempts > 0) {
    w.push(`存在 ${diagnostics.totals.repeatedAttempts} 次重复尝试（同场景多次）；已按学员聚合，未当作独立样本。`);
  }
  if (ex.missingPracticeLogs + ex.missingTransferLogs > 0) {
    w.push(`日志缺失：练习缺失 ${ex.missingPracticeLogs} 条、迁移缺失 ${ex.missingTransferLogs} 条；配对路径的可用样本因此减少，层级模型利用可用记录但依赖模型假设。`);
  }
  const unshuffled = diagnostics.shuffleCheck.filter((s) => !s.shuffled);
  if (unshuffled.length > 0) {
    w.push(`${unshuffled.length} 名学员的练习顺序未体现乱序（同一顺序或仅单场景），顺序效应可能混入训练安排效应。`);
  }
  if (diagnostics.epochs.some((e) => e.pairedCoverage < 0.5)) {
    w.push('至少一个版本下可用配对学员覆盖率 < 50%，配对估计的可用样本明显减少。');
  }
  if (ex.leakedTransferItems > 0 || ex.seenInstanceItems > 0) {
    const leakedShare = (ex.leakedTransferItems + ex.seenInstanceItems) /
      Math.max(1, obs.filter((o) => o.phase === 'transfer').length);
    if (leakedShare > 0.15) w.push(`迁移题中约 ${(leakedShare * 100).toFixed(0)}% 不作为泛化证据，当前迁移证据较薄弱。`);
  }
  return w;
}

function buildLimitations(diagnostics: ReturnType<typeof computeDiagnostics>, mainPath: EstimatorPath): string[] {
  const out = [
    '观测性比较：训练安排不是随机分配的，即使匹配场景，仍可能有未测量的学员差异；本报告只给出关联性效应估计与区间。',
    '训练安排效应按规则/包版本分别估计；版本更新后不跨版本合并，避免把规则变化误当学习效果。',
    '效应以百分点（pp）表示“未见场景处置正确率”的差异；区间来自学员聚类自助法，反映抽样不确定性。',
    '不生成个人能力排名；学员层面的基线仅用于模型校正，不单独报告、不排序。'
  ];
  if (mainPath === 'paired') {
    out.push('主估计为配对路径：口径直观、假设少，但只能按单个匹配层（场景家族）分层；未完成的成对练习被排除，样本减少。');
    out.push('场景属性之间的交互未被配对法吸收；可参考层级模型作为补充，但层级结果依赖模型结构。');
  } else {
    out.push('主估计为层级反应模型：可利用不平衡与部分缺测，但依赖“学员基线 + 场景难度 + 迁移项”的模型结构；已附敏感性检查。');
    out.push('若强正则或完整案例变体下效应方向/大小明显变化，应降低对点估计的信任，优先看区间与敏感性结论。');
  }
  if (diagnostics.attributeCount > 4) {
    out.push(`场景属性共 ${diagnostics.attributeCount} 个，配对法难以同时分离多个场景属性，场景难度/区分度解释需谨慎。`);
  }
  out.push('场景难度与区分度是基于本次合成演练包的校准，不应外推为真实应急场景的普遍难度。');
  return out;
}

export { ARRANGEMENT_LABELS };
