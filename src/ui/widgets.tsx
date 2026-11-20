// 共享 UI 小组件

import type { Level } from '../domain/types';

export function LevelBadge({ level }: { level: Level | 'PASS' | 'WARN' | 'FAIL' | 'running' | 'done' | 'failed' | 'draft' | 'approved' | 'latest' | 'superseded' }) {
  const map: Record<string, { cls: string; text: string }> = {
    pass: { cls: 'ok', text: '通过' },
    warn: { cls: 'warn', text: '告警' },
    fail: { cls: 'bad', text: '失败' },
    PASS: { cls: 'ok', text: 'PASS' },
    WARN: { cls: 'warn', text: 'WARN' },
    FAIL: { cls: 'bad', text: 'FAIL' },
    running: { cls: 'info', text: '运行中' },
    done: { cls: 'ok', text: '已完成' },
    failed: { cls: 'bad', text: '失败' },
    draft: { cls: '', text: '草稿' },
    approved: { cls: 'ok', text: '已批准' },
    latest: { cls: 'ok', text: '当前修订' },
    superseded: { cls: 'warn', text: '已被取代' }
  };
  const m = map[level] ?? { cls: '', text: level };
  return <span className={`badge ${m.cls}`}>{m.text}</span>;
}

export function HashChip({ text, len = 12 }: { text?: string; len?: number }) {
  if (!text) return <span className="muted">-</span>;
  return <span className="mono" title={text}>{text.slice(0, len)}…</span>;
}

export function Empty({ text }: { text: string }) {
  return <div className="muted" style={{ padding: '18px 4px' }}>{text}</div>;
}
