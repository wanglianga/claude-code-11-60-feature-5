// 随题样例生成脚本（确定性，种子固定）。
// 生成去标识化历史事件样例：覆盖并发派车、多级转运、罕见组合、跨午夜任务；
// r2 为“迟到源修订”：补齐迟到到场记录、修正结案时间、修订一条事件分类。
// 用法：node scripts/gen-samples.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples', 'emerg-2025-09');

// ---------- 确定性 RNG ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20250901);
const ri = (min, max) => min + Math.floor(rng() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const weighted = (items, weights) => {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
};

// ---------- 时间 ----------
const MIN = 60000;
const fmt = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// ---------- 资源 ----------
const STATIONS = ['城东分站', '城西分站', '城南分站', '城北分站', '高新分站', '郊区分站'];
const resources = [];
for (let i = 1; i <= 8; i++) resources.push({ resource_id: `AMB-${String(i).padStart(2, '0')}`, resource_type: '救护车', station: STATIONS[i % 6], capability: '急救,转运' });
for (let i = 1; i <= 4; i++) resources.push({ resource_id: `FIRE-${String(i).padStart(2, '0')}`, resource_type: '消防车', station: STATIONS[(i + 1) % 6], capability: '消防,急救' });
for (let i = 1; i <= 2; i++) resources.push({ resource_id: `HAZ-${String(i).padStart(2, '0')}`, resource_type: '危化专勤车', station: STATIONS[(i + 3) % 6], capability: '危化,消防' });

// ---------- 分布设定 ----------
const TYPE_MIX = [
  ['突发疾病', 0.30], ['外伤急救', 0.27], ['交通事故', 0.16], ['火灾', 0.09], ['危化品泄漏', 0.025], ['其他', 0.155]
];
const DISTRICTS = [
  ['城东区', 0.22], ['城西区', 0.20], ['城南区', 0.18], ['城北区', 0.16], ['高新区', 0.14], ['郊区', 0.10]
];
const HOURLY = [1.2, 0.8, 0.6, 0.5, 0.5, 0.8, 1.6, 2.6, 3.4, 3.6, 3.6, 3.4, 3.2, 3.0, 3.2, 3.4, 3.6, 3.8, 3.4, 2.8, 2.4, 2.0, 1.8, 1.5];
const CAPABILITY = { 突发疾病: ['急救'], 外伤急救: ['急救'], 交通事故: ['急救'], 火灾: ['消防'], 危化品泄漏: ['危化'], 其他: ['急救'] };
const ROAD = ['建设路', '和平街', '长河大道', '梧桐巷', '临江路', '望岳街', '春晖路', '云溪路'];
const PLACE = ['某小区', '某商场', '某学校附近', '某工地', '某路口', '某园区', '某地铁站口', '某农贸市场'];

const TURNOVER_MIN = 20;
const busy = new Map(); // resource_id -> [{start,end}]
const isFree = (rid, s, e) => !(busy.get(rid) ?? []).some((iv) => s < iv.end && iv.start < e);
const occupy = (rid, s, e) => busy.set(rid, [...(busy.get(rid) ?? []), { start: s, end: e }]);

function sampleHour() {
  const total = HOURLY.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let h = 0; h < 24; h++) { r -= HOURLY[h]; if (r <= 0) return h; }
  return 23;
}
const lognorm = (mu, sigma) => Math.exp(mu + sigma * Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-9))) * Math.cos(2 * Math.PI * rng()));

function sampleTravel(district) {
  const base = { 城东区: 2.0, 城西区: 2.0, 城南区: 2.1, 城北区: 2.1, 高新区: 2.2, 郊区: 2.6 }[district] ?? 2.1;
  return Math.max(3, Math.min(55, lognorm(base, 0.45)));
}
function sampleResponse(priority) {
  const mu = priority === 'P1' ? 0.6 : priority === 'P2' ? 1.0 : 1.3;
  return Math.max(0.5, Math.min(18, lognorm(mu, 0.5)));
}
function sampleOnScene(type) {
  const mu = { 火灾: 3.6, 危化品泄漏: 3.9, 交通事故: 3.0, 突发疾病: 2.8, 外伤急救: 2.8, 其他: 2.4 }[type] ?? 2.8;
  return Math.max(5, Math.min(200, lognorm(mu, 0.5)));
}

// ---------- 事件生成 ----------
const N_EVENTS = 132;
const START = new Date('2025-09-01T00:00:00').getTime();
const events = [], dispatches = [], arrivals = [], closures = [];
let phoneSeq = 1000;

