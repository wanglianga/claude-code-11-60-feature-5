// ============================================================
// 演练场景学习效果校准：数据模型
// ------------------------------------------------------------
// 设计要点：
// 1) 学员一律使用本地匿名编号（T-xxx），不记录姓名，也不输出个人能力排名；
// 2) 场景特征来自合成演练包（事件类型、链型、优先级、时段、并发/转运腿数、罕见组合）；
// 3) 每次练习记录顺序、决策步骤、用时；是否正确由“标准处置依据”重算，不信任日志里的结论；
// 4) 迁移测验用未在练习中出现过的场景实例；答案泄漏或实例被练习过的迁移题不作为泛化证据；
// 5) 同一学员的重复尝试按学员聚类，绝不当作独立样本。
// ============================================================

export type TrainingArrangement = 'varied' | 'repeat';
export type CalibrationPhase = 'practice' | 'transfer';
export type PriorityBand = 'high' | 'mid' | 'low';
export type TimeBand = 'day' | 'evening' | 'night';

export const ARRANGEMENT_LABELS: Record<TrainingArrangement, string> = {
  varied: '交叉随机训练（多场景混合、乱序）',
  repeat: '重复场景训练（少场景多次演练）'
};

/** 场景特征：全部来自合成演练包的结构化属性 */
export interface ScenarioFeature {
  eventType: string;
  chainPattern: string;
  priorityBand: PriorityBand;
  timeBand: TimeBand;
  concurrentLegs: number;
  transferLegs: number;
  rareCombo: boolean;
}

export const FEATURE_LABELS: Record<keyof ScenarioFeature, string> = {
  eventType: '事件类型',
  chainPattern: '链型',
  priorityBand: '优先级',
  timeBand: '时段',
  concurrentLegs: '并发腿数',
  transferLegs: '转运腿数',
  rareCombo: '罕见组合'
};

/**
 * 场景家族（按演练包版本分开）：携带标准处置依据。
 * 规则版本更新后，同一业务场景的 requiredSteps 可能变化，
 * 因此家族按 epoch 分键，新旧训练效果分开估计。
 */
export interface ScenarioFamily {
  key: string;
  epoch: string;
  label: string;
  feature: ScenarioFeature;
  /** 标准处置步骤（必须全部完成） */
  requiredSteps: string[];
  /** 禁止步骤（出现即判错，例如派不具备能力的车辆） */
  forbiddenSteps: string[];
  /** 标准处置依据的文字出处（规则版本 + 能力映射 + 链型要求） */
  standardBasis: string;
}

/** 具体场景实例：迁移测验必须使用练习中未出现过的实例 */
export interface ScenarioInstance {
  id: string;
  familyKey: string;
  epoch: string;
  phase: CalibrationPhase;
  /** 迁移题答案是否泄漏（泄漏题不作为泛化证据） */
  answerExposed?: boolean;
}

export interface CalibrationAttempt {
  traineeId: string;
  scenarioId: string;
  epoch: string;
  phase: CalibrationPhase;
  /** 练习顺序（1 起，乱序后可验证）；迁移题为 0 */
  practiceOrder: number;
  decisionSteps: string[];
  timeSec: number;
}

export interface CalibrationTrainee {
  id: string;
  arrangement: TrainingArrangement;
  enrolledEpoch: string;
  withdrew: boolean;
  withdrawalEpoch?: string;
  /** 应完成的练习/迁移条目数，用于保留“可用性缺口” */
  expectedPractice: number;
  missingPracticeLogs: number;
  missingTransferLogs: number;
  versionSwitched: boolean;
}

export interface CalibrationEpoch {
  key: string;
  ruleVersion: number;
  packageId: string;
  packageVersion: number;
  note: string;
}

export type SamplePreset = 'comprehensive' | 'missing-heavy' | 'leak-heavy' | 'paired-clean';

export interface CalibrationDataset {
  id: string;
  name: string;
  preset: SamplePreset;
  seed: number;
  generatedAt: string;
  epochs: CalibrationEpoch[];
  families: ScenarioFamily[];
  scenarios: ScenarioInstance[];
  trainees: CalibrationTrainee[];
  attempts: CalibrationAttempt[];
  notes: string[];
}

// ---------- 观测（把日志与标准依据关联后的分析视图） ----------

export interface ObservedAttempt {
  traineeId: string;
  arrangement: TrainingArrangement;
  epoch: string;
  phase: CalibrationPhase;
  scenarioId: string;
  familyKey: string;
  family: ScenarioFamily;
  practiceOrder: number;
  timeSec: number;
  correct: boolean;
  answerExposed: boolean;
  /** 迁移题对应的场景实例是否被该学员练习过（非“未见”即失去泛化资格） */
  instanceSeen: boolean;
  withdrew: boolean;
}

