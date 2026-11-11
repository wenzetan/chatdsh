-- 设备侧 Super-Agent 数据库第一版；所有时间使用 UTC 毫秒。
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
) STRICT;

CREATE TABLE store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_device_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  repository_root TEXT NOT NULL,
  git_common_directory TEXT NOT NULL,
  project_relative_path TEXT NOT NULL,
  main_conversation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('enabled','disabled','recovery','archived')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  config_revision INTEGER NOT NULL CHECK (config_revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_device_id, canonical_path)
) STRICT;

CREATE TABLE configurations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, revision)
) STRICT;

CREATE TABLE router_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('preparing','active','stopping','ended','interrupted')),
  config_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  FOREIGN KEY (project_id, config_revision) REFERENCES configurations(project_id, revision),
  UNIQUE (project_id, generation)
) STRICT;
CREATE UNIQUE INDEX router_one_live ON router_runs(project_id) WHERE state IN ('preparing','active','stopping');

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','agent','system')),
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  request_ref TEXT NOT NULL REFERENCES objects(digest) ON DELETE RESTRICT,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('accepted','applied','rejected','conflict','unconfirmed')),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  CHECK (state <> 'unconfirmed' OR expires_at IS NULL)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  origin_message_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal_ref TEXT NOT NULL,
  base_kind TEXT NOT NULL CHECK (base_kind IN ('commit','empty')),
  base_oid TEXT,
  target_ref TEXT,
  config_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','preparing','running','waiting','review','completed','cancelled','failed')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  generation INTEGER NOT NULL CHECK (generation > 0),
  model_requests_used INTEGER NOT NULL DEFAULT 0 CHECK (model_requests_used >= 0),
  model_requests_limit INTEGER NOT NULL CHECK (model_requests_limit > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id, config_revision) REFERENCES configurations(project_id, revision),
  FOREIGN KEY (origin_message_id,project_id) REFERENCES goals(origin_message_id,project_id),
  CHECK ((base_kind = 'empty' AND base_oid IS NULL) OR (base_kind = 'commit' AND base_oid IS NOT NULL AND length(base_oid) IN (40,64))),
  UNIQUE (id, project_id)
) STRICT;
CREATE INDEX tasks_pending ON tasks(project_id,state,created_at);

CREATE TABLE task_waits (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('dependency','question','approval','budget','recovery','resource','unconfirmed','paused')),
  source_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id,reason,source_id)
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  worker_session_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending','running','ended','interrupted')),
  workspace_id TEXT NOT NULL,
  end_reason TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (id,task_id)
) STRICT;
CREATE UNIQUE INDEX attempts_one_live ON attempts(task_id) WHERE state IN ('pending','running');

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT,
  attempt_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('router','worker','subagent')),
  parent_id TEXT REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  child_depth INTEGER NOT NULL CHECK (child_depth IN (0,1)),
  generation INTEGER NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('registered','active','waiting','stopping','ended','interrupted')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id,project_id) REFERENCES tasks(id,project_id),
  FOREIGN KEY (attempt_id,task_id) REFERENCES attempts(id,task_id),
  CHECK ((role = 'router' AND task_id IS NULL AND attempt_id IS NULL AND parent_id IS NULL AND child_depth = 0)
    OR (role = 'worker' AND task_id IS NOT NULL AND attempt_id IS NOT NULL AND parent_id IS NULL AND child_depth = 0)
    OR (role = 'subagent' AND task_id IS NOT NULL AND attempt_id IS NOT NULL AND parent_id IS NOT NULL AND child_depth = 1))
) STRICT;
CREATE TRIGGER child_parent_guard BEFORE INSERT ON agent_sessions WHEN NEW.role = 'subagent'
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM agent_sessions p WHERE p.id=NEW.parent_id AND p.role='worker' AND p.task_id=NEW.task_id AND p.attempt_id=NEW.attempt_id AND p.project_id=NEW.project_id AND p.generation=NEW.generation AND p.state IN ('registered','active','waiting')) THEN RAISE(ABORT,'invalid_child_parent') END;
END;
CREATE TRIGGER agent_identity_immutable BEFORE UPDATE OF project_id,task_id,attempt_id,role,parent_id,child_depth,generation ON agent_sessions
BEGIN SELECT RAISE(ABORT,'agent_identity_immutable'); END;
CREATE TRIGGER worker_attempt_guard BEFORE INSERT ON agent_sessions WHEN NEW.role='worker'
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM attempts a WHERE a.id=NEW.attempt_id AND a.task_id=NEW.task_id AND a.worker_session_id=NEW.id AND a.generation=NEW.generation) THEN RAISE(ABORT,'invalid_worker_attempt') END;
END;

