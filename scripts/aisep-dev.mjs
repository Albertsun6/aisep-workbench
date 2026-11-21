#!/usr/bin/env node
// AISEP 一键启动：aisep 的 MCP HTTP 服务（workbench 画像）+ 工作台网页版（dev:web），外加批准前只读预检。
// 用法见 scripts/aisep-dev.md。只用 Node 内置模块，不碰上游依赖。
// 默认是预览模式：allow-root 只含专用检出（游离 HEAD），批准工具在这里一定被拒。
// --approve 才把 allow-root 扩到整个 aisep 目录，只由 Albert 本人在批准那一步启动。
//
//   node scripts/aisep-dev.mjs start [--approve] [--branch <分支>] [--workbench <工作台检出>] [--mcp-port N] [--web-port N] [--fetch-interval 秒]
//   node scripts/aisep-dev.mjs refresh
//   node scripts/aisep-dev.mjs preflight <分支> [--mcp-port N]
//
// 服务的代码与 --repo 用一个专用的游离检出（默认 ~/Desktop/AISEP/aisep-serve，跟随 origin/main），
// 从不读写 aisep 主检出的工作区。预检只调用只读工具，脚本里没有任何调用批准工具的代码路径。
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HOME = homedir();
const AISEP_ROOT = process.env.AISEP_ROOT ?? join(HOME, "Desktop/AISEP");
const AISEP_REPO = process.env.AISEP_REPO ?? join(AISEP_ROOT, "aisep");
const SERVE_DIR = process.env.AISEP_SERVE_DIR ?? join(AISEP_ROOT, "aisep-serve");
const PYTHON = process.env.AISEP_PYTHON ?? join(AISEP_REPO, ".venv/bin/python");
// 默认避开 3001（AO 守护进程）、5173（electron-forge / 别的 dev server）、18765 与 15173（规划会话在用）。
const DEFAULT_MCP_PORT = 18790;
const DEFAULT_WEB_PORT = 15190;
// 网页版把 /api、/mux 代理到这里。默认指向一个不监听的端口，避免连到本机 3001 上别的会话的守护进程。
const DEFAULT_AO_API_TARGET = "http://127.0.0.1:9";
const MCP_PROTOCOL_VERSION = "2026-07-28";
// 预检只允许这几个只读工具；governance_record_approval 不在其中，callTool 遇到别的名字直接抛错。
const READ_ONLY_TOOLS = new Set(["model_diff", "model_gate", "model_query"]);
const GATE_TIMEOUT_MS = 600_000;
// start 运行期间每隔这么多秒 git fetch origin 一次（--fetch-interval，0 关闭）。
const DEFAULT_FETCH_INTERVAL_S = 60;
// 专用检出自动跟进时，这些路径一变就不跟：运行中的服务用的是启动时导入的代码（见 scripts/aisep-dev.md「refresh」）。
const SERVE_CODE_PATHS = ["aisep", "requirements.txt"];
const WORKBENCH_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 与工作台关口页 APPROVERS_QUERY（AisepGatePage.tsx）逐字相同，行数与顺序才和页面下拉一致。改页面时同步改这里。
const APPROVERS_QUERY = `PREFIX aisep: <https://aisep.example/ont/aisep#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?approver ?prefLabel WHERE {
  ?approver a/rdfs:subClassOf* arch:Stakeholder ; skos:prefLabel ?prefLabel .
  FILTER NOT EXISTS { ?approver a/rdfs:subClassOf* aisep:AIAgent }
  FILTER(lang(?prefLabel) = "zh")
}`;
// 单独查每个 Stakeholder 属于哪个模型，只用来标注，不影响上面的顺序。
const STAKEHOLDER_MODELS_QUERY = `SELECT ?approver ?model WHERE { ?approver a/rdfs:subClassOf* arch:Stakeholder ; arch:inModel ?model }`;

function fail(message) {
	console.error(`错误：${message}`);
	process.exit(1);
}

const FLAGS = new Set(["approve"]);

function parseArgs(argv) {
	const positional = [];
	const opts = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			if (FLAGS.has(key)) {
				opts[key] = true;
				continue;
			}
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) fail(`${a} 缺少取值`);
			opts[key] = value;
			i++;
		} else {
			positional.push(a);
		}
	}
	return { positional, opts };
}

function port(value, fallback, name) {
	if (value === undefined) return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1024 || n > 65535) fail(`${name} 不是合法端口：${value}`);
	return n;
}