// 强制覆盖的特定事件（罕见组合 & 跨午夜）
const forced = [];
// 罕见组合：危化品泄漏 × 郊区 × P1 × 多级转运（仅 3 起）
for (let i = 0; i < 3; i++) {
  forced.push({ type: '危化品泄漏', district: '郊区', priority: 'P1', pattern: i === 2 ? 'transfer3' : 'transfer2', day: ri(2, 27), hour: pick([1, 2, 23, 22]) });
}
// 跨午夜任务（报警在 22:30~23:55，到场/结案跨入次日）
for (let i = 0; i < 8; i++) {
  forced.push({ type: weighted(TYPE_MIX.map(t => t[0]), TYPE_MIX.map(t => t[1])), district: null, priority: null, pattern: 'single', day: ri(1, 28), hour: 23, minute: ri(30, 55) });
}

const usedSlots = new Set();
while (forced.length + events.length < N_EVENTS + forced.length && events.length < N_EVENTS) {
  const spec = forced.shift();
  const day = spec ? spec.day : ri(0, 29);
  const hour = spec ? spec.hour : sampleHour();
  const minute = spec?.minute ?? ri(0, 59);
  const alarmMs = START + day * 24 * 60 * MIN + hour * 60 * MIN + minute * MIN + ri(0, 59) * 1000;
  const slotKey = Math.round(alarmMs / (5 * MIN));
  if (usedSlots.has(slotKey)) continue;
  usedSlots.add(slotKey);

  const type = spec?.type ?? weighted(TYPE_MIX.map(t => t[0]), TYPE_MIX.map(t => t[1]));
  const district = spec?.district ?? weighted(DISTRICTS.map(d => d[0]), DISTRICTS.map(d => d[1]));
  const priority = spec?.priority ?? (() => {
    const p1 = { 火灾: 0.45, 危化品泄漏: 0.9, 交通事故: 0.3, 突发疾病: 0.15, 外伤急救: 0.18, 其他: 0.08 }[type] ?? 0.1;
    const p2 = 0.45;
    const r = rng();
    return r < p1 ? 'P1' : r < p1 + p2 ? 'P2' : 'P3';
  })();
  // 链型：火灾倾向并发派车；危化为转运；急救类小比例转运
  let pattern = spec?.pattern;
  if (!pattern) {
    if (type === '火灾') pattern = weighted(['single', 'concurrent2', 'concurrent3'], [0.25, 0.55, 0.20]);
    else if (type === '交通事故') pattern = weighted(['single', 'concurrent2', 'transfer2'], [0.78, 0.14, 0.08]);
    else if (type === '突发疾病' || type === '外伤急救') pattern = weighted(['single', 'transfer2', 'transfer3'], [0.86, 0.11, 0.03]);
    else pattern = 'single';
  }
  const nLegs = { single: 1, concurrent2: 2, concurrent3: 3, transfer2: 2, transfer3: 3 }[pattern];
  const isTransfer = pattern.startsWith('transfer');

  // 生成事件链（资源按占用区间分配，保证源数据本身占用合法）
  const legs = [];
  let prevArrive = null;
  let ok = true;
  for (let leg = 0; leg < nLegs; leg++) {
    const travel = sampleTravel(district);
    let dispatchMs;
    if (leg === 0) dispatchMs = alarmMs + sampleResponse(priority) * MIN;
    else if (isTransfer && prevArrive != null) dispatchMs = prevArrive + ri(5, 25) * MIN;
    else dispatchMs = legs[0].dispatchMs + ri(0, 3) * MIN;
    const occS = dispatchMs, occE = dispatchMs + travel * MIN + TURNOVER_MIN * MIN;
    const need = CAPABILITY[type];
    const cands = resources.filter((r) => need.every((n) => r.capability.split(',').includes(n)) && !legs.some((l) => l.resId === r.resource_id) && isFree(r.resource_id, occS, occE));
    if (cands.length === 0) { ok = false; break; }
    const res = pick(cands);
    occupy(res.resource_id, occS, occE);
    const arriveMs = dispatchMs + travel * MIN;
    legs.push({ resId: res.resource_id, dispatchMs, arriveMs });
    prevArrive = arriveMs;
  }
  if (!ok) continue;

  const lastArrive = Math.max(...legs.map((l) => l.arriveMs));
  const closeMs = lastArrive + sampleOnScene(type) * MIN;
  const outcome = isTransfer ? '转运上级医院'
    : type === '火灾' ? weighted(['现场处置', '送医', '取消'], [0.8, 0.12, 0.08])
    : type === '其他' ? weighted(['现场处置', '取消'], [0.7, 0.3])
    : weighted(['送医', '现场处置', '取消'], [0.62, 0.33, 0.05]);

  const idx = events.length + 1;
  const eid = `E${String(idx).padStart(4, '0')}`;
  phoneSeq += ri(1, 37);
  events.push({
    event_id: eid,
    alarm_time: fmt(alarmMs),
    event_type: type,
    district,
    address_text: `${district}${pick(ROAD)}${pick(PLACE)}${ri(1, 180)}号`,
    caller_phone: `1${pick(['30', '35', '37', '38', '39', '50', '51', '58', '66', '77', '80', '85', '86', '88', '89', '99'])}****${String(phoneSeq % 10000).padStart(4, '0')}`,
    priority
  });
  legs.forEach((leg, li) => {
    const did = `D${String(idx).padStart(4, '0')}-${li + 1}`;
    dispatches.push({ dispatch_id: did, event_id: eid, resource_id: leg.resId, dispatch_time: fmt(leg.dispatchMs) });
    arrivals.push({ arrival_id: `A${String(idx).padStart(4, '0')}-${li + 1}`, dispatch_id: did, arrive_time: fmt(leg.arriveMs), arrive_site: isTransfer && li > 0 ? '医院' : '现场' });
  });
  closures.push({ closure_id: `C${String(idx).padStart(4, '0')}`, event_id: eid, close_time: fmt(closeMs), outcome });
}

