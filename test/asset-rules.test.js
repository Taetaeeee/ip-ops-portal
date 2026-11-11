import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_STATUSES,
  STATUS_TRANSITIONS,
  planAssetAssign,
  planAssetReturn,
  planAssetStatus,
} from '../src/lib/asset-rules.js';

const isEmployee = (e) => ['DT-0009', 'DT-0010'].includes(e);
const laptop = (status) => ({ id: 1, assetType: 'LAPTOP', status });
const OPEN = { id: 77, empNo: 'DT-0009' };

test('배정: 재고 상태의 개인 장비만, 재직 직원에게', () => {
  const ok = planAssetAssign(laptop('IN_STOCK'), null, { empNo: 'DT-0009', note: ' 신규 입사 ' }, { isEmployee });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.changes, { status: 'IN_USE', location: null, status_note: null });
  assert.deepEqual(ok.assignment, { empNo: 'DT-0009', note: '신규 입사' });

  for (const s of ['IN_USE', 'REPAIR', 'DISPOSED']) {
    assert.equal(planAssetAssign(laptop(s), null, { empNo: 'DT-0009' }, { isEmployee }).code, 'NOT_IN_STOCK', s);
  }
  assert.equal(planAssetAssign(laptop('IN_STOCK'), OPEN, { empNo: 'DT-0009' }, { isEmployee }).code, 'ALREADY_ASSIGNED');
  assert.equal(planAssetAssign(laptop('IN_STOCK'), null, { empNo: 'DT-9999' }, { isEmployee }).code, 'INVALID_EMPLOYEE');
  assert.equal(
    planAssetAssign({ assetType: 'PRINTER', status: 'IN_STOCK' }, null, { empNo: 'DT-0009' }, { isEmployee }).code,
    'NOT_ASSIGNABLE',
  );
});

test('반납: 정상은 재고, 고장은 수리 + 사유 필수', () => {
  const ok = planAssetReturn(laptop('IN_USE'), OPEN, { condition: 'IN_STOCK' });
  assert.deepEqual(ok.changes, { status: 'IN_STOCK', status_note: null });
  assert.equal(ok.closeAssignment.id, 77);

  assert.equal(planAssetReturn(laptop('IN_USE'), OPEN, { condition: 'REPAIR', note: '  ' }).code, 'VALIDATION_FAILED');
  const broken = planAssetReturn(laptop('IN_USE'), OPEN, { condition: 'REPAIR', note: '화면 깨짐' });
  assert.deepEqual(broken.changes, { status: 'REPAIR', status_note: '화면 깨짐' });

  assert.equal(planAssetReturn(laptop('IN_STOCK'), null, { condition: 'IN_STOCK' }).code, 'NOT_ASSIGNED');
  assert.equal(planAssetReturn(laptop('IN_USE'), OPEN, { condition: 'DISPOSED' }).code, 'INVALID_CONDITION');
});

test('상태 변경 전수 검사: 재고⇄수리, 재고·수리→폐기만 허용', () => {
  const allowed = new Set(['IN_STOCK>REPAIR', 'IN_STOCK>DISPOSED', 'REPAIR>IN_STOCK', 'REPAIR>DISPOSED']);
  for (const from of Object.keys(ASSET_STATUSES)) {
    for (const to of Object.keys(ASSET_STATUSES)) {
      const r = planAssetStatus(laptop(from), { to, note: '사유' });
      assert.equal(r.ok, allowed.has(`${from}>${to}`), `${from} → ${to}`);
    }
  }
  assert.deepEqual(STATUS_TRANSITIONS.DISPOSED, []);
});

test('사용 중 자산은 반납부터, 수리·폐기는 사유 필수, 재고 복귀는 사유 비움', () => {
  assert.equal(planAssetStatus(laptop('IN_USE'), { to: 'DISPOSED', note: 'x' }).code, 'IN_USE');
  assert.equal(planAssetStatus(laptop('IN_STOCK'), { to: 'DISPOSED' }).code, 'VALIDATION_FAILED');
  assert.equal(planAssetStatus(laptop('IN_STOCK'), { to: 'REPAIR', note: '' }).code, 'VALIDATION_FAILED');
  assert.deepEqual(planAssetStatus(laptop('REPAIR'), { to: 'IN_STOCK' }).changes, { status: 'IN_STOCK', status_note: null });
  assert.equal(planAssetStatus(laptop('IN_STOCK'), { to: '__proto__', note: 'x' }).ok, false);
});
