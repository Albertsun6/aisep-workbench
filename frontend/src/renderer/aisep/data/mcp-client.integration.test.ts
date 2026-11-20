// @vitest-environment node
// Against a REAL AISEP MCP Server (aisep repo, slice S7) over HTTP, on a throwaway git repo holding the procurement
// example. Needs an aisep checkout: AISEP_ROOT=<checkout> [AISEP_PY=<python with aisep's deps>]; skipped without it.
// AISEP_RECORD_FIXTURES=1 also rewrites ./fixtures/*.json from the live answers (§8 step 1: fixtures are recorded,
// never hand-written).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AisepToolError, ELEMENTS_QUERY, elementsFromRows, type AisepModelClient } from "./client";
import { fixtureClient } from "./fixture-client";
import { callMcpTool, McpModelClient, McpProtocolError } from "./mcp-client";

const AISEP_ROOT = process.env.AISEP_ROOT;
const PY = process.env.AISEP_PY ?? (AISEP_ROOT ? join(AISEP_ROOT, ".venv", "bin", "python") : "");
const RECORD = process.env.AISEP_RECORD_FIXTURES === "1";
const M = "https://aisep.example/model/procurement/";
const ORIGIN = "http://localhost:5173";

function git(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = createServer().listen(0, "127.0.0.1", () => {
			const { port } = s.address() as { port: number };
			s.close(() => resolve(port));
		});
	});
}

async function startServer(root: string, repo: string, profile: string): Promise<{ url: string; proc: ChildProcess }> {
	const port = await freePort();
	const proc = spawn(
		PY,
		["-m", "aisep.server", "--transport", "http", "--profile", profile, "--port", String(port),
			"--repo", repo, "--allow-root", repo, "--allow-origin", ORIGIN],
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

/** A fresh git repo (single commit on main) with the procurement example, modules/ and vendor/ (as aisep's conftest). */
function makeRepo(root: string): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "aisep-s8-")));
	for (const dir of ["modules", "vendor", join("models", "procurement")]) cpSync(join(root, dir), join(repo, dir), { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "add", "-A");
	git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "procurement");
	return repo;
}

/** Same keys and value kinds, recursively (arrays compared by their first element). */
function shape(value: unknown): unknown {
	if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, shape(v)]));
	}
	return value === null ? "null" : typeof value;
}

function record(name: string, value: unknown, repo: string) {
	if (!RECORD) return;
	const text = JSON.stringify(value, null, "\t").replaceAll(repo, "/fixture/repo");
	writeFileSync(join(__dirname, "fixtures", name), `${text}\n`);
}

