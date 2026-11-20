// 校准 Worker：在后台线程执行两条估计路径与敏感性检查（自助法较重）。

import { runCalibration } from '../domain/calibration/estimate';
import type { CalibrationDataset } from '../domain/calibration/types';

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type !== 'calibrate') return;
  try {
    const result = await runCalibration(msg.payload as CalibrationDataset);
    (self as unknown as Worker).postMessage({ type: 'done', result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
