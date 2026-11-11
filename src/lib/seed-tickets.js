// 데모 티켓 30건과 이력·FAQ를 만드는 순수 함수.
//
// - 시각은 "초기화 시각(now) 기준 업무 시간 몇 분 전" 으로 만든다.
//   고정 날짜로 만들면 며칠 뒤 전부 '기한 초과'가 되므로, 매일 초기화 때 같은 분포가 되게 한다.
// - 이력은 실제 상태 전이 규칙을 그대로 따른다 (테스트에서 규칙으로 다시 검증).
// - 요청자는 1단계 가상 직원. 내용은 모두 가상의 사례다.

import { addBusinessMinutes, subtractBusinessMinutes } from './business-time.js';
import { computeDueAt, targetMinutes } from './sla.js';
import { PERSONA_EMP_NO, IT_BACKUP_EMP_NO } from './seed-data.js';
import { resolveDemoAsset } from './seed-assets.js';

const IT = PERSONA_EMP_NO.it_admin; // DT-0004 정담당
const BACKUP = IT_BACKUP_EMP_NO; // DT-0003 부담당
const ME = PERSONA_EMP_NO.employee; // DT-0009 데모 일반 직원

// r: 목표 대비 경과 비율 (0.85 → 남은 시간 15% = 임박, 1.3 → 초과)
// age: 접수 후 경과 업무 시간(분), work: 완료까지 걸린 업무 시간(분)
// hold: [보류 시작, 재개] 접수 기준 분, holdAt: 현재 보류 중인 티켓의 보류 시작
export const TICKET_SPECS = Object.freeze([
  // ── 접수 4 (+ 데모 직원 1) ──
  { s: 'RECEIVED', p: 'URGENT', c: 'NETWORK', by: 'DT-0025', r: 0.3,
    title: '생산라인 2번 PC 네트워크 끊김',
    symptom: '생산실적 입력 PC 화면 오른쪽 아래에 "인터넷 없음"이 30분째 표시됩니다. 랜선은 꽂혀 있고, 옆 PC는 정상입니다.' },
  { s: 'RECEIVED', p: 'NORMAL', c: 'SOFTWARE', by: ME, r: 0.1,
    title: '견적서 엑셀 파일 열 때 "보호된 보기" 경고',
    symptom: '거래처에서 메일로 받은 견적서 엑셀을 열면 노란 경고줄이 뜨고 편집이 안 됩니다.' },
  { s: 'RECEIVED', p: 'LOW', c: 'PRINTER', by: 'DT-0015', r: 0.05,
    title: '구매팀 복합기 스캔 파일 이름 규칙 변경 요청',
    symptom: '스캔하면 파일 이름이 숫자로만 저장됩니다. 날짜_부서 형식으로 바꿀 수 있는지 문의드립니다.' },
  { s: 'RECEIVED', p: 'HIGH', c: 'ACCOUNT', by: 'DT-0018', r: 0.85,
    title: '그룹웨어 비밀번호 만료 후 로그인 불가',
    symptom: '비밀번호 만료 안내가 떠서 변경했는데, 새 비밀번호로 로그인이 안 됩니다.' },

  // ── 배정 4 ──
  { s: 'ASSIGNED', p: 'HIGH', c: 'PC', by: 'DT-0011', r: 0.5,
    title: '노트북 부팅 시 BitLocker 복구 키 요구',
    symptom: 'BIOS 업데이트 알림을 누른 뒤 재부팅하니 복구 키를 입력하라는 파란 화면이 나옵니다.' },
  { s: 'ASSIGNED', p: 'NORMAL', c: 'SOFTWARE', by: 'DT-0032', r: 1.3,
    title: '품질검사 성적서 프로그램 설치 요청',
    symptom: '신규 입고 검사 장비용 성적서 프로그램을 품질관리팀 PC 2대에 설치해 주세요.' },
  { s: 'ASSIGNED', p: 'LOW', c: 'NETWORK', by: 'DT-0002', r: 0.4, to: BACKUP,
    title: '임원 회의실 Wi-Fi 신호 약함',
    symptom: '회의실 안쪽 자리에서 화상회의가 자주 끊깁니다.' },
  { s: 'ASSIGNED', p: 'URGENT', c: 'SECURITY', by: 'DT-0012', r: 0.9,
    title: '거래처 사칭 메일의 첨부파일을 열었습니다',
    symptom: '"세금계산서 재발행" 메일의 첨부(.zip)를 열었는데 아무 화면도 안 떴습니다. 발신 주소가 거래처와 한 글자 다릅니다.' },

  // ── 처리 중 7 ──
  { s: 'IN_PROGRESS', p: 'URGENT', c: 'PRINTER', by: 'DT-0039', r: 1.5, note: '현장 확인: 프린터 IP가 DHCP로 바뀐 것으로 보임. 고정 IP 재설정 예정',
    title: '자재물류팀 라벨 프린터 출력 안 됨 (출하 지연)',
    symptom: '출하 라벨이 인쇄 대기열에만 쌓이고 나오지 않습니다. 오후 출하분이 밀리고 있습니다.' },
  { s: 'IN_PROGRESS', p: 'HIGH', c: 'ACCOUNT', by: 'DT-0022', r: 0.2, note: '잠금 원인 확인 중 (어느 PC에서 실패했는지 보안 로그 확인)',
    title: 'ERP 계정 잠김 - 생산실적 입력 불가',
    symptom: '아침에 ERP 로그인 시 "계정이 잠겼습니다"가 나옵니다.' },
  { s: 'IN_PROGRESS', p: 'NORMAL', c: 'NETWORK', by: 'DT-0019', r: 0.8, note: '파일 서버 디스크 사용률 92% 확인. 정리 대상 협의 중',
    title: '연구개발팀 공유 폴더 접근 느림',
    symptom: '도면 폴더를 열 때 1분 넘게 걸립니다. 어제부터 그렇습니다.' },
  { s: 'IN_PROGRESS', p: 'LOW', c: 'PC', by: 'DT-0036', r: 0.6,
    title: '설비보전팀 PC 모니터 1대 추가 요청',
    symptom: '설비 도면과 점검표를 동시에 봐야 해서 모니터 1대 추가를 요청합니다.' },
  { s: 'IN_PROGRESS', p: 'NORMAL', c: 'SOFTWARE', by: 'DT-0016', r: 0.3, to: BACKUP,
    title: 'PDF 편집 프로그램 라이선스 만료 안내 팝업',
    symptom: 'PDF 편집 프로그램을 열 때마다 "라이선스가 곧 만료됩니다" 창이 뜹니다.' },
  { s: 'IN_PROGRESS', p: 'HIGH', c: 'SECURITY', by: 'DT-0027', r: 1.1, note: '네트워크에서 분리 후 백신 정밀 검사 진행 중',
    title: '생산팀 공용 PC 바이러스 경고 창 반복',
    symptom: '공용 PC에서 "PC가 감염되었습니다" 창이 계속 뜹니다. USB를 꽂은 뒤부터입니다.' },
  { s: 'IN_PROGRESS', p: 'LOW', c: 'PRINTER', by: ME, r: 0.2,
    title: '영업팀 프린터 양면 인쇄 기본값 설정 요청',
    symptom: '용지 절약을 위해 영업팀 프린터 기본값을 양면 인쇄로 바꿔 주세요.' },

  // ── 보류 3 ──
  { s: 'ON_HOLD', p: 'NORMAL', c: 'PC', by: 'DT-0033', age: 300, holdAt: 150, holdNote: '교체용 키보드 입고 대기',
    title: '품질관리팀 PC 키보드 일부 키 입력 안 됨',
    symptom: '숫자 키패드의 4, 5, 6이 눌리지 않습니다.' },
  { s: 'ON_HOLD', p: 'LOW', c: 'SOFTWARE', by: 'DT-0020', age: 900, holdAt: 400, holdNote: '제조사 기술지원 회신 대기',
    title: 'CAD 뷰어 최신 버전 업데이트 요청',
    symptom: '협력사에서 받은 신규 형식 도면이 열리지 않습니다.' },
  { s: 'ON_HOLD', p: 'HIGH', c: 'NETWORK', by: 'DT-0029', age: 400, holdAt: 200, holdNote: '교체 스위치 입고 대기 (유지보수 업체)',
    title: '제1공장 사무동 스위치 포트 불량 의심',
    symptom: '사무동 PC 3대가 번갈아 가며 네트워크가 끊겼다 붙었다 합니다.' },

  // ── 완료 12 (FAQ 3, 기한 초과 완료 2, 보류 후 완료 2, 데모 직원 1) ──
  { s: 'RESOLVED', p: 'URGENT', c: 'ACCOUNT', by: 'DT-0010', age: 2000, work: 120,
    title: '출근 후 PC 로그인 불가 (계정 잠김)',
    symptom: '출근해서 PC에 로그인하려는데 "계정이 잠겼습니다"가 나옵니다.',
    cause: '휴대폰 메일 앱에 이전 비밀번호가 저장되어 있어, 비밀번호 변경 후 반복 인증 실패로 계정이 잠김',
    action: '계정 잠금 해제, 휴대폰 메일 앱의 저장된 비밀번호 갱신 안내',
    verification: '사용자 PC 로그인 정상, 휴대폰 메일 동기화 정상 확인',
    faq: { title: '비밀번호를 바꾼 뒤 계정이 자꾸 잠겨요',
      question: '비밀번호를 변경한 뒤로 아침마다 계정이 잠겨 있습니다.',
      answer: '휴대폰 메일 앱처럼 이전 비밀번호를 저장해 둔 기기가 계속 로그인을 시도하면 계정이 잠깁니다.\n1) IT 담당자에게 잠금 해제를 요청하세요.\n2) 휴대폰 메일 앱 등 저장된 비밀번호를 새 비밀번호로 바꾸세요.' } },
  { s: 'RESOLVED', p: 'HIGH', c: 'PRINTER', by: 'DT-0024', age: 3000, work: 300,
    title: '생산팀 복합기 "용지 걸림" 오류 반복',
    symptom: '용지가 없는데도 하루에 여러 번 용지 걸림 오류가 납니다.',
    cause: '급지 롤러 마모', action: '유지보수 업체 방문, 급지 롤러 교체', verification: '테스트 50매 연속 출력 정상' },
  { s: 'RESOLVED', p: 'NORMAL', c: 'NETWORK', by: ME, age: 4000, work: 400,
    title: '외근 중 VPN 접속 안 됨',
    symptom: '거래처 방문 중 노트북 VPN 연결 시 "인증서 오류"가 나옵니다.',
    cause: 'VPN 서버 인증서 갱신 후 구버전 VPN 클라이언트와 호환되지 않음',
    action: 'VPN 클라이언트 최신 버전 설치',
    verification: '사용자가 외부망에서 VPN 접속 후 ERP 접속까지 확인',
    faq: { title: '외부에서 VPN이 연결되지 않아요 (인증서 오류)',
      question: 'VPN 연결 시 인증서 오류가 나며 접속되지 않습니다.',
      answer: 'VPN 클라이언트가 구버전이면 서버 인증서 갱신 후 접속이 안 될 수 있습니다.\n사내망에 접속한 상태에서 IT 담당자에게 VPN 클라이언트 업데이트를 요청하세요.' } },
  { s: 'RESOLVED', p: 'LOW', c: 'SOFTWARE', by: 'DT-0017', age: 5000, work: 1200,
    title: '엑셀 매크로 실행 차단 해제 요청',
    symptom: '공유받은 재고 집계 엑셀의 매크로가 "보안 위험" 표시와 함께 차단됩니다.',
    cause: '인터넷·메일에서 받은 파일에 붙는 차단 표시로 매크로가 차단됨',
    action: '파일 출처 확인 후 파일 속성에서 차단 해제, 사내 공유 폴더 사용 안내',
    verification: '사용자 PC에서 매크로 정상 실행 확인',
    faq: { title: '엑셀 매크로가 "보안 위험"으로 차단돼요',
      question: '받은 엑셀 파일의 매크로가 차단되어 실행되지 않습니다.',
      answer: '인터넷이나 메일로 받은 파일은 보안을 위해 매크로가 차단됩니다.\n1) 파일 출처가 확실한지 먼저 확인하세요. 모르는 사람이 보낸 파일이면 IT 담당자에게 신고하세요.\n2) 출처가 확실하면 IT 담당자에게 차단 해제를 요청하세요.' } },
  { s: 'RESOLVED', p: 'URGENT', c: 'NETWORK', by: 'DT-0021', age: 6000, work: 360,
    title: '제1공장 전체 인터넷 끊김',
    symptom: '공장 사무동과 현장 PC 전체가 인터넷과 ERP에 접속되지 않습니다.',
    cause: '통신사 회선 장애', action: '통신사 장애 접수, 복구 후 공장 라우터 재시작', verification: '공장 PC 5대에서 인터넷·ERP 접속 확인' },
  { s: 'RESOLVED', p: 'HIGH', c: 'SECURITY', by: 'DT-0013', age: 2500, work: 200,
    title: '의심 메일 신고 (택배 조회 링크)',
    symptom: '"배송 주소 확인" 문자와 같은 내용의 메일이 왔습니다. 링크는 누르지 않았습니다.',
    cause: '불특정 다수 대상 피싱 메일. 클릭한 직원 없음', action: '발신 도메인 수신 차단 규칙 등록, 전 직원 주의 공지',
    verification: '같은 발신 도메인 메일이 차단되는 것 확인' },
  { s: 'RESOLVED', p: 'NORMAL', c: 'PC', by: 'DT-0035', age: 7000, work: 800, hold: [200, 500], holdNote: '교체 배터리 주문',
    title: '설비보전팀 노트북 배터리 부풀음',
    symptom: '노트북 바닥이 볼록하게 올라와 책상에서 흔들립니다.',
    cause: '배터리 노후로 인한 팽창', action: '노트북 사용 중지 안내 후 배터리 교체', verification: '완충 후 4시간 사용 정상, 외관 정상' },
  { s: 'RESOLVED', p: 'LOW', c: 'ACCOUNT', by: 'DT-0038', age: 8000, work: 1500,
    title: '공유 폴더 "자재" 쓰기 권한 요청',
    symptom: '부서 이동 후 자재 공유 폴더에 파일을 저장할 수 없습니다.',
    cause: '부서 이동 후 보안 그룹이 바뀌지 않음', action: '팀장 승인 확인 후 자재물류팀 보안 그룹에 추가',
    verification: '사용자가 파일 생성·수정 가능한 것 확인' },
  { s: 'RESOLVED', p: 'HIGH', c: 'SOFTWARE', by: 'DT-0014', age: 9000, work: 700,
    title: 'ERP 발주서 출력 시 프로그램 종료',
    symptom: 'ERP에서 발주서 인쇄 버튼을 누르면 프로그램이 꺼집니다.',
    cause: '프린터 드라이버 충돌', action: '프린터 드라이버 제거 후 제조사 최신 드라이버 설치', verification: '발주서 10건 연속 출력 정상' },
  { s: 'RESOLVED', p: 'NORMAL', c: 'PRINTER', by: 'DT-0031', age: 3500, work: 250,
    title: '품질관리팀 프린터 인쇄 대기열 멈춤',
    symptom: '인쇄를 눌러도 대기열에 "오류"로 멈춰 있습니다.',
    cause: '인쇄 스풀러 서비스 중단', action: '인쇄 스풀러(Print Spooler) 서비스 재시작, 대기열 정리', verification: '테스트 인쇄 정상' },
  { s: 'RESOLVED', p: 'URGENT', c: 'PC', by: 'DT-0026', age: 4500, work: 200, hold: [50, 120], holdNote: '예비 PC 투입 후 SSD 입고 대기',
    title: '생산라인 3번 PC 부팅 불가',
    symptom: '전원은 들어오는데 제조사 로고에서 멈춥니다.',
    cause: 'SSD 고장', action: '예비 PC로 교체(데이터는 서버 저장이라 손실 없음), 고장 PC는 SSD 교체 후 예비로 보관',
    verification: '생산실적 입력 프로그램 정상 실행 확인' },
  { s: 'RESOLVED', p: 'LOW', c: 'NETWORK', by: 'DT-0040', age: 10000, work: 1400,
    title: '창고 무선 바코드 스캐너 연결 끊김',
    symptom: '창고 안쪽 랙에서 바코드 스캐너의 무선 연결이 자주 끊깁니다.',
    cause: '무선 AP 채널 간섭', action: '창고 AP 채널 변경', verification: '창고 전 구역에서 스캐너 연결 유지 확인' },
]);