describe.skipIf(!AISEP_ROOT)("McpModelClient against a real AISEP MCP Server (HTTP)", () => {
	const root = AISEP_ROOT as string;
	let repo: string;
	let workbench: { url: string; proc: ChildProcess };
	let client: AisepModelClient;

	beforeAll(async () => {
		expect(existsSync(PY), `no python at ${PY}`).toBe(true);
		repo = makeRepo(root);
		workbench = await startServer(root, repo, "workbench");
		client = new McpModelClient(workbench.url);
	}, 60_000);

	afterAll(() => {
		workbench?.proc.kill();
		if (repo) rmSync(repo, { recursive: true, force: true });
	});

	it("reads elements with derived approval states; the approval record is not among them", async () => {
		const result = await client.query(ELEMENTS_QUERY);
		record("elements-query.json", result, repo);
		const elements = elementsFromRows(result);
		expect(elements.length).toBeGreaterThan(0);
		expect(elements.map((e) => e.iri)).not.toContain(`${M}approval-20261119-arch-baseline`);
		const pending = elements.filter((e) => e.approvalState === "Proposed");
		expect(pending.length).toBeGreaterThan(0);
		for (const e of elements) expect(e.inModel).toBe(M);
	});

	it("runs gate, findings, impact and diff", async () => {
		const gate = await client.gate();
		record("gate.json", gate, repo);
		expect(gate.result).toBe("PASS");
		expect(gate.source.repo).toBe(repo);

		const findings = await client.findings();
		record("findings.json", findings, repo);
		expect(findings.partial).toBe(true);
		expect(findings.openViolations).toEqual({ count: 0, byLayer: { L0: 0, build: 0, L1: 0, L2: 0 }, items: [] });

		const impact = await client.impact("procurement:quotation");
		record("impact-quotation.json", impact, repo);
		expect(impact.focus.iri).toBe(`${M}quotation`);
		expect(impact.mode).toBe("depends");
		expect(impact.items.length).toBeGreaterThan(0);
		for (const item of impact.items) {
			expect(item.depth).toBeLessThanOrEqual(impact.depth);
			expect(item.path).toHaveLength(item.depth);
		}

		const diff = await client.diff({ head: "main", detail: "items" });
		record("diff-main.json", diff, repo);
		expect(diff.head).toMatchObject({ kind: "ref", ref: "main" });
		expect(diff.changedElementCount).toBe(0);
		expect(diff.items).toEqual([]);
	}, 60_000);

	it("maps tool execution errors to AisepToolError with code, hint, retryable and details", async () => {
		const notFound = await client.impact("procurement:noSuchThing").catch((e: unknown) => e);
		expect(notFound).toBeInstanceOf(AisepToolError);
		expect(notFound).toMatchObject({ code: "ELEMENT_NOT_FOUND", retryable: false });
		expect((notFound as AisepToolError).hint).toBeTruthy();
		expect((notFound as AisepToolError).details?.candidates).toEqual(expect.any(Array));

		await expect(client.query("SELECT * WHERE { SERVICE <http://x.example/> { ?s ?p ?o } }")).rejects.toMatchObject({
			code: "QUERY_NOT_READONLY",
		});
		await expect(client.diff({ head: "no-such-branch" })).rejects.toMatchObject({ code: "REF_NOT_FOUND" });

		const invalid = await callMcpTool(workbench.url, "model_gate", { bogus: 1 }).catch((e: unknown) => e);
		expect(invalid).toMatchObject({ code: "INVALID_ARGUMENT", details: { rejectedFields: ["bogus"] } });
	});

	it("maps protocol refusals to McpProtocolError", async () => {
		// governance_record_approval is slice S5, not yet on aisep main: the server answers -32602 unknown tool.
		const approval = await client
			.recordApproval({ model: "procurement", gate: "GateArchitecture", decision: "Approved", approvedBy: `${M}x`,
				approves: [`${M}quotation`], branch: "main", headCommit: git(repo, "rev-parse", "HEAD") })
			.catch((e: unknown) => e);
		expect(approval).toBeInstanceOf(McpProtocolError);
		expect(approval).toMatchObject({ rpcCode: -32602 });

		const withOrigin = (origin: string): typeof fetch => (input, init) =>
			fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), Origin: origin } });
		await expect(new McpModelClient(workbench.url, withOrigin("https://evil.example")).gate()).rejects.toMatchObject({
			name: "McpProtocolError",
			status: 403,
		});
		const allowed = await fetch(workbench.url, {
			method: "OPTIONS",
			headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "content-type, mcp-protocol-version, mcp-method, mcp-name" },
		});
		expect(allowed.status).toBe(204);
		expect(allowed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
	});

	it("FixtureClient answers with the same structure as the live server (contract)", async () => {
		const pairs: [string, (c: AisepModelClient) => Promise<unknown>][] = [
			["query", (c) => c.query(ELEMENTS_QUERY)],
			["gate", (c) => c.gate()],
			["findings", (c) => c.findings()],
			["impact", (c) => c.impact(`${M}quotation`)],
			["diff", (c) => c.diff({ head: "main", detail: "items" })],
		];
		for (const [name, run] of pairs) {
			const live = await run(client);
			const fixture = await run(fixtureClient);
			expect(shape(fixture), name).toEqual(shape(live));
		}
	}, 60_000);

	it("a write tool (profile all) changes the worktree and the reads see it", async () => {
		const all = await startServer(root, repo, "all");
		try {
			const added = await callMcpTool(all.url, "model_add_element", {
				model: "procurement", type: "am4:BusinessObject", prefLabel: "报价行", slug: "quotationLine",
			});
			expect(added).toMatchObject({ changed: true, iri: expect.stringMatching(new RegExp(`^${M}`)) });

			const reader = new McpModelClient(all.url);
			const elements = elementsFromRows(await reader.query(ELEMENTS_QUERY));
			expect(elements.find((e) => e.iri === added.iri)).toMatchObject({ prefLabel: "报价行", approvalState: "Proposed" });

			const diff = await reader.diff({ head: { worktree: "main" } });
			expect(diff.head).toMatchObject({ kind: "worktree", branch: "main", dirty: true });
			expect(diff.counts.element.added).toBe(1);
		} finally {
			all.proc.kill();
		}
	}, 60_000);
});
