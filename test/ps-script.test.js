// PowerShell 스크립트 생성 테스트
// 1) 문자열로 이스케이프 확인
// 2) 이 PC 에 Windows PowerShell 이 있으면, 실제 PowerShell 파서로 생성된 스크립트를 파싱해
//    - 문법 오류가 없고
//    - 실행될 명령이 예상한 cmdlet 뿐이며 (주입된 명령 없음)
//    - 작은따옴표 문자열 값이 원래 입력과 정확히 같은지
//    확인한다. PowerShell 이 없는 환경에서는 2) 만 건너뛴다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { psQuote, buildScript, OPERATION_CMDLETS } from '../src/lib/ps-script.js';
import { userDn, ouDn } from '../src/lib/ad-model.js';

const META = { label: '테스트', generatedAtKst: '2026-11-11 15:00' };

// 깨뜨리기 쉬운 값들: 작은따옴표, 유니코드 따옴표, 큰따옴표, $, 백틱, ;, $( ), 쉼표(DN), 해시
const EVIL = [
  "O'Brien",
  "홍'; Remove-Item C:\\ -Recurse; '",
  '김‘따옴표’',
  '‚낮은‛',
  '"큰따옴표" $env:USERNAME `n $(Get-Date)',
  'Kim, Jr. + <tag> ; = #',
  "''이미 두 개''",
];

test('psQuote: 작은따옴표·유니코드 따옴표는 두 번, 나머지는 그대로', () => {
  assert.equal(psQuote('abc'), "'abc'");
  assert.equal(psQuote("O'Brien"), "'O''Brien'");
  assert.equal(psQuote('a‘b’c'), "'a‘‘b’’c'");
  assert.equal(psQuote('$x `y "z"'), "'$x `y \"z\"'");
  assert.throws(() => psQuote('줄\n바꿈'));
  assert.throws(() => psQuote('탭\t'));
  assert.throws(() => psQuote('줄\u2028구분'));
});

test('비밀번호는 스크립트에 없고, [미실행] 표시가 있다', () => {
  const s = buildScript('RESET_PASSWORD', { sam: 'gdhong' }, META);
  assert.ok(s.includes('[미실행]'));
  assert.ok(s.includes('Read-Host -AsSecureString'));
  assert.ok(!/ConvertTo-SecureString/.test(s));
  assert.ok(s.includes("Set-ADAccountPassword -Identity 'gdhong' -Reset -NewPassword $password"));
});

test('작업별 cmdlet', () => {
  const p = { sam: 'gdhong', group: 'GG-Dept-Sales', fromDn: userDn('홍길동', 'SALES'), toOuDn: ouDn('FORMER') };
  assert.ok(buildScript('DISABLE_ACCOUNT', p, META).includes("Disable-ADAccount -Identity 'gdhong'"));
  assert.ok(buildScript('ENABLE_ACCOUNT', p, META).includes("Enable-ADAccount -Identity 'gdhong'"));
  assert.ok(buildScript('UNLOCK_ACCOUNT', p, META).includes("Unlock-ADAccount -Identity 'gdhong'"));
  assert.ok(buildScript('ADD_GROUP_MEMBER', p, META).includes("Add-ADGroupMember -Identity 'GG-Dept-Sales' -Members 'gdhong'"));
  assert.ok(buildScript('REMOVE_GROUP_MEMBER', p, META).includes('-Confirm:$false'));
  assert.ok(buildScript('MOVE_OU', p, META).includes("-TargetPath 'OU=퇴사자,DC=corp,DC=ossan,DC=example'"));
  assert.throws(() => buildScript('DELETE_USER', p, META));
});

function createScript(name) {
  return buildScript(
    'CREATE_USER',
    {
      cn: name,
      displayName: name,
      givenName: name,
      surname: name,
      sam: 'gdhong',
      upn: 'gdhong@corp.ossan.example',
      ouDn: ouDn('SALES'),
      department: name,
      title: name,
      employeeId: 'DT-0041',
      groups: ['GG-Dept-Sales'],
    },
    META,
  );
}

