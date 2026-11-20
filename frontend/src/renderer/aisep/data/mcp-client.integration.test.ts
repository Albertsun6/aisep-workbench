// @vitest-environment node
// Against a REAL AISEP MCP Server (aisep repo, slice S7) over HTTP, on a throwaway git repo holding the procurement
// example. Needs an aisep checkout: AISEP_ROOT=<checkout> [AISEP_PY=<python with aisep's deps>]; skipped without it.
// AISEP_RECORD_FIXTURES=1 also rewrites ./fixtures/*.json from the live answers (§8 step 1: fixtures are recorded,
// never hand-written).
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { branchChanges } from "./changed-elements";
import { AisepToolError, ELEMENTS_QUERY, PENDING_QUERY, elementsFromRows, type AisepModelClient } from "./client";
import { fixtureClient } from "./fixture-client";
import {
	AISEP_PY as PY,
	AISEP_ROOT,
	M,
	ORIGIN,
	appendModel,
	businessObject,
	commitAll,
	git,
	makeRepo,
	record,
	shape,
	startServer,
	type LiveServer,
} from "./live-server";
import { callMcpTool, McpModelClient, McpProtocolError } from "./mcp-client";

/** model_gate runs L3 (≈5 s idle); on a loaded machine it can take minutes. */
const SLOW = { timeoutMs: 600_000 };
const DIRECT_L1 = "\n:quoteApproval am4:accesses :quotation .\n"; // a direct triple: one L1 Violation (aisep T37)

describe.skipIf(!AISEP_ROOT)("McpModelClient against a real AISEP MCP Server (HTTP)", () => {
	let base: string;
	let repo: string;
	let workbench: LiveServer;
	let client: AisepModelClient;

	beforeAll(async () => {
		expect(existsSync(PY), `no python at ${PY}`).toBe(true);
		({ base, repo } = makeRepo());
		workbench = await startServer(repo, "workbench", base);
		client = new McpModelClient(workbench.url);
	}, 60_000);

	afterAll(() => {
		workbench?.proc.kill();
		if (base) rmSync(base, { recursive: true, force: true });
	});

	it("lists every architecture element, the stakeholder included, but not the approval record", async () => {
		const result = await client.query(ELEMENTS_QUERY);
		record("elements-query.json", result, base);
		const { elements } = elementsFromRows(result);
		expect(elements.length).toBeGreaterThan(0);
		expect(elements.map((e) => e.iri)).not.toContain(`${M}approval-20261119-arch-baseline`);
		expect(elements.map((e) => e.iri)).toContain(`${M}chiefArchitect`);
		expect(elements.find((e) => e.iri === `${M}quoteApproval`)?.approvalState).toBe("Approved");
		for (const e of elements) expect(e.inModel).toBe(M);
	});

	it("keeps elements the server derives no approval state for (aisep#29: Stakeholders), with no state", async (ctx) => {
		const result = await client.query(ELEMENTS_QUERY);
		const architect = elementsFromRows(result).elements.find((e) => e.iri === `${M}chiefArchitect`);
		if (architect?.approvalState !== undefined) ctx.skip(); // a server before aisep#29 still derives one
		// With approvalState required in ELEMENTS_QUERY, the Stakeholder would vanish here.
		expect(architect).toMatchObject({ prefLabel: "首席架构师" });
		expect(architect?.approvalState).toBeUndefined();
	});

	it("lists only Proposed elements as pending, never the approval record or an Approved element", async () => {
		const result = await client.query(PENDING_QUERY);
		record("pending-query.json", result, base);
		const { elements } = elementsFromRows(result);
		expect(elements.length).toBeGreaterThan(0);
		for (const e of elements) expect(e.approvalState).toBe("Proposed");
		const iris = elements.map((e) => e.iri);
		expect(iris).not.toContain(`${M}approval-20261119-arch-baseline`);
		expect(iris).not.toContain(`${M}quoteApproval`);
	});

	it("runs gate, findings, impact and diff", async () => {
		const gate = await client.gate({}, SLOW);
		record("gate.json", gate, base);
		expect(gate.result).toBe("PASS");
		expect(gate.source.repo).toBe(repo);

		const findings = await client.findings();
		record("findings.json", findings, base);
		expect(findings.partial).toBe(true);
		expect(findings.openViolations).toEqual({ count: 0, byLayer: { L0: 0, build: 0, L1: 0, L2: 0 }, items: [] });

		const impact = await client.impact("procurement:quotation");
		record("impact-quotation.json", impact, base);
		expect(impact.focus.iri).toBe(`${M}quotation`);
		expect(impact.mode).toBe("depends");
		expect(impact.items.length).toBeGreaterThan(0);
		for (const item of impact.items) {
			expect(item.depth).toBeLessThanOrEqual(impact.depth);
			expect(item.path).toHaveLength(item.depth);
		}

		const diff = await client.diff({ head: "main", detail: "items" });
		record("diff-main.json", diff, base);
		expect(diff.head).toMatchObject({ kind: "ref", ref: "main" });
		expect(diff.changedElementCount).toBe(0);
		expect(diff.items).toEqual([]);
	}, 400_000);

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
		const unknown = await callMcpTool(workbench.url, "no_such_tool", {}).catch((e: unknown) => e);
		expect(unknown).toBeInstanceOf(McpProtocolError);
		expect(unknown).toMatchObject({ rpcCode: -32602 });

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
			["pending", (c) => c.query(PENDING_QUERY)],
			["gate", (c) => c.gate({}, SLOW)],
			["findings", (c) => c.findings()],
			["impact", (c) => c.impact(`${M}quotation`)],
			["diff", (c) => c.diff({ head: "main", detail: "items" })],
		];
		for (const [name, run] of pairs) {
			const live = await run(client);
			const fixture = await run(fixtureClient);
			expect(shape(fixture), name).toEqual(shape(live));
		}
	}, 400_000);

	it("a write tool (profile all) changes the worktree and the reads see it", async () => {
		const all = await startServer(repo, "all", base);
		try {
			const added = await callMcpTool(all.url, "model_add_element", {
				model: "procurement", type: "am4:BusinessObject", prefLabel: "报价行", slug: "quotationLine",
			});
			expect(added).toMatchObject({ changed: true, iri: expect.stringMatching(new RegExp(`^${M}`)) });

			const reader = new McpModelClient(all.url);
			const { elements } = elementsFromRows(await reader.query(ELEMENTS_QUERY));
			expect(elements.find((e) => e.iri === added.iri)).toMatchObject({ prefLabel: "报价行", approvalState: "Proposed" });

			const diff = await reader.diff({ head: { worktree: "main" } });
			expect(diff.head).toMatchObject({ kind: "worktree", branch: "main", dirty: true });
			expect(diff.counts.element.added).toBe(1);
		} finally {
			all.proc.kill();
		}
	}, 60_000);
});