// 3단계: 데모 티켓 ↔ 관련 자산. 'holder' = 요청자의 개인 PC, 그 외 = 공용 장비 key (seed-assets.js)
export const TICKET_ASSET_REFS = Object.freeze({
  '생산라인 2번 PC 네트워크 끊김': 'line-2',
  '노트북 부팅 시 BitLocker 복구 키 요구': 'holder',
  '자재물류팀 라벨 프린터 출력 안 됨 (출하 지연)': 'printer-label',
  '생산팀 공용 PC 바이러스 경고 창 반복': 'line-1',
  '품질관리팀 PC 키보드 일부 키 입력 안 됨': 'holder',
  '제1공장 사무동 스위치 포트 불량 의심': 'switch-plant',
  '생산팀 복합기 "용지 걸림" 오류 반복': 'printer-prod',
  '설비보전팀 노트북 배터리 부풀음': 'holder',
  'ERP 발주서 출력 시 프로그램 종료': 'holder',
  '품질관리팀 프린터 인쇄 대기열 멈춤': 'printer-qc',
  '생산라인 3번 PC 부팅 불가': 'line-3',
  '창고 무선 바코드 스캐너 연결 끊김': 'ap-warehouse',
});

/**
 * @param {{now: Date, cfg: object, assets?: object}} param0 assets = generateDemoAssets() 결과 (없으면 자산 연결 없음)
 * @returns {{tickets: object[], events: object[], faqs: object[]}}
 */
