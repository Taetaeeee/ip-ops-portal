-- 0001_init.sql : 1단계 기본 스키마
-- 회사 조직(사업장·부서·직원), 데모 로그인 세션, 데모 초기화 기록.
--
-- 참고: 여기 employees 는 "인사 명단"이다. AD 계정(sAMAccountName 등)은 4단계에서
-- 별도 테이블로 만든다. 실제 회사에서도 인사 시스템과 AD는 다른 시스템이고,
-- 둘을 맞추는 것이 입·퇴사 처리의 핵심이다.
-- 시각 값은 모두 UTC ISO 8601 문자열(예: 2026-11-11T19:30:00.000Z)로 저장한다.

-- 사업장: 본사, 공장
CREATE TABLE sites (
  code        TEXT PRIMARY KEY,                               -- 예: HQ, PLANT1
  name        TEXT NOT NULL,                                  -- 예: 본사
  kind        TEXT NOT NULL CHECK (kind IN ('HQ', 'PLANT')),
  sort_order  INTEGER NOT NULL
);

-- 부서: 각 부서는 한 사업장에 속한다
CREATE TABLE departments (
  code        TEXT PRIMARY KEY,                               -- 예: MGMT
  name        TEXT NOT NULL,                                  -- 예: 경영지원팀
  site_code   TEXT NOT NULL REFERENCES sites(code),
  sort_order  INTEGER NOT NULL
);

-- 직원(인사 명단)
CREATE TABLE employees (
  emp_no        TEXT PRIMARY KEY,                             -- 사번, 예: DT-0004
  name          TEXT NOT NULL,
  dept_code     TEXT NOT NULL REFERENCES departments(code),
  job_title     TEXT NOT NULL,                                -- 직급, 예: 대리
  is_team_lead  INTEGER NOT NULL DEFAULT 0 CHECK (is_team_lead IN (0, 1)),
  duty          TEXT,                                         -- 담당 업무(있을 때만), 예: 전산·IT 운영
  hire_date     TEXT NOT NULL,                                -- 입사일 YYYY-MM-DD
  extension     TEXT NOT NULL                                 -- 내선 번호
);
CREATE INDEX idx_employees_dept ON employees(dept_code);

-- 데모 로그인 세션
-- 쿠키에 담긴 토큰 원문은 저장하지 않고 SHA-256 해시만 저장한다.
-- (DB가 유출돼도 해시만으로는 세션을 가로챌 수 없게)
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  persona     TEXT NOT NULL,                                  -- it_admin / employee
  emp_no      TEXT NOT NULL REFERENCES employees(emp_no),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- 데모 초기화 기록 (초기화 때도 지우지 않는다)
CREATE TABLE reset_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type  TEXT NOT NULL CHECK (trigger_type IN ('cron', 'manual')),
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  statements    INTEGER NOT NULL DEFAULT 0,                   -- 실행한 SQL 문 수
  message       TEXT
);
