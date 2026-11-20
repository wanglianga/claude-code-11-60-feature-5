// 观测构建与诊断：把匿名练习日志关联到场景特征与标准处置依据，
// 计算批改结果、交叉覆盖、缺测与证据限制，并给出方法选择建议。

import type {
  CalibrationAttempt,
  CalibrationDataset,
  CalibrationDiagnostics,
  CalibrationExclusions,
  EpochCoverage,
  FamilyCoverage,
  ObservedAttempt,
  ScenarioFamily,
  ScenarioInstance,
  TrainingArrangement
} from './types';
import { FEATURE_LABELS } from './types';

/** 按“标准处置依据”重算一次作答是否正确：必需步骤齐全、无禁止步骤、未超时 */
export function gradeAttempt(
  family: ScenarioFamily,
  decisionSteps: string[],
  timeSec: number,
  timeLimitSec = 180
): boolean {
  const steps = new Set(decisionSteps);
  const hasAll = family.requiredSteps.every((s) => steps.has(s));
  const noForbidden = family.forbiddenSteps.every((s) => !steps.has(s));
  return hasAll && noForbidden && timeSec > 0 && timeSec <= timeLimitSec;
}

export interface ObservationIndex {
  instances: Map<string, ScenarioInstance>;
  families: Map<string, ScenarioFamily>;
  /** 学员在某 epoch 练习过的场景实例集合（用于“未见迁移”判定） */
  seenInstancesByTrainee: Map<string, Set<string>>;
  /** 学员在某 epoch 练习过的场景家族集合 */
  seenFamiliesByTrainee: Map<string, Set<string>>;
  /** 迁移题的去重实例数（每 epoch） */
  transferItemsByEpoch: Map<string, Set<string>>;
}

function key(traineeId: string, epoch: string): string {
  return `${traineeId}@${epoch}`;
}

export function buildIndex(dataset: CalibrationDataset): ObservationIndex {
  const instances = new Map(dataset.scenarios.map((s) => [s.id, s]));
  const families = new Map(dataset.families.map((f) => [f.key, f]));
  const seenInstancesByTrainee = new Map<string, Set<string>>();
  const seenFamiliesByTrainee = new Map<string, Set<string>>();
  const transferItemsByEpoch = new Map<string, Set<string>>();
  for (const a of dataset.attempts) {
    if (a.phase !== 'practice') continue;
    const inst = instances.get(a.scenarioId);
    if (!inst) continue;
    const k = key(a.traineeId, a.epoch);
    const set = seenInstancesByTrainee.get(k) ?? new Set<string>();
    set.add(a.scenarioId);
    seenInstancesByTrainee.set(k, set);
    const fams = seenFamiliesByTrainee.get(k) ?? new Set<string>();
    fams.add(inst.familyKey);
    seenFamiliesByTrainee.set(k, fams);
  }
  for (const a of dataset.attempts) {
    if (a.phase !== 'transfer') continue;
    const set = transferItemsByEpoch.get(a.epoch) ?? new Set<string>();
    set.add(a.scenarioId);
    transferItemsByEpoch.set(a.epoch, set);
  }
  return { instances, families, seenInstancesByTrainee, seenFamiliesByTrainee, transferItemsByEpoch };
}

/** 把原始日志展开为可分析的观测（含批改、未见判定、泄漏标记） */
export function buildObservations(dataset: CalibrationDataset, index: ObservationIndex): ObservedAttempt[] {
  const traineeById = new Map(dataset.trainees.map((t) => [t.id, t]));
  const out: ObservedAttempt[] = [];
  for (const a of dataset.attempts) {
    const t = traineeById.get(a.traineeId);
    const inst = index.instances.get(a.scenarioId);
    if (!t || !inst) continue;
    const fam = index.families.get(inst.familyKey);
    if (!fam) continue;
    const seenKey = key(a.traineeId, a.epoch);
    const seen = index.seenInstancesByTrainee.get(seenKey)?.has(a.scenarioId) ?? false;
    const arr: TrainingArrangement = t.arrangement;
    out.push({
      traineeId: a.traineeId,
      arrangement: arr,
      epoch: a.epoch,
      phase: a.phase,
      scenarioId: a.scenarioId,
      familyKey: inst.familyKey,
      family: fam,
      practiceOrder: a.practiceOrder,
      timeSec: a.timeSec,
      correct: gradeAttempt(fam, a.decisionSteps, a.timeSec),
      answerExposed: inst.answerExposed === true,
      instanceSeen: seen,
      withdrew: t.withdrew && (t.withdrawalEpoch === undefined || t.withdrawalEpoch === a.epoch)
    });
  }
  return out;
}

