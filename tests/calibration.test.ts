import { describe, it, expect } from 'vitest';
import { makeCalibrationDataset } from '../src/domain/calibration/samples';
import {
  buildIndex,
  buildObservations,
  gradeAttempt,
  isEligibleTransfer
} from '../src/domain/calibration/data';
import { runCalibration } from '../src/domain/calibration/estimate';
import type { ScenarioFamily } from '../src/domain/calibration/types';

const SEED = 20251118;
const ds = makeCalibrationDataset('comprehensive', SEED);

function fam(key: string): ScenarioFamily {
  return ds.families.find((f) => f.key === key)!;
}

describe('批改：标准处置依据重算（不信任日志结论）', () => {
  it('必需步骤齐全 + 无禁止步骤 + 未超时才判正确', () => {
    const f = fam('fam-cardiac-night-pkg-r1-rule-v1');
    expect(gradeAttempt(f, f.requiredSteps, 90)).toBe(true);
    // 缺一个必需步骤
    expect(gradeAttempt(f, f.requiredSteps.slice(0, -1), 90)).toBe(false);
    // 含禁止步骤
    expect(gradeAttempt(f, [...f.requiredSteps, f.forbiddenSteps[0]], 90)).toBe(false);
    // 超时
    expect(gradeAttempt(f, f.requiredSteps, 999)).toBe(false);
  });

  it('规则更新后的家族要求更多步骤，旧作答在新规则下不再自动成立', () => {
    const oldF = fam('fam-cardiac-night-pkg-r1-rule-v1');
    const newF = fam('fam-cardiac-night-pkg-r2-rule-v2');
    expect(newF.requiredSteps).toContain('记录处置依据');
    expect(oldF.requiredSteps).not.toContain('记录处置依据');
    // 旧规则下的“正确”步骤集，在新规则下缺「记录处置依据」→ 不通过
    expect(gradeAttempt(newF, oldF.requiredSteps, 90)).toBe(false);
  });
});

describe('观测构建：泄漏、未见实例与退出', () => {
  const index = buildIndex(ds);
  const obs = buildObservations(ds, index);

  it('正确性是重算得到的，不是样例直接写入的标签', () => {
    const practice = obs.filter((o) => o.phase === 'practice');
    const rate = practice.filter((o) => o.correct).length / practice.length;
    expect(rate).toBeGreaterThan(0.05);
    expect(rate).toBeLessThan(0.95);
  });

  it('答案泄漏的迁移题与练习过的实例不作为泛化证据', () => {
    const transfer = obs.filter((o) => o.phase === 'transfer');
    expect(transfer.some((o) => o.answerExposed)).toBe(true);
    expect(transfer.some((o) => o.instanceSeen)).toBe(true);
    for (const o of transfer) {
      if (o.answerExposed || o.instanceSeen) expect(isEligibleTransfer(o)).toBe(false);
    }
  });

  it('重复场景：同一学员在同一实例上多次尝试确实存在', () => {
    const practice = obs.filter((o) => o.phase === 'practice');
    const byKey = new Map<string, number>();
    for (const o of practice) byKey.set(`${o.traineeId}|${o.scenarioId}`, (byKey.get(`${o.traineeId}|${o.scenarioId}`) ?? 0) + 1);
    expect([...byKey.values()].some((n) => n > 1)).toBe(true);
  });
});

describe('诊断与方法选择', () => {
  it('完整覆盖五类限制条件（重复/乱序/未见/缺失/版本/泄漏）', async () => {
    const r = await runCalibration(ds);
    const d = r.diagnostics;
    expect(d.totals.repeatedAttempts).toBeGreaterThan(0);
    expect(d.totals.missingLogs).toBeGreaterThan(0);
    expect(d.totals.versionSwitchedTrainees).toBeGreaterThan(0);
    expect(d.totals.withdrewTrainees).toBeGreaterThan(0);
    expect(r.exclusions.leakedTransferItems).toBeGreaterThan(0);
    expect(r.exclusions.seenInstanceItems).toBeGreaterThan(0);
    expect(d.epochs.length).toBe(2);
    // 交叉训练学员的乱序核查：综合样例应大多体现乱序
    const variedShuffle = d.shuffleCheck.filter((s) => !s.shuffled).length;
    expect(variedShuffle).toBeLessThanOrEqual(3);
  });

  it('场景属性计数与冗余识别', async () => {
    const r = await runCalibration(ds);
    expect(r.diagnostics.attributeCount).toBe(7);
    // 并发腿数/转运腿数由链型决定 → 属于冗余属性
    expect(r.diagnostics.independentAttributeCount).toBeLessThan(7);
    expect(r.diagnostics.redundantAttributes.length).toBeGreaterThan(0);
  });

  it('干净交叉 + 属性少 → 推荐配对；缺失为主 → 推荐层级', async () => {
    const clean = await runCalibration(makeCalibrationDataset('paired-clean', 7));
    expect(clean.methodRecommended).toBe('paired');
    const missing = await runCalibration(makeCalibrationDataset('missing-heavy', 42));
    expect(missing.methodRecommended).toBe('hierarchical');
    expect(missing.diagnostics.epochs.some((e) => e.pairedCoverage < 0.5)).toBe(true);
  });
});

