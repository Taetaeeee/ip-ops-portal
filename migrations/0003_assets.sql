-- 0003_assets.sql : 3단계 IT 자산·라이선스
-- 날짜만 필요한 값은 'YYYY-MM-DD', 시각은 UTC ISO 8601 문자열.

-- IT 자산
-- 개인 장비(노트북·데스크톱)는 사람에게 배정하고, 공용 장비(프린터·네트워크·서버·생산라인 PC)는
-- 위치(location)로 관리한다. 공용 장비를 특정 직원 명의로 두면 퇴사 처리 때 꼬이기 때문.
CREATE TABLE assets (
  id                 INTEGER PRIMARY KEY,
  asset_tag          TEXT NOT NULL UNIQUE,                    -- 자산 번호, 예: NB-0012 (사번 DT-0004 와 겹치지 않는 접두어)
  asset_type         TEXT NOT NULL CHECK (asset_type IN ('LAPTOP', 'DESKTOP', 'PRINTER', 'NETWORK', 'SERVER')),
  manufacturer       TEXT NOT NULL,
  model              TEXT NOT NULL,
  serial_no          TEXT NOT NULL UNIQUE,                    -- 같은 시리얼이 두 번 등록되면 안 된다
  purchased_on       TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('IN_USE', 'IN_STOCK', 'REPAIR', 'DISPOSED')),
  location           TEXT,                                    -- 공용 장비 위치
  status_note        TEXT,                                    -- 수리·폐기 사유
  status_changed_at  TEXT,
  version            INTEGER NOT NULL DEFAULT 1,              -- 동시 수정 방지(낙관적 잠금)
  write_token        TEXT,
  CHECK (status NOT IN ('REPAIR', 'DISPOSED') OR status_note IS NOT NULL)
);
CREATE INDEX idx_assets_status ON assets(status);

-- 배정·반납 이력. returned_at 이 비어 있으면 "지금 쓰는 중"
CREATE TABLE asset_assignments (
  id                INTEGER PRIMARY KEY,
  asset_id          INTEGER NOT NULL REFERENCES assets(id),
  emp_no            TEXT NOT NULL REFERENCES employees(emp_no),
  assigned_at       TEXT NOT NULL,
  assigned_by       TEXT NOT NULL REFERENCES employees(emp_no),
  assign_note       TEXT,
  returned_at       TEXT,
  returned_by       TEXT REFERENCES employees(emp_no),
  return_condition  TEXT CHECK (return_condition IN ('IN_STOCK', 'REPAIR')),
  return_note       TEXT,
  CHECK ((returned_at IS NULL) = (returned_by IS NULL)),
  CHECK ((returned_at IS NULL) = (return_condition IS NULL))
);
-- 이중 안전장치: 한 자산에 "반납 안 된 배정"은 1건만 (부분 고유 인덱스)
CREATE UNIQUE INDEX ux_asset_assignments_open ON asset_assignments(asset_id) WHERE returned_at IS NULL;
CREATE INDEX idx_asset_assignments_emp ON asset_assignments(emp_no);

-- 라이선스 (계약 단위)
CREATE TABLE licenses (
  id            INTEGER PRIMARY KEY,
  product_name  TEXT NOT NULL,
  vendor        TEXT NOT NULL,                                -- 계약 업체 (가상)
  license_type  TEXT NOT NULL CHECK (license_type IN ('PERPETUAL', 'SUBSCRIPTION')),
  quantity      INTEGER NOT NULL CHECK (quantity >= 0),       -- 보유 수량 (설치 가능 대수)
  expires_on    TEXT,                                         -- 비어 있으면 영구
  contract_no   TEXT
);

-- 허용 소프트웨어 목록. 설치 SW 이름을 이 규칙으로 맞춰 본다.
-- license_id 가 있으면 유료(라이선스 수에 포함), 없으면 무료·기본 탑재 허용.
CREATE TABLE software_allowlist (
  id          INTEGER PRIMARY KEY,
  pattern     TEXT NOT NULL,
  match_type  TEXT NOT NULL CHECK (match_type IN ('EXACT', 'PREFIX')),
  license_id  INTEGER REFERENCES licenses(id),
  note        TEXT
);

-- 자산별 설치 소프트웨어 (6단계부터는 가상 에이전트가 보고한다)
CREATE TABLE asset_software (
  id             INTEGER PRIMARY KEY,
  asset_id       INTEGER NOT NULL REFERENCES assets(id),
  software_name  TEXT NOT NULL,
  version        TEXT,
  installed_on   TEXT
);
CREATE INDEX idx_asset_software_asset ON asset_software(asset_id);

-- 티켓 ↔ 자산 연결 (관련 자산 1개)
ALTER TABLE tickets ADD COLUMN asset_id INTEGER REFERENCES assets(id);
CREATE INDEX idx_tickets_asset ON tickets(asset_id);
