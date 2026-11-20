// 验收样例生成（确定性）：覆盖重复场景、乱序训练、未见迁移题、
// 日志缺失、包版本更新与答案泄漏。
//
// 所有样例都由 seed 决定，同 seed 同输出，便于在界面与测试中复现。
// 样例中的“正确性”不是直接写入的标签，而是由学员实际决策步骤经由标准处置依据
// 重新批改得到——与真实日志的处理路径一致。

import type {
  CalibrationAttempt,
  CalibrationDataset,
  CalibrationEpoch,
  CalibrationTrainee,
  SamplePreset,
  ScenarioFamily,
  ScenarioInstance,
  ScenarioFeature,
  TrainingArrangement
} from './types';
import { gaussian, mulberry32, type Rng } from '../prng';

export const PRESET_LABELS: Record<SamplePreset, string> = {
  comprehensive: '综合验收样例（覆盖全部五类限制条件）',
  'missing-heavy': '日志缺失为主（配对可用样本减少）',
  'leak-heavy': '答案泄漏为主（泛化证据受限）',
  'paired-clean': '干净交叉（配对样本充足）'
};

interface Template {
  code: string;
  label: string;
  feature: ScenarioFeature;
  /** 场景难度（logit 尺度，越大越难） */
  difficulty: number;
  requiredSteps: string[];
  forbiddenSteps: string[];
  basis: string;
}

const COMMON_FORBIDDEN = ['派不具备能力的车辆', '跳过到场直接结案'];

const TEMPLATES: Template[] = [
  {
    code: 'cardiac-night',
    label: '夜间突发疾病·单车处置',
    feature: { eventType: '突发疾病', chainPattern: 'single', priorityBand: 'high', timeBand: 'night', concurrentLegs: 1, transferLegs: 0, rareCombo: false },
    difficulty: -0.2,
    requiredSteps: ['确认地址', '派车', '跟踪到场', '登记结案'],
    forbiddenSteps: COMMON_FORBIDDEN,
    basis: '标准规则 v1：P1 事件须 30 分钟内派车、90 分钟内到场；单车即可满足「急救」能力'
  },
  {
    code: 'traffic-concurrent2',
    label: '交通事故·并发派车×2',
    feature: { eventType: '交通事故', chainPattern: 'concurrent2', priorityBand: 'mid', timeBand: 'day', concurrentLegs: 2, transferLegs: 0, rareCombo: false },
    difficulty: 0.1,
    requiredSteps: ['确认地址', '判断并发', '派车×2', '协调到场', '登记结案'],
    forbiddenSteps: COMMON_FORBIDDEN,
    basis: '标准规则 v1：同一事件 2 条腿的占用区间以绝对毫秒核验；并发需协调两车同时到场'
  },
  {
    code: 'fire-concurrent3',
    label: '火灾·并发派车×3',
    feature: { eventType: '火灾', chainPattern: 'concurrent3', priorityBand: 'high', timeBand: 'evening', concurrentLegs: 3, transferLegs: 0, rareCombo: false },
    difficulty: 0.55,
    requiredSteps: ['确认地址', '判断并发', '派消防车×3', '协调到场', '登记结案'],
    forbiddenSteps: COMMON_FORBIDDEN,
    basis: '标准规则 v1：火灾需「消防」能力；单车占用区间重叠会被资源核验检出'
  },
  {
    code: 'hazmat-transfer2',
    label: '危化品泄漏·二级转运（郊区罕见组合）',
    feature: { eventType: '危化品泄漏', chainPattern: 'transfer2', priorityBand: 'high', timeBand: 'night', concurrentLegs: 0, transferLegs: 2, rareCombo: true },
    difficulty: 1.05,
    requiredSteps: ['确认地址', '判断转运', '核对危化能力', '派车首程', '安排接收', '登记交接'],
    forbiddenSteps: COMMON_FORBIDDEN,
    basis: '标准规则 v1：危化需「危化」能力；转运链要求上一程到场后才能派遣下一程（交接间隔 ≥5 分钟）'
  },
  {
    code: 'midnight-injury',
    label: '跨午夜外伤·单车处置',
    feature: { eventType: '外伤急救', chainPattern: 'single', priorityBand: 'mid', timeBand: 'night', concurrentLegs: 1, transferLegs: 0, rareCombo: false },
    difficulty: 0.3,
    requiredSteps: ['确认地址', '派车', '跟踪到场', '登记结案'],
    forbiddenSteps: COMMON_FORBIDDEN,
    basis: '标准规则 v1：跨午夜任务按绝对毫秒比较，不得判为日期倒序；到场晚于结案视为非法顺序'
  },
  {
    code: 'other-transfer3',
    label: '其他事件·三级转运',
    feature: { eventType: '其他', chainPattern: 'transfer3', priorityBand: 'low', timeBand: 'day', concurrentLegs: 0, transferLegs: 3, rareCombo: false },
    difficulty: 0.85,
    requiredSteps: ['确认地址', '判断转运', '派车首程', '安排接收', '登记交接', '跟踪终点'],
    forbiddenSteps: COMMON_FORBIDDEN,
    basis: '标准规则 v1：三级转运链每程交接间隔 ≥5 分钟；末次到场后才能结案'
  },
  {
    code: 'cardiac-transfer2',
    label: '突发疾病·二级转运',
    feature: { eventType: '突发疾病', chainPattern: 'transfer2', priorityBand: 'mid', timeBand: 'evening', concurrentLegs: 0, transferLegs: 2, rareCombo: false },
    difficulty: 0.4,
    requiredSteps: ['确认地址', '判断转运', '派车首程', '安排接收', '登记交接'],
    forbiddenSteps: COMMON_FORBIDDEN,
    basis: '标准规则 v1：转运链首程到场后不得早于交接间隔派遣；送医结局需记录接收机构'
  },
  {
    code: 'traffic-single',
    label: '交通事故·单车处置（低优先级）',
    feature: { eventType: '交通事故', chainPattern: 'single', priorityBand: 'low', timeBand: 'day', concurrentLegs: 1, transferLegs: 0, rareCombo: false },
    difficulty: -0.35,
    requiredSteps: ['确认地址', '派车', '跟踪到场', '登记结案'],
    forbiddenSteps: COMMON_FORBIDDEN,
    basis: '标准规则 v1：低优先级仍须满足 30 分钟派车上限；不得跳过到场'
  }
];