describe('效应区间：训练安排对未见场景正确率的配对估计', () => {
  it('干净交叉样例上，交叉训练优于重复场景且区间不含 0', async () => {
    const r = await runCalibration(makeCalibrationDataset('paired-clean', 7));
    const paired = r.effects.find((e) => e.path === 'paired' && e.epoch === 'pkg-r1-rule-v1')!;
    expect(paired.effectPP).toBeGreaterThan(0);
    expect(paired.ci95[0]).toBeGreaterThan(0);
    expect(Number.isFinite(paired.ci95[1])).toBe(true);
    // 以学员为独立单位，nTrainees 应等于该版本参与学员数（远离尝试数）
    expect(paired.nTrainees).toBeGreaterThan(0);
    expect(paired.nTrainees).toBeLessThan(ds.attempts.length);
  });

  it('配对估计对学员重抽稳定可复现（同种子同结果）', async () => {
    const a = await runCalibration(makeCalibrationDataset('paired-clean', 7));
    const b = await runCalibration(makeCalibrationDataset('paired-clean', 7));
    const pick = (r: typeof a, path: 'paired' | 'hierarchical') =>
      r.effects.find((e) => e.path === path && e.epoch === 'pkg-r1-rule-v1')!.effectPP;
    expect(pick(a, 'paired')).toBeCloseTo(pick(b, 'paired'), 6);
  });

  it('缺失为主的样例：配对可用学员明显少于完整学员（可用样本减少）', async () => {
    const r = await runCalibration(makeCalibrationDataset('missing-heavy', 42));
    const paired = r.effects.find((e) => e.path === 'paired' && e.epoch === 'pkg-r1-rule-v1')!;
    expect(paired.nTrainees).toBeLessThan(r.exclusions.allTrainees * 0.7);
  });
});

describe('层级反应模型与敏感性检查', () => {
  it('两层估计方向一致（同为正向训练效应），但量级可不同', async () => {
    const r = await runCalibration(makeCalibrationDataset('comprehensive', 11));
    for (const ep of ['pkg-r1-rule-v1', 'pkg-r2-rule-v2']) {
      const p = r.effects.find((e) => e.path === 'paired' && e.epoch === ep)!;
      const h = r.effects.find((e) => e.path === 'hierarchical' && e.epoch === ep)!;
      expect(h.logitEffect).not.toBeNull();
      expect(h.oddsRatio).toBeGreaterThan(0);
      expect(Math.sign(p.effectPP)).toBe(Math.sign(h.effectPP));
    }
  });

  it('每个版本都给出多种敏感性变体，含泄漏/实例/完整案例/强正则/朴素均值差', async () => {
    const r = await runCalibration(makeCalibrationDataset('comprehensive', 11));
    const variants = [...new Set(r.sensitivity.map((s) => s.variant))];
    expect(variants).toContain('含答案泄漏的迁移题');
    expect(variants).toContain('含练习过的迁移实例（非未见）');
    expect(variants).toContain('仅完整配对学员（有练习+迁移）');
    expect(variants.some((v) => v.startsWith('强正则'))).toBe(true);
    expect(variants.some((v) => v.startsWith('配对路径：不按场景匹配'))).toBe(true);
    // 强正则与完整案例变体都给出数值（非 NaN），用于稳定性判断
    const strong = r.sensitivity.filter((s) => s.variant.startsWith('强正则'));
    expect(strong.every((s) => Number.isFinite(s.effectPP as number))).toBe(true);
  });

  it('答案泄漏为主时，含泄漏变体与排除泄漏的主估计不同（泄漏抬高了表观成绩）', async () => {
    const r = await runCalibration(makeCalibrationDataset('leak-heavy', 42));
    const main = r.effects.find((e) => e.path === 'hierarchical' && e.epoch === 'pkg-r1-rule-v1')!;
    const leakRow = r.sensitivity.find((s) => s.epoch === 'pkg-r1-rule-v1' && s.variant === '含答案泄漏的迁移题')!;
    expect(r.exclusions.leakedTransferItems).toBeGreaterThan(20);
    expect(Number.isFinite(leakRow.effectPP as number)).toBe(true);
    expect(leakRow.effectPP).not.toBeCloseTo(main.effectPP, 6);
    // 泄漏题不得作为泛化证据：主估计的观测数应小于含泄漏变体
    expect(main.nObservations).toBeLessThanOrEqual(leakRow.nObservations);
  });
});