// ---------- 诊断 ----------

export interface FamilyCoverage {
  epoch: string;
  familyKey: string;
  label: string;
  practiceAttempts: number;
  practiceTrainees: number;
  transferItems: number;
}

export interface EpochCoverage {
  epoch: string;
  ruleVersion: number;
  packageId: string;
  packageVersion: number;
  trainees: number;
  variedTrainees: number;
  repeatTrainees: number;
  practiceAttempts: number;
  transferAttempts: number;
  eligibleTransferAttempts: number;
  matchedTransferAttempts: number;
  pairedTrainees: number;
  pairedCoverage: number;
  repeatedAttempts: number;
  missingPracticeLogs: number;
  missingTransferLogs: number;
  withdrewTrainees: number;
  versionSwitchedTrainees: number;
  leakedTransferItems: number;
  seenInstanceItems: number;
}

export interface CalibrationDiagnostics {
  epochs: EpochCoverage[];
  totals: {
    trainees: number;
    attempts: number;
    practiceAttempts: number;
    transferAttempts: number;
    families: number;
    epochs: number;
    missingLogs: number;
    withdrewTrainees: number;
    versionSwitchedTrainees: number;
    repeatedAttempts: number;
    leakedTransferItems: number;
    seenInstanceItems: number;
  };
  /** 场景属性个数（含冗余属性） */
  attributeCount: number;
  /** 需同时分离的独立属性个数（剔除由其他属性完全决定的冗余属性） */
  independentAttributeCount: number;
  varyingAttributes: (keyof ScenarioFeature)[];
  redundantAttributes: (keyof ScenarioFeature)[];
  shuffleCheck: { epoch: string; traineeId: string; shuffled: boolean }[];
  familyCoverage: FamilyCoverage[];
  recommendation: {
    method: 'paired' | 'hierarchical';
    reason: string[];
    pairedCoverage: number;
    attributeCount: number;
  };
}

// ---------- 估计结果 ----------

export type EstimatorPath = 'paired' | 'hierarchical';

export interface EffectEstimate {
  path: EstimatorPath;
  epoch: string;
  /** 对未见场景处置正确率的平均效应（百分点），varied − repeat */
  effectPP: number;
  ci95: [number, number];
  ciMethod: string;
  /** 层级模型的 logit 系数与比值比（配对路径为 null） */
  logitEffect: number | null;
  oddsRatio: number | null;
  nTrainees: number;
  nObservations: number;
  /** 有效独立单位说明（学员数，而非尝试数） */
  independence: string;
  note?: string;
}

export interface ScenarioCalibrationRow {
  epoch: string;
  familyKey: string;
  label: string;
  eventType: string;
  chainPattern: string;
  /** 练习正确率（按学员先平均，重复尝试不重复计数） */
  accuracy: number;
  /** 场景难度 b（越大越难，logit 尺度） */
  difficulty: number;
  /** 区分度 a（越大越能拉开迁移表现；样本不足为 null） */
  discrimination: number | null;
  practiceTrainees: number;
  transferItems: number;
  repeatedAttempts: number;
  identifiability: '可估' | '样本不足' | '仅迁移观测';
  source: EstimatorPath;
}

export interface SensitivityRow {
  variant: string;
  path: EstimatorPath | 'unadjusted';
  epoch: string;
  effectPP: number | null;
  ci95: [number, number] | null;
  nTrainees: number;
  nObservations: number;
  finding: string;
}

export interface ArrangementPrediction {
  epoch: string;
  arrangement: TrainingArrangement;
  /** 平均学员在未见场景上的预期正确率 */
  unseenCorrectness: number;
  ci95: [number, number];
  nTrainees: number;
}

export interface CalibrationExclusions {
  leakedTransferItems: number;
  seenInstanceItems: number;
  withdrawnTransferAttempts: number;
  missingPracticeLogs: number;
  missingTransferLogs: number;
  completeCaseTrainees: number;
  allTrainees: number;
}

export interface CalibrationReport {
  id: string;
  datasetId: string;
  datasetName: string;
  datasetSeed: number;
  createdAt: string;
  methodRecommended: 'paired' | 'hierarchical';
  recommendationReason: string[];
  diagnostics: CalibrationDiagnostics;
  effects: EffectEstimate[];
  scenarios: ScenarioCalibrationRow[];
  sensitivity: SensitivityRow[];
  predictions: ArrangementPrediction[];
  exclusions: CalibrationExclusions;
  limitations: string[];
  warnings: string[];
  noRankingStatement: string;
  hash: string;
}
