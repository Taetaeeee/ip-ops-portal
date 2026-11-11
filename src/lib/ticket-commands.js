// 티켓 작업 계획 (순수 함수).
//
// 각 함수는 "현재 티켓 + 입력 + 맥락(시각·작업자)"을 받아
//   실패: { ok: false, httpStatus, code, message, errors? }
//   성공: { ok: true, changes: {DB 열: 값}, events: [이력], faq? }
// 를 돌려준다. DB에 쓰는 일은 하지 않는다. 그래서 규칙을 DB 없이 테스트할 수 있다.
//
// ticket 객체 모양(helpdesk.js 의 rowToTicket):
// { id, requesterEmpNo, category, priority, title, symptom, status, assigneeEmpNo,
//   createdAt: Date, slaDueAt: Date, slaPausedMinutes, holdStartedAt: Date|null,
//   resolvedAt: Date|null, cause, actionTaken, verification, incidentUrl, version }

import { canTransition, cleanText, validateNewTicket, validateResolution, LIMITS, STATUSES, ticketNo } from './ticket-rules.js';
import { computeDueAt, resumeSla } from './sla.js';
import { validateIncidentLink } from './link-rules.js';

const fail = (httpStatus, code, message, errors) => ({ ok: false, httpStatus, code, message, errors });
const iso = (d) => (d ? d.toISOString() : null);

/** 접수 */
export function planCreate(input, { now, requesterEmpNo, cfg }) {
  const v = validateNewTicket(input);
  if (!v.ok) return fail(400, 'VALIDATION_FAILED', '입력값을 확인해 주세요', v.errors);
  const nowIso = iso(now);
  return {
    ok: true,
    row: {
      requester_emp_no: requesterEmpNo,
      category: v.value.category,
      priority: v.value.priority,
      title: v.value.title,
      symptom: v.value.symptom,
      status: 'RECEIVED',
      created_at: nowIso,
      updated_at: nowIso,
      sla_due_at: iso(computeDueAt(now, v.value.priority, 0, cfg)),
    },
    events: [{ eventType: 'CREATED', fromStatus: null, toStatus: 'RECEIVED', note: null, data: null }],
  };
}

/** 배정·재배정. 접수 상태에서 배정하면 상태도 '배정'으로 바뀐다. */
export function planAssign(ticket, input, { assigneeEmpNos }) {
  if (ticket.status === 'RESOLVED') return fail(409, 'TICKET_CLOSED', '완료된 티켓은 배정을 바꿀 수 없습니다');
  const assignee = input?.assigneeEmpNo;
  if (typeof assignee !== 'string' || !assigneeEmpNos.includes(assignee)) {
    return fail(400, 'INVALID_ASSIGNEE', '담당자는 IT 담당자 목록에서 골라야 합니다');
  }
  if (assignee === ticket.assigneeEmpNo) return fail(409, 'ALREADY_ASSIGNED', '이미 그 담당자에게 배정돼 있습니다');

  const events = [
    {
      eventType: 'ASSIGNED',
      fromStatus: null,
      toStatus: null,
      note: null,
      data: { from: ticket.assigneeEmpNo ?? null, to: assignee },
    },
  ];
  const changes = { assignee_emp_no: assignee };
  if (ticket.status === 'RECEIVED') {
    changes.status = 'ASSIGNED';
    events.push({ eventType: 'STATUS_CHANGED', fromStatus: 'RECEIVED', toStatus: 'ASSIGNED', note: null, data: null });
  }
  return { ok: true, changes, events };
}

/**
 * 상태 변경 (IT 담당자). 배정은 planAssign 으로만 한다.
 * - 처리 중 → 보류: 사유(note) 필수, 시계 정지 시작
 * - 보류 → 처리 중: 멈춘 시간만큼 기한을 다시 계산
 * - 처리 중 → 완료: 원인·조치·검증 결과 필수
 */
export function planStatusChange(ticket, input, { now, cfg }) {
  const to = input?.to;
  const from = ticket.status;
  if (to === 'ASSIGNED') return fail(400, 'USE_ASSIGN', '배정은 담당자 지정으로 합니다');
  if (!canTransition(from, to)) {
    const fromLabel = STATUSES[from] ?? from;
    const toLabel = STATUSES[to] ?? String(to);
    return fail(409, 'INVALID_TRANSITION', `'${fromLabel}'에서 '${toLabel}'(으)로 바꿀 수 없습니다`);
  }
  if (!ticket.assigneeEmpNo) return fail(409, 'NO_ASSIGNEE', '담당자가 없습니다');

  const errors = [];
  const note = cleanText(
    input.note,
    { field: 'note', label: to === 'ON_HOLD' ? '보류 사유' : '메모', max: LIMITS.note, required: to === 'ON_HOLD' },
    errors,
  );
  if (errors.length) return fail(400, 'VALIDATION_FAILED', '입력값을 확인해 주세요', errors);

  const changes = { status: to };
  const event = { eventType: 'STATUS_CHANGED', fromStatus: from, toStatus: to, note, data: null };

  if (to === 'ON_HOLD') {
    changes.hold_started_at = iso(now);
  } else if (from === 'ON_HOLD' && to === 'IN_PROGRESS') {
    const r = resumeSla(
      {
        createdAt: ticket.createdAt,
        priority: ticket.priority,
        pausedMinutes: ticket.slaPausedMinutes,
        holdStartedAt: ticket.holdStartedAt,
      },
      now,
      cfg,
    );
    changes.hold_started_at = null;
    changes.sla_paused_minutes = r.pausedMinutes;
    changes.sla_due_at = iso(r.dueAt);
    event.data = { pausedMinutesAdded: r.addedMinutes, newDueAt: iso(r.dueAt) };
  } else if (to === 'RESOLVED') {
    const v = validateResolution(input);
    if (!v.ok) return fail(400, 'RESOLUTION_REQUIRED', '완료하려면 원인·조치·검증 결과를 모두 입력해야 합니다', v.errors);
    changes.resolved_at = iso(now);
    changes.cause = v.value.cause;
    changes.action_taken = v.value.action;
    changes.verification = v.value.verification;
    event.data = v.value;
  }
  return { ok: true, changes, events: [event] };
}

