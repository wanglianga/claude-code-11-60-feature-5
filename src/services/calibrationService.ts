// 演练场景学习效果校准：样例生成、落库、Worker 估计与报告持久化。

import { db } from '../db/db';
import type { CalibrationDataset, CalibrationReport, SamplePreset } from '../domain/calibration/types';
import { makeCalibrationDataset } from '../domain/calibration/samples';

export const SAMPLE_SEED_DEFAULT = 20251118;

/** 生成（或复用）一份内置验收样例并落库；同 preset+seed 复用既有数据集，保证可复现。 */
export async function ensureSampleDataset(
  preset: SamplePreset,
  seed = SAMPLE_SEED_DEFAULT
): Promise<CalibrationDataset> {
  const id = `DS-${preset}-${seed}`;
  const existing = await db.calibrationDatasets.get(id);
  if (existing) return existing;
  const ds = makeCalibrationDataset(preset, seed, id);
  await db.calibrationDatasets.put(ds);
  return ds;
}

export async function listDatasets(): Promise<CalibrationDataset[]> {
  const all = await db.calibrationDatasets.toArray();
  return all.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || b.id.localeCompare(a.id));
}

export async function saveDataset(ds: CalibrationDataset): Promise<void> {
  await db.calibrationDatasets.put(ds);
}

export async function runCalibrationForDataset(
  dataset: CalibrationDataset
): Promise<{ ok: true; report: CalibrationReport } | { ok: false; error: string }> {
  try {
    const body = await runCalibrationWorker(dataset);
    const report: CalibrationReport = body;
    // 报告按数据集覆盖保存（同 seed 可复现，重跑得到同一数据上的同一估计）
    await db.calibrationReports.put(report);
    return { ok: true, report };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function runCalibrationWorker(dataset: CalibrationDataset): Promise<CalibrationReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/calibration.worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('校准超时（180s）')); }, 180_000);
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'done') { clearTimeout(timer); worker.terminate(); resolve(msg.result as CalibrationReport); }
      else if (msg.type === 'error') { clearTimeout(timer); worker.terminate(); reject(new Error(msg.error)); }
    };
    worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({ type: 'calibrate', payload: dataset });
  });
}