export function generateDemoTickets({ now, cfg, assets = null }) {
  const built = TICKET_SPECS.map((spec) => {
    const b = buildOne(spec, now, cfg);
    b.ticket.assetId = resolveDemoAsset(assets, TICKET_ASSET_REFS[spec.title], spec.by);
    return b;
  });

  // 접수 시각 순으로 번호를 매긴다 (먼저 들어온 요청이 낮은 번호)
  built.sort((a, b) => a.createdAt - b.createdAt);

  const tickets = [];
  const events = [];
  const faqs = [];
  built.forEach((b, i) => {
    const id = i + 1;
    tickets.push({ ...b.ticket, id });
    for (const ev of b.events) events.push({ ...ev, ticketId: id });
    if (b.faq) faqs.push({ ...b.faq, id: faqs.length + 1, sourceTicketId: id });
  });
  return { tickets, events, faqs };
}

function buildOne(spec, now, cfg) {
  const target = targetMinutes(spec.p, cfg);
  const age = spec.age ?? Math.max(10, Math.round(target * spec.r));
  const span = spec.s === 'RESOLVED' ? spec.work : age;
  const createdAt = subtractBusinessMinutes(now, age, cfg);
  const at = (offset) => addBusinessMinutes(createdAt, offset, cfg).toISOString();
  const assignee = spec.s === 'RECEIVED' ? null : (spec.to ?? IT);

  const events = [];
  const push = (offset, eventType, actor, extra = {}) =>
    events.push({
      eventType,
      actorEmpNo: actor,
      fromStatus: extra.from ?? null,
      toStatus: extra.to ?? null,
      note: extra.note ?? null,
      data: extra.data ? JSON.stringify(extra.data) : null,
      createdAt: at(offset),
      offset,
    });

  push(0, 'CREATED', spec.by, { to: 'RECEIVED' });

  const a1 = Math.max(1, Math.round(span * 0.1));
  const a2 = Math.max(a1 + 1, Math.round(span * 0.2));
  if (spec.s !== 'RECEIVED') {
    push(a1, 'ASSIGNED', IT, { data: { from: null, to: assignee } });
    push(a1, 'STATUS_CHANGED', IT, { from: 'RECEIVED', to: 'ASSIGNED' });
  }
  if (['IN_PROGRESS', 'ON_HOLD', 'RESOLVED'].includes(spec.s)) {
    push(a2, 'STATUS_CHANGED', assignee, { from: 'ASSIGNED', to: 'IN_PROGRESS' });
  }
  if (spec.note) {
    push(Math.max(a2 + 1, Math.round(span * 0.35)), 'NOTE', assignee, { note: spec.note });
  }

  let pausedMinutes = 0;
  let holdStartedAt = null;
  if (spec.s === 'ON_HOLD') {
    push(spec.holdAt, 'STATUS_CHANGED', assignee, { from: 'IN_PROGRESS', to: 'ON_HOLD', note: spec.holdNote });
    holdStartedAt = at(spec.holdAt);
  }
  if (spec.hold) {
    const [h0, h1] = spec.hold;
    pausedMinutes = h1 - h0;
    push(h0, 'STATUS_CHANGED', assignee, { from: 'IN_PROGRESS', to: 'ON_HOLD', note: spec.holdNote });
    push(h1, 'STATUS_CHANGED', assignee, {
      from: 'ON_HOLD',
      to: 'IN_PROGRESS',
      data: { pausedMinutesAdded: pausedMinutes, newDueAt: computeDueAt(createdAt, spec.p, pausedMinutes, cfg).toISOString() },
    });
  }

  let faq = null;
  if (spec.s === 'RESOLVED') {
    push(spec.work, 'STATUS_CHANGED', assignee, {
      from: 'IN_PROGRESS',
      to: 'RESOLVED',
      data: { cause: spec.cause, action: spec.action, verification: spec.verification },
    });
    if (spec.faq) {
      push(spec.work + 30, 'FAQ_PUBLISHED', IT, { note: 'FAQ 등록' });
      faq = { ...spec.faq, category: spec.c, publishedBy: IT, createdAt: at(spec.work + 30) };
    }
  }

  // 같은 시각 이벤트는 넣은 순서를 유지 (stable sort)
  events.sort((x, y) => x.offset - y.offset);
  for (const ev of events) delete ev.offset;

  const ticket = {
    requesterEmpNo: spec.by,
    category: spec.c,
    priority: spec.p,
    title: spec.title,
    symptom: spec.symptom,
    status: spec.s,
    assigneeEmpNo: assignee,
    createdAt: createdAt.toISOString(),
    updatedAt: events.at(-1).createdAt,
    slaDueAt: computeDueAt(createdAt, spec.p, pausedMinutes, cfg).toISOString(),
    slaPausedMinutes: pausedMinutes,
    holdStartedAt,
    resolvedAt: spec.s === 'RESOLVED' ? at(spec.work) : null,
    cause: spec.cause ?? null,
    actionTaken: spec.action ?? null,
    verification: spec.verification ?? null,
    incidentUrl: null,
    version: 1,
  };
  return { createdAt, ticket, events, faq };
}