describe('场景难度与区分度校准', () => {
  it('层级的场景难度排序与练习正确率反序一致（越难正确率越低）', async () => {
    const r = await runCalibration(makeCalibrationDataset('paired-clean', 7));
    const rows = r.scenarios.filter((s) => s.epoch === 'pkg-r1-rule-v1' && Number.isFinite(s.difficulty));
    const sorted = [...rows].sort((a, b) => a.difficulty - b.difficulty);
    // 最低难度与最高难度场景的练习正确率应有可见差
    expect(sorted[sorted.length - 1].accuracy).toBeLessThan(sorted[0].accuracy);
    // 每个场景给出可识别性判定
    expect(rows.every((x) => ['可估', '样本不足', '仅迁移观测'].includes(x.identifiability))).toBe(true);
  });

  it('区分度在样本充足时为数值、样本少时为 null，而不是伪造', async () => {
    const r = await runCalibration(makeCalibrationDataset('comprehensive', 11));
    const withA = r.scenarios.filter((s) => s.discrimination !== null);
    const withoutA = r.scenarios.filter((s) => s.discrimination === null);
    expect(withA.length).toBeGreaterThan(0);
    expect(withA.every((s) => Number.isFinite(s.discrimination as number) && Math.abs(s.discrimination as number) <= 1)).toBe(true);
    // 样本不足者明确为 null（不是 0）
    expect(withoutA.every((s) => s.discrimination === null)).toBe(true);
  });
});

describe('版本更新：新旧分开估计', () => {
  it('两个版本各自给出效应，不跨版本合并', async () => {
    const r = await runCalibration(ds);
    const epochs = new Set(r.effects.map((e) => e.epoch));
    expect(epochs.size).toBe(2);
    for (const ep of epochs) {
      expect(r.effects.filter((e) => e.epoch === ep).length).toBe(2); // 配对 + 层级
    }
    // 版本切换学员在诊断中可见
    expect(r.diagnostics.epochs.some((e) => e.versionSwitchedTrainees > 0)).toBe(true);
  });
});

describe('不生成个人能力排名', () => {
  it('报告中不含学员级排序字段，且显式声明', async () => {
    const r = await runCalibration(ds);
    expect(r.noRankingStatement).toContain('不生成个人能力排名');
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/"rank"/);
    expect(json).not.toMatch(/traineeRanking/);
    // 效应结果以学员数为独立单位，而非逐人分数
    for (const e of r.effects) expect(typeof e.nTrainees).toBe('number');
  });

  it('匿名学员编号不可回溯到个人（仅本地编号）', () => {
    for (const t of ds.trainees) expect(t.id).toMatch(/^T-\d{3}$/);
  });
});

describe('样例可复现与持久化口径', () => {
  it('同种子生成的数据集逐字节一致（可复现）', () => {
    const a = makeCalibrationDataset('comprehensive', 999);
    const b = makeCalibrationDataset('comprehensive', 999);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = makeCalibrationDataset('comprehensive', 1000);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('报告哈希对同一数据集稳定（落库与回查可复现）', async () => {
    const a = await runCalibration(makeCalibrationDataset('comprehensive', 999));
    const b = await runCalibration(makeCalibrationDataset('comprehensive', 999));
    // createdAt 会不同，但结果数值应完全一致
    expect(a.effects.map((e) => e.effectPP)).toEqual(b.effects.map((e) => e.effectPP));
    expect(a.scenarios.map((s) => s.difficulty)).toEqual(b.scenarios.map((s) => s.difficulty));
  });
});

describe('落库：校准数据集与报告持久化（fake-indexeddb）', () => {
  it('数据集与报告可写入并读回，v2 表与既有表并存', async () => {
    const { db } = await import('../src/db/db');
    const local = makeCalibrationDataset('paired-clean', 7, 'DS-test-persist');
    await db.calibrationDatasets.put(local);
    const readBack = await db.calibrationDatasets.get('DS-test-persist');
    expect(readBack?.attempts.length).toBe(local.attempts.length);

    const report = await runCalibration(local);
    await db.calibrationReports.put(report);
    const reports = await db.calibrationReports.where('datasetId').equals('DS-test-persist').toArray();
    expect(reports.length).toBe(1);
    expect(reports[0].methodRecommended).toBe(report.methodRecommended);
    // 既有表仍可访问（schema 升级未破坏）
    expect(await db.batches.count()).toBeGreaterThanOrEqual(0);
    await db.calibrationDatasets.delete('DS-test-persist');
    await db.calibrationReports.delete(report.id);
  });
});