// 按时间排序输出
const order = events.map((e, i) => i).sort((a, b) => events[a].alarm_time.localeCompare(events[b].alarm_time));
const sortRows = (rows, key) => rows.slice().sort((a, b) => a[key].localeCompare(b[key]));
const eventsS = sortRows(events, 'event_id');
const dispatchesS = sortRows(dispatches, 'dispatch_id');
const arrivalsS = sortRows(arrivals, 'arrival_id');
const closuresS = sortRows(closures, 'closure_id');

// ---------- r1 的“待修订”数据问题（迟到源修订素材） ----------
// 1) 两条到场记录迟到未报（r1 缺失，r2 补登）
const missingArrivalIds = [arrivalsS[10]?.arrival_id, arrivalsS[77]?.arrival_id].filter(Boolean);
const arrivalsR1 = arrivalsS.filter((a) => !missingArrivalIds.includes(a.arrival_id));
// 2) 三条结案时间登记错误（早于末次到场，r2 修正）
const earlyClosureIds = [closuresS[20]?.event_id, closuresS[55]?.event_id, closuresS[101]?.event_id].filter(Boolean);
const closuresR1 = closuresS.map((c) => {
  if (!earlyClosureIds.includes(c.event_id)) return c;
  const wrong = new Date(c.close_time.replace(' ', 'T')).getTime() - ri(40, 90) * MIN;
  return { ...c, close_time: fmt(wrong) };
});
// 3) 一条事件分类待修订（r1=其他，r2=交通事故）
const reclassEventId = eventsS[66]?.event_id;
const eventsR1 = eventsS.map((e) => (e.event_id === reclassEventId ? { ...e, event_type: '其他' } : e));
const eventsR2 = eventsS.map((e) => (e.event_id === reclassEventId ? { ...e, event_type: '交通事故' } : e));

