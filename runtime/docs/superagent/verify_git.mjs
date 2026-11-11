// 只在项目内独立验证目录操作真实 Git 仓库，文本文件用作算法输入数据。
import assert from 'node:assert/strict';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(runtime, '.verify/superagent-design');
mkdirSync(output, { recursive: true });
const pointer = join(output, 'git-latest.json');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'ChatDSH Design Verification', GIT_AUTHOR_EMAIL: 'design-verification@chatdsh.invalid', GIT_COMMITTER_NAME: 'ChatDSH Design Verification', GIT_COMMITTER_EMAIL: 'design-verification@chatdsh.invalid' };
for (const key of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/u.test(key)) delete env[key];
function git(cwd, args, options = {}) {
  const result = spawnSync('git', ['-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${join(output, 'empty-hooks')}`, ...args], { cwd, env: { ...env, ...options.env }, stdio: options.stdio, encoding: options.binary ? 'buffer' : 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.error?.message ?? String(result.stderr)}`);
  return result.stdout;
}
function save(value) {
  const content = JSON.stringify(value, null, 2);
  writeFileSync(pointer, content);
  writeFileSync(join(value.root, 'state.json'), content);
}
function read() { return JSON.parse(readFileSync(pointer, 'utf8')); }
function data(lines) { return `${lines.join('\n')}\n`; }
function candidate(state, name, tree) {
  const dir = join(state.root, name);
  git(state.root, ['clone', '--quiet', '--shared', '--no-checkout', state.source, dir]);
  git(dir, ['read-tree', tree]);
  git(dir, ['checkout-index', '--all', '--index']);
  return dir;
}
function importTree(from, to, tree) {
  const request = join(from, '.git/export.oids');
  const archive = join(from, '.git/export.pack');
  writeFileSync(request, `${tree}\n`);
  const input = openSync(request, 'r');
  const packed = openSync(archive, 'w');
  git(from, ['pack-objects', '--stdout', '--revs'], { stdio: [input, packed, 'pipe'], binary: true });
  closeSync(input); closeSync(packed);
  const saved = openSync(archive, 'r');
  git(to, ['unpack-objects', '-q'], { stdio: [saved, 'pipe', 'pipe'], binary: true });
  closeSync(saved);
}
mkdirSync(join(output, 'empty-hooks'), { recursive: true });
const phase = process.argv[2];
if (phase === 'prepare') {
  const root = mkdtempSync(join(output, 'git-'));
  const source = join(root, 'project');
  const objectFormat = process.argv[3] ?? 'sha1';
  assert.ok(['sha1', 'sha256'].includes(objectFormat));
  git(root, ['init', '--quiet', '--initial-branch=main', `--object-format=${objectFormat}`, source]);
  git(source, ['worktree', 'add', '--orphan', '-b', 'worker-empty-a', '../empty-a']);
  git(source, ['worktree', 'add', '--orphan', '-b', 'worker-empty-b', '../empty-b']);
  for (const dir of [source, join(root, 'empty-a'), join(root, 'empty-b')]) assert.equal(git(dir, ['rev-list', '--all', '--count']).trim(), '0');
  const lines = Array.from({ length: 40 }, (_, index) => `line-${index + 1}`);
  writeFileSync(join(source, 'a.txt'), data(lines));
  writeFileSync(join(source, 'blob.bin'), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(source, 'notes.txt'), 'reference\n');
  git(source, ['add', '--', 'a.txt', 'blob.bin', 'notes.txt']);
  save({ root, source, lines, objectFormat, emptyRepositories: 3 });
  console.log(git(source, ['diff', '--cached']));
} else if (phase === 'stage') {
  const message = process.argv[3];
  assert.ok(message);
  const state = read();
  git(state.source, ['commit', '--quiet', '-m', message]);
  const head = git(state.source, ['rev-parse', 'HEAD']).trim();
  const baseTree = git(state.source, ['rev-parse', 'HEAD^{tree}']).trim();
  const task = candidate(state, 'task', head);
  const taskLines = [...state.lines]; taskLines[0] = 'task-change';
  writeFileSync(join(task, 'a.txt'), data(taskLines));
  writeFileSync(join(task, 'blob.bin'), Buffer.from([0, 3, 4, 255]));
  renameSync(join(task, 'notes.txt'), join(task, 'renamed.txt'));
  git(task, ['add', '--all', '--', 'a.txt', 'blob.bin', 'notes.txt', 'renamed.txt']);
  const taskTree = git(task, ['write-tree']).trim();
  importTree(task, state.source, taskTree);
  const patch = git(task, ['diff', '--cached', '--binary', '--full-index', '--find-renames', head]);
  writeFileSync(join(state.root, 'artifact.patch'), patch);
  const downstream = candidate(state, 'downstream', taskTree);
  const downstreamLines = [...taskLines]; downstreamLines[4] = 'downstream-change';
  writeFileSync(join(downstream, 'a.txt'), data(downstreamLines));
  git(downstream, ['add', '--', 'a.txt']);
  const downstreamTree = git(downstream, ['write-tree']).trim();
  importTree(downstream, state.source, downstreamTree);
  const conflict = candidate(state, 'conflict', head);
  const conflictLines = [...state.lines]; conflictLines[0] = 'user-overlap';
  writeFileSync(join(conflict, 'a.txt'), data(conflictLines));
  git(conflict, ['add', '--', 'a.txt']);
  const conflictTree = git(conflict, ['write-tree']).trim();
  importTree(conflict, state.source, conflictTree);
  const staged = [...state.lines]; staged[29] = 'user-staged';
  writeFileSync(join(state.source, 'a.txt'), data(staged));
  git(state.source, ['add', '--', 'a.txt']);
  const indexTree = git(state.source, ['write-tree']).trim();
  const working = [...staged]; working[39] = 'user-unstaged';
  writeFileSync(join(state.source, 'a.txt'), data(working));
  const scratchIndex = join(state.root, 'work.index');
  copyFileSync(join(state.source, '.git/index'), scratchIndex);
  git(state.source, ['add', '--', 'a.txt'], { env: { GIT_INDEX_FILE: scratchIndex } });
  const workTree = git(state.source, ['write-tree'], { env: { GIT_INDEX_FILE: scratchIndex } }).trim();
  const emptyIndex = join(state.root, 'empty.index');
  git(state.source, ['read-tree', '--empty'], { env: { GIT_INDEX_FILE: emptyIndex } });
  const emptyTree = git(state.source, ['write-tree'], { env: { GIT_INDEX_FILE: emptyIndex } }).trim();
  const inputTrees = { task: taskTree, downstream: downstreamTree, conflict: conflictTree, index: indexTree, work: workTree, empty: emptyTree };
  save({ ...state, head, baseTree, inputTrees, taskLines, downstreamLines, staged, working });
  for (const [kind, tree] of Object.entries(inputTrees)) console.log(`### Diff: ${kind}\n${git(state.source, ['diff', '--binary', '--full-index', head, tree])}`);
} else if (phase === 'merge') {
  const message = process.argv[3];
  assert.ok(message);
  const state = read();
  const calc = candidate(state, 'calculation', state.head);
  const messageFile = join(calc, '.git/calculation-message.txt');
  writeFileSync(messageFile, `${message}\n`);
  const commits = new Map([[state.baseTree, state.head]]);
  function commit(tree) {
    if (!commits.has(tree)) commits.set(tree, git(calc, ['commit-tree', tree, '-p', state.head, '-F', messageFile]).trim());
    return commits.get(tree);
  }
  function merge(base, ours, theirs) {
    const tree = git(calc, ['merge-tree', '--write-tree', '--no-messages', `--merge-base=${commit(base)}`, commit(ours), commit(theirs)]).trim();
    assert.equal(git(calc, ['cat-file', '-t', tree]).trim(), 'tree');
    return tree;
  }
  const input = state.inputTrees;
  const trees = {
    approved: merge(state.baseTree, state.baseTree, input.task),
    index: merge(state.baseTree, input.index, input.task),
    work: merge(state.baseTree, input.work, input.task),
  };
  assert.equal(trees.approved, input.task);
  const expectedIndex = [...state.staged]; expectedIndex[0] = 'task-change';
  const expectedWork = [...state.working]; expectedWork[0] = 'task-change';
  assert.equal(git(calc, ['show', `${trees.index}:a.txt`]), data(expectedIndex));
  assert.equal(git(calc, ['show', `${trees.work}:a.txt`]), data(expectedWork));
  assert.equal(merge(state.baseTree, input.task, input.task), input.task);
  assert.equal(merge(input.task, input.task, input.downstream), input.downstream);
  const dependentIndex = merge(state.baseTree, input.index, input.downstream);
  const dependentWork = merge(state.baseTree, input.work, input.downstream);
  expectedIndex[4] = 'downstream-change'; expectedWork[4] = 'downstream-change';
  assert.equal(git(calc, ['show', `${dependentIndex}:a.txt`]), data(expectedIndex));
  assert.equal(git(calc, ['show', `${dependentWork}:a.txt`]), data(expectedWork));
  assert.equal(merge(input.empty, input.empty, input.task), input.task);
  const conflicting = spawnSync('git', ['merge-tree', '--write-tree', '--no-messages', `--merge-base=${commit(state.baseTree)}`, commit(input.conflict), commit(input.task)], { cwd: calc, env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(conflicting.status, 1);
  assert.equal(git(state.source, ['rev-parse', 'HEAD']).trim(), state.head);
  assert.equal(git(state.source, ['rev-list', '--all', '--count']).trim(), '1');
  for (const tree of Object.values(trees)) importTree(calc, state.source, tree);
  const dirs = Object.fromEntries(Object.entries(trees).map(([kind, tree]) => [kind, candidate(state, kind, tree)]));
  const mergeChecks = { alreadyAppliedInputMerged: true, downstreamInputMerged: true, dependentStagedIntentPreserved: true, dependentUnstagedChangePreserved: true, emptyTreeMerged: true, actualOverlapRejected: true, calculationCommitsPrivate: true };
  save({ ...state, trees, dirs, mergeChecks });
  console.log(git(state.source, ['diff', '--binary', '--full-index', state.head, trees.approved]));
} else if (phase === 'apply') {
  const message = process.argv[3];
  assert.ok(message);
  const state = read();
  const afterIndex = join(state.root, 'after.index');
  copyFileSync(join(state.source, '.git/index'), afterIndex);
  git(state.source, ['update-index', '--no-split-index'], { env: { GIT_INDEX_FILE: afterIndex } });
  git(state.source, ['read-tree', '-m', '-i', state.trees.index], { env: { GIT_INDEX_FILE: afterIndex } });
  copyFileSync(join(state.dirs.work, 'a.txt'), join(state.source, 'a.txt'));
  copyFileSync(join(state.dirs.work, 'blob.bin'), join(state.source, 'blob.bin'));
  unlinkSync(join(state.source, 'notes.txt'));
  copyFileSync(join(state.dirs.work, 'renamed.txt'), join(state.source, 'renamed.txt'));
  copyFileSync(afterIndex, join(state.source, '.git/index'));
  const messageFile = join(state.root, 'commit-message.txt');
  writeFileSync(messageFile, `${message}\n`);
  const commit = git(state.source, ['commit-tree', state.trees.approved, '-p', state.head, '-F', messageFile]).trim();
  git(state.source, ['update-ref', 'refs/heads/main', commit, state.head]);
  const committed = git(state.source, ['show', 'HEAD:a.txt']);
  const indexed = git(state.source, ['show', ':a.txt']);
  const working = readFileSync(join(state.source, 'a.txt'), 'utf8');
  assert.equal(committed, data(state.taskLines));
  const expectedIndex = [...state.staged]; expectedIndex[0] = 'task-change';
  const expectedWork = [...state.working]; expectedWork[0] = 'task-change';
  assert.equal(indexed, data(expectedIndex)); assert.equal(working, data(expectedWork));
  assert.deepEqual(git(state.source, ['show', 'HEAD:blob.bin'], { binary: true }), Buffer.from([0, 3, 4, 255]));
  assert.deepEqual(readFileSync(join(state.source, 'blob.bin')), Buffer.from([0, 3, 4, 255]));
  assert.equal(git(state.source, ['show', 'HEAD:renamed.txt']), 'reference\n');
  assert.equal(existsSync(join(state.source, 'notes.txt')), false);
  assert.equal(git(state.source, ['rev-parse', 'HEAD^{tree}']).trim(), state.trees.approved);
  assert.equal(git(state.source, ['rev-list', '--all', '--count']).trim(), '2');
  const stale = spawnSync('git', ['update-ref', 'refs/heads/main', state.head, state.head], { cwd: state.source, env, encoding: 'utf8' });
  assert.notEqual(stale.status, 0);
  assert.equal(git(state.source, ['rev-parse', 'HEAD']).trim(), commit);
  const report = { productionAcceptance: false, objectFormat: state.objectFormat, emptyRepositories: state.emptyRepositories, commitContainsOnlyArtifact: true, stagedIntentPreserved: true, unstagedChangePreserved: true, binaryChangeApplied: true, renameApplied: true, staleRefUpdateRejected: true, gitObjectsTransferredWithNativePack: true, ...state.mergeChecks, root: state.root };
  writeFileSync(join(state.root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} else if (phase === 'index') {
  const requestedRoot = process.argv[3] ? resolve(process.argv[3]) : null;
  if (requestedRoot) assert.ok(requestedRoot.startsWith(`${output}/git-`));
  const state = requestedRoot ? JSON.parse(readFileSync(join(requestedRoot, 'state.json'), 'utf8')) : read();
  assert.ok(resolve(state.root).startsWith(`${output}/git-`));
  const root = mkdtempSync(join(state.root, 'index-flags-'));
  const repo = candidate({ ...state, root }, 'repo', state.trees.approved);
  writeFileSync(join(repo, 'intent.txt'), 'intent-content\n');
  git(repo, ['add', '--intent-to-add', '--', 'intent.txt']);
  git(repo, ['update-index', '--assume-unchanged', '--', 'renamed.txt']);
  git(repo, ['update-index', '--index-version=4', '--split-index']);
  const originalTree = git(repo, ['write-tree']).trim();
  const beforeIndex = readFileSync(join(repo, '.git/index'));
  const beforeFlags = git(repo, ['ls-files', '-v']);
  const privateIndex = join(root, 'private.index');
  copyFileSync(join(repo, '.git/index'), privateIndex);
  git(repo, ['update-index', '--no-split-index'], { env: { GIT_INDEX_FILE: privateIndex } });
  git(repo, ['read-tree', '-m', '-i', state.inputTrees.downstream], { env: { GIT_INDEX_FILE: privateIndex } });
  git(repo, ['add', '--intent-to-add', '--', 'intent.txt'], { env: { GIT_INDEX_FILE: privateIndex } });
  assert.equal(git(repo, ['ls-files', '-v'], { env: { GIT_INDEX_FILE: privateIndex } }), beforeFlags);
  assert.equal(git(repo, ['write-tree'], { env: { GIT_INDEX_FILE: privateIndex } }).trim(), state.inputTrees.downstream);
  assert.deepEqual(readFileSync(join(repo, '.git/index')), beforeIndex);
  assert.equal(git(repo, ['write-tree']).trim(), originalTree);
  const report = { productionAcceptance: false, objectFormat: state.objectFormat, intentToAddPreserved: true, unaffectedAssumeUnchangedPreserved: true, version4AndSplitIndexReadByNativeGit: true, originalIndexUnchanged: true, resultTreeMatchesCandidate: true, root };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} else {
  throw new Error('需要指定 prepare、stage、merge、apply 或 index');
}
