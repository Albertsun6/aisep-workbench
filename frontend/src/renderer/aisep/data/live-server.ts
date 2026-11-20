// Test helper (not app code): a REAL AISEP MCP Server (aisep repo) over HTTP on throwaway git repos holding the
// procurement example. Needs an aisep checkout: AISEP_ROOT=<checkout> [AISEP_PY=<python with aisep's deps>].
// AISEP_RECORD_FIXTURES=1 makes record() rewrite ./fixtures/*.json from live answers (§8 step 1: fixtures are
// recorded, never hand-written).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AISEP_ROOT = process.env.AISEP_ROOT;
export const AISEP_PY = process.env.AISEP_PY ?? (AISEP_ROOT ? join(AISEP_ROOT, ".venv", "bin", "python") : "");
export const RECORD = process.env.AISEP_RECORD_FIXTURES === "1";
/** The procurement model's IRI prefix. */
export const M = "https://aisep.example/model/procurement/";
export const ORIGIN = "http://localhost:5173";

export function git(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

export function commitAll(cwd: string, message: string) {
	git(cwd, "add", "-A");
	git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message);
}

/** An am4:BusinessObject block for the procurement model's am4.ttl. */
export function businessObject(local: string, zh: string): string {
	return `\n:${local} a am4:BusinessObject ;\n    arch:inModel <${M}> ;\n    skos:prefLabel "${zh}"@zh .\n`;
}

export function appendModel(worktree: string, file: string, text: string) {
	appendFileSync(join(worktree, "models", "procurement", file), text);
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = createServer().listen(0, "127.0.0.1", () => {
			const { port } = s.address() as { port: number };
			s.close(() => resolve(port));
		});
	});
}

export interface LiveServer {
	url: string;
	proc: ChildProcess;
}

/** `aisep.server --transport http` on `repo`; worktrees must live under `allowRoot`. */
export async function startServer(repo: string, profile: string, allowRoot = repo): Promise<LiveServer> {
	const root = AISEP_ROOT as string;
	const port = await freePort();
	const proc = spawn(
		AISEP_PY,
		["-m", "aisep.server", "--transport", "http", "--profile", profile, "--port", String(port),
			"--repo", repo, "--allow-root", allowRoot, "--allow-origin", ORIGIN],
		{ env: { ...process.env, PYTHONPATH: root }, stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	proc.stderr?.on("data", (d) => (stderr += d));
	const url = `http://127.0.0.1:${port}/mcp`;
	for (let i = 0; i < 200; i++) {
		if (proc.exitCode !== null) throw new Error(`server exited: ${stderr}`);
		try {
			await fetch(url, { method: "GET" });
			return { url, proc };
		} catch {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw new Error(`server did not start: ${stderr}`);
}

/**
 * A fresh temp dir `base` holding `base/repo`: a git repo (single commit on main) with the procurement example,
 * modules/ and vendor/ (as aisep's conftest), unless `withModels` is false (then a README only). Linked worktrees
 * go under `base` too, so `--allow-root base` covers them.
 */
export function makeRepo(withModels = true): { base: string; repo: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "aisep-s8-")));
	const repo = join(base, "repo");
	mkdirSync(repo);
	if (withModels) {
		const root = AISEP_ROOT as string;
		for (const dir of ["modules", "vendor", join("models", "procurement")]) cpSync(join(root, dir), join(repo, dir), { recursive: true });
	} else {
		writeFileSync(join(repo, "README.md"), "no models here\n");
	}
	git(repo, "init", "-q", "-b", "main");
	commitAll(repo, "init");
	return { base, repo };
}

/** Writes ./fixtures/<name> when recording; temp paths become /fixture/… so fixtures do not depend on the machine. */
export function record(name: string, value: unknown, base: string) {
	if (!RECORD) return;
	const text = JSON.stringify(value, null, "\t").replaceAll(base, "/fixture");
	writeFileSync(join(__dirname, "fixtures", name), `${text}\n`);
}

/** Same keys and value kinds, recursively (arrays compared by their first element). */
export function shape(value: unknown): unknown {
	if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, shape(v)]));
	}
	return value === null ? "null" : typeof value;
}
