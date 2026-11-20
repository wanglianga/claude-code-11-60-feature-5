// 核验 Worker：在后台线程执行质量核验。

import { verifyQuality, type VerifyInput } from '../domain/verify';

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type !== 'verify') return;
  try {
    const result = await verifyQuality(msg.payload as VerifyInput);
    (self as unknown as Worker).postMessage({ type: 'done', result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