CREATE TABLE objects (
  digest TEXT PRIMARY KEY CHECK (length(digest)=64),
  bytes INTEGER NOT NULL CHECK (bytes>=0),
  kind TEXT NOT NULL CHECK (kind IN ('text','binary','manifest','evidence','file_image','message')),
  storage_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text_ref TEXT NOT NULL REFERENCES objects(digest) ON DELETE RESTRICT,
  operation_id TEXT UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  source_session_id TEXT REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  source_seq INTEGER,
  state TEXT NOT NULL CHECK (state IN ('streaming','final','interrupted')),
  revision INTEGER NOT NULL CHECK (revision>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  goal_id TEXT,
  position INTEGER NOT NULL CHECK (position>0),
  FOREIGN KEY (goal_id,project_id) REFERENCES goals(origin_message_id,project_id),
  CHECK ((role='user' AND operation_id IS NOT NULL AND source_session_id IS NULL AND source_seq IS NULL AND state='final')
    OR (role='assistant' AND operation_id IS NULL AND source_session_id IS NOT NULL AND source_seq IS NOT NULL AND source_seq>=0)),
  UNIQUE (source_session_id,source_seq),
  UNIQUE (project_id,position),
  UNIQUE (id,project_id)
) STRICT;
CREATE INDEX messages_project ON messages(project_id,position);
CREATE TRIGGER message_source_guard BEFORE INSERT ON messages
BEGIN
  SELECT CASE WHEN NEW.role='user' AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.id=NEW.operation_id AND o.project_id=NEW.project_id AND o.actor_kind='human' AND o.kind='send') THEN RAISE(ABORT,'human_message_required') END;
  SELECT CASE WHEN NEW.role='assistant' AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id=NEW.source_session_id AND s.project_id=NEW.project_id AND s.role='router') THEN RAISE(ABORT,'router_message_required') END;
END;
CREATE TRIGGER message_identity_immutable BEFORE UPDATE OF id,project_id,role,operation_id,source_session_id,source_seq,position ON messages
BEGIN SELECT RAISE(ABORT,'message_identity_immutable'); END;
CREATE TRIGGER message_goal_immutable BEFORE UPDATE OF goal_id ON messages WHEN OLD.goal_id IS NOT NULL AND NEW.goal_id IS NOT OLD.goal_id
BEGIN SELECT RAISE(ABORT,'message_goal_immutable'); END;

