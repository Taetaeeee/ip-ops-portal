// 입·퇴사 데모 데이터 (순수 함수). 날짜는 초기화 날짜(KST) 기준 상대 날짜.
// - 진행 중 퇴사 케이스: 구매팀 DT-0016, 퇴사일 = 오늘 → 체크리스트를 처음부터 끝까지 진행해 볼 수 있다
// - 미처리 퇴사자: 설비보전팀 DT-0036, 퇴사일 = 3일 전, 계정 활성, 케이스 없음 → 경고
// - 입사 예정자: DT-0041 (영업팀), 입사일 = 7일 뒤, 인사 등록만 됨 → 진행 중 입사 케이스

import { kstToday, addDays } from './license-reconcile.js';
import { buildChecklist } from './lifecycle-rules.js';
import { PERSONA_EMP_NO } from './seed-data.js';

const IT = PERSONA_EMP_NO.it_admin;

export function generateLifecycle({ employees, directoryUsers, now }) {
  const today = kstToday(now);
  const resignDates = { 'DT-0016': today, 'DT-0036': addDays(today, -3) };

  const newHires = [
    {
      empNo: 'DT-0041',
      name: '문서윤',
      deptCode: 'SALES',
      jobTitle: '사원',
      isTeamLead: false,
      duty: null,
      hireDate: addDays(today, 7),
      extension: '221',
      resignDate: null,
    },
  ];

  const leadOf = (deptCode) => employees.find((e) => e.deptCode === deptCode && e.isTeamLead)?.empNo ?? null;
  const leaver = employees.find((e) => e.empNo === 'DT-0016');
  const leaverAccount = directoryUsers.find((u) => u.employee_id === 'DT-0016');
  const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();

  const cases = [
    {
      id: 1,
      case_type: 'OFFBOARDING',
      emp_no: 'DT-0016',
      effective_date: today,
      status: 'OPEN',
      dir_user_id: leaverAccount?.id ?? null,
      created_by: IT,
      created_at: iso(2 * 86400000),
      completed_at: null,
      note: '일신상의 사유로 퇴사 (인사팀 통보)',
    },
    {
      id: 2,
      case_type: 'ONBOARDING',
      emp_no: 'DT-0041',
      effective_date: newHires[0].hireDate,
      status: 'OPEN',
      dir_user_id: null,
      created_by: IT,
      created_at: iso(86400000),
      completed_at: null,
      note: '영업팀 신규 입사 (인사팀 통보)',
    },
  ];

  const items = [];
  const addItems = (caseId, type, deptLead) => {
    for (const i of buildChecklist(type, { itAssignee: IT, deptLead })) {
      items.push({
        case_id: caseId,
        seq: i.seq,
        item_key: i.itemKey,
        title: i.title,
        kind: i.kind,
        requires: JSON.stringify(i.requires),
        status: 'PENDING',
        assignee_emp_no: i.assigneeEmpNo,
      });
    }
  };
  addItems(1, 'OFFBOARDING', leadOf(leaver.deptCode));
  addItems(2, 'ONBOARDING', null);

  return { resignDates, newHires, cases, items };
}
