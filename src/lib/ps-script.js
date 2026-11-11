// 실제 환경에서 쓸 PowerShell(ActiveDirectory 모듈) 스크립트 생성 (순수 함수)
//
// 이 시뮬레이터는 스크립트를 "만들기만" 하고 실행하지 않는다 → 머리말에 [미실행] 표시.
//
// 명령 주입 방지
// - 사용자 입력은 전부 작은따옴표 문자열 '...' 에 넣는다. 작은따옴표 안에서는 $변수, 백틱(`), $( ) 가 해석되지 않는다.
// - 문자열 안의 작은따옴표는 두 번 써서 이스케이프한다 ('' ).
//   PowerShell 은 유니코드 따옴표 ‘ ’ ‚ ‛ 도 작은따옴표로 취급하므로 이것들도 두 번 쓴다. (놓치기 쉬운 주입 경로)
// - 줄바꿈 같은 제어 문자는 아예 거부한다 (주석 탈출·명령 분리 방지).
// - DN 에 들어가는 값은 DN 이스케이프(RFC 4514)를 먼저 하고(ad-model.js), 그 결과를 다시 PowerShell 따옴표 처리한다.
// - 비밀번호는 스크립트에 절대 넣지 않는다. 실행할 때 Read-Host -AsSecureString 으로 입력받는다.

