// 使用真实 SQLite 检查设计附件，输出写入项目内已忽略的数据目录。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TASK_STATES, WAIT_REASONS, APPLY_PHASES, ERROR_CODES, DEFAULT_LIMITS } from './contracts.ts';

const here = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(here, '../..');
const output = join(runtime, '.verify/superagent-design');
mkdirSync(output, { recursive: true });
const run = mkdtempSync(join(output, 'schema-'));
const db = new DatabaseSync(join(run, 'state.sqlite'));
const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
db.exec(sql);
const checks = [];
function check(name, body) { body(); checks.push(name); }
function reject(name, body) { check(name, () => assert.throws(body)); }
function object(text) {
  const digest = createHash('sha256').update(text).digest('hex');
  db.prepare('INSERT OR IGNORE INTO objects VALUES (?,?,?,?,?)').run(digest, Buffer.byteLength(text), 'manifest', digest, 1);
  return digest;
}
function project(id) {
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'device', `/projects/${id}`, `/projects/${id}`, `/projects/${id}/.git`, '', `main-${id}`, 'enabled', 1, 1, 1, 1, 1);
  db.prepare('INSERT INTO configurations VALUES (?,?,?,?,?)').run(id, 1, object(`config-${id}`), '{}', 1);
  operation(`message-${id}`, 'human', id, 'send');
  message(`message-${id}`, id, `message-${id}`);
  db.prepare('INSERT INTO goals VALUES (?,?,?,?,?,?,?,?,?,?)').run(`message-${id}`, id, 'active', 0, DEFAULT_LIMITS.goalModelRequests, 0, DEFAULT_LIMITS.goalTasks, 1, 1, 1);
  db.prepare('UPDATE messages SET goal_id=? WHERE id=?').run(`message-${id}`, `message-${id}`);
}
function task(id, state = 'queued', owner = 'p') {
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, `message-${owner}`, '任务', object(`goal-${id}`), 'empty', null, 'refs/heads/main', 1, state, 1, 1, 0, 100, 1, 1);
}
function operation(id, actor = 'human', owner = 'p', kind = 'decide') {
  const digest = object(`request-${id}`);
  db.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, actor, 'actor', kind, digest, digest, 1, 'accepted', null, null, 1, 1, null);
}
function message(id, owner, op = null, session = null, sequence = null) {
  const position = db.prepare('SELECT coalesce(max(position),0)+1 AS value FROM messages WHERE project_id=?').get(owner).value;
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, session ? 'assistant' : 'user', object(`text-${id}`), op, session, sequence, 'final', 1, 1, 1, session ? `message-${owner}` : null, position);
}
function decision(id, state = 'pending', op = null, owner = 'p') {
  db.prepare('INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, owner, 'dependency', object(`scope-${id}`), '{}', state, 1, op, 1, null);
}
function allow(id) {
  const op = `op-${id}`;
  operation(op);
  decision(id);
  db.prepare("UPDATE decisions SET state='allowed',operation_id=?,revision=2 WHERE id=?").run(op, id);
}
function artifact(id, source, scope = 'task-output') {
  if (!db.prepare('SELECT id FROM attempts WHERE id=?').get(`attempt-${source}`)) {
    db.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?)').run(`attempt-${source}`, source, 1, `worker-${source}`, 'ended', 'workspace', null, 1, 1);
    db.prepare('INSERT INTO agent_sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run(`worker-${source}`, 'p', source, `attempt-${source}`, 'worker', null, 0, 1, 'ended', 1);
  }
  const version = db.prepare('SELECT coalesce(max(version),0)+1 AS value FROM artifacts WHERE task_id=?').get(source).value;
  db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, source, 'p', `attempt-${source}`, `worker-${source}`, scope, version, object(`artifact-${id}`), object(`input-${id}`), 1);
}
function review(id, owner = 'p') {
  db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, object(`review-${id}`), null, 'refs/heads/main', 'apply_commit', object(`index-${id}`), object(`work-${id}`), 'a'.repeat(40), object(`message-${id}`), 'ready', 1, 1);
}
function apply(id, rev, op, phase = 'prepared', owner = 'p', action = 'apply_commit') {
  db.prepare('INSERT INTO applies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, rev, op, action, phase, null, null, null, null, null, 1, 1, 1);
}

project('p');
project('q');
check('foreign_keys_enabled', () => assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1));
for (const state of TASK_STATES) check(`task_state_${state}`, () => task(`state-${state}`, state));
reject('unknown_task_state', () => task('invalid-task', 'invalid'));
reject('empty_base_has_no_oid', () => db.prepare("UPDATE tasks SET base_oid=? WHERE id='state-queued'").run('a'.repeat(40)));
reject('commit_base_requires_oid', () => db.prepare("UPDATE tasks SET base_kind='commit' WHERE id='state-queued'").run());
reject('message_operation_deduplicated', () => message('repeated-message', 'p', 'message-p'));
reject('cross_project_origin_rejected', () => db.prepare("UPDATE tasks SET origin_message_id='message-q' WHERE id='state-queued'").run());
reject('message_goal_immutable', () => db.prepare("UPDATE messages SET goal_id=NULL WHERE id='message-p'").run());
task('a'); task('b'); task('c'); task('other', 'queued', 'q');
for (const reason of WAIT_REASONS) check(`wait_${reason}`, () => db.prepare('INSERT INTO task_waits VALUES (?,?,?,?)').run('a', reason, reason, 1));
reject('unknown_wait_reason', () => db.prepare('INSERT INTO task_waits VALUES (?,?,?,?)').run('a', 'invalid', 'x', 1));
db.prepare('INSERT INTO router_runs VALUES (?,?,?,?,?,?,?,?)').run('router', 'p', 'router-session', 1, 'active', 1, 1, null);
db.prepare('INSERT INTO agent_sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run('router-session', 'p', null, null, 'router', null, 0, 1, 'active', 1);
check('router_message_has_real_source', () => message('reply', 'p', null, 'router-session', 1));
reject('router_message_deduplicated', () => message('repeated-reply', 'p', null, 'router-session', 1));
reject('message_sequence_required', () => message('missing-sequence', 'p', null, 'router-session', null));
reject('message_source_immutable', () => db.prepare("UPDATE messages SET source_seq=2 WHERE id='reply'").run());
reject('model_cannot_originate_goal', () => db.prepare('INSERT INTO goals VALUES (?,?,?,?,?,?,?,?,?,?)').run('reply', 'p', 'active', 0, 500, 0, 50, 1, 1, 1));
reject('goal_request_budget_enforced', () => db.prepare("UPDATE goals SET model_requests_used=model_requests_limit+1 WHERE origin_message_id='message-p'").run());
reject('goal_task_budget_enforced', () => db.prepare("UPDATE goals SET tasks_created=tasks_limit+1 WHERE origin_message_id='message-p'").run());
reject('one_router_per_project', () => db.prepare('INSERT INTO router_runs VALUES (?,?,?,?,?,?,?,?)').run('router-2', 'p', 'router-2-session', 2, 'active', 1, 1, null));
db.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?)').run('attempt-a', 'a', 1, 'worker-a', 'running', 'workspace', null, 1, null);
reject('one_attempt_per_task', () => db.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?)').run('attempt-a2', 'a', 1, 'worker-a2', 'pending', 'workspace', null, 1, null));
db.prepare('INSERT INTO agent_sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run('worker-a', 'p', 'a', 'attempt-a', 'worker', null, 0, 1, 'active', 1);
reject('worker_cannot_impersonate_router_message', () => message('worker-reply', 'p', null, 'worker-a', 1));
check('one_child_layer_allowed', () => db.prepare('INSERT INTO agent_sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run('child-a', 'p', 'a', 'attempt-a', 'subagent', 'worker-a', 1, 1, 'active', 1));
reject('grandchild_rejected', () => db.prepare('INSERT INTO agent_sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run('grandchild', 'p', 'a', 'attempt-a', 'subagent', 'child-a', 1, 1, 'active', 1));
reject('depth_two_rejected', () => db.prepare('INSERT INTO agent_sessions VALUES (?,?,?,?,?,?,?,?,?,?)').run('depth-two', 'p', 'a', 'attempt-a', 'subagent', 'worker-a', 2, 1, 'active', 1));
reject('actor_identity_immutable', () => db.prepare("UPDATE agent_sessions SET role='worker' WHERE id='child-a'").run());
operation('agent-op', 'agent'); decision('blocked');
reject('agent_cannot_allow_decision', () => db.prepare("UPDATE decisions SET state='allowed',operation_id='agent-op' WHERE id='blocked'").run());
reject('decision_cannot_start_allowed', () => decision('bypass', 'allowed', 'agent-op'));
allow('dep-a'); allow('dep-b');
artifact('artifact-a', 'a'); artifact('artifact-b', 'b');
artifact('internal-a', 'a', 'internal');
reject('internal_artifact_not_cross_task_input', () => db.prepare('INSERT INTO dependencies VALUES (?,?,?,?,?,?)').run('c', 'a', 'p', 'internal-a', 'dep-a', 1));
check('authorized_dependency', () => db.prepare('INSERT INTO dependencies VALUES (?,?,?,?,?,?)').run('b', 'a', 'p', 'artifact-a', 'dep-a', 1));
reject('dependency_immutable', () => db.prepare("UPDATE dependencies SET producer_task_id='c' WHERE consumer_task_id='b'").run());
reject('dependency_cycle', () => db.prepare('INSERT INTO dependencies VALUES (?,?,?,?,?,?)').run('a', 'b', 'p', 'artifact-b', 'dep-b', 1));
reject('wrong_producer_rejected', () => db.prepare('INSERT INTO dependencies VALUES (?,?,?,?,?,?)').run('c', 'b', 'p', 'artifact-a', 'dep-a', 1));
reject('unapproved_dependency', () => db.prepare('INSERT INTO dependencies VALUES (?,?,?,?,?,?)').run('c', 'a', 'p', 'artifact-a', 'blocked', 1));
reject('cross_project_dependency', () => db.prepare('INSERT INTO dependencies VALUES (?,?,?,?,?,?)').run('other', 'a', 'p', 'artifact-a', 'dep-a', 1));
reject('artifact_immutable', () => db.prepare("UPDATE artifacts SET version=99 WHERE id='artifact-a'").run());
review('review-a');
reject('internal_artifact_not_project_review', () => db.prepare('INSERT INTO review_artifacts VALUES (?,?)').run('review-a', 'internal-a'));
reject('agent_cannot_apply', () => apply('bad-apply', 'review-a', 'agent-op'));
operation('human-apply', 'human', 'p', 'apply');
check('human_can_start_apply', () => apply('apply-a', 'review-a', 'human-apply'));
operation('human-apply2', 'human', 'p', 'apply'); review('review-b');
reject('one_apply_per_project', () => apply('apply-b', 'review-b', 'human-apply2'));
db.prepare("UPDATE applies SET phase='conflict' WHERE id='apply-a'").run();
reject('conflicted_apply_keeps_lock', () => apply('apply-conflict', 'review-b', 'human-apply2'));
db.prepare("UPDATE applies SET phase='completed' WHERE id='apply-a'").run();
reject('review_consumed_once', () => apply('repeat-review', 'review-a', 'human-apply2'));
reject('review_action_bound', () => apply('wrong-action', 'review-b', 'human-apply2', 'prepared', 'p', 'apply'));
operation('wrong-operation');
reject('unrelated_human_operation_cannot_apply', () => apply('wrong-human-apply', 'review-b', 'wrong-operation'));
review('other-project-review', 'q');
reject('review_cannot_include_other_project', () => db.prepare('INSERT INTO review_artifacts VALUES (?,?)').run('other-project-review', 'artifact-a'));
for (const phase of APPLY_PHASES) {
  const id = `phase-${phase}`;
  project(id); operation(`op-${id}`, 'human', id, 'apply'); review(`review-${id}`, id);
  check(`apply_phase_${phase}`, () => apply(`apply-${id}`, `review-${id}`, `op-${id}`, phase, id));
}
operation('invalid-phase', 'human', 'p', 'apply'); review('invalid-review');
reject('unknown_apply_phase', () => apply('invalid-apply', 'invalid-review', 'invalid-phase', 'invalid'));
reject('unknown_operation_cannot_expire', () => db.prepare("UPDATE operations SET state='unconfirmed',expires_at=2 WHERE id='human-apply'").run());
db.prepare('INSERT INTO events (project_id,kind,entity_id,revision,payload,created_at) VALUES (?,?,?,?,?,?)').run('p', 'task_changed', 'a', 1, '{}', 1);
reject('event_immutable', () => db.prepare("UPDATE events SET revision=2 WHERE entity_id='a'").run());
check('all_foreign_keys_valid', () => assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []));
check('metric_phase_cardinality', () => assert.ok(new Set([...TASK_STATES, ...WAIT_REASONS, ...APPLY_PHASES]).size <= 32));
check('defaults_are_bounded', () => assert.ok(DEFAULT_LIMITS.workerChildren > 0 && DEFAULT_LIMITS.taskModelRequests > 0));
const protocol = readFileSync(join(here, 'protocol.md'), 'utf8');
for (const code of ERROR_CODES) check(`error_documented_${code}`, () => assert.ok(protocol.includes(code)));
const report = { checks: checks.length, passed: checks, database: join(run, 'state.sqlite'), scope: 'design-sql-and-contract', productionAcceptance: false };
writeFileSync(join(run, 'report.json'), JSON.stringify(report, null, 2));
db.close();
console.log(JSON.stringify(report, null, 2));