/** 처리 메모. 완료된 티켓에는 남기지 않는다. */
export function planNote(ticket, input) {
  if (ticket.status === 'RESOLVED') return fail(409, 'TICKET_CLOSED', '완료된 티켓에는 메모를 남길 수 없습니다');
  const errors = [];
  const note = cleanText(input?.note, { field: 'note', label: '메모', max: LIMITS.note }, errors);
  if (errors.length) return fail(400, 'VALIDATION_FAILED', '입력값을 확인해 주세요', errors);
  return { ok: true, changes: {}, events: [{ eventType: 'NOTE', fromStatus: null, toStatus: null, note, data: null }] };
}

/** B 장애 링크 저장·삭제 */
export function planLinkChange(ticket, input, { baseUrl }) {
  const v = validateIncidentLink(input?.url, baseUrl);
  if (!v.ok) return fail(400, 'INVALID_LINK', v.message);
  if (v.value === (ticket.incidentUrl ?? null)) return fail(409, 'NO_CHANGE', '바뀐 내용이 없습니다');
  return {
    ok: true,
    changes: { incident_url: v.value },
    events: [
      {
        eventType: 'LINK_CHANGED',
        fromStatus: null,
        toStatus: null,
        note: null,
        data: { kind: 'incident', from: ticket.incidentUrl ?? null, to: v.value },
      },
    ],
  };
}

/**
 * 관련 자산 연결·해제 (3단계).
 * 이력은 B 링크와 같은 LINK_CHANGED 에 kind: 'asset' 을 붙여 남긴다.
 * (새 이벤트 종류를 만들려면 ticket_events 의 CHECK 제약 때문에 테이블을 다시 만들어야 해서 재사용)
 * @param {{assetId: number|null}} input
 * @param {{asset: {id, assetTag, status}|null}} ctx  input.assetId 로 찾은 자산 (없으면 null)
 */
export function planAssetLink(ticket, input, { asset, currentAssetTag }) {
  const raw = input?.assetId;
  const wanted = raw === null || raw === undefined || raw === '' ? null : Number(raw);
  if (wanted !== null && !(Number.isSafeInteger(wanted) && wanted > 0)) {
    return fail(400, 'INVALID_ASSET', '자산을 골라야 합니다');
  }
  if (wanted !== null && !asset) return fail(400, 'INVALID_ASSET', '없는 자산입니다');
  if (asset && asset.status === 'DISPOSED') return fail(409, 'ASSET_DISPOSED', '폐기된 자산은 연결할 수 없습니다');
  if (wanted === (ticket.assetId ?? null)) return fail(409, 'NO_CHANGE', '바뀐 내용이 없습니다');
  return {
    ok: true,
    changes: { asset_id: wanted },
    events: [
      {
        eventType: 'LINK_CHANGED',
        fromStatus: null,
        toStatus: null,
        note: null,
        data: {
          kind: 'asset',
          from: ticket.assetId ? { id: ticket.assetId, assetTag: currentAssetTag ?? null } : null,
          to: asset ? { id: asset.id, assetTag: asset.assetTag } : null,
        },
      },
    ],
  };
}

/**
 * FAQ 초안: 요청자 이름·사번은 넣지 않는다 (사내 매뉴얼이라도 개인 정보는 뺀다)
 */
export function buildFaqDraft(ticket) {
  return {
    title: ticket.title,
    question: ticket.symptom,
    answer: `원인: ${ticket.cause ?? ''}\n조치: ${ticket.actionTaken ?? ''}\n확인 방법: ${ticket.verification ?? ''}`,
  };
}

/** 완료 티켓을 FAQ로 등록 */
export function planFaq(ticket, input, { hasFaq }) {
  if (ticket.status !== 'RESOLVED') return fail(409, 'NOT_RESOLVED', '완료된 티켓만 FAQ로 등록할 수 있습니다');
  if (hasFaq) return fail(409, 'FAQ_EXISTS', '이미 FAQ로 등록된 티켓입니다');
  const errors = [];
  const title = cleanText(input?.title, { field: 'title', label: 'FAQ 제목', max: LIMITS.faqTitle }, errors);
  const question = cleanText(input?.question, { field: 'question', label: '질문', max: LIMITS.faqQuestion }, errors);
  const answer = cleanText(input?.answer, { field: 'answer', label: '답변', max: LIMITS.faqAnswer }, errors);
  if (errors.length) return fail(400, 'VALIDATION_FAILED', '입력값을 확인해 주세요', errors);
  return {
    ok: true,
    changes: {},
    faq: { category: ticket.category, title, question, answer },
    events: [
      { eventType: 'FAQ_PUBLISHED', fromStatus: null, toStatus: null, note: `${ticketNo(ticket.id)} → FAQ 등록`, data: null },
    ],
  };
}
