// 디렉터리 화면 공통: 계정 상태 배지
import { el } from './common.js';

export function accountBadges(u) {
  const badges = [];
  badges.push(el('span', { class: `badge ${u.enabled ? 'acct-enabled' : 'acct-disabled'}`, text: u.enabled ? '활성' : '비활성' }));
  if (u.lockedOut) badges.push(el('span', { class: 'badge acct-locked', text: '잠김' }));
  if (u.kind === 'SERVICE') badges.push(el('span', { class: 'badge', text: '서비스 계정' }));
  if (u.enabled && !u.pwdLastSet && u.kind === 'PERSON') badges.push(el('span', { class: 'badge', text: '비밀번호 변경 필요' }));
  return el('span', { class: 'badges' }, badges);
}