// 제어 문자(0x00~0x1F, 0x7F)와 유니코드 줄 구분 문자(U+2028, U+2029)
function hasControlChar(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

// 작은따옴표 + PowerShell 이 작은따옴표로 취급하는 유니코드 따옴표 (U+2018, U+2019, U+201A, U+201B)
const SINGLE_QUOTES = new RegExp(`['${String.fromCharCode(0x2018, 0x2019, 0x201a, 0x201b)}]`, 'g');

/** PowerShell 작은따옴표 문자열 리터럴 */
export function psQuote(value) {
  const s = String(value);
  if (hasControlChar(s)) throw new RangeError('스크립트 값에 제어 문자(줄바꿈 등)를 넣을 수 없습니다');
  return `'${s.replace(SINGLE_QUOTES, (q) => q + q)}'`;
}

export const OPERATION_CMDLETS = Object.freeze({
  CREATE_USER: ['New-ADUser', 'Add-ADGroupMember'],
  DISABLE_ACCOUNT: ['Disable-ADAccount'],
  ENABLE_ACCOUNT: ['Enable-ADAccount'],
  RESET_PASSWORD: ['Set-ADAccountPassword', 'Set-ADUser'],
  UNLOCK_ACCOUNT: ['Unlock-ADAccount'],
  ADD_GROUP_MEMBER: ['Add-ADGroupMember'],
  REMOVE_GROUP_MEMBER: ['Remove-ADGroupMember'],
  MOVE_OU: ['Move-ADObject'],
});

function header({ label, targetSam, generatedAtKst }) {
  return [
    '# ============================================================',
    '# [미실행] 도담테크산업 IT 운영 포털(시뮬레이션)이 생성한 스크립트입니다.',
    '#          가상 디렉터리에만 반영되었고, 실제 AD 에서는 실행되지 않았습니다.',
    `# 작업: ${label} / 대상: ${targetSam} / 생성: ${generatedAtKst} (KST)`,
    '# 실제 환경에서는:',
    '#   1) 먼저 각 명령 끝에 -WhatIf 를 붙여 결과를 확인한 뒤 실행하세요.',
    '#   2) Windows PowerShell 5.1 에서는 파일을 UTF-8(BOM) 으로 저장해야 한글이 깨지지 않습니다.',
    '# ============================================================',
    'Import-Module ActiveDirectory',
    '',
  ];
}

/** 키 = 값 표를 splatting 해시테이블로 (값은 이미 PowerShell 식으로 만든 문자열) */
function splat(varName, entries) {
  const width = Math.max(...entries.map(([k]) => k.length));
  const lines = entries.map(([k, v, comment]) => `    ${k.padEnd(width)} = ${v}${comment ? `   # ${comment}` : ''}`);
  return [`$${varName} = @{`, ...lines, '}'];
}

/**
 * @param {string} type 작업 종류 (ad-operations.js 의 OPERATIONS)
 * @param {object} p 스크립트 재료. sam·그룹·DN 등 (검증된 값)
 * @param {{label: string, generatedAtKst: string}} meta
 */
export function buildScript(type, p, meta) {
  const q = psQuote;
  // 머리말의 대상은 검증된 sAMAccountName 만 쓴다 (사용자 입력 이름을 주석에 넣지 않음)
  const lines = header({ label: meta.label, targetSam: p.sam, generatedAtKst: meta.generatedAtKst });

  switch (type) {
    case 'CREATE_USER':
      lines.push(
        "$password = Read-Host -AsSecureString -Prompt '초기 비밀번호 입력 (스크립트에 비밀번호를 적지 않습니다)'",
        '',
        '# 매개변수를 해시테이블로 넘기는 방식(splatting): 줄이 길어지지 않고 값마다 주석을 달 수 있다',
        ...splat('newUser', [
          ['Name', q(p.cn)],
          ['DisplayName', q(p.displayName)],
          ...(p.givenName ? [['GivenName', q(p.givenName)]] : []),
          ...(p.surname ? [['Surname', q(p.surname)]] : []),
          ['SamAccountName', q(p.sam)],
          ['UserPrincipalName', q(p.upn)],
          ['Path', q(p.ouDn)],
          ...(p.department ? [['Department', q(p.department)]] : []),
          ...(p.title ? [['Title', q(p.title)]] : []),
          ...(p.employeeId ? [['EmployeeID', q(p.employeeId), '공식 문서 확인 필요: New-ADUser -EmployeeID 매개변수']] : []),
          ['AccountPassword', '$password'],
          ['Enabled', '$true'],
          ['ChangePasswordAtLogon', '$true', '첫 로그인 때 비밀번호 변경 (pwdLastSet = 0)'],
        ]),
        'New-ADUser @newUser',
        '',
        '# 부서 그룹에 추가',
        ...p.groups.map((g) => `Add-ADGroupMember -Identity ${q(g)} -Members ${q(p.sam)}`),
      );
      break;
    case 'DISABLE_ACCOUNT':
      lines.push(`Disable-ADAccount -Identity ${q(p.sam)}`);
      break;
    case 'ENABLE_ACCOUNT':
      lines.push(`Enable-ADAccount -Identity ${q(p.sam)}`);
      break;
    case 'RESET_PASSWORD':
      lines.push(
        "$password = Read-Host -AsSecureString -Prompt '임시 비밀번호 입력 (스크립트에 비밀번호를 적지 않습니다)'",
        `Set-ADAccountPassword -Identity ${q(p.sam)} -Reset -NewPassword $password`,
        '# 다음 로그인 때 비밀번호를 바꾸게 한다 (pwdLastSet = 0)',
        `Set-ADUser -Identity ${q(p.sam)} -ChangePasswordAtLogon $true`,
        '# 참고: 비밀번호를 초기화해도 잠금은 풀리지 않는다. 잠겨 있으면 Unlock-ADAccount 를 따로 실행',
      );
      break;
    case 'UNLOCK_ACCOUNT':
      lines.push(`Unlock-ADAccount -Identity ${q(p.sam)}`);
      break;
    case 'ADD_GROUP_MEMBER':
      lines.push(
        `Add-ADGroupMember -Identity ${q(p.group)} -Members ${q(p.sam)}`,
        '# 참고: 그룹 변경은 사용자가 다음에 로그인(새 Kerberos 티켓)할 때부터 적용된다',
      );
      break;
    case 'REMOVE_GROUP_MEMBER':
      lines.push(
        `Remove-ADGroupMember -Identity ${q(p.group)} -Members ${q(p.sam)} -Confirm:$false`,
        '# 참고: 이미 로그인한 세션에는 다시 로그인할 때까지 이전 권한이 남아 있을 수 있다',
      );
      break;
    case 'MOVE_OU':
      lines.push(
        '# Move-ADObject 의 -Identity 는 계정명이 아니라 DN(또는 GUID)을 받는다',
        `Move-ADObject -Identity ${q(p.fromDn)} -TargetPath ${q(p.toOuDn)}`,
      );
      break;
    default:
      throw new RangeError(`스크립트를 만들 수 없는 작업: ${type}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}
