// IndexedDB（Dexie）：批次/规则/方案/运行/报告/清单全部本地持久化。

import Dexie, { type Table } from 'dexie';
import type { BatchMeta, RuleSet, Plan, Run, Report, Manifest, TableRows } from '../domain/types';
import type { CalibrationDataset, CalibrationReport } from '../domain/calibration/types';

export interface BatchRowsRow { key: string; tables: TableRows; }
export interface RunOutputRow { runId: string; tables: TableRows; }
export interface KvRow { key: string; value: unknown; }

export class SynthDB extends Dexie {
  batches!: Table<BatchMeta, string>;
  batchRows!: Table<BatchRowsRow, string>;
  ruleSets!: Table<RuleSet, string>;
  plans!: Table<Plan, string>;
  runs!: Table<Run, string>;
  runOutputs!: Table<RunOutputRow, string>;
  reports!: Table<Report, string>;
  manifests!: Table<Manifest, string>;
  kv!: Table<KvRow, string>;
  calibrationDatasets!: Table<CalibrationDataset, string>;
  calibrationReports!: Table<CalibrationReport, string>;

  constructor() {
    super('emerg-synth-lab');
    this.version(1).stores({
      batches: 'key, batchId, revision',
      batchRows: 'key',
      ruleSets: 'id, status',
      plans: 'id, status',
      runs: 'id, seq, planId, status',
      runOutputs: 'runId',
      reports: 'id, runId',
      manifests: 'id, runId',
      kv: 'key'
    });
    // v2：新增演练场景学习效果校准（数据集 + 报告），与既有表并存
    this.version(2).stores({
      calibrationDatasets: 'id, preset, seed',
      calibrationReports: 'id, datasetId, methodRecommended'
    });
  }
}

export const db = new SynthDB();

export async function getKv<T>(key: string): Promise<T | undefined> {
  const row = await db.kv.get(key);
  return row?.value as T | undefined;
}
export async function setKv(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}

export async function nextSeq(key: string): Promise<number> {
  const cur = (await getKv<number>(key)) ?? 0;
  const next = cur + 1;
  await setKv(key, next);
  return next;
}