/** 迁移证据是否可用于泛化：未泄漏、实例确实未见、学员未退出 */
export function isEligibleTransfer(o: ObservedAttempt): boolean {
  return o.phase === 'transfer' && !o.answerExposed && !o.instanceSeen && !o.withdrew;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * 场景属性计数与“变化属性”：配对法在同一匹配层内比较，
 * 一次只能吸收一个组合键；属性越多、交叉越稀，（同时）分离越难。
 * 同时识别冗余属性（取值完全由另一属性决定，例如并发/转运腿数由链型决定），
 * 冗余属性不重复计入“需分离的独立属性”。
 */
export function featureProfile(dataset: CalibrationDataset): {
  attributeCount: number;
  independentAttributeCount: number;
  varyingAttributes: (keyof import('./types').ScenarioFeature)[];
  redundantAttributes: (keyof import('./types').ScenarioFeature)[];
} {
  const fams = dataset.families;
  const keys = Object.keys(FEATURE_LABELS) as (keyof import('./types').ScenarioFeature)[];
  const varying = keys.filter((k) => new Set(fams.map((f) => String(f.feature[k]))).size > 1);
  // 冗余：存在另一属性，使本属性是其函数（同值必同值）
  const isFunctionOf = (a: keyof import('./types').ScenarioFeature, b: keyof import('./types').ScenarioFeature) => {
    const map = new Map<string, Set<string>>();
    for (const f of fams) {
      const set = map.get(String(f.feature[b])) ?? new Set<string>();
      set.add(String(f.feature[a]));
      map.set(String(f.feature[b]), set);
    }
    return [...map.values()].every((s) => s.size === 1);
  };
  const redundant: (keyof import('./types').ScenarioFeature)[] = [];
  for (const k of varying) {
    if (keys.some((other) => other !== k && isFunctionOf(k, other))) redundant.push(k);
  }
  return {
    attributeCount: keys.length,
    independentAttributeCount: varying.length - redundant.length,
    varyingAttributes: varying,
    redundantAttributes: redundant
  };
}

export function computeDiagnostics(
  dataset: CalibrationDataset,
  observations: ObservedAttempt[],
  index: ObservationIndex
): CalibrationDiagnostics {
  const traineeById = new Map(dataset.trainees.map((t) => [t.id, t]));
  const epochKeys = dataset.epochs.map((e) => e.key);
  const byEpoch = new Map<string, ObservedAttempt[]>();
  for (const o of observations) {
    const arr = byEpoch.get(o.epoch) ?? [];
    arr.push(o);
    byEpoch.set(o.epoch, arr);
  }

  const epochCov: EpochCoverage[] = [];
  const familyCoverage: FamilyCoverage[] = [];
  const shuffleCheck: CalibrationDiagnostics['shuffleCheck'] = [];

  for (const ep of dataset.epochs) {
    const obs = byEpoch.get(ep.key) ?? [];
    // 队列以“该版本内实际有记录”为准：更换包版本的学员会同时留下旧版本的缺口
    const activeIds = new Set(obs.map((o) => o.traineeId));
    const trainees = dataset.trainees.filter((t) => activeIds.has(t.id));
    const varied = trainees.filter((t) => t.arrangement === 'varied').length;
    const repeat = trainees.filter((t) => t.arrangement === 'repeat').length;
    const practice = obs.filter((o) => o.phase === 'practice');
    const transfer = obs.filter((o) => o.phase === 'transfer');
    const eligible = transfer.filter(isEligibleTransfer);
    const eligiblePairs = new Set(eligible.map((o) => o.traineeId));
    const allPairs = new Set(transfer.map((o) => o.traineeId));
    // 配对覆盖：varied 与 repeat 两侧都有可用迁移记录的学员覆盖率
    const arrOf = (id: string) => traineeById.get(id)?.arrangement;
    const pairedVaried = [...eligiblePairs].filter((id) => arrOf(id) === 'varied').length;
    const pairedRepeat = [...eligiblePairs].filter((id) => arrOf(id) === 'repeat').length;
    const pairedTrainees = Math.min(pairedVaried, pairedRepeat);
    const expectedPaired = Math.min(varied, repeat);

    // 学员层面的去重
    const practiceTrainees = new Set(practice.map((o) => o.traineeId)).size;

    epochCov.push({
      epoch: ep.key,
      ruleVersion: ep.ruleVersion,
      packageId: ep.packageId,
      packageVersion: ep.packageVersion,
      trainees: trainees.length,
      variedTrainees: varied,
      repeatTrainees: repeat,
      practiceAttempts: practice.length,
      transferAttempts: transfer.length,
      eligibleTransferAttempts: eligible.length,
      matchedTransferAttempts: eligible.filter((o) => allPairs.has(o.traineeId)).length,
      pairedTrainees,
      pairedCoverage: expectedPaired > 0 ? pairedTrainees / expectedPaired : 0,
      repeatedAttempts: practice.length - new Set(practice.map((o) => `${o.traineeId}|${o.scenarioId}`)).size,
      missingPracticeLogs: trainees.reduce((s, t) => s + t.missingPracticeLogs, 0),
      missingTransferLogs: trainees.reduce((s, t) => s + t.missingTransferLogs, 0),
      withdrewTrainees: trainees.filter((t) => t.withdrew).length,
      versionSwitchedTrainees: trainees.filter((t) => t.versionSwitched).length,
      leakedTransferItems: transfer.filter((o) => o.answerExposed).length,
      seenInstanceItems: transfer.filter((o) => o.instanceSeen && !o.answerExposed).length
    });

    // 场景家族级覆盖（按 epoch）
    const famKeys = new Set(dataset.families.filter((f) => f.epoch === ep.key).map((f) => f.key));
    for (const fk of famKeys) {
      const fam = dataset.families.find((f) => f.key === fk)!;
      const p = practice.filter((o) => o.familyKey === fk);
      const t = transfer.filter((o) => o.familyKey === fk);
      familyCoverage.push({
        epoch: ep.key,
        familyKey: fk,
        label: fam.label,
        practiceAttempts: p.length,
        practiceTrainees: new Set(p.map((o) => o.traineeId)).size,
        transferItems: new Set(t.map((o) => o.scenarioId)).size
      });
    }

    // 乱序核查：只针对交叉随机训练——其练习顺序不应按场景分块重复；
    // 重复场景训练本就按设计重复少数场景，不作为乱序失败。
    const practices = practice
      .filter((o) => o.arrangement === 'varied')
      .slice()
      .sort((a, b) => a.practiceOrder - b.practiceOrder);
    const byT = new Map<string, ObservedAttempt[]>();
    for (const o of practices) {
      const arr = byT.get(o.traineeId) ?? [];
      arr.push(o);
      byT.set(o.traineeId, arr);
    }
    for (const [tid, arr] of byT) {
      // 乱序判据：若顺序中同一场景家族连续出现占比过高（> 0.7），视为未有效乱序
      let sameAdj = 0;
      for (let i = 1; i < arr.length; i++) if (arr[i].familyKey === arr[i - 1].familyKey) sameAdj++;
      const sameRate = arr.length > 1 ? sameAdj / (arr.length - 1) : 0;
      shuffleCheck.push({ epoch: ep.key, traineeId: tid, shuffled: arr.length < 2 || sameRate <= 0.7 });
    }
  }

  const totals = {
    trainees: dataset.trainees.length,
    attempts: observations.length,
    practiceAttempts: observations.filter((o) => o.phase === 'practice').length,
    transferAttempts: observations.filter((o) => o.phase === 'transfer').length,
    families: dataset.families.length,
    epochs: dataset.epochs.length,
    missingLogs: dataset.trainees.reduce((s, t) => s + t.missingPracticeLogs + t.missingTransferLogs, 0),
    withdrewTrainees: dataset.trainees.filter((t) => t.withdrew).length,
    versionSwitchedTrainees: dataset.trainees.filter((t) => t.versionSwitched).length,
    repeatedAttempts: observations.filter((o) => o.phase === 'practice').length -
      new Set(observations.filter((o) => o.phase === 'practice').map((o) => `${o.traineeId}|${o.scenarioId}`)).size,
    leakedTransferItems: observations.filter((o) => o.phase === 'transfer' && o.answerExposed).length,
    seenInstanceItems: observations.filter((o) => o.phase === 'transfer' && o.instanceSeen && !o.answerExposed).length
  };

  const { attributeCount, independentAttributeCount, varyingAttributes, redundantAttributes } = featureProfile(dataset);
  const recommendation = recommendMethod(epochCov, independentAttributeCount);

  return {
    epochs: epochCov,
    totals,
    attributeCount,
    independentAttributeCount,
    varyingAttributes,
    redundantAttributes,
    shuffleCheck,
    familyCoverage,
    recommendation
  };
}

/** 选择依据：缺测与交叉覆盖程度、场景属性数量、所需可解释粒度 */
export function recommendMethod(
  epochCov: EpochCoverage[],
  attributeCount: number
): CalibrationDiagnostics['recommendation'] {
  const minPaired = epochCov.length ? Math.min(...epochCov.map((e) => e.pairedCoverage)) : 0;
  const totalMissing = epochCov.reduce((s, e) => s + e.missingPracticeLogs + e.missingTransferLogs, 0);
  const totalPractice = epochCov.reduce((s, e) => s + e.practiceAttempts, 0);
  const missingRate = totalPractice > 0 ? totalMissing / totalPractice : 0;
  const reason: string[] = [];
  let method: 'paired' | 'hierarchical' = 'paired';

  reason.push(`交叉覆盖：可用配对学员覆盖率最低 ${(minPaired * 100).toFixed(0)}%（各版本取最低）`);
  reason.push(`需分离的独立场景属性 ${attributeCount} 个；配对法同一匹配层只能吸收一个组合键`);
  reason.push(`缺测率（缺失日志/练习记录）${(missingRate * 100).toFixed(0)}%；缺测与部分记录会直接减少配对样本`);

  if (minPaired >= 0.7 && attributeCount <= 3 && missingRate <= 0.15) {
    method = 'paired';
    reason.push('结论：交叉覆盖高、属性少、缺测低 → 配对估计口径直观、假设少，作为主估计');
  } else if (minPaired < 0.5 || attributeCount > 2 || missingRate > 0.3) {
    method = 'hierarchical';
    reason.push('结论：配对样本不足（覆盖低），或需同时分离多个独立场景属性，或缺测偏高 → 层级反应模型可利用不平衡与部分缺测，作为主估计（须做敏感性检查）');
  } else {
    method = 'paired';
    reason.push('结论：条件尚可，优先配对估计；如需同时分离多个场景属性再参考层级模型');
  }
  if (attributeCount > 4) reason.push('提示：需同时分离的独立属性 > 4 时，配对只能在单个属性层内匹配，无法同时分离多个属性');
  reason.push(
    '可解释粒度：配对路径给出“按场景家族加权的成对差异”，最直观、易向教研组解释；' +
    '层级路径给出学员基线/场景难度/迁移项的 logit 结构，可分项归因但解释成本更高。' +
    '教研方若需要最细的场景属性归因，可同时参考层级结果与敏感性检查，但主估计仍按缺测与覆盖程度选择。'
  );
  return { method, reason, pairedCoverage: minPaired, attributeCount };
}

export function computeExclusions(
  dataset: CalibrationDataset,
  observations: ObservedAttempt[],
  diagnostics: CalibrationDiagnostics
): CalibrationExclusions {
  const transfer = observations.filter((o) => o.phase === 'transfer');
  const eligible = transfer.filter(isEligibleTransfer);
  const byTrainee = new Map<string, ObservedAttempt[]>();
  for (const o of eligible) {
    const arr = byTrainee.get(o.traineeId) ?? [];
    arr.push(o);
    byTrainee.set(o.traineeId, arr);
  }
  const completeCase = dataset.trainees.filter((t) => (byTrainee.get(t.id)?.length ?? 0) > 0).length;
  return {
    leakedTransferItems: transfer.filter((o) => o.answerExposed).length,
    seenInstanceItems: transfer.filter((o) => o.instanceSeen && !o.answerExposed).length,
    withdrawnTransferAttempts: transfer.filter((o) => o.withdrew).length,
    missingPracticeLogs: diagnostics.totals.missingLogs,
    missingTransferLogs: dataset.trainees.reduce((s, t) => s + t.missingTransferLogs, 0),
    completeCaseTrainees: completeCase,
    allTrainees: dataset.trainees.length
  };
}

/** 按学员聚合迁移正确率（重复尝试不当作独立样本） */
export function traineeTransferMeans(observations: ObservedAttempt[]): Map<string, number> {
  const byTrainee = new Map<string, number[]>();
  for (const o of observations) {
    if (!isEligibleTransfer(o)) continue;
    const arr = byTrainee.get(o.traineeId) ?? [];
    arr.push(o.correct ? 1 : 0);
    byTrainee.set(o.traineeId, arr);
  }
  const out = new Map<string, number>();
  for (const [id, xs] of byTrainee) out.set(id, mean(xs));
  return out;
}

export function attemptsFor(dataset: CalibrationDataset): CalibrationAttempt[] {
  return dataset.attempts;
}
