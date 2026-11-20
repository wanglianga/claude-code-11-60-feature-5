import { NavLink, Route, Routes } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getKv, setKv } from './db/db';
import Dashboard from './pages/Dashboard';
import Batches from './pages/Batches';
import RuleSets from './pages/RuleSets';
import Plans from './pages/Plans';
import Runs from './pages/Runs';
import Reports from './pages/Reports';
import Manifests from './pages/Manifests';
import Calibration from './pages/Calibration';

export function useOperator(): [string, (v: string) => void] {
  const op = useLiveQuery(async () => (await getKv<string>('operator')) ?? '管理员A', []);
  const set = (v: string) => void setKv('operator', v);
  return [op ?? '管理员A', set];
}

export default function App() {
  const [operator, setOperator] = useOperator();
  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">
          应急调度合成数据演练台
          <small>本地运行 · 不调用外部服务</small>
        </div>
        <NavLink to="/" end>总览</NavLink>
        <NavLink to="/batches">来源批次</NavLink>
        <NavLink to="/rulesets">关系规则</NavLink>
        <NavLink to="/plans">生成方案</NavLink>
        <NavLink to="/runs">生成运行</NavLink>
        <NavLink to="/reports">质量核验</NavLink>
        <NavLink to="/manifests">发布清单</NavLink>
        <NavLink to="/calibration">学习效果校准</NavLink>
        <div className="op-box">
          当前操作员（本地演示）
          <select value={operator} onChange={(e) => setOperator(e.target.value)}>
            <option>管理员A</option>
            <option>管理员B</option>
          </select>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/batches" element={<Batches />} />
          <Route path="/rulesets" element={<RuleSets />} />
          <Route path="/plans" element={<Plans />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/manifests" element={<Manifests />} />
          <Route path="/calibration" element={<Calibration />} />
        </Routes>
      </main>
    </div>
  );
}