interface PresetSpec {
  variedPerEpoch: number;
  repeatPerEpoch: number;
  familiesVaried: number;
  familiesRepeat: number;
  practiceItemsVaried: number;
  practiceItemsRepeat: number;
  transferItems: number;
  transferFamilies: number;
  leakRate: number;
  seenInstanceRate: number;
  missingTransferRate: number;
  missingPracticeRate: number;
  withdrawRate: number;
  switchedPerEpoch: number;
}

function specFor(preset: SamplePreset): PresetSpec {
  const base: PresetSpec = {
    variedPerEpoch: 22,
    repeatPerEpoch: 18,
    familiesVaried: 7,
    familiesRepeat: 2,
    practiceItemsVaried: 8,
    practiceItemsRepeat: 12,
    transferItems: 5,
    transferFamilies: 3,
    leakRate: 0.12,
    seenInstanceRate: 0.1,
    missingTransferRate: 0.18,
    missingPracticeRate: 0.12,
    withdrawRate: 0.1,
    switchedPerEpoch: 4
  };
  switch (preset) {
    case 'missing-heavy':
      return { ...base, missingTransferRate: 0.52, missingPracticeRate: 0.36, withdrawRate: 0.16, leakRate: 0.04, seenInstanceRate: 0.04 };
    case 'leak-heavy':
      return { ...base, leakRate: 0.62, seenInstanceRate: 0.3, missingTransferRate: 0.1, missingPracticeRate: 0.06 };
    case 'paired-clean':
      return { ...base, leakRate: 0, seenInstanceRate: 0, missingTransferRate: 0, missingPracticeRate: 0, withdrawRate: 0, switchedPerEpoch: 0 };
    case 'comprehensive':
    default:
      return base;
  }
}

