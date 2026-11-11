-- 0002_helpdesk.sql : 2단계 헬프데스크
-- 티켓, 티켓 이력, FAQ. 시각은 모두 UTC ISO 8601 문자열.

CREATE TABLE tickets (
  id                  INTEGER PRIMARY KEY,                       -- 화면 표시는 HD-0001 형식
  requester_emp_no    TEXT NOT NULL REFERENCES employees(emp_no),
  category            TEXT NOT NULL CHECK (category IN ('NETWORK', 'PC', 'ACCOUNT', 'PRINTER', 'SOFTWARE', 'SECURITY')),
  priority            TEXT NOT NULL CHECK (priority IN ('URGENT', 'HIGH', 'NORMAL', 'LOW')),
  title               TEXT NOT NULL,
  symptom             TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('RECEIVED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED')),
  assignee_emp_no     TEXT REFERENCES employees(emp_no),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  sla_due_at          TEXT NOT NULL,                             -- SLA 기한 (보류로 멈춘 시간 반영)
  sla_paused_minutes  INTEGER NOT NULL DEFAULT 0,                -- 보류로 멈춘 업무 시간 합계(분)
  hold_started_at     TEXT,                                      -- 보류 중일 때만 값이 있음
  resolved_at         TEXT,
  cause               TEXT,                                      -- 완료 시 원인
  action_taken        TEXT,                                      -- 완료 시 조치
  verification        TEXT,                                      -- 완료 시 검증 결과
  incident_url        TEXT,                                      -- B(Uptime Monitor) 장애 링크. 링크만 저장
  version             INTEGER NOT NULL DEFAULT 1,                -- 동시 수정 방지(낙관적 잠금)용
  write_token         TEXT,                                      -- 마지막으로 이 티켓을 바꾼 요청의 무작위 표식 (이력 INSERT 보호용)
  -- 이중 안전장치: 서버 코드가 놓쳐도 DB가 "내용 없는 완료"와 "담당자 없는 진행"을 거부한다
  CHECK (status <> 'RESOLVED' OR (resolved_at IS NOT NULL AND cause IS NOT NULL AND action_taken IS NOT NULL AND verification IS NOT NULL)),
  CHECK (status = 'RECEIVED' OR assignee_emp_no IS NOT NULL),
  CHECK ((status = 'ON_HOLD') = (hold_started_at IS NOT NULL))
);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_requester ON tickets(requester_emp_no);
CREATE INDEX idx_tickets_assignee ON tickets(assignee_emp_no);

-- 티켓 이력: 추가만 한다 (수정·삭제 API 없음)
CREATE TABLE ticket_events (
  id            INTEGER PRIMARY KEY,
  ticket_id     INTEGER NOT NULL REFERENCES tickets(id),
  event_type    TEXT NOT NULL CHECK (event_type IN ('CREATED', 'ASSIGNED', 'STATUS_CHANGED', 'NOTE', 'LINK_CHANGED', 'FAQ_PUBLISHED')),
  actor_emp_no  TEXT NOT NULL REFERENCES employees(emp_no),
  from_status   TEXT,
  to_status     TEXT,
  note          TEXT,
  data          TEXT,                                            -- 추가 정보(JSON)
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_ticket_events_ticket ON ticket_events(ticket_id, created_at);

-- FAQ(사용자 매뉴얼): 완료 티켓 1건당 최대 1개. 요청자 정보는 넣지 않는다.
CREATE TABLE faq_articles (
  id                INTEGER PRIMARY KEY,
  source_ticket_id  INTEGER NOT NULL UNIQUE REFERENCES tickets(id),
  category          TEXT NOT NULL,
  title             TEXT NOT NULL,
  question          TEXT NOT NULL,
  answer            TEXT NOT NULL,
  published_by      TEXT NOT NULL REFERENCES employees(emp_no),
  created_at        TEXT NOT NULL
);
