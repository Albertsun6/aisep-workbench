// scripts/aisep-dev.mjs 的定时 fetch（autoFetchOnce）：在临时的本地仓库对上跑真实 git，不碰 ~/Desktop/AISEP。
// node --test scripts/aisep-dev.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { autoFetchOnce } from './aisep-dev.mjs';

const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
	GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** origin（裸库）、repo（克隆，相当于 aisep 主检出）、serve（repo 的游离 worktree）、upstream（另一个克隆，用来往 origin 推新提交）。 */
function setup(t) {
	const dir = mkdtempSync(join(tmpdir(), 'aisep-dev-test-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const origin = join(dir, 'origin.git');
	const upstream = join(dir, 'upstream');
	const repo = join(dir, 'repo');
	const serve = join(dir, 'serve');
	execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin], { env: ENV });
	execFileSync('git', ['clone', '--quiet', origin, upstream], { env: ENV, stdio: 'ignore' });
	commit(upstream, 'models/a/model.ttl', 'v1');
	commit(upstream, 'aisep/core.py', 'v1');
	git(upstream, 'push', '--quiet', 'origin', 'HEAD:main');
	execFileSync('git', ['clone', '--quiet', origin, repo], { env: ENV, stdio: 'ignore' });
	git(repo, 'worktree', 'add', '--quiet', '--detach', serve, 'origin/main');
	return { origin, upstream, repo, serve };
}

function commit(cwd, file, content) {
	mkdirSync(dirname(join(cwd, file)), { recursive: true });
	writeFileSync(join(cwd, file), content);
	git(cwd, 'add', '--', file);
	git(cwd, 'commit', '--quiet', '-m', `${file} ${content}`);
	return git(cwd, 'rev-parse', 'HEAD');
}

function push(env, file, content) {
	const sha = commit(env.upstream, file, content);
	git(env.upstream, 'push', '--quiet', 'origin', 'HEAD:main');
	return sha;
}

async function once(env, state = {}) {
	const lines = [];
	const outcome = await autoFetchOnce(state, { repo: env.repo, serveDir: env.serve, log: (l) => lines.push(l) });
	return { outcome, lines, state };
}

test('跟进只改模型的快进：远端跟踪引用与专用检出都到新 main', async (t) => {
	const env = setup(t);
	const sha = push(env, 'models/a/model.ttl', 'v2');
	const { outcome } = await once(env);
	assert.equal(outcome, 'followed');
	assert.equal(git(env.repo, 'rev-parse', 'refs/remotes/origin/main'), sha);
	assert.equal(git(env.serve, 'rev-parse', 'HEAD'), sha);
	// 主检出（repo）的工作区与分支不动。
	assert.equal(git(env.repo, 'status', '--porcelain'), '');
	assert.notEqual(git(env.repo, 'rev-parse', 'HEAD'), sha);
});

test('改了服务代码只提示，不移动专用检出；但远端跟踪引用照样更新', async (t) => {
	const env = setup(t);
	const before = git(env.serve, 'rev-parse', 'HEAD');
	const sha = push(env, 'aisep/core.py', 'v2');
	const { outcome, lines } = await once(env);
	assert.equal(outcome, 'held');
	assert.match(lines[0], /服务代码（aisep\/core\.py）/);
	assert.equal(git(env.serve, 'rev-parse', 'HEAD'), before);
	assert.equal(git(env.repo, 'rev-parse', 'refs/remotes/origin/main'), sha);
});

test('专用检出有未提交改动时不移动', async (t) => {
	const env = setup(t);
	const before = git(env.serve, 'rev-parse', 'HEAD');
	writeFileSync(join(env.serve, 'models/a/model.ttl'), 'local edit');
	push(env, 'models/a/model.ttl', 'v2');
	const { outcome } = await once(env);
	assert.equal(outcome, 'held');
	assert.equal(git(env.serve, 'rev-parse', 'HEAD'), before);
	assert.equal(git(env.serve, 'status', '--porcelain'), 'M models/a/model.ttl');
});

test('不是快进（专用检出上有 main 没有的提交）时不移动', async (t) => {
	const env = setup(t);
	const local = commit(env.serve, 'models/a/other.ttl', 'x');
	push(env, 'models/a/model.ttl', 'v2');
	const { outcome, lines } = await once(env);
	assert.equal(outcome, 'held');
	assert.match(lines[0], /不是快进/);
	assert.equal(git(env.serve, 'rev-parse', 'HEAD'), local);
});

test('fetch 失败（远端不可达）不抛错，同样的失败只打印一次', async (t) => {
	const env = setup(t);
	git(env.repo, 'remote', 'set-url', 'origin', join(env.origin, '..', 'gone.git'));
	const state = {};
	const first = await once(env, state);
	assert.equal(first.outcome, 'fetch-failed');
	assert.equal(first.lines.length, 1);
	assert.match(first.lines[0], /git fetch origin 失败，服务照常运行/);
	const second = await once(env, state);
	assert.equal(second.outcome, 'fetch-failed');
	assert.deepEqual(second.lines, []);
	// 恢复后打印一次结论。
	git(env.repo, 'remote', 'set-url', 'origin', env.origin);
	const third = await once(env, state);
	assert.equal(third.outcome, 'current');
	assert.equal(third.lines.length, 1);
});