function epochFamilies(epoch: CalibrationEpoch, preset: SamplePreset): ScenarioFamily[] {
  return TEMPLATES.map((t, idx) => {
    const updated = epoch.ruleVersion >= 2 && idx % 3 === 0; // 规则更新：部分场景新增步骤
    // 干净交叉样例刻意只让「事件类型 / 链型」变化，压低需同时分离的独立属性数，
    // 用于验收“属性少时应优先配对估计”。
    const feature: ScenarioFeature = preset === 'paired-clean'
      ? { ...t.feature, priorityBand: 'mid', timeBand: 'day', rareCombo: false }
      : { ...t.feature };
    return {
      key: `fam-${t.code}-${epoch.key}`,
      epoch: epoch.key,
      label: t.label,
      feature,
      requiredSteps: updated ? [...t.requiredSteps, '记录处置依据'] : [...t.requiredSteps],
      forbiddenSteps: [...t.forbiddenSteps],
      standardBasis: updated
        ? `${t.basis} ／ 标准规则 v${epoch.ruleVersion} 起新增「记录处置依据」`
        : t.basis
    };
  });
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** 场景固有难度（logit 尺度），由模板编码查找；家族键形如 fam-<code>-<epoch> */
function difficultyOf(fam: ScenarioFamily): number {
  const t = TEMPLATES.find((x) => fam.key.startsWith(`fam-${x.code}-`));
  return t ? t.difficulty : 0.2;
}

function sampleWithoutReplacement<T>(rng: Rng, arr: T[], n: number): T[] {
  const copy = arr.slice();
  const out: T[] = [];
  while (out.length < n && copy.length > 0) {
    out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  }
  return out;
}

function correctSteps(rng: Rng, fam: ScenarioFamily): string[] {
  // 正确作答：包含全部必需步骤，绝不包含禁止步骤
  return [...fam.requiredSteps];
}

function wrongSteps(rng: Rng, fam: ScenarioFamily): string[] {
  // 错误作答：缺失一个必需步骤，或误用一个禁止步骤
  if (rng() < 0.4 && fam.forbiddenSteps.length > 0) {
    const steps = fam.requiredSteps.slice(0, Math.max(1, fam.requiredSteps.length - 1));
    return [...steps, fam.forbiddenSteps[Math.floor(rng() * fam.forbiddenSteps.length)]];
  }
  const dropIdx = Math.floor(rng() * fam.requiredSteps.length);
  return fam.requiredSteps.filter((_, i) => i !== dropIdx);
}

function buildAttempt(
  rng: Rng,
  trainee: CalibrationTrainee,
  fam: ScenarioFamily,
  instance: ScenarioInstance,
  phase: 'practice' | 'transfer',
  order: number,
  pCorrect: number,
  timeLow: number,
  timeHigh: number
): CalibrationAttempt {
  const ok = rng() < pCorrect;
  const timeSec = Math.round(timeLow + rng() * (timeHigh - timeLow));
  return {
    traineeId: trainee.id,
    scenarioId: instance.id,
    epoch: instance.epoch,
    phase,
    practiceOrder: phase === 'practice' ? order : 0,
    decisionSteps: ok ? correctSteps(rng, fam) : wrongSteps(rng, fam),
    timeSec
  };
}

export function makeCalibrationDataset(
  preset: SamplePreset = 'comprehensive',
  seed = 20251118,
  id = `DS-${preset}-${seed}`
): CalibrationDataset {
  const rng = mulberry32(seed >>> 0);
  const spec = specFor(preset);
  const epochs: CalibrationEpoch[] = [
    { key: 'pkg-r1-rule-v1', ruleVersion: 1, packageId: 'emerg-2025-09', packageVersion: 1, note: '首批演练包，规则 v1' },
    { key: 'pkg-r2-rule-v2', ruleVersion: 2, packageId: 'emerg-2025-09', packageVersion: 2, note: '演练包更新到 r2，规则 v2 新增「记录处置依据」' }
  ];
  const families: ScenarioFamily[] = epochs.flatMap((e) => epochFamilies(e, preset));
  const familiesOf = (epoch: string) => families.filter((f) => f.epoch === epoch);

  const scenarios: ScenarioInstance[] = [];
  const attempts: CalibrationAttempt[] = [];
  const trainees: CalibrationTrainee[] = [];
  const notes: string[] = [];

  // 为每个（epoch, 家族）预生成练习实例与未见迁移实例
  const practiceInstances = new Map<string, ScenarioInstance[]>(); // famKey -> instances
  const transferInstances = new Map<string, ScenarioInstance[]>();
  for (const fam of families) {
    const pi: ScenarioInstance[] = [];
    for (let i = 0; i < 4; i++) {
      const inst: ScenarioInstance = { id: `${fam.key}-P${i + 1}`, familyKey: fam.key, epoch: fam.epoch, phase: 'practice' };
      pi.push(inst);
      scenarios.push(inst);
    }
    practiceInstances.set(fam.key, pi);
    const ti: ScenarioInstance[] = [];
    for (let i = 0; i < 5; i++) {
      const exposed = rng() < 0.18;
      const inst: ScenarioInstance = { id: `${fam.key}-T${i + 1}`, familyKey: fam.key, epoch: fam.epoch, phase: 'transfer', answerExposed: exposed };
      ti.push(inst);
      scenarios.push(inst);
    }
    transferInstances.set(fam.key, ti);
  }

  let traineeSeq = 0;
  const makeTrainee = (epoch: CalibrationEpoch, arrangement: TrainingArrangement): CalibrationTrainee => {
    traineeSeq++;
    const idStr = `T-${String(traineeSeq).padStart(3, '0')}`;
    const withdrawn = rng() < spec.withdrawRate;
    return {
      id: idStr,
      arrangement,
      enrolledEpoch: epoch.key,
      withdrew: withdrawn,
      withdrawalEpoch: withdrawn ? epoch.key : undefined,
      expectedPractice: arrangement === 'repeat' ? spec.practiceItemsRepeat : spec.practiceItemsVaried,
      missingPracticeLogs: 0,
      missingTransferLogs: 0,
      versionSwitched: false
    };
  };

  for (const ep of epochs) {
    const epFams = familiesOf(ep.key);
    const elig = epFams.filter((f) => !f.feature.rareCombo || rng() < 0.7);
    const epTrainees: { trainee: CalibrationTrainee; theta: number }[] = [];

    for (let i = 0; i < spec.variedPerEpoch; i++) {
      epTrainees.push({ trainee: makeTrainee(ep, 'varied'), theta: gaussian(rng, 0, 0.7) });
    }
    for (let i = 0; i < spec.repeatPerEpoch; i++) {
      epTrainees.push({ trainee: makeTrainee(ep, 'repeat'), theta: gaussian(rng, 0, 0.7) });
    }

    for (const { trainee, theta } of epTrainees) {
      const isRepeat = trainee.arrangement === 'repeat';
      const famCount = isRepeat ? spec.familiesRepeat : Math.min(spec.familiesVaried, elig.length);
      const fams = sampleWithoutReplacement(rng, elig, famCount);
      if (fams.length === 0) continue;
      const itemCount = isRepeat ? spec.practiceItemsRepeat : spec.practiceItemsVaried;

      // 练习序列：重复场景训练在少数家族内反复；交叉训练在多个家族间乱序穿插
      const sequence: ScenarioFamily[] = [];
      if (isRepeat) {
        while (sequence.length < itemCount) sequence.push(fams[Math.floor(rng() * fams.length)]);
      } else {
        let round = 0;
        while (sequence.length < itemCount) {
          const shuffled = sampleWithoutReplacement(rng, fams, fams.length);
          for (const f of shuffled) {
            if (sequence.length >= itemCount) break;
            sequence.push(f);
          }
          round++;
          if (round > 20) break;
        }
      }

      const practiceMissing = rng() < spec.missingPracticeRate;
      const keepPractice = practiceMissing ? Math.floor(sequence.length * (isRepeat ? 0.5 : 0.6)) : sequence.length;
      let order = 0;
      for (let s = 0; s < keepPractice; s++) {
        const fam = sequence[s];
        const pool = practiceInstances.get(fam.key)!;
        const inst = pool[Math.floor(rng() * pool.length)];
        const speed = isRepeat ? 12 : 0;
        const p = sigmoid(theta - difficultyOf(fam) + 0.35 + (isRepeat ? 0.45 : 0));
        attempts.push(buildAttempt(rng, trainee, fam, inst, 'practice', ++order, p, 40 - speed, 150 - speed));
      }
      trainee.expectedPractice = sequence.length;
      trainee.missingPracticeLogs = sequence.length - keepPractice;

      if (trainee.withdrew) {
        trainee.missingTransferLogs = spec.transferItems;
        attempts.push(...[]);
        continue;
      }

      const transferMissing = rng() < spec.missingTransferRate;
      if (transferMissing) {
        trainee.missingTransferLogs = spec.transferItems;
        continue;
      }
      const tFams = sampleWithoutReplacement(rng, fams, Math.min(spec.transferFamilies, fams.length));
      if (tFams.length === 0) continue;
      let made = 0;
      for (let k = 0; k < spec.transferItems; k++) {
        const fam = tFams[k % tFams.length];
        // 少量迁移作答错误地复用了练习实例（非未见）；另一部分使用了答案已泄漏的实例
        const useSeen = rng() < spec.seenInstanceRate;
        const useLeak = !useSeen && rng() < spec.leakRate;
        let chosen: ScenarioInstance;
        if (useSeen) {
          const pool = practiceInstances.get(fam.key)!;
          chosen = pool[Math.floor(rng() * pool.length)];
        } else {
          const pool = transferInstances.get(fam.key)!;
          const exposed = pool.filter((x) => x.answerExposed);
          const clean = pool.filter((x) => !x.answerExposed);
          chosen = useLeak && exposed.length
            ? exposed[Math.floor(rng() * exposed.length)]
            : (clean[Math.floor(rng() * Math.max(1, clean.length))] ?? pool[0]);
        }
        const p = sigmoid(theta - difficultyOf(fam) - 0.25 + (isRepeat ? 0 : 0.7));
        attempts.push(buildAttempt(rng, trainee, fam, chosen, 'transfer', 0, p, 45, 160));
        made++;
      }
      trainee.missingTransferLogs = Math.max(0, spec.transferItems - made);
      void tFams;
    }

    // 包版本更新：少数较早批学员更换到新包（下一 epoch 再处理）
    trainees.push(...epTrainees.map((x) => x.trainee));
  }

  // 版本切换：从 epoch1 选若干学员转移到 epoch2，练习与迁移都发生在 epoch2
  if (epochs.length > 1) {
    const e1 = epochs[0].key;
    const e2 = epochs[1].key;
    const candidates = trainees.filter((t) => t.enrolledEpoch === e1 && !t.withdrew).slice(0, spec.switchedPerEpoch);
    const e2Fams = familiesOf(e2);
    for (const t of candidates) {
      t.versionSwitched = true;
      t.withdrew = false;
      t.withdrawalEpoch = undefined;
      // 清除其在 epoch1 的迁移记录，改为在 epoch2 重做练习与迁移
      for (let i = attempts.length - 1; i >= 0; i--) {
        if (attempts[i].traineeId === t.id && attempts[i].phase === 'transfer' && attempts[i].epoch === e1) attempts.splice(i, 1);
      }
      const theta = gaussian(rng, 0, 0.7);
      const fams = sampleWithoutReplacement(rng, e2Fams, t.arrangement === 'repeat' ? spec.familiesRepeat : 4);
      let order = 0;
      for (let s = 0; s < Math.min(5, fams.length * 2); s++) {
        const fam = fams[s % fams.length];
        const pool = practiceInstances.get(fam.key)!;
        const inst = pool[Math.floor(rng() * pool.length)];
        const p = sigmoid(theta - difficultyOf(fam) + 0.3);
        attempts.push(buildAttempt(rng, t, fam, inst, 'practice', ++order, p, 45, 150));
      }
      for (let k = 0; k < 3 && fams.length; k++) {
        const fam = fams[k % fams.length];
        const pool = transferInstances.get(fam.key)!;
        const inst = pool[Math.floor(rng() * pool.length)];
        const p = sigmoid(theta - difficultyOf(fam) - 0.25 + (t.arrangement === 'repeat' ? 0 : 0.7));
        attempts.push(buildAttempt(rng, t, fam, inst, 'transfer', 0, p, 45, 160));
      }
      t.missingTransferLogs = 0;
      t.expectedPractice = 5;
      t.missingPracticeLogs = 0;
    }
  }

  // 学员练习顺序乱序化：交叉训练的打乱顺序（保证同一次训练的家族序列已经乱序）
  // 校验样例中的乱序由 sequence 生成保证；这里只标注说明。
  notes.push('重复场景：重复训练学员在 2 个家族内多次演练；交叉训练学员在 7 个家族间乱序穿插。');
  notes.push('乱序训练：交叉训练序列按轮次打乱，可在诊断的「乱序核查」查看。');
  notes.push('未见迁移题：迁移作答默认使用未在练习中出现的场景实例；答案泄漏或使用练习实例的作答被标记，不计入泛化证据。');
  notes.push('日志缺失：部分学员练习/迁移记录缺失，保留为可用性缺口而非插补。');
  notes.push('包版本更新：规则 v2 起部分场景新增「记录处置依据」，epoch 分开估计。');
  if (preset === 'leak-heavy') notes.push('本样例刻意放大迁移答案泄漏与练习实例复用，用于验收证据限制。');
  if (preset === 'missing-heavy') notes.push('本样例刻意放大日志缺失与退出，用于验收配对可用样本减少。');
  if (preset === 'paired-clean') notes.push('本样例为完整交叉、无缺失、无泄漏，用于验收配对估计的主估计地位。');

  // 学员退出：退出学员没有迁移记录，练习记录保留
  for (const t of trainees) {
    if (t.withdrew) t.missingTransferLogs = Math.max(t.missingTransferLogs, 3);
  }

  return {
    id,
    name: `演练场景学习效果校准样例 · ${PRESET_LABELS[preset]}`,
    preset,
    seed,
    generatedAt: new Date(0).toISOString(),
    epochs,
    families,
    scenarios,
    trainees,
    attempts,
    notes
  };
}

export const PRESETS: SamplePreset[] = ['comprehensive', 'paired-clean', 'missing-heavy', 'leak-heavy'];