/** The envelope of a tool error, as the server sent it (structuredContent.error). */
function envelope(error: unknown) {
	expect(error).toBeInstanceOf(AisepToolError);
	const { code, message, hint, retryable, details } = error as AisepToolError;
	return { code, message, hint, retryable, details };
}

describe.skipIf(!AISEP_ROOT)("the AI activity column's model_diff states against a real server (§8 step 4)", () => {
	let base: string;
	let repo: string;
	let server: LiveServer;
	let client: McpModelClient;

	beforeAll(async () => {
		({ base, repo } = makeRepo());
		const worktree = (name: string, branch: string) => {
			const path = join(base, name);
			git(repo, "worktree", "add", "-q", "-b", branch, path);
			return path;
		};
		// feat/edit: one committed new element, one more uncommitted -> dirty, 2 changed elements.
		const edit = worktree("wt-edit", "feat/edit");
		appendModel(edit, "am4.ttl", businessObject("quotationLine", "报价行"));
		commitAll(edit, "add quotationLine");
		appendModel(edit, "am4.ttl", businessObject("quotationNote", "报价备注"));
		// feat/clean: one committed new element, nothing uncommitted.
		const clean = worktree("wt-clean", "feat/clean");
		appendModel(clean, "am4.ttl", businessObject("quotationLine", "报价行"));
		commitAll(clean, "add quotationLine");
		// feat/broken: a half-written file -> incomplete.
		appendModel(worktree("wt-broken", "feat/broken"), "code.ttl", "\n:half a <\n");
		// feat/gone: committed, then its worktree removed -> WORKTREE_NOT_FOUND, then Git ref mode.
		const gone = worktree("wt-gone", "feat/gone");
		appendModel(gone, "am4.ttl", businessObject("quotationLine", "报价行"));
		commitAll(gone, "add quotationLine");
		git(repo, "worktree", "remove", gone);
		server = await startServer(repo, "workbench", base);
		client = new McpModelClient(server.url);
	}, 60_000);

	afterAll(() => {
		server?.proc.kill();
		if (base) rmSync(base, { recursive: true, force: true });
	});

	it("counts the committed changes of a clean checked-out branch (worktree mode)", async () => {
		const { result, viaRef } = await branchChanges(client, "feat/clean");
		record("diff-wt-clean.json", result, base);
		expect(viaRef).toBe(false);
		expect(result.head).toMatchObject({ kind: "worktree", branch: "feat/clean", dirty: false });
		expect(result.changedElementCount).toBe(1);
	});

	it("counts committed and uncommitted changes in a checked-out branch (worktree mode, dirty)", async () => {
		const { result, viaRef } = await branchChanges(client, "feat/edit");
		record("diff-wt-dirty.json", result, base);
		expect(viaRef).toBe(false);
		expect(result.head).toMatchObject({ kind: "worktree", branch: "feat/edit", dirty: true });
		expect(result.changedElementCount).toBe(2);
		expect(result.incomplete).toBe(false);
	});

	it("reports a half-written file as incomplete, not as removed elements", async () => {
		const { result } = await branchChanges(client, "feat/broken");
		record("diff-wt-incomplete.json", result, base);
		expect(result.incomplete).toBe(true);
		expect(result.failedFiles.map((f) => f.file)).toEqual(["models/procurement/code.ttl"]);
		expect(result.counts.element.removed).toBe(0);
		expect(result.indeterminate.length).toBeGreaterThan(0);
	});

	it("falls back to the Git ref when the branch has no worktree", async () => {
		const worktreeError = await client.diff({ head: { worktree: "feat/gone" } }).catch((e: unknown) => e);
		record("error-worktree-not-found.json", envelope(worktreeError), base);
		expect(worktreeError).toMatchObject({ code: "WORKTREE_NOT_FOUND", details: { branchExists: true } });

		const { result, viaRef } = await branchChanges(client, "feat/gone");
		record("diff-ref-fallback.json", result, base);
		expect(viaRef).toBe(true);
		expect(result.head).toMatchObject({ kind: "ref", ref: "feat/gone" });
		expect(result.changedElementCount).toBe(1);
	});

	it("fails with REF_NOT_FOUND when the branch is not in the model repo at all", async () => {
		const error = await branchChanges(client, "feat/elsewhere").catch((e: unknown) => e);
		record("error-ref-not-found.json", envelope(error), base);
		expect(error).toMatchObject({ code: "REF_NOT_FOUND" });
	});
});