// ---------- 输出 ----------
const COLS = {
  events: ['event_id', 'alarm_time', 'event_type', 'district', 'address_text', 'caller_phone', 'priority'],
  dispatches: ['dispatch_id', 'event_id', 'resource_id', 'dispatch_time'],
  resources: ['resource_id', 'resource_type', 'station', 'capability'],
  arrivals: ['arrival_id', 'dispatch_id', 'arrive_time', 'arrive_site'],
  closures: ['closure_id', 'event_id', 'close_time', 'outcome']
};
const toCsv = (rows, cols) => {
  const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(String(r[c] ?? ''))).join(','))].join('\n') + '\n';
};
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const FIELDS = {
  tables: {
    events: {
      label: '报警事件',
      fields: [
        { name: 'event_id', meaning: '事件编号', type: 'string', role: 'identifier' },
        { name: 'alarm_time', meaning: '报警时间', type: 'datetime', role: 'quasi' },
        { name: 'event_type', meaning: '事件类型', type: 'enum', role: 'quasi' },
        { name: 'district', meaning: '行政区', type: 'enum', role: 'quasi' },
        { name: 'address_text', meaning: '去标识化地址', type: 'string', role: 'direct' },
        { name: 'caller_phone', meaning: '报警电话（已脱敏）', type: 'string', role: 'direct' },
        { name: 'priority', meaning: '优先级', type: 'enum', role: 'quasi' }
      ]
    },
    dispatches: {
      label: '派遣记录',
      fields: [
        { name: 'dispatch_id', meaning: '派遣编号', type: 'string', role: 'identifier' },
        { name: 'event_id', meaning: '所属事件', type: 'string', role: 'normal' },
        { name: 'resource_id', meaning: '派遣资源', type: 'string', role: 'normal' },
        { name: 'dispatch_time', meaning: '派遣时间', type: 'datetime', role: 'quasi' }
      ]
    },
    resources: {
      label: '资源(车辆)',
      fields: [
        { name: 'resource_id', meaning: '资源编号', type: 'string', role: 'identifier' },
        { name: 'resource_type', meaning: '资源类型', type: 'enum', role: 'quasi' },
        { name: 'station', meaning: '所属站点', type: 'enum', role: 'quasi' },
        { name: 'capability', meaning: '能力（逗号分隔）', type: 'string', role: 'normal' }
      ]
    },
    arrivals: {
      label: '到场记录',
      fields: [
        { name: 'arrival_id', meaning: '到场编号', type: 'string', role: 'identifier' },
        { name: 'dispatch_id', meaning: '所属派遣', type: 'string', role: 'normal' },
        { name: 'arrive_time', meaning: '到场时间', type: 'datetime', role: 'quasi' },
        { name: 'arrive_site', meaning: '到场位置（现场/医院）', type: 'enum', role: 'normal' }
      ]
    },
    closures: {
      label: '结案记录',
      fields: [
        { name: 'closure_id', meaning: '结案编号', type: 'string', role: 'identifier' },
        { name: 'event_id', meaning: '所属事件', type: 'string', role: 'normal' },
        { name: 'close_time', meaning: '结案时间', type: 'datetime', role: 'quasi' },
        { name: 'outcome', meaning: '结案方式', type: 'enum', role: 'quasi' }
      ]
    }
  }
};

function writeBatch(dir, revision, declaredAt, note, changes, tables) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const [table, rows] of Object.entries(tables)) {
    const csv = toCsv(rows, COLS[table]);
    const name = `${table}.csv`;
    writeFileSync(join(dir, name), csv);
    files.push({ name, table, sha256: sha256(csv), rows: rows.length });
  }
  writeFileSync(join(dir, 'fields.json'), JSON.stringify(FIELDS, null, 2));
  const batch = {
    batchId: 'emerg-2025-09',
    revision,
    declaredAt,
    note,
    changes,
    files
  };
  writeFileSync(join(dir, 'batch.json'), JSON.stringify(batch, null, 2));
  return files;
}

const r1Files = writeBatch(
  join(ROOT, 'r1'), 1, '2025-10-08T09:00:00+08:00',
  '2025年9月去标识化调度数据（首批登记）',
  [],
  { events: eventsR1, dispatches: dispatchesS, resources, arrivals: arrivalsR1, closures: closuresR1 }
);
writeBatch(
  join(ROOT, 'r2'), 2, '2025-10-15T14:30:00+08:00',
  '2025年9月去标识化调度数据（迟到源修订 r2）',
  [
    `补登 2 条迟到到场记录（${missingArrivalIds.join('、')}）`,
    `修正 3 条结案时间登记错误（事件 ${earlyClosureIds.join('、')}，原值早于末次到场）`,
    `修订 1 条事件分类（${reclassEventId}：其他 → 交通事故）`
  ],
  { events: eventsR2, dispatches: dispatchesS, resources, arrivals: arrivalsS, closures: closuresS }
);

console.log('样例生成完成：');
console.log(`  r1: ${r1Files.map((f) => `${f.name}(${f.rows})`).join(' ')}`);
console.log(`  缺失到场(r1): ${missingArrivalIds.join(', ')}`);
console.log(`  结案待修正(r1): ${earlyClosureIds.join(', ')}`);
console.log(`  分类待修订: ${reclassEventId}`);
console.log(`  事件总数: ${events.length}, 派遣: ${dispatches.length}, 到场(r2): ${arrivalsS.length}, 结案: ${closures.length}`);
