-- 0004_directory.sql : 4단계 가상 AD 디렉터리 + 계정 작업 시뮬레이터
-- 속성 이름은 실제 AD 를 따른다 (sAMAccountName → sam_account_name 처럼 snake_case 로 저장).
-- 시각은 UTC ISO 8601 문자열.

-- 사용자 계정
CREATE TABLE dir_users (
  id                   INTEGER PRIMARY KEY,
  -- sAMAccountName: 20자 이하, 대소문자 구분 없이 유일 (COLLATE NOCASE)
  sam_account_name     TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(sam_account_name) BETWEEN 1 AND 20),
  user_principal_name  TEXT NOT NULL COLLATE NOCASE UNIQUE,
  -- DN 이 유일하면 "같은 OU 안에서 CN 유일" 도 함께 보장된다
  distinguished_name   TEXT NOT NULL COLLATE NOCASE UNIQUE,
  cn                   TEXT NOT NULL,
  ou_key               TEXT NOT NULL,                       -- 소속 OU (코드 상수 ad-model.js 의 OUS)
  given_name           TEXT,
  surname              TEXT,
  display_name         TEXT NOT NULL,
  employee_id          TEXT,                                -- employeeID: 인사 사번 (5단계 입퇴사 대조용)
  department           TEXT,
  title                TEXT,
  description          TEXT,
  kind                 TEXT NOT NULL CHECK (kind IN ('PERSON', 'SERVICE')),
  enabled              INTEGER NOT NULL CHECK (enabled IN (0, 1)),          -- userAccountControl 의 ACCOUNTDISABLE 비트
  locked_out           INTEGER NOT NULL DEFAULT 0 CHECK (locked_out IN (0, 1)),
  lockout_time         TEXT,
  bad_pwd_count        INTEGER NOT NULL DEFAULT 0,
  pwd_last_set         TEXT,                                -- NULL = 0 (다음 로그온 시 비밀번호 변경 필요)
  last_logon           TEXT,                                -- DC 1대 가정 (실제 lastLogon 은 DC 마다 따로)
  when_created         TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1,          -- 동시 수정 방지
  write_token          TEXT,
  CHECK ((locked_out = 1) = (lockout_time IS NOT NULL))
);
CREATE INDEX idx_dir_users_ou ON dir_users(ou_key);
CREATE INDEX idx_dir_users_employee ON dir_users(employee_id);

-- 보안 그룹 (이 시뮬레이터는 전역 보안 그룹만 쓴다)
CREATE TABLE dir_groups (
  id                  INTEGER PRIMARY KEY,
  sam_account_name    TEXT NOT NULL COLLATE NOCASE UNIQUE,
  cn                  TEXT NOT NULL,
  distinguished_name  TEXT NOT NULL COLLATE NOCASE UNIQUE,
  group_scope         TEXT NOT NULL CHECK (group_scope IN ('Global', 'DomainLocal', 'Universal')),
  group_category      TEXT NOT NULL CHECK (group_category IN ('Security', 'Distribution')),
  kind                TEXT NOT NULL CHECK (kind IN ('DEPT', 'ROLE')),
  description         TEXT
);

-- 그룹 멤버십 (같은 그룹에 두 번 가입 불가)
CREATE TABLE dir_memberships (
  id        INTEGER PRIMARY KEY,
  group_id  INTEGER NOT NULL REFERENCES dir_groups(id),
  user_id   INTEGER NOT NULL REFERENCES dir_users(id),
  added_at  TEXT NOT NULL,
  UNIQUE (group_id, user_id)
);
CREATE INDEX idx_dir_memberships_user ON dir_memberships(user_id);

-- 작업 기록: 입력·변경 전후·생성된 스크립트. 스크립트는 실행하지 않는다(NOT_EXECUTED)
CREATE TABLE dir_operations (
  id                INTEGER PRIMARY KEY,
  op_token          TEXT NOT NULL UNIQUE,                   -- 같은 batch 안에서 이 작업을 찾는 무작위 표식
  op_type           TEXT NOT NULL CHECK (op_type IN (
                      'CREATE_USER', 'DISABLE_ACCOUNT', 'ENABLE_ACCOUNT', 'RESET_PASSWORD',
                      'UNLOCK_ACCOUNT', 'ADD_GROUP_MEMBER', 'REMOVE_GROUP_MEMBER', 'MOVE_OU')),
  target_user_id    INTEGER REFERENCES dir_users(id),
  target_sam        TEXT NOT NULL,
  actor_sam         TEXT NOT NULL,
  actor_emp_no      TEXT,
  input             TEXT,                                   -- JSON
  diff              TEXT NOT NULL,                          -- JSON [{field, before, after}]
  notes             TEXT,                                   -- JSON
  script            TEXT NOT NULL,
  execution_status  TEXT NOT NULL DEFAULT 'NOT_EXECUTED' CHECK (execution_status IN ('NOT_EXECUTED')),
  created_at        TEXT NOT NULL
);

-- 가상 보안 이벤트 (Windows 보안 이벤트 ID 기준)
CREATE TABLE dir_events (
  id              INTEGER PRIMARY KEY,
  event_id        INTEGER NOT NULL,
  event_name      TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  target_user_id  INTEGER REFERENCES dir_users(id),
  target_sam      TEXT NOT NULL,
  group_sam       TEXT,
  actor_sam       TEXT NOT NULL,
  operation_id    INTEGER REFERENCES dir_operations(id),
  details         TEXT                                      -- JSON
);
CREATE INDEX idx_dir_events_user ON dir_events(target_user_id, occurred_at);
CREATE INDEX idx_dir_events_operation ON dir_events(operation_id);