describe.skipIf(!AISEP_ROOT)("a repo without models, and one with a legacy violation (§8 steps 4, 4b)", () => {
	const bases: string[] = [];
	const servers: LiveServer[] = [];

	afterAll(() => {
		for (const s of servers) s.proc.kill();
		for (const b of bases) rmSync(b, { recursive: true, force: true });
	});

	it("reports neither side having models", async () => {
		const { base, repo } = makeRepo(false);
		bases.push(base);
		const server = await startServer(repo, "workbench", base);
		servers.push(server);
		const { result } = await branchChanges(new McpModelClient(server.url), "main");
		record("diff-no-models.json", result, base);
		expect(result).toMatchObject({ baseHasModels: false, headHasModels: false, changedElementCount: 0 });
	}, 60_000);

	it("lists a committed legacy L1 violation in findings.openViolations", async () => {
		const { base, repo } = makeRepo();
		bases.push(base);
		appendModel(repo, "am4.ttl", DIRECT_L1);
		commitAll(repo, "legacy violation (as if committed with --no-verify)");
		const server = await startServer(repo, "workbench", base);
		servers.push(server);
		const findings = await new McpModelClient(server.url).findings();
		record("findings-violation.json", findings, base);
		const gate = await new McpModelClient(server.url).gate({}, SLOW);
		record("gate-fail.json", gate, base);
		expect(gate.result).toBe("FAIL");
		expect(findings.openViolations.count).toBe(1);
		expect(findings.openViolations.byLayer.L1).toBe(1);
		expect(findings.openViolations.items[0]).toMatchObject({ severity: "Violation", layer: "L1", focus: `${M}quoteApproval` });
	}, 400_000);
});
