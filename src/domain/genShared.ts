// 生成器共享辅助：合成资源池、合成直接标识令牌、地址模板。

import type { SourceResource } from './types';
import type { Rng } from './prng';
import { pick, randInt } from './prng';

export interface PoolSpec { ambulances: number; fireTrucks: number; hazmat: number; }

const STATIONS = ['城东分站', '城西分站', '城南分站', '城北分站', '高新分站', '郊区分站'];

/** 生成全新标识的合成资源池（不复制源资源编号） */
export function buildResourcePool(spec: PoolSpec, rng: Rng, runTag: string): SourceResource[] {
  const out: SourceResource[] = [];
  let n = 0;
  const mk = (prefix: string, type: string, caps: string[], count: number) => {
    for (let i = 1; i <= count; i++) {
      n++;
      out.push({
        resource_id: `${prefix}-S${runTag}-${String(i).padStart(2, '0')}`,
        resource_type: type,
        station: STATIONS[n % STATIONS.length],
        capability: caps.join(',')
      });
    }
  };
  mk('AMB', '救护车', ['急救', '转运'], spec.ambulances);
  mk('FIRE', '消防车', ['消防', '急救'], spec.fireTrucks);
  mk('HAZ', '危化专勤车', ['危化', '消防'], spec.hazmat);
  return out;
}

const ROAD = ['建设路', '和平街', '长河大道', '梧桐巷', '临江路', '望岳街', '春晖路', '云溪路'];
const PLACE = ['某小区', '某商场', '某学校附近', '某工地', '某路口', '某园区', '某地铁站口', '某农贸市场'];

/** 合成去标识化地址（模板拼装，不逐字复制源记录） */
export function synthAddress(rng: Rng, district: string): string {
  return `${district}${pick(rng, ROAD)}${pick(rng, PLACE)}${randInt(rng, 1, 200)}号(演练)`;
}

/** 合成电话令牌：明显为演练占位，不匹配真实号码正则，也不复制源脱敏值 */
export function synthPhone(seq: number): string {
  return `SYN-PH-${String(seq).padStart(6, '0')}`;
}