CREATE TABLE goals (
  origin_message_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('active','waiting','completed','cancelled')),
  model_requests_used INTEGER NOT NULL CHECK (model_requests_used>=0),
  model_requests_limit INTEGER NOT NULL CHECK (model_requests_limit>0 AND model_requests_used<=model_requests_limit),
  tasks_created INTEGER NOT NULL CHECK (tasks_created>=0),
  tasks_limit INTEGER NOT NULL CHECK (tasks_limit>0 AND tasks_created<=tasks_limit),
  revision INTEGER NOT NULL CHECK (revision>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (origin_message_id,project_id) REFERENCES messages(id,project_id),
  UNIQUE (origin_message_id,project_id)
) STRICT;
CREATE TRIGGER goal_source_guard BEFORE INSERT ON goals
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM messages m WHERE m.id=NEW.origin_message_id AND m.project_id=NEW.project_id AND m.role='user') THEN RAISE(ABORT,'human_goal_required') END;
END;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE RESTRICT,
  producer_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (scope IN ('task-output','internal')),
  version INTEGER NOT NULL CHECK (version>0),
  manifest_digest TEXT NOT NULL REFERENCES objects(digest) ON DELETE RESTRICT,
  input_manifest_digest TEXT NOT NULL REFERENCES objects(digest) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id,project_id) REFERENCES tasks(id,project_id),
  UNIQUE (task_id,version),
  UNIQUE (id,project_id)
) STRICT;
CREATE TRIGGER artifact_source_guard BEFORE INSERT ON artifacts
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id=NEW.producer_session_id AND s.project_id=NEW.project_id AND s.task_id=NEW.task_id AND s.attempt_id=NEW.attempt_id AND (NEW.scope='internal' OR s.role='worker')) THEN RAISE(ABORT,'invalid_artifact_source') END;
END;
CREATE TRIGGER artifact_immutable BEFORE UPDATE ON artifacts
BEGIN SELECT RAISE(ABORT,'artifact_immutable'); END;

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('dependency','question','approval','recovery','budget')),
  scope_digest TEXT NOT NULL REFERENCES objects(digest) ON DELETE RESTRICT,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  state TEXT NOT NULL CHECK (state IN ('pending','allowed','denied','expired','revoked')),
  revision INTEGER NOT NULL CHECK (revision>0),
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  CHECK (state NOT IN ('allowed','denied','revoked') OR operation_id IS NOT NULL)
) STRICT;
CREATE TRIGGER decision_human_guard BEFORE UPDATE OF state ON decisions WHEN NEW.state IN ('allowed','denied','revoked')
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM operations o WHERE o.id=NEW.operation_id AND o.actor_kind='human' AND o.project_id=NEW.project_id AND o.kind IN ('decide','control') AND o.state='accepted') THEN RAISE(ABORT,'human_decision_required') END;
END;
CREATE TRIGGER decision_pending_guard BEFORE INSERT ON decisions WHEN NEW.state<>'pending'
BEGIN SELECT RAISE(ABORT,'decision_must_start_pending'); END;

CREATE TABLE dependencies (
  consumer_task_id TEXT NOT NULL,
  producer_task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (consumer_task_id,project_id) REFERENCES tasks(id,project_id),
  FOREIGN KEY (producer_task_id,project_id) REFERENCES tasks(id,project_id),
  FOREIGN KEY (artifact_id,project_id) REFERENCES artifacts(id,project_id),
  PRIMARY KEY (consumer_task_id,artifact_id),
  CHECK (consumer_task_id<>producer_task_id)
) STRICT;
CREATE TRIGGER dependency_guard BEFORE INSERT ON dependencies
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM artifacts a JOIN decisions d ON d.id=NEW.decision_id WHERE a.id=NEW.artifact_id AND a.task_id=NEW.producer_task_id AND a.scope='task-output' AND d.project_id=NEW.project_id AND d.kind='dependency' AND d.state='allowed') THEN RAISE(ABORT,'dependency_unapproved') END;
  SELECT CASE WHEN EXISTS (WITH RECURSIVE parents(id) AS (SELECT producer_task_id FROM dependencies WHERE consumer_task_id=NEW.producer_task_id UNION SELECT d.producer_task_id FROM dependencies d JOIN parents p ON d.consumer_task_id=p.id) SELECT 1 FROM parents WHERE id=NEW.consumer_task_id) THEN RAISE(ABORT,'dependency_cycle') END;