test('위험한 이름이 들어가도 작은따옴표 밖으로 나오지 않는다 (문자열 확인)', () => {
  const s = createScript("홍'; Remove-Item C:\\ -Recurse; '");
  assert.ok(s.includes("'홍''; Remove-Item C:\\ -Recurse; '''"));
  // DN 에 들어가는 값은 DN 이스케이프 → PS 따옴표 순서
  const move = buildScript('MOVE_OU', { sam: 'x', fromDn: userDn("O'Brien, Jr.", 'SALES'), toOuDn: ouDn('FORMER') }, META);
  assert.ok(move.includes("-Identity 'CN=O''Brien\\, Jr.,OU=영업팀"));
});

// ── 실제 PowerShell 파서로 검증 ──
function powershellAvailable() {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '1'], { encoding: 'utf8' });
  return r.status === 0;
}

// 스크립트 파일을 파싱해 { errors, commands, singleQuoted } 를 돌려준다 (문자열은 UTF-8 base64 로 주고받음)
const PARSE_PS = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:PS_TEST_FILE, [ref]$tokens, [ref]$errors)
$b64 = { param($s) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$s)) }
$commands = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
$strings = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $args[0].StringConstantType -eq 'SingleQuoted' }, $true) | ForEach-Object { & $b64 $_.Value })
[pscustomobject]@{ errors = @($errors).Count; commands = $commands; strings = $strings } | ConvertTo-Json -Compress
`;

function parseWithPowerShell(script) {
  const dir = mkdtempSync(join(tmpdir(), 'ps-parse-'));
  const file = join(dir, 'generated.ps1');
  try {
    writeFileSync(file, `\ufeff${script}`, 'utf8'); // UTF-8(BOM): Windows PowerShell 5.1 이 한글을 바르게 읽도록
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PARSE_PS], {
      encoding: 'utf8',
      env: { ...process.env, PS_TEST_FILE: file },
    });
    if (r.status !== 0) throw new Error(r.stderr);
    const out = JSON.parse(r.stdout.trim());
    return {
      errors: out.errors,
      commands: [out.commands ?? []].flat(),
      strings: [out.strings ?? []].flat().map((s) => Buffer.from(s, 'base64').toString('utf8')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HAS_PS = powershellAvailable();

test('[PowerShell 파서] 위험한 이름으로 만든 계정 생성 스크립트: 오류 없음, 주입된 명령 없음, 값 그대로', { skip: !HAS_PS && 'PowerShell 없음' }, () => {
  for (const name of EVIL) {
    const parsed = parseWithPowerShell(createScript(name));
    assert.equal(parsed.errors, 0, `문법 오류: ${name}`);
    const allowed = new Set(['Import-Module', 'Read-Host', ...OPERATION_CMDLETS.CREATE_USER]);
    for (const c of parsed.commands) assert.ok(allowed.has(c), `예상 밖 명령 ${c} ← ${name}`);
    assert.ok(parsed.strings.includes(name), `값이 바뀜: ${name}`);
  }
});

test('[PowerShell 파서] OU 이동: DN 이스케이프 + 따옴표 두 겹이 정확히 복원된다', { skip: !HAS_PS && 'PowerShell 없음' }, () => {
  for (const name of EVIL) {
    const fromDn = userDn(name, 'SALES');
    const parsed = parseWithPowerShell(buildScript('MOVE_OU', { sam: 'x', fromDn, toOuDn: ouDn('FORMER') }, META));
    assert.equal(parsed.errors, 0, name);
    assert.deepEqual(new Set(parsed.commands), new Set(['Import-Module', 'Move-ADObject']));
    assert.ok(parsed.strings.includes(fromDn), `DN 이 바뀜: ${name}`);
  }
});

test('[PowerShell 파서] 모든 작업 스크립트가 문법 오류 없이 파싱된다', { skip: !HAS_PS && 'PowerShell 없음' }, () => {
  const p = { sam: 'gdhong', group: 'GG-Dept-Sales', fromDn: userDn('홍길동', 'SALES'), toOuDn: ouDn('FORMER') };
  for (const type of Object.keys(OPERATION_CMDLETS).filter((t) => t !== 'CREATE_USER')) {
    const parsed = parseWithPowerShell(buildScript(type, p, META));
    assert.equal(parsed.errors, 0, type);
    for (const c of OPERATION_CMDLETS[type]) assert.ok(parsed.commands.includes(c), `${type}: ${c}`);
  }
});
