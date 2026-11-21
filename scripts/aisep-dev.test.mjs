// scripts/aisep-dev.mjs 的定时 fetch（autoFetchOnce）：在临时的本地仓库对上跑真实 git，不碰 ~/Desktop/AISEP。
// node --test scripts/aisep-dev.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

async function once(env, state = {}, options = {}) {
	const lines = [];
	const outcome = await autoFetchOnce(state, { repo: env.repo, serveDir: env.serve, log: (l) => lines.push(l), ...options });
	return { outcome, lines, state };
}

test('跟进只改模型的快进：远端跟踪引用与专用检出都到新 main', async (t) => {
	const env = setup(t);
	const sha = push(env, 'models/a/model.ttl', 'v2');
	const { outcome } = await once(env);
	assert.equal(outcome, 'followed');
	assert.equal(git(env.repo, 'rev-parse', 'refs/remotes/origin/main'), sha);
	assert.equal(git(env.serve, 'rev-parse', 'HEAD'), sha);
	// 主检出（repo）的工作区与分支不动，也不写 .git/FETCH_HEAD。
	assert.equal(git(env.repo, 'status', '--porcelain'), '');
	assert.notEqual(git(env.repo, 'rev-parse', 'HEAD'), sha);
	assert.equal(existsSync(join(env.repo, '.git', 'FETCH_HEAD')), false);
});

for (const file of ['aisep/core.py', 'modules/aisep-core/shapes.ttl', 'vendor/meta.linked.archi/ttl/relationships.ttl', 'requirements.txt']) {
	test(`改了服务已加载的 ${file} 只提示停服务重启，不移动专用检出；远端跟踪引用照样更新`, async (t) => {
		const env = setup(t);
		const before = git(env.serve, 'rev-parse', 'HEAD');
		const sha = push(env, file, 'v2');
		const { outcome, lines } = await once(env);
		assert.equal(outcome, 'held');
		assert.ok(lines[0].includes(`代码或规则文件（${file}）`), lines[0]);
		// 服务运行中 refresh 同样会新旧混用：这一种只让人停服务、重新 start。
		assert.match(lines[0], /要先停掉服务，再重新 start；服务运行中不要 refresh$/);
		assert.equal(git(env.serve, 'rev-parse', 'HEAD'), before);
		assert.equal(git(env.repo, 'rev-parse', 'refs/remotes/origin/main'), sha);
	});
}

test('服务代码的比较基准是启动时的提交：手动 refresh 越过规则改动后，之后只改模型也不跟', async (t) => {
	const env = setup(t);
	const loadedHead = git(env.serve, 'rev-parse', 'HEAD');
	// main 改了 shapes，有人在服务运行中手动 refresh 把检出移了过去；之后 main 又只改了模型。
	const shapes = push(env, 'modules/aisep-core/shapes.ttl', 'v2');
	git(env.repo, 'fetch', '--quiet', 'origin');
	git(env.serve, 'checkout', '--quiet', '--detach', shapes);
	push(env, 'models/a/model.ttl', 'v2');
	const { outcome, lines } = await once(env, {}, { loadedHead });
	assert.equal(outcome, 'held');
	assert.match(lines[0], /modules\/aisep-core\/shapes\.ttl/);
	assert.equal(git(env.serve, 'rev-parse', 'HEAD'), shapes);
});

test('专用检出检出了分支时不移动', async (t) => {
	const env = setup(t);
	git(env.serve, 'switch', '--quiet', '-c', 'local-work');
	const before = git(env.serve, 'rev-parse', 'HEAD');
	push(env, 'models/a/model.ttl', 'v2');
	const { outcome, lines } = await once(env);
	assert.equal(outcome, 'held');
	assert.match(lines[0], /不是登记过的游离 worktree/);
	assert.equal(git(env.serve, 'rev-parse', 'HEAD'), before);
	assert.equal(git(env.serve, 'branch', '--show-current'), 'local-work');
});

test('专用检出不是该仓库登记的 worktree（另一个克隆）时不移动', async (t) => {
	const env = setup(t);
	const other = join(env.origin, '..', 'other');
	execFileSync('git', ['clone', '--quiet', env.origin, other], { env: ENV, stdio: 'ignore' });
	git(other, 'checkout', '--quiet', '--detach');
	const before = git(other, 'rev-parse', 'HEAD');
	push(env, 'models/a/model.ttl', 'v2');
	const { outcome, lines } = await once({ ...env, serve: other });
	assert.equal(outcome, 'held');
	assert.match(lines[0], /不是登记过的游离 worktree/);
	assert.equal(git(other, 'rev-parse', 'HEAD'), before);
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