END;
CREATE TRIGGER dependency_immutable BEFORE UPDATE ON dependencies
BEGIN SELECT RAISE(ABORT,'dependency_immutable'); END;

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  manifest_digest TEXT NOT NULL REFERENCES objects(digest) ON DELETE RESTRICT,
  expected_head TEXT,
  expected_ref TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('apply','apply_commit')),
  index_digest TEXT NOT NULL CHECK (length(index_digest)=64),
  worktree_digest TEXT NOT NULL CHECK (length(worktree_digest)=64),
  candidate_tree TEXT NOT NULL CHECK (length(candidate_tree) IN (40,64)),
  commit_message_ref TEXT NOT NULL REFERENCES objects(digest) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('building','ready','stale','consumed','conflict')),
  revision INTEGER NOT NULL CHECK (revision>0),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE review_artifacts (
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE RESTRICT,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  PRIMARY KEY (review_id,artifact_id)
) STRICT;
CREATE TRIGGER review_artifact_project_guard BEFORE INSERT ON review_artifacts
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM reviews r JOIN artifacts a ON a.id=NEW.artifact_id WHERE r.id=NEW.review_id AND r.project_id=a.project_id AND a.scope='task-output') THEN RAISE(ABORT,'review_artifact_project_mismatch') END;
END;

CREATE TABLE applies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  review_id TEXT NOT NULL UNIQUE REFERENCES reviews(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('apply','apply_commit')),
  phase TEXT NOT NULL CHECK (phase IN ('preparing','prepared','authorized','files_applying','files_applied','index_applied','ref_published','verified','completed','needs_decision','conflict','aborted')),
  candidate_commit TEXT,
  observed_head TEXT,
  before_index_ref TEXT REFERENCES objects(digest) ON DELETE RESTRICT,
  after_index_ref TEXT REFERENCES objects(digest) ON DELETE RESTRICT,
  inspected_digest TEXT,
  revision INTEGER NOT NULL CHECK (revision>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX apply_one_live ON applies(project_id) WHERE phase NOT IN ('completed','aborted');
CREATE TRIGGER apply_human_guard BEFORE INSERT ON applies
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM operations o JOIN reviews r ON r.id=NEW.review_id WHERE o.id=NEW.operation_id AND o.actor_kind='human' AND o.kind='apply' AND o.state='accepted' AND o.project_id=NEW.project_id AND r.project_id=NEW.project_id AND r.status='ready' AND r.action=NEW.action) THEN RAISE(ABORT,'human_apply_required') END;
END;

CREATE TABLE apply_files (
  apply_id TEXT NOT NULL REFERENCES applies(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal>=0),
  path TEXT NOT NULL,
  before_ref TEXT REFERENCES objects(digest) ON DELETE RESTRICT,
  after_ref TEXT REFERENCES objects(digest) ON DELETE RESTRICT,
  before_mode INTEGER,
  after_mode INTEGER,
  phase TEXT NOT NULL CHECK (phase IN ('planned','written','verified','conflict','restored')),
  PRIMARY KEY (apply_id,ordinal),
  UNIQUE (apply_id,path)
) STRICT;

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  attempt_id TEXT REFERENCES attempts(id) ON DELETE RESTRICT,
  input_ref TEXT NOT NULL REFERENCES objects(digest) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('pending','accepted','read','unknown','cancelled')),
  inbox_id TEXT,
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('create_agent','deliver','stop','seal','prepare_review','apply','notify','replicate')),
  stable_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','done','unknown','held','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX outbox_due ON outbox(state,due_at,id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('message','goal_changed','task_changed','decision_changed','artifact_created','apply_changed','config_changed','router_changed')),
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision>0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX events_project ON events(project_id,id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT,'event_immutable'); END;

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('model','process','resource')),
  resource_key TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount>0),
  state TEXT NOT NULL CHECK (state IN ('reserved','settled','released','unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX reservations_active ON reservations(kind,state,resource_key);

CREATE TABLE processes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('srt','docker')),
  identity TEXT NOT NULL CHECK (json_valid(identity)),
  state TEXT NOT NULL CHECK (state IN ('starting','running','exited','unknown','stopping')),
  created_at INTEGER NOT NULL,
  ended_at INTEGER
) STRICT;

CREATE TABLE object_links (
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  digest TEXT NOT NULL REFERENCES objects(digest) ON DELETE RESTRICT,
  PRIMARY KEY (owner_kind,owner_id,digest)
) STRICT;

CREATE TABLE command_nonces (
  nonce TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
