-- 0005_lifecycle.sql : 5단계 입·퇴사 처리 워크플로
-- 날짜만 필요한 값은 KST 'YYYY-MM-DD', 시각은 UTC ISO 8601 문자열.

-- 인사 기준 퇴사일. 재직·퇴사·입사 예정은 입사일·퇴사일과 오늘 날짜로 계산한다 (lifecycle-rules.js)
ALTER TABLE employees ADD COLUMN resign_date TEXT;

-- 입·퇴사 케이스
CREATE TABLE lifecycle_cases (
  id              INTEGER PRIMARY KEY,
  case_type       TEXT NOT NULL CHECK (case_type IN ('ONBOARDING', 'OFFBOARDING')),
  emp_no          TEXT NOT NULL REFERENCES employees(emp_no),
  effective_date  TEXT NOT NULL,                              -- 입사일 또는 퇴사일
  status          TEXT NOT NULL CHECK (status IN ('OPEN', 'COMPLETED')),
  dir_user_id     INTEGER REFERENCES dir_users(id),           -- 연결된 AD 계정 (입사는 계정 생성 후 채워짐)
  created_by      TEXT NOT NULL REFERENCES employees(emp_no),
  created_at      TEXT NOT NULL,
  completed_at    TEXT,
  note            TEXT,
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);
-- 같은 사람에게 같은 종류의 진행 중 케이스는 1건만
CREATE UNIQUE INDEX ux_lifecycle_open ON lifecycle_cases(emp_no, case_type) WHERE status = 'OPEN';

-- 체크리스트 항목
CREATE TABLE checklist_items (
  id               INTEGER PRIMARY KEY,
  case_id          INTEGER NOT NULL REFERENCES lifecycle_cases(id),
  seq              INTEGER NOT NULL,
  item_key         TEXT NOT NULL,
  title            TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('DIRECTORY', 'ASSET', 'LICENSE', 'MANUAL')),
  requires         TEXT NOT NULL DEFAULT '[]',                -- 선행 항목 키 (JSON 배열)
  status           TEXT NOT NULL CHECK (status IN ('PENDING', 'DONE')),
  assignee_emp_no  TEXT REFERENCES employees(emp_no),         -- 담당자
  completed_by     TEXT REFERENCES employees(emp_no),         -- 완료 처리자
  completed_at     TEXT,
  note             TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (case_id, item_key),
  UNIQUE (case_id, seq),
  CHECK ((status = 'DONE') = (completed_at IS NOT NULL AND completed_by IS NOT NULL))
);

-- 항목 ↔ 결과 연결 (한 항목에 여러 건: 그룹 제거 n건, 장비 여러 대, SW 여러 개)
-- SW 설치 기록은 회수하면 asset_software 에서 지워지므로, 이름을 여기에 남겨 이력으로 보관한다
CREATE TABLE checklist_links (
  id                INTEGER PRIMARY KEY,
  item_id           INTEGER NOT NULL REFERENCES checklist_items(id),
  link_type         TEXT NOT NULL CHECK (link_type IN (
                      'DIR_OPERATION', 'ASSET_ASSIGN', 'ASSET_RETURN', 'SOFTWARE_INSTALL', 'SOFTWARE_REMOVE')),
  dir_operation_id  INTEGER REFERENCES dir_operations(id),    -- A-4 작업 (→ 스크립트·이벤트)
  asset_id          INTEGER REFERENCES assets(id),
  assignment_id     INTEGER REFERENCES asset_assignments(id),
  detail            TEXT,                                     -- JSON (그룹 이름, SW 이름, 라이선스 등)
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_checklist_links_item ON checklist_links(item_id);
