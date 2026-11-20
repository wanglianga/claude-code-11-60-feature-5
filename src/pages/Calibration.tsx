import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { ensureSampleDataset, runCalibrationForDataset, SAMPLE_SEED_DEFAULT, saveDataset } from '../services/calibrationService';
import { PRESET_LABELS, PRESETS, makeCalibrationDataset } from '../domain/calibration/samples';
import { LevelBadge, Empty, HashChip } from '../ui/widgets';
import { useToast } from '../ui/toast';
import type {
  CalibrationDataset,
  CalibrationReport,
  ArrangementPrediction,
  EffectEstimate,
  ScenarioCalibrationRow,
  SensitivityRow
} from '../domain/calibration/types';
import { ARRANGEMENT_LABELS, FEATURE_LABELS } from '../domain/calibration/types';

function fmt(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}
function fmtCI(ci: [number, number], digits = 1): string {
  if (!Number.isFinite(ci[0]) || !Number.isFinite(ci[1])) return '区间不可用';
  return `[${ci[0].toFixed(digits)}, ${ci[1].toFixed(digits)}]`;
}
function fmtPP(x: number, ci: [number, number]): string {
  if (!Number.isFinite(x)) return '—';
  return `${x > 0 ? '+' : ''}${x.toFixed(1)} pp`;
}

