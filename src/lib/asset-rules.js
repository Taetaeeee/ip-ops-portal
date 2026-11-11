// IT 자산 규칙 (순수 함수): 종류·상태 상수, 배정·반납·상태 변경 계획
//
// 상태 흐름
//   재고 ─배정→ 사용 중 ─반납(정상)→ 재고
//                    └─반납(고장)→ 수리
//   재고 ⇄ 수리,  재고·수리 → 폐기 (폐기는 마지막 상태)
//   사용 중인 자산은 상태를 바로 바꿀 수 없고 반납부터 한다.

import { cleanText } from './ticket-rules.js';

export const ASSET_TYPES = Object.freeze({
  LAPTOP: '노트북',
  DESKTOP: '데스크톱',
  PRINTER: '프린터·복합기',
  NETWORK: '네트워크 장비',
  SERVER: '서버·NAS',
});

// 자산 번호 접두어 (사번 DT- 와 겹치지 않게)
export const TYPE_PREFIX = Object.freeze({ LAPTOP: 'NB', DESKTOP: 'PC', PRINTER: 'PR', NETWORK: 'NW', SERVER: 'SV' });

// 사람에게 배정하는 종류. 나머지는 위치로 관리하는 공용 장비
export const ASSIGNABLE_TYPES = Object.freeze(['LAPTOP', 'DESKTOP']);

export const ASSET_STATUSES = Object.freeze({
  IN_USE: '사용 중',
  IN_STOCK: '재고',
  REPAIR: '수리',
  DISPOSED: '폐기',
});

// 상태 변경 API 로 바꿀 수 있는 전이 (배정·반납은 별도 동작)
export const STATUS_TRANSITIONS = Object.freeze({
  IN_STOCK: Object.freeze(['REPAIR', 'DISPOSED']),
  REPAIR: Object.freeze(['IN_STOCK', 'DISPOSED']),
  IN_USE: Object.freeze([]),
  DISPOSED: Object.freeze([]),
});

export const RETURN_CONDITIONS = Object.freeze({ IN_STOCK: '정상 (재고로)', REPAIR: '고장 (수리로)' });

const NOTE_MAX = 500;
const fail = (httpStatus, code, message, errors) => ({ ok: false, httpStatus, code, message, errors });

export const isAssetType = (v) => typeof v === 'string' && Object.hasOwn(ASSET_TYPES, v);
export const isAssetStatus = (v) => typeof v === 'string' && Object.hasOwn(ASSET_STATUSES, v);

/**
 * 배정: 재고 상태의 개인 장비만, 재직 직원에게
 * @param {{status, assetType}} asset
 * @param {object|null} openAssignment 반납 안 된 배정
 * @param {{empNo, note}} input
 * @param {{isEmployee: (empNo) => boolean}} ctx
 */
export function planAssetAssign(asset, openAssignment, input, { isEmployee }) {
  if (!ASSIGNABLE_TYPES.includes(asset.assetType)) {
    return fail(409, 'NOT_ASSIGNABLE', '공용 장비는 사람에게 배정하지 않고 위치로 관리합니다');
  }
  if (openAssignment) return fail(409, 'ALREADY_ASSIGNED', '이미 사용자가 있습니다. 먼저 반납 처리하세요');
  if (asset.status !== 'IN_STOCK') {
    return fail(409, 'NOT_IN_STOCK', `'${ASSET_STATUSES[asset.status]}' 상태의 자산은 배정할 수 없습니다 (재고만 가능)`);
  }
  const empNo = input?.empNo;
  if (typeof empNo !== 'string' || !isEmployee(empNo)) return fail(400, 'INVALID_EMPLOYEE', '배정할 직원을 골라야 합니다');
  const errors = [];
  const note = cleanText(input.note, { field: 'note', label: '메모', max: NOTE_MAX, required: false }, errors);
  if (errors.length) return fail(400, 'VALIDATION_FAILED', '입력값을 확인해 주세요', errors);
  return {
    ok: true,
    changes: { status: 'IN_USE', location: null, status_note: null },
    assignment: { empNo, note },
  };
}

/**
 * 반납: 정상이면 재고, 고장이면 수리(사유 필수)
 */
export function planAssetReturn(asset, openAssignment, input) {
  if (!openAssignment) return fail(409, 'NOT_ASSIGNED', '배정된 사용자가 없습니다');
  const condition = input?.condition;
  if (!Object.hasOwn(RETURN_CONDITIONS, condition ?? '')) {
    return fail(400, 'INVALID_CONDITION', '반납 상태(정상/고장)를 골라야 합니다');
  }
  const errors = [];
  const note = cleanText(
    input.note,
    { field: 'note', label: condition === 'REPAIR' ? '고장 내용' : '메모', max: NOTE_MAX, required: condition === 'REPAIR' },
    errors,
  );
  if (errors.length) return fail(400, 'VALIDATION_FAILED', '입력값을 확인해 주세요', errors);
  return {
    ok: true,
    changes: { status: condition, status_note: condition === 'REPAIR' ? note : null },
    closeAssignment: { id: openAssignment.id, condition, note },
  };
}

/**
 * 상태 변경: 재고⇄수리, 재고·수리 → 폐기. 수리·폐기는 사유 필수
 */
export function planAssetStatus(asset, input) {
  const to = input?.to;
  if (asset.status === 'IN_USE') return fail(409, 'IN_USE', '사용 중인 자산은 먼저 반납해야 합니다');
  if (!isAssetStatus(to) || !STATUS_TRANSITIONS[asset.status].includes(to)) {
    return fail(409, 'INVALID_TRANSITION', `'${ASSET_STATUSES[asset.status]}'에서 '${ASSET_STATUSES[to] ?? String(to)}'(으)로 바꿀 수 없습니다`);
  }
  const errors = [];
  const label = to === 'DISPOSED' ? '폐기 사유' : to === 'REPAIR' ? '수리 사유' : '메모';
  const note = cleanText(input.note, { field: 'note', label, max: NOTE_MAX, required: to !== 'IN_STOCK' }, errors);
  if (errors.length) return fail(400, 'VALIDATION_FAILED', '입력값을 확인해 주세요', errors);
  return { ok: true, changes: { status: to, status_note: to === 'IN_STOCK' ? null : note } };
}
