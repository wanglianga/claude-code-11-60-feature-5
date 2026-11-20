// ============================================================
// 领域类型定义：应急调度合成数据演练台
// ============================================================

export type TableName = 'events' | 'dispatches' | 'resources' | 'arrivals' | 'closures';
export const TABLE_NAMES: TableName[] = ['events', 'dispatches', 'resources', 'arrivals', 'closures'];

export const TABLE_LABELS: Record<TableName, string> = {
  events: '报警事件',
  dispatches: '派遣记录',
  resources: '资源(车辆)',
  arrivals: '到场记录',
  closures: '结案记录'
};

// ---------- 源数据行（脱敏样表结构） ----------
export interface SourceEvent {
  event_id: string;
  alarm_time: string;      // 'YYYY-MM-DD HH:mm:ss'
  event_type: string;
  district: string;
  address_text: string;    // 已去标识化
  caller_phone: string;    // 已脱敏
  priority: string;
}
export interface SourceDispatch {
  dispatch_id: string;
  event_id: string;
  resource_id: string;
  dispatch_time: string;
}
export interface SourceResource {
  resource_id: string;
  resource_type: string;
  station: string;
  capability: string; // 逗号分隔: 急救,转运,消防,危化
}
export interface SourceArrival {
  arrival_id: string;
  dispatch_id: string;
  arrive_time: string;
  arrive_site: string; // 现场 / 医院
}
export interface SourceClosure {
  closure_id: string;
  event_id: string;
  close_time: string;
  outcome: string; // 现场处置 / 送医 / 转运上级医院 / 取消
}

export interface TableRows {
  events: SourceEvent[];
  dispatches: SourceDispatch[];
  resources: SourceResource[];
  arrivals: SourceArrival[];
  closures: SourceClosure[];
}

// ---------- 字段字典 ----------
export interface FieldDef {
  name: string;
  meaning: string;
  type: 'string' | 'datetime' | 'enum' | 'number';
  role: 'identifier' | 'direct' | 'quasi' | 'derived' | 'normal';
}
export interface TableDict {
  label: string;
  fields: FieldDef[];
}
export type FieldDict = Record<TableName, TableDict>;

// ---------- 来源批次 ----------
export interface FileDesc {
  name: string;
  table: TableName;
  sha256: string;          // 登记时实算
  declaredSha256?: string; // batch.json 声明值
  hashMatch: boolean;
  rows: number;
}
export interface BatchMeta {
  key: string;        // `${batchId}@r${revision}`
  batchId: string;
  revision: number;
  note: string;
  declaredAt: string;  // batch.json 声明的发布时间
  registeredAt: string;
  files: FileDesc[];
  status: 'latest' | 'superseded';
  changes: string[];   // 修订说明
  fieldDict?: FieldDict;
}