// GIT_OPTIONAL_LOCKS=0：git status 不回写 index（预检会读别的会话的 worktree）；GIT_TERMINAL_PROMPT=0：凭据失效时报错而不是挂住。
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

function git(cwd, ...args) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV }).trim();
}

function tryGit(cwd, ...args) {
	try {
		return git(cwd, ...args);
	} catch {
		return undefined;
	}
}

/** git worktree list --porcelain → [{worktree, head, branch, detached, prunable}] */
function worktrees(repo) {
	const out = git(repo, "worktree", "list", "--porcelain");
	const list = [];
	let cur;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) {
			cur = { worktree: line.slice(9) };
			list.push(cur);
		} else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
		else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7);
		else if (cur && line === "detached") cur.detached = true;
		else if (cur && line.startsWith("prunable")) cur.prunable = true;
	}
	return list;
}

function real(p) {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

function under(path, root) {
	const p = real(path);
	const r = real(root);
	return p === r || p.startsWith(r + sep);
}

function allowRoots(approve) {
	// 服务的 --repo 本身也必须在 allow-root 之下（aisep gitio.locate_repo），所以专用检出总在其中。
	// 预览模式只有它：专用检出是游离 HEAD，批准工具找不到可批准的分支 worktree。
	// 批准模式再加整个 aisep 目录，覆盖各会话放在 aisep/.claude/worktrees 与 aisep/aisep/.claude/worktrees 下的分支。
	return approve ? [AISEP_REPO, SERVE_DIR] : [SERVE_DIR];
}

/** 正在 port 上监听的那个服务实际的 --allow-root 与 --profile（读进程命令行，只读）。 */
function serverArgs(p) {
	try {
		const pid = execFileSync("lsof", ["-nP", "-t", `-iTCP:${p}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
		const cmd = execFileSync("ps", ["-ww", "-o", "command=", "-p", pid], { encoding: "utf8" }).trim().split(/\s+/);
		const roots = [];
		let profile = "agent";
		cmd.forEach((a, i) => {
			if (a === "--allow-root") roots.push(cmd[i + 1]);
			if (a === "--profile") profile = cmd[i + 1];
		});
		return cmd.includes("aisep.server") ? { pid, roots, profile } : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------- 专用检出

function refreshServeCheckout() {
	if (!existsSync(join(AISEP_REPO, ".git"))) fail(`找不到 aisep 仓库：${AISEP_REPO}`);
	console.log(`[refresh] git fetch origin（${AISEP_REPO}，只更新远端跟踪引用，不动主检出工作区）`);
	try {
		git(AISEP_REPO, "fetch", "origin");
	} catch (e) {
		fail(`git fetch origin 失败（网络或凭据？），专用检出没有移动：\n${String(e.stderr ?? e.message).trim()}`);
	}
	const target = git(AISEP_REPO, "rev-parse", "refs/remotes/origin/main^{commit}");
	const registered = worktrees(AISEP_REPO).find((w) => real(w.worktree) === real(SERVE_DIR));
	if (!existsSync(SERVE_DIR)) {
		if (registered) fail(`${SERVE_DIR} 已登记为 worktree 但目录不存在；先在 aisep 仓库跑 git worktree prune`);
		console.log(`[refresh] 新建专用检出 ${SERVE_DIR}（游离 HEAD）`);
		git(AISEP_REPO, "worktree", "add", "--detach", SERVE_DIR, target);
	} else {
		if (!registered) fail(`${SERVE_DIR} 已存在但不是 aisep 仓库登记的 worktree；换 AISEP_SERVE_DIR 或手工处理`);
		if (!registered.detached) fail(`${SERVE_DIR} 检出了分支 ${registered.branch}，专用检出必须是游离 HEAD`);
		const dirty = git(SERVE_DIR, "status", "--porcelain", "--untracked-files=all");
		if (dirty) fail(`专用检出 ${SERVE_DIR} 有未提交改动，拒绝移动：\n${dirty}`);
		const before = git(SERVE_DIR, "rev-parse", "HEAD");
		if (before !== target) git(SERVE_DIR, "checkout", "--quiet", "--detach", target);
		console.log(`[refresh] ${before.slice(0, 7)} → ${target.slice(0, 7)}`);
	}
	const head = git(SERVE_DIR, "rev-parse", "HEAD");
	if (head !== target) fail(`专用检出 HEAD ${head} 不等于 origin/main ${target}`);
	console.log(`[refresh] 专用检出 = origin/main = ${git(SERVE_DIR, "log", "--oneline", "-1")}`);
	return head;
}

// ---------------------------------------------------------------- 定时 fetch

const execFileAsync = promisify(execFile);

async function gitAsync(cwd, args, signal) {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, timeout: 120_000, signal });
	return stdout.trim();
}

/**
 * start 运行期间的一轮：git fetch origin（只更新远端跟踪引用，关口页的「已推送」「已合入」靠它），
 * 再看专用检出能不能自动跟到新的 origin/main（首页的「已批准」靠它）。只在同时满足下面几条时才移动：
 * 是登记过的游离 worktree、工作区干净、只是快进、这段提交没改服务代码（SERVE_CODE_PATHS）。否则只提示。
 * 从不抛错、从不退出进程；返回这一轮的结论，log 只在结论变了时打印（断网时不会每分钟刷屏）。
 */
export async function autoFetchOnce(state, { repo = AISEP_REPO, serveDir = SERVE_DIR, log = console.log, signal } = {}) {
	const say = (outcome, message) => {
		if (message !== state.lastMessage) log(message);
		state.lastMessage = message;
		return outcome;
	};
	try {
		await gitAsync(repo, ["fetch", "--quiet", "--no-auto-maintenance", "origin"], signal);
	} catch (e) {
		const reason = String(e.stderr || e.message).trim().split("\n")[0];
		return say("fetch-failed", `[fetch] git fetch origin 失败，服务照常运行，下一轮再试：${reason}`);
	}
	try {
		const target = await gitAsync(repo, ["rev-parse", "refs/remotes/origin/main^{commit}"], signal);
		const head = await gitAsync(serveDir, ["rev-parse", "HEAD"], signal);
		const short = (c) => c.slice(0, 7);
		if (head === target) return say("current", `[fetch] 已 fetch；专用检出 = origin/main = ${short(target)}`);
		const hold = (why) =>
			say("held", `[fetch] origin/main 已到 ${short(target)}，专用检出仍在 ${short(head)}，没有自动跟进：${why}。首页要看新的 main 就处理后跑 refresh`);
		const registered = worktrees(repo).find((w) => real(w.worktree) === real(serveDir));
		if (!registered?.detached) return hold("专用检出不是登记过的游离 worktree");
		try {
			await gitAsync(repo, ["merge-base", "--is-ancestor", head, target], signal);
		} catch {
			return hold("不是快进（专用检出不在 origin/main 的历史上）");
		}
		const dirty = await gitAsync(serveDir, ["status", "--porcelain", "--untracked-files=all"], signal);
		if (dirty) return hold("专用检出有未提交改动");
		const code = await gitAsync(repo, ["diff", "--name-only", head, target, "--", ...SERVE_CODE_PATHS], signal);
		if (code) {
			return hold(`这段提交改了服务代码（${code.split("\n").slice(0, 3).join("、")}${code.includes("\n") ? " 等" : ""}），要停掉服务后重新 start`);
		}
		await gitAsync(serveDir, ["checkout", "--quiet", "--detach", target], signal);
		return say("followed", `[fetch] 专用检出已快进 ${short(head)} → ${short(target)}（这段提交没改服务代码，服务不用重启）`);
	} catch (e) {
		const reason = String(e.stderr || e.message).trim().split("\n")[0];
		return say("error", `[fetch] 检查专用检出时出错，服务照常运行：${reason}`);
	}
}

// ---------------------------------------------------------------- MCP 客户端（与工作台 mcp-client.ts 同一信封）

async function mcp(mcpPort, method, params, name, timeoutMs = 60_000) {
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
		"Mcp-Method": method,
	};
	if (name) headers["Mcp-Name"] = name;
	const body = {
		jsonrpc: "2.0",
		id: 1,
		method,
		params: {
			...params,
			_meta: {
				"io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientCapabilities": {},
				"io.modelcontextprotocol/clientInfo": { name: "aisep-dev-preflight", version: "0.1.0" },
			},
		},
	};
	const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
	}
	if (json.error) throw new Error(`JSON-RPC ${json.error.code}: ${json.error.message}`);
	return json.result;
}

async function callTool(mcpPort, name, args, timeoutMs) {
	if (!READ_ONLY_TOOLS.has(name)) throw new Error(`预检不允许调用 ${name}`);
	const result = await mcp(mcpPort, "tools/call", { name, arguments: args }, name, timeoutMs);
	const sc = result?.structuredContent;
	if (result?.isError) {
		const e = sc?.error;
		throw new Error(e ? `${e.code}: ${e.message}` : "isError（无错误信封）");
	}
	if (!sc) throw new Error("没有 structuredContent");
	return sc;
}

// ---------------------------------------------------------------- 进程与端口

function portInUse(p) {
	const probe = (host) =>
		new Promise((done) => {
			const s = connect({ port: p, host });
			s.once("connect", () => {
				s.destroy();
				done(true);
			});
			s.once("error", () => done(false));
		});
	return Promise.all([probe("127.0.0.1"), probe("::1")]).then((r) => r.some(Boolean));
}

const children = [];

function launch(label, command, args, options, drop) {
	// detached：子进程自成进程组，停的时候按组 PID 一起停（dev-web.mjs 会再拉起 vite 子进程）。
	const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	children.push({ label, child });
	const prefix = (stream, out) => {
		let buf = "";
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			buf += chunk;
			const lines = buf.split("\n");
			buf = lines.pop();
			for (const line of lines) if (!drop?.test(line)) out.write(`[${label}] ${line}\n`);
		});
	};
	prefix(child.stdout, process.stdout);
	prefix(child.stderr, process.stderr);
	console.log(`[start] ${label} PID ${child.pid}（进程组 ${child.pid}）`);
	return child;
}

// 以进程组是否还有进程为准，不看组长：dev-web.mjs 先退出时，它拉起的 vite 仍在同一组里。
function groupAlive(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e) {
		return e.code !== "ESRCH";
	}
}

let stopping = false;
let fetchTimer;
const fetchAbort = new AbortController();
async function stopAll(code) {
	if (stopping) return;
	stopping = true;
	clearTimeout(fetchTimer);
	fetchAbort.abort();
	// 先发信号再打日志：终端已关闭时写 stdout 可能出错，不能让它挡在清理前面。
	for (const { child } of children) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {}
	}
	for (const { label, child } of children) console.log(`[stop] 已向 ${label} 进程组 ${child.pid} 发 SIGTERM`);
	const deadline = Date.now() + 5000;
	for (const { label, child } of children) {
		while (groupAlive(child.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (groupAlive(child.pid)) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
			console.log(`[stop] ${label} 5 秒未退出，已 SIGKILL 进程组 ${child.pid}`);
		}
	}
	process.exit(code);
}

async function waitFor(what, check, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (stopping) return;
		try {
			if (await check()) return;
		} catch {}
		if (Date.now() > deadline) {
			console.error(`错误：${what} 在 ${timeoutMs / 1000} 秒内没有就绪`);
			await stopAll(1);
		}
		await new Promise((r) => setTimeout(r, 500));
	}
}

// ---------------------------------------------------------------- 子命令

async function start(opts) {
	const mcpPort = port(opts["mcp-port"], DEFAULT_MCP_PORT, "--mcp-port");
	const webPort = port(opts["web-port"], DEFAULT_WEB_PORT, "--web-port");
	const workbench = resolve(opts.workbench ?? WORKBENCH_DEFAULT);
	const aoApi = opts["ao-api"] ?? DEFAULT_AO_API_TARGET;
	const approve = opts.approve === true;
	const fetchInterval = opts["fetch-interval"] === undefined ? DEFAULT_FETCH_INTERVAL_S : Number(opts["fetch-interval"]);
	if (!Number.isInteger(fetchInterval) || fetchInterval < 0) fail(`--fetch-interval 不是非负整数秒：${opts["fetch-interval"]}`);
	const roots = allowRoots(approve);
	const frontend = join(workbench, "frontend");
	if (!existsSync(join(frontend, "scripts/dev-web.mjs"))) fail(`${workbench} 不是工作台检出（缺 frontend/scripts/dev-web.mjs）`);
	if (!existsSync(join(frontend, "node_modules/vite/bin/vite.js"))) {
		fail(
			`${frontend} 还没装依赖。先跑：\n  cd ${frontend} && ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts --no-audit --no-fund`,
		);
	}
	if (!existsSync(PYTHON)) fail(`找不到解释器 ${PYTHON}`);
	for (const [p, name] of [
		[mcpPort, "--mcp-port"],
		[webPort, "--web-port"],
	]) {
		if (await portInUse(p)) fail(`端口 ${p}（${name}）已被占用，换一个端口`);
	}

	const head = refreshServeCheckout();
	// 服务从专用检出导入 aisep（工作目录在 sys.path 首位），确认没有导入到别处的代码。
	const imported = execFileSync(PYTHON, ["-c", "import aisep, os; print(os.path.realpath(aisep.__file__))"], {
		cwd: SERVE_DIR,
		encoding: "utf8",
	}).trim();
	if (!under(imported, SERVE_DIR)) fail(`解释器导入的 aisep 来自 ${imported}，不在专用检出 ${SERVE_DIR} 里`);

	const origins = [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`];
	const mcpArgs = [
		"-m",
		"aisep.server",
		"--transport",
		"http",
		"--profile",
		"workbench",
		"--port",
		String(mcpPort),
		"--repo",
		SERVE_DIR,
		...roots.flatMap((r) => ["--allow-root", r]),
		...origins.flatMap((o) => ["--allow-origin", o]),
	];
	const mcpChild = launch("mcp", PYTHON, mcpArgs, { cwd: SERVE_DIR, env: process.env });
	const webChild = launch(
		"web",
		process.execPath,
		[join(frontend, "scripts/dev-web.mjs"), "--port", String(webPort), "--strictPort"],
		{
			cwd: frontend,
			env: { ...process.env, VITE_AISEP_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`, AO_DEV_API_TARGET: aoApi },
		},
		// 默认不接 AO 时，页面每隔几秒重连 /api 都会让 vite 打一段代理报错，这里不转发。
		aoApi === DEFAULT_AO_API_TARGET ? /http proxy error|ECONNREFUSED 127\.0\.0\.1:9\b|TCPConnectWrap\.afterConnect/ : undefined,
	);
	for (const { label, child } of [
		{ label: "mcp", child: mcpChild },
		{ label: "web", child: webChild },
	]) {
		child.once("exit", (code, signal) => {
			if (stopping) return;
			console.error(`[${label}] 意外退出（code ${code}, signal ${signal}），停止全部`);
			stopAll(1);
		});
	}
	for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => stopAll(0));

	await waitFor("MCP 服务", async () => (await mcp(mcpPort, "tools/list", {}, undefined, 5000))?.tools?.length > 0, 60_000);
	if (stopping) return;
	await waitFor("网页版", async () => (await fetch(`http://localhost:${webPort}/`, { signal: AbortSignal.timeout(5000) })).ok, 120_000);
	if (stopping) return;

	const base = `http://localhost:${webPort}`;
	console.log("");
	console.log("================ AISEP 工作台已就绪 ================");
	console.log(`服务检出   ${SERVE_DIR} @ ${head.slice(0, 7)}（origin/main）`);
	console.log(`工作台检出 ${workbench} @ ${tryGit(workbench, "rev-parse", "--short", "HEAD") ?? "?"}（${tryGit(workbench, "branch", "--show-current") || "游离"}）`);
	console.log(`模式       ${approve ? "批准模式（--approve）：allow-root 覆盖所有会话的 worktree，只由 Albert 本人启动，批准完立即停止" : "预览模式：批准工具在这里一定被拒（批准要用 --approve 重新启动）"}`);
	console.log(`MCP        http://127.0.0.1:${mcpPort}/mcp  画像 workbench  allow-root ${roots.join(" , ")}`);
	console.log(`AO 代理    ${aoApi}（「AI 进行中」一栏需要 AO 守护进程，默认不接）`);
	console.log(`首页       ${base}/#/aisep`);
	if (opts.branch) console.log(`关口页     ${base}/#/aisep/gate/${opts.branch}`);
	else console.log(`关口页     ${base}/#/aisep/gate/<分支名>（start 加 --branch 直接打印）`);
	if (opts.branch && approve) console.log(`预检       node ${join(WORKBENCH_DEFAULT, "scripts/aisep-dev.mjs")} preflight ${opts.branch} --mcp-port ${mcpPort}`);
	console.log(
		`自动刷新   ${fetchInterval ? `每 ${fetchInterval} 秒 git fetch origin；专用检出在干净、快进、没改服务代码时自动跟到 origin/main` : "关（--fetch-interval 0），需要时手动 refresh"}`,
	);
	console.log("Ctrl-C（或对本进程 PID 发 SIGTERM）停止两项服务");
	console.log("====================================================");

	if (fetchInterval) {
		const state = {};
		const tick = async () => {
			await autoFetchOnce(state, { signal: fetchAbort.signal });
			if (!stopping) fetchTimer = setTimeout(tick, fetchInterval * 1000);
		};
		fetchTimer = setTimeout(tick, fetchInterval * 1000);
	}
}

async function preflight(branch, opts) {
	if (!branch) fail("用法：preflight <分支> [--mcp-port N]");
	const mcpPort = port(opts["mcp-port"], DEFAULT_MCP_PORT, "--mcp-port");
	let failed = 0;
	const report = (ok, title, detail = "") => {
		if (!ok) failed++;
		console.log(`${ok ? "通过" : "不通过"}  ${title}${detail ? `：${detail}` : ""}`);
	};
	const info = (title, detail) => console.log(`信息  ${title}：${detail}`);
	console.log(`预检分支 ${branch}（只读：不 fetch、不写任何文件，只调用 ${[...READ_ONLY_TOOLS].join("、")}）\n`);

	// 1. 已在 allow-root 下的 worktree 检出（服务按 git 登记的第一条匹配，aisep gitio.locate_worktree）
	const hit = worktrees(AISEP_REPO).find((w) => w.branch === `refs/heads/${branch}`);
	const wt = hit && !hit.prunable && existsSync(hit.worktree) ? hit.worktree : undefined;
	// allow-root 取端口上那个服务进程实际的启动参数，不是本脚本自己算的
	const srv = serverArgs(mcpPort);
	if (srv) info("端口上的服务", `PID ${srv.pid}，画像 ${srv.profile}，allow-root ${srv.roots.join(" , ") || "（无）"}`);
	const inRoot = wt && srv && srv.roots.some((r) => under(wt, r));
	report(
		Boolean(wt && inRoot),
		"分支已在服务 allow-root 下的 worktree 检出",
		!wt ? "没有检出该分支的 worktree" : !srv ? `${wt}（读不到 ${mcpPort} 端口上服务的 allow-root）` : `${wt}${inRoot ? "" : "（不在服务的 allow-root 内：服务是预览模式？批准要用 start --approve）"}`,
	);

	// 0. 不能是主分支（approval.py _check_branch）
	report(branch !== "main", "分支不是 main", branch === "main" ? "main 上不能批准" : "");

	// 2. models/ 下的 .ttl 干净（批准时 DIRTY_WORKTREE 只比 .ttl；assume-unchanged/skip-worktree 标记的文件这里看不到）
	if (wt) {
		const dirty = git(wt, "status", "--porcelain", "--untracked-files=all", "--", ":(glob)models/**/*.ttl");
		report(!dirty, "该 worktree 的 models/ 干净", dirty ? dirty.split("\n").slice(0, 5).join("；") : "");
	} else report(false, "该 worktree 的 models/ 干净", "没有 worktree，无法检查");

	// 3. 本地头 = 远端头（ls-remote 直接问远端，不改本地引用）
	const local = tryGit(AISEP_REPO, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`);
	const remoteLine = tryGit(AISEP_REPO, "ls-remote", "origin", `refs/heads/${branch}`);
	const remote = remoteLine?.split(/\s+/)[0] || undefined;
	report(
		Boolean(local && remote && local === remote),
		"本地头等于远端头",
		`本地 ${local?.slice(0, 7) ?? "无"} / 远端 ${remote?.slice(0, 7) ?? (remoteLine === undefined ? "ls-remote 失败" : "未推送")}`,
	);

	// 服务检出是否还是最新 origin/main（合并后首页要靠它显示已批准）
	const serveHead = tryGit(SERVE_DIR, "rev-parse", "HEAD");
	const mainRemote = tryGit(AISEP_REPO, "ls-remote", "origin", "refs/heads/main")?.split(/\s+/)[0];
	info("服务检出", `${serveHead?.slice(0, 7) ?? "不存在"}；远端 main ${mainRemote?.slice(0, 7) ?? "?"}${serveHead && serveHead === mainRemote ? "（一致）" : "（不一致，需要时跑 refresh）"}`);

	// 4. tools/list 里有批准工具（说明服务是 workbench 画像）
	let tools;
	try {
		tools = ((await mcp(mcpPort, "tools/list", {}, undefined, 10_000))?.tools ?? []).map((t) => t.name);
		report(tools.includes("governance_record_approval"), "tools/list 含 governance_record_approval", tools.join(", "));
	} catch (e) {
		report(false, "tools/list 含 governance_record_approval", `连不上 http://127.0.0.1:${mcpPort}/mcp：${e.message}`);
		console.log(`\n服务没起来，后续检查跳过。共 ${failed} 项不通过。`);
		process.exit(1);
	}

	// 5. 分支头 model_gate PASS（与关口页同：先 model_diff 拿头提交，再在该提交上跑 gate）
	let head;
	try {
		const diff = await callTool(mcpPort, "model_diff", { head: branch, detail: "items" });
		head = diff.head?.commit;
		const items = diff.items ?? [];
		info("model_diff", `head ${head?.slice(0, 7)} · base ${diff.base?.commit?.slice(0, 7)} · 条目 ${items.length}`);
		if (local && head !== local) report(false, "服务看到的分支头等于本地分支头", `${head?.slice(0, 7)} ≠ ${local.slice(0, 7)}`);
		// 分支头已在 main 上（已合并或与 main 同头）时只能批 GateRelease，关口页的四个关口都会被拒（approval.py）
		if (head) {
			let inMain = false;
			try {
				execFileSync("git", ["-C", AISEP_REPO, "merge-base", "--is-ancestor", head, "refs/remotes/origin/main"], { env: GIT_ENV, stdio: "ignore" });
				inMain = true;
			} catch {}
			report(!inMain, "分支头还不在 origin/main 上", inMain ? "已在本地记录的 origin/main 里，关口页的关口批准会被拒" : "");
		}
	} catch (e) {
		report(false, "model_diff", e.message);
	}
	if (head) {
		try {
			const t0 = Date.now();
			const gate = await callTool(mcpPort, "model_gate", { ref: head }, GATE_TIMEOUT_MS);
			const s = gate.summary ?? {};
			report(
				gate.result === "PASS",
				"分支头 model_gate 为 PASS",
				`${gate.result}，违规 ${s.violations ?? "?"}，警告 ${s.warnings ?? "?"}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`,
			);
		} catch (e) {
			report(false, "分支头 model_gate 为 PASS", e.message);
		}

		// 6. 批准人下拉会出现的 Stakeholder（顺序同下拉，第一行是默认值）
		try {
			const q = await callTool(mcpPort, "model_query", { sparql: APPROVERS_QUERY, ref: head });
			const rows = q.rows ?? [];
			const models = new Map();
			try {
				const m = await callTool(mcpPort, "model_query", { sparql: STAKEHOLDER_MODELS_QUERY, ref: head });
				for (const r of m.rows ?? []) {
					const iri = r.approver?.value;
					models.set(iri, [...(models.get(iri) ?? []), r.model?.value]);
				}
			} catch {}
			console.log(`\n批准人下拉（${rows.length} 行，与页面同一条查询，第 1 行是默认选中）：`);
			rows.forEach((r, i) => {
				const iri = r.approver?.value ?? "?";
				const label = r.prefLabel?.value ?? "?";
				console.log(`  ${i + 1}. ${label}  ${iri}  模型 ${(models.get(iri) ?? ["（无 inModel）"]).join(", ")}`);
			});
			console.log("提醒：选新模型的「项目负责人」，不要选 procurement 的人；默认第 1 行不一定是他。");
		} catch (e) {
			report(false, "查询批准人列表", e.message);
		}
	}

	console.log(`\n${failed === 0 ? "全部通过。" : `${failed} 项不通过。`}预检没有调用批准工具，也没有写入任何东西。`);
	console.log("预检没覆盖的服务端检查：批准时头提交之后不能有非批准提交（STALE_HEAD）、写锁冲突、批准过程中 worktree 被切换分支。");
	process.exit(failed === 0 ? 0 : 1);
}

// 被测试 import 时不跑命令行。
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
	const [cmd, ...rest] = process.argv.slice(2);
	const { positional, opts } = parseArgs(rest);
	if (cmd === "start") await start(opts);
	else if (cmd === "refresh") refreshServeCheckout();
	else if (cmd === "preflight") await preflight(positional[0], opts);
	else {
		console.log("用法：node scripts/aisep-dev.mjs <start|refresh|preflight> …（详见 scripts/aisep-dev.md）");
		process.exit(cmd ? 1 : 0);
	}
}