export default function Calibration() {
  const toast = useToast();
  const datasets = useLiveQuery(() => db.calibrationDatasets.toArray(), []);
  const reports = useLiveQuery(() => db.calibrationReports.toArray(), []);
  const [seed, setSeed] = useState(SAMPLE_SEED_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [selectedDataset, setSelectedDataset] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<string | null>(null);

  const sortedDatasets = useMemo(
    () => (datasets ?? []).slice().sort((a, b) => b.seed - a.seed || b.preset.localeCompare(a.preset)),
    [datasets]
  );
  const sortedReports = useMemo(
    () => (reports ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [reports]
  );

  // 默认选中最近一份报告
  useEffect(() => {
    if (!selectedReport && sortedReports.length > 0) setSelectedReport(sortedReports[0].id);
  }, [selectedReport, sortedReports]);

  const report = sortedReports.find((r) => r.id === selectedReport);

  const generate = async (preset: keyof typeof PRESET_LABELS) => {
    setBusy(true);
    try {
      const ds = await ensureSampleDataset(preset, seed);
      setSelectedDataset(ds.id);
      const res = await runCalibrationForDataset(ds);
      if (res.ok) {
        setSelectedReport(res.report.id);
        toast(`校准完成：${PRESET_LABELS[preset]}`, 'ok');
      } else toast(res.error, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const rerun = async (ds: CalibrationDataset) => {
    setBusy(true);
    try {
      const res = await runCalibrationForDataset(ds);
      if (res.ok) { setSelectedReport(res.report.id); toast('已按当前数据重跑校准', 'ok'); }
      else toast(res.error, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const loadAll = async () => {
    setBusy(true);
    try {
      let last: CalibrationReport | null = null;
      for (const preset of PRESETS) {
        const ds = await ensureSampleDataset(preset, seed);
        const res = await runCalibrationForDataset(ds);
        if (res.ok) last = res.report;
        else throw new Error(res.error);
      }
      if (last) setSelectedReport(last.id);
      toast('已生成并校准四类验收样例', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  const ds = sortedDatasets.find((d) => d.id === selectedDataset) ?? sortedDatasets[0];

  return (
    <div>
      <h1 className="page-title">学习效果校准</h1>
      <p className="page-sub">
        把合成演练包的场景特征与匿名学员的练习顺序、决策步骤、用时、标准处置依据及后续迁移测验关联，
        估计场景难度、区分度，以及不同训练安排对<strong>未见场景处置正确率</strong>的影响。
        <span className="muted">不生成个人能力排名；学员编号为本地匿名标识。</span>
      </p>

      <div className="notice info">
        <b>两种估计路径，估计同一个量。</b>{' '}
        <b>配对估计</b>：在随机交叉数据上对同一学员做按场景分层的成对对比，口径直观、假设少；但学员未完成成对练习时可用样本会减少，一次只能吸收一个匹配层，难同时分离多个场景属性。
        <b>层级反应模型</b>：联合估计学员基线、场景难度与迁移表现，能利用不平衡与部分缺测，却依赖模型结构，须做敏感性检查。
        选择依据是<strong>缺测与交叉覆盖程度、场景属性数量、所需的可解释粒度</strong>。
      </div>

      <div className="card">
        <h3>生成 / 校准样例</h3>
        <div className="btn-row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>随机种子（同种子可复现）</span>
            <input type="number" value={seed} onChange={(e) => setSeed(Math.floor(Number(e.target.value)))} />
          </label>
          <button className="primary" disabled={busy} onClick={() => void loadAll()}>一键生成四类验收样例并校准</button>
          {busy && <span className="muted small">校准中…（自助法在 WebWorker 执行）</span>}
        </div>
        <div className="btn-row" style={{ marginTop: 10 }}>
          {PRESETS.map((p) => (
            <button key={p} disabled={busy} onClick={() => void generate(p)}>生成「{PRESET_LABELS[p]}」</button>
          ))}
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          验收覆盖：重复场景、乱序训练、未见迁移题、日志缺失、包版本更新、答案泄漏。四类样例分别用于：
          综合（全部限制）、干净交叉（配对样本充足）、缺失为主（配对样本减少）、泄漏为主（泛化证据受限）。
        </p>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>数据集</h3>
          {sortedDatasets.length === 0 ? <Empty text="尚无数据集，请先生成样例" /> : (
            <table className="data">
              <thead><tr><th>数据集</th><th>学员</th><th>尝试</th><th>种子</th><th>操作</th></tr></thead>
              <tbody>
                {sortedDatasets.map((d) => (
                  <tr key={d.id}>
                    <td><b>{d.name}</b><div className="small muted mono">{d.id}</div></td>
                    <td>{d.trainees.length}</td>
                    <td>{d.attempts.length}</td>
                    <td>{d.seed}</td>
                    <td>
                      <div className="btn-row">
                        <button onClick={() => setSelectedDataset(d.id)}>详情</button>
                        <button disabled={busy} onClick={() => void rerun(d)}>重跑校准</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h3>校准报告</h3>
          {sortedReports.length === 0 ? <Empty text="尚无报告" /> : (
            <table className="data">
              <thead><tr><th>报告</th><th>主路径</th><th>报告哈希</th><th>操作</th></tr></thead>
              <tbody>
                {sortedReports.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.datasetName}</b><div className="small muted">{new Date(r.createdAt).toLocaleString()}</div></td>
                    <td><LevelBadge level={r.methodRecommended === 'paired' ? 'pass' : 'warn'} />{' '}
                      {r.methodRecommended === 'paired' ? '配对估计' : '层级模型'}</td>
                    <td><HashChip text={r.hash} len={10} /></td>
                    <td><button onClick={() => setSelectedReport(r.id)}>{selectedReport === r.id ? '当前' : '查看'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {ds && <DatasetDetail key={ds.id} dataset={ds} />}
      {report && <ReportView key={report.id} report={report} />}

      <div className="notice warn small">
        <b>证据边界：</b>同一学员的重复尝试不作为独立样本；迁移测验答案泄漏或使用练习实例时不作泛化证据；
        学员退出或更换包版本时保留可用性缺口；场景规则更新后新旧训练效果分开估计。
        本页面只报告训练安排与场景特征的平均效应和区间，不对个人排序或下结论。
      </div>
    </div>
  );
}

function DatasetDetail({ dataset }: { dataset: CalibrationDataset }) {
  const [tab, setTab] = useState<'features' | 'coverage' | 'notes'>('features');
  const fams = dataset.families;
  const features = Object.keys(FEATURE_LABELS) as (keyof typeof FEATURE_LABELS)[];
  return (
    <div className="card">
      <h3>数据集详情：{dataset.name}</h3>
      <div className="grid4">
        <div><div className="stat-num">{dataset.trainees.length}</div><div className="stat-label">匿名学员</div></div>
        <div><div className="stat-num">{dataset.attempts.length}</div><div className="stat-label">练习/迁移尝试</div></div>
        <div><div className="stat-num">{dataset.families.length}</div><div className="stat-label">场景家族（含版本）</div></div>
        <div><div className="stat-num">{dataset.epochs.length}</div><div className="stat-label">演练包 / 规则版本</div></div>
      </div>
      <div className="tabs" style={{ marginTop: 12 }}>
        <button className={tab === 'features' ? 'active' : ''} onClick={() => setTab('features')}>场景特征 × 标准处置依据</button>
        <button className={tab === 'coverage' ? 'active' : ''} onClick={() => setTab('coverage')}>练习顺序 / 退出 / 版本</button>
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>样例说明</button>
      </div>

      {tab === 'features' && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>场景家族</th><th>版本</th>
                {features.map((f) => <th key={f}>{FEATURE_LABELS[f]}</th>)}
                <th>标准处置依据</th>
              </tr>
            </thead>
            <tbody>
              {fams.map((f) => (
                <tr key={f.key}>
                  <td className="small">{f.label}</td>
                  <td className="small mono">{f.epoch}</td>
                  {features.map((k) => <td key={k} className="small">{String(f.feature[k])}</td>)}
                  <td className="small">{f.standardBasis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'coverage' && (
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead><tr><th>匿名学员</th><th>训练安排</th><th>入选版本</th><th>练习条数</th><th>缺口（练习/迁移）</th><th>退出</th><th>版本切换</th></tr></thead>
            <tbody>
              {dataset.trainees.map((t) => {
                const practice = dataset.attempts.filter((a) => a.traineeId === t.id && a.phase === 'practice').length;
                return (
                  <tr key={t.id}>
                    <td className="mono">{t.id}</td>
                    <td>{t.arrangement === 'varied' ? '交叉随机' : '重复场景'}</td>
                    <td className="small mono">{t.enrolledEpoch}</td>
                    <td>{practice} / {t.expectedPractice}</td>
                    <td>{t.missingPracticeLogs} / {t.missingTransferLogs}</td>
                    <td>{t.withdrew ? <span className="badge warn">退出</span> : '—'}</td>
                    <td>{t.versionSwitched ? <span className="badge info">切换</span> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'notes' && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {dataset.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

function ReportView({ report }: { report: CalibrationReport }) {
  return (
    <div>
      <div className="card">
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>校准报告：{report.datasetName}</h3>
          <div className="btn-row">
            <LevelBadge level={report.methodRecommended === 'paired' ? 'pass' : 'warn'} />
            <span className="small muted">主估计：{report.methodRecommended === 'paired' ? '配对估计' : '层级反应模型'}</span>
          </div>
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          数据集种子 {report.datasetSeed} · 报告哈希 <HashChip text={report.hash} len={16} /> · 生成 {new Date(report.createdAt).toLocaleString()}
        </div>
        <div className="notice info" style={{ marginTop: 12 }}>
          <b>方法选择依据：</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{report.recommendationReason.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      </div>

      <EffectCards report={report} />
      <PredictionCards report={report} />
      <ScenarioTable report={report} />
      <SensitivityTable report={report} />
      <DiagnosticsCard report={report} />
      <WarningsCard report={report} />
    </div>
  );
}

function EffectCards({ report }: { report: CalibrationReport }) {
  return (
    <div className="card">
      <h3>训练安排对未见场景处置正确率的效应（varied − repeat，百分点）</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        两条路径都估计同一个量。配对路径为按场景家族分层加权的成对对比；层级路径为模型平均边际效应
        （安排主效应 + 迁移阶段交互）。区间来自学员聚类自助法。
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="data">
          <thead>
            <tr><th>版本</th><th>路径</th><th>效应</th><th>95% 区间</th><th>比值比</th><th>独立单位</th><th>说明</th></tr>
          </thead>
          <tbody>
            {report.effects.map((e) => (
              <tr key={`${e.epoch}-${e.path}`}>
                <td className="small mono">{e.epoch}</td>
                <td>{e.path === 'paired' ? '配对估计' : '层级模型'}</td>
                <td><b>{fmtPP(e.effectPP, e.ci95)}</b></td>
                <td className="small">{fmtCI(e.ci95)}</td>
                <td className="small">{e.oddsRatio === null ? '—' : e.oddsRatio.toFixed(2)}</td>
                <td className="small">{e.nTrainees} 名学员 / {e.nObservations} 条观测</td>
                <td className="small">{e.note ?? e.independence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        学员独立性：{report.effects[0]?.independence ?? '以学员为单位'}。
      </p>
    </div>
  );
}

function PredictionCards({ report }: { report: CalibrationReport }) {
  return (
    <div className="card">
      <h3>不同训练安排对未见场景正确率的估计</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        用主估计（{report.methodRecommended === 'paired' ? '配对' : '层级模型'}）给出各安排下平均学员在未见场景上的预期正确率；区间为学员聚类自助法。
      </p>
      <div className="grid2" style={{ gap: 12 }}>
        {report.predictions.map((p) => (
          <PredictionTile key={`${p.epoch}-${p.arrangement}`} pred={p} />
        ))}
      </div>
    </div>
  );
}

function PredictionTile({ pred }: { pred: ArrangementPrediction }) {
  const pct = Number.isFinite(pred.unseenCorrectness) ? pred.unseenCorrectness : NaN;
  const width = Number.isFinite(pct) ? Math.max(2, Math.min(100, pct)) : 0;
  return (
    <div className="card" style={{ background: '#fafbfe', marginBottom: 0 }}>
      <div className="small muted">{pred.epoch} · {ARRANGEMENT_LABELS[pred.arrangement]}</div>
      <div className="stat-num">{Number.isFinite(pct) ? `${pct.toFixed(1)}%` : '—'}</div>
      <div className="small muted">未见场景预期正确率 · 区间 {fmtCI(pred.ci95)} · {pred.nTrainees} 名学员</div>
      <div className="progress-track" style={{ marginTop: 8 }}>
        <div className="progress-bar" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function ScenarioTable({ report }: { report: CalibrationReport }) {
  const [epoch, setEpoch] = useState<string>(report.scenarios[0]?.epoch ?? '');
  const epochs = [...new Set(report.scenarios.map((s) => s.epoch))];
  const rows = report.scenarios.filter((s) => s.epoch === epoch);
  const maxAbsB = Math.max(1e-6, ...rows.map((r) => Math.abs(Number.isFinite(r.difficulty) ? r.difficulty : 0)));
  return (
    <div className="card">
      <h3>场景校准：难度与区分度</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        难度 b（logit 尺度，越大越难）；区分度 a 为该场景得分与学员其余场景得分的相关（越接近 1 越能拉开迁移表现）。
        练习正确率按学员先聚合，重复尝试不重复计数。
      </p>
      <div className="tabs">
        {epochs.map((e) => <button key={e} className={epoch === e ? 'active' : ''} onClick={() => setEpoch(e)}>{e}</button>)}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data">
          <thead><tr><th>场景</th><th>类型 / 链型</th><th>练习正确率</th><th>难度 b</th><th>区分度 a</th><th>练习学员</th><th>迁移题数</th><th>可识别性</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.familyKey}>
                <td className="small">{r.label}</td>
                <td className="small">{r.eventType} / {r.chainPattern}</td>
                <td className="small">{(r.accuracy * 100).toFixed(0)}%</td>
                <td className="small">
                  {Number.isFinite(r.difficulty) ? r.difficulty.toFixed(2) : '—'}
                  <div className="progress-track" style={{ width: 70, marginTop: 3 }}>
                    <div className="progress-bar" style={{
                      width: `${Number.isFinite(r.difficulty) ? Math.min(100, Math.abs(r.difficulty) / maxAbsB * 100) : 0}%`,
                      background: r.difficulty >= 0 ? 'var(--warn)' : 'var(--ok)'
                    }} />
                  </div>
                </td>
                <td className="small">{r.discrimination === null ? '样本不足' : r.discrimination.toFixed(2)}</td>
                <td className="small">{r.practiceTrainees}</td>
                <td className="small">{r.transferItems}</td>
                <td><LevelBadge level={r.identifiability === '可估' ? 'pass' : r.identifiability === '样本不足' ? 'warn' : 'warn'} />{' '}
                  <span className="small muted">{r.identifiability} · 来源:{r.source === 'paired' ? '配对' : '层级'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SensitivityTable({ report }: { report: CalibrationReport }) {
  const epochs = [...new Set(report.sensitivity.map((s) => s.epoch))];
  const [epoch, setEpoch] = useState(epochs[0] ?? '');
  const rows = report.sensitivity.filter((s) => s.epoch === epoch);
  return (
    <div className="card">
      <h3>敏感性检查</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        层级模型依赖模型结构，需检查结论对“泄漏题、练习实例、完整案例、强正则”的敏感性；并对比配对路径与未控制场景的朴素均值差。
      </p>
      <div className="tabs">
        {epochs.map((e) => <button key={e} className={epoch === e ? 'active' : ''} onClick={() => setEpoch(e)}>{e}</button>)}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data">
          <thead><tr><th>变体</th><th>路径</th><th>效应</th><th>95% 区间</th><th>学员 / 观测</th><th>说明</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.variant}-${i}`}>
                <td className="small">{r.variant}</td>
                <td className="small">{r.path === 'unadjusted' ? '未调整' : r.path === 'paired' ? '配对' : '层级'}</td>
                <td className="small">{r.effectPP === null ? '—' : fmtPP(r.effectPP, r.ci95 ?? [NaN, NaN])}</td>
                <td className="small">{r.ci95 ? fmtCI(r.ci95) : '—'}</td>
                <td className="small">{r.nTrainees} / {r.nObservations}</td>
                <td className="small">{r.finding}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiagnosticsCard({ report }: { report: CalibrationReport }) {
  const d = report.diagnostics;
  return (
    <div className="card">
      <h3>诊断：交叉覆盖、缺测与证据限制</h3>
      <div className="grid4" style={{ marginBottom: 10 }}>
        <div><div className="stat-num">{d.totals.trainees}</div><div className="stat-label">匿名学员</div></div>
        <div><div className="stat-num">{d.totals.families}</div><div className="stat-label">场景家族</div></div>
        <div><div className="stat-num">{d.independentAttributeCount} / {d.attributeCount}</div><div className="stat-label">独立属性 / 总属性</div></div>
        <div><div className="stat-num">{(d.recommendation.pairedCoverage * 100).toFixed(0)}%</div><div className="stat-label">配对覆盖率（最低）</div></div>
      </div>
      <table className="data">
        <thead><tr><th>版本</th><th>学员</th><th>练习</th><th>可用迁移</th><th>配对覆盖</th><th>重复尝试</th><th>缺测（练习/迁移）</th><th>退出</th><th>版本切换</th><th>泄漏题</th><th>练习实例</th></tr></thead>
        <tbody>
          {d.epochs.map((e) => (
            <tr key={e.epoch}>
              <td className="small mono">{e.epoch}<div className="muted">规则 v{e.ruleVersion} · 包 v{e.packageVersion}</div></td>
              <td>{e.trainees}</td>
              <td>{e.practiceAttempts}</td>
              <td>{e.eligibleTransferAttempts}</td>
              <td>{e.pairedTrainees} / {(e.pairedCoverage * 100).toFixed(0)}%</td>
              <td>{e.repeatedAttempts}</td>
              <td>{e.missingPracticeLogs} / {e.missingTransferLogs}</td>
              <td>{e.withdrewTrainees}</td>
              <td>{e.versionSwitchedTrainees}</td>
              <td>{e.leakedTransferItems}</td>
              <td>{e.seenInstanceItems}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ marginTop: 8 }}>
        冗余属性（由其他属性完全决定，不重复计入独立属性）：{d.redundantAttributes.length === 0 ? '无' : d.redundantAttributes.map((k) => FEATURE_LABELS[k]).join('、')}。
        乱序核查：{d.shuffleCheck.filter((s) => !s.shuffled).length === 0
          ? '交叉训练学员练习顺序均体现乱序'
          : `${d.shuffleCheck.filter((s) => !s.shuffled).length} 名交叉训练学员未体现有效乱序`}。
      </p>
      <div className="small muted">排除口径：学员可用性缺口 {report.exclusions.completeCaseTrainees}/{report.exclusions.allTrainees} 名有可用迁移记录；泄漏题 {report.exclusions.leakedTransferItems}、练习实例 {report.exclusions.seenInstanceItems}、退出后迁移 {report.exclusions.withdrawnTransferAttempts} 条不计入泛化证据。</div>
    </div>
  );
}

function WarningsCard({ report }: { report: CalibrationReport }) {
  return (
    <div className="card">
      <h3>证据限制与警告</h3>
      {report.warnings.length > 0 ? (
        <div className="notice warn">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      ) : <div className="notice ok">当前样例未触发额外限制提示。</div>}
      <div className="notice info small" style={{ marginBottom: 0 }}>
        <b>解读边界：</b>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{report.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
        <div style={{ marginTop: 6 }}>{report.noRankingStatement}</div>
      </div>
    </div>
  );
}