// ---------- 关系规则 ----------
export interface RuleBounds {
  responseMaxMin: number;   // 报警->派遣 最大分钟
  travelMaxMin: number;     // 派遣->到场 最大分钟
  onSceneMaxMin: number;    // 末次到场->结案 最大分钟
  totalMaxMin: number;      // 报警->结案 最大分钟
  turnoverMin: number;      // 车辆到场后周转时间（占用区间 = [派遣, 到场+turnover]）
  transferGapMin: number;   // 转运链：上一程到场 -> 下一程派遣 最小间隔
}
export interface RuleSet {
  id: string;
  name: string;
  version: number;
  status: 'draft' | 'approved';
  bounds: RuleBounds;
  capabilityMap: Record<string, string[]>; // event_type -> 所需能力
  approvedBy?: string;
  approvedAt?: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

// ---------- 生成方案 ----------
export interface Hist { edges: number[]; counts: number[]; } // 分钟直方图

export interface PlanDistributions {
  eventTypeMix: Record<string, number>;
  districtMix: Record<string, number>;
  priorityMixByType: Record<string, Record<string, number>>;
  hourlyMix: number[]; // 24 小时报警分布
  chainPatternMixByType: Record<string, Record<string, number>>; // single/concurrent2/concurrent3/transfer2/transfer3
  outcomeMixByType: Record<string, Record<string, number>>;
  durationHists: { response: Hist; travel: Hist; onScene: Hist; total: Hist };
}

export type GenMethod = 'constraint' | 'joint-filter';

export interface PlanTolerances {
  typeMixPP: number;      // 事件类型占比允许偏差（百分点）
  histPP: number;         // 时长直方图单桶允许偏差（百分点）
  meanRelPct: number;     // 均值相对偏差 %
  volumeRelPct: number;   // 日量相对偏差 %
  nearCopyWarn: number;   // 近乎复制告警相似度
  nearCopyFail: number;   // 近乎复制判失败相似度
  kAnonymity: number;     // 声明组合最小 k
}

export interface Plan {
  id: string;
  name: string;
  version: number;
  status: 'draft' | 'approved';
  ruleSetId: string;
  ruleSetVersion: number;
  batchKey: string; // 分布学习来源批次
  method: GenMethod;
  targetEvents: number;
  seed: number;
  dateRange: { start: string; days: number };
  resourcePool: { ambulances: number; fireTrucks: number; hazmat: number };
  tolerances: PlanTolerances;
  quasiCombos: string[][]; // 已声明字段组合（独特组合检查）
  exportFields: Record<TableName, string[]>;
  distributions: PlanDistributions;
  approvedBy?: string;
  approvedAt?: string;
  approvalChecks?: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------- 生成运行 ----------
export interface Run {
  id: string;
  seq: number;
  planId: string;
  planVersion: number;
  status: 'running' | 'done' | 'failed';
  method: GenMethod;
  seed: number;
  targetEvents: number;
  batchKey: string;
  batchRevision: number;
  batchFileHashes: Record<string, string>;
  ruleSetId: string;
  ruleSetVersion: number;
  ruleSetHash: string;
  planHash: string;
  planSnapshot: Plan;
  ruleSetSnapshot: RuleSet;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  stats?: {
    events: number; dispatches: number; arrivals: number; closures: number; resources: number;
    filterRate?: number;   // 分布+筛选路线的筛选丢弃率
    candidates?: number;   // 候选总数
    dropped?: number;      // 约束路线重试后丢弃数
    throughputPerSec?: number;
  };
  outputHashes?: Record<TableName, string>;
  error?: string;
  notice?: string;
}

// ---------- 质量核验报告 ----------
export type Level = 'pass' | 'warn' | 'fail';
export interface CheckItem {
  label: string;
  level: Level;
  source?: string;
  synthetic?: string;
  tol?: string;
  detail?: string;
}
export interface ReportSection {
  key: string;
  title: string;
  level: Level;
  items: CheckItem[];
}
export interface RiskItem {
  level: 'high' | 'medium' | 'low';
  kind: string;
  message: string;
  detail?: string;
}
export interface Report {
  id: string;
  runId: string;
  createdAt: string;
  overall: 'PASS' | 'WARN' | 'FAIL';
  sections: ReportSection[];
  risks: RiskItem[];
  disclaimer: string;
  hash: string;
}

// ---------- 发布清单 ----------
export interface Manifest {
  id: string;
  runId: string;
  reportId: string;
  createdAt: string;
  createdBy: string;
  batch: { batchId: string; revision: number; batchKey: string; fileHashes: Record<string, string> };
  ruleSet: { id: string; version: number; hash: string; approvedBy?: string };
  plan: { id: string; version: number; hash: string; method: GenMethod; seed: number; targetEvents: number };
  run: { id: string; seq: number; startedAt: string; finishedAt?: string; stats?: Run['stats']; outputHashes?: Record<TableName, string> };
  report: { id: string; overall: string; hash: string; riskCount: number };
  manifestHash: string;
}

// ---------- 方案并发冲突 ----------
export interface ConflictField {
  field: string;
  yours: string;
  current: string;
}

// ---------- 生成器载荷 ----------
export interface GenPayload {
  plan: Plan;
  ruleSet: RuleSet;
  source: TableRows;
}
export interface GenResult {
  tables: TableRows;
  stats: NonNullable<Run['stats']>;
}
