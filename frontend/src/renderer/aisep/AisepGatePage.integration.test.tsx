// End to end against a REAL AISEP MCP Server (§8 step 5): the gate page on a temp repo's branch, approve in the UI,
// then find the approval record on the branch with model_query. Needs AISEP_ROOT (see data/live-server.ts); the
// approval part also needs a server with governance_record_approval (aisep slice S5) and is skipped without one.
// AISEP_RECORD_FIXTURES=1 records the page's answers into data/fixtures/gate-*.json for AisepGatePage.test.tsx.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPROVERS_QUERY, AisepGatePage, NOT_APPROVABLE_QUERY } from "./AisepGatePage";
import {
	APPROVED_QUERY,
	AisepToolError,
	ELEMENTS_QUERY,
	iriColumn,
	PENDING_QUERY,
	asSelect,
	elementsFromRows,
	type AisepModelClient,
	type ApprovalInput,
} from "./data/client";
import {
	AISEP_PY,
	AISEP_ROOT,
	M,
	appendModel,
	businessObject,
	commitAll,
	git,
	makeRepo,
	record,
	startServer,
	type LiveServer,
} from "./data/live-server";
import { callMcpTool, McpModelClient, McpProtocolError } from "./data/mcp-client";
import { aisepCatalogs } from "./i18n";

const en = aisepCatalogs.en;
const BRANCH = "feat/approve";

/** jsdom's AbortSignal is not the one Node's fetch accepts; the live server needs no cancellation here. */
const nodeFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: undefined });

describe.skipIf(!AISEP_ROOT)("AisepGatePage against a real AISEP MCP Server", () => {
	let base: string;
	let repo: string;
	let server: LiveServer;
	let live: McpModelClient;
	let client: AisepModelClient;

	const approvals: unknown[] = [];
	let head = "";

	beforeAll(async () => {
		expect(existsSync(AISEP_PY), `no python at ${AISEP_PY}`).toBe(true);
		({ base, repo } = makeRepo());
		const wt = join(base, "wt-approve");
		git(repo, "worktree", "add", "-q", "-b", BRANCH, wt);
		appendModel(wt, "am4.ttl", businessObject("quotationLine", "报价行"));
		// A new Stakeholder is an "element" to the diff but can never be approved (R4-5): it must not be prefilled.
		appendModel(wt, "governance.ttl", `\n:reviewer a arch:Stakeholder ;\n    arch:inModel <${M}> ;\n    skos:prefLabel "评审人"@zh .\n`);
		commitAll(wt, "add quotationLine and a reviewer");
		head = git(repo, "rev-parse", BRANCH);
		server = await startServer(repo, "workbench", base);
		live = new McpModelClient(server.url, nodeFetch);
		// The page's own calls, recorded as they happen (one model_gate per page: it takes long on a snapshot).
		client = Object.assign(Object.create(live) as AisepModelClient, {
			diff: async (...args: Parameters<AisepModelClient["diff"]>) => {
				const result = await live.diff(...args);
				record("gate-diff.json", result, base);
				return result;
			},
			gate: async (...args: Parameters<AisepModelClient["gate"]>) => {
				const result = await live.gate(...args);
				record("gate-check.json", result, base);
				return result;
			},
			query: async (...args: Parameters<AisepModelClient["query"]>) => {
				const result = await live.query(...args);
				if (args[0] === APPROVERS_QUERY) record("gate-approvers.json", result, base);
				if (args[0] === NOT_APPROVABLE_QUERY) record("gate-not-approvable.json", result, base);
				return result;
			},
			recordApproval: async (...args: Parameters<AisepModelClient["recordApproval"]>) => {
				approvals.push(args[0]);
				const result = await live.recordApproval(...args);
				record("gate-approval.json", result, base);
				return result;
			},
		});
	}, 60_000);

	// The test setup unmounts after each test; one QueryClient keeps the slow gate answer across both renders.
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const renderGate = () =>
		render(
			<QueryClientProvider client={queryClient}>
				<AisepGatePage branch={BRANCH} client={client} />
			</QueryClientProvider>,
		);

	afterAll(() => {
		cleanup();
		server?.proc.kill();
		if (base) rmSync(base, { recursive: true, force: true });
	});

	it("shows the branch's committed changes and the gate result for that commit", async () => {
		renderGate();
		const changes = await screen.findByRole("region", { name: en["gate.diff.title"] }, { timeout: 60_000 });
		const row = (await within(changes).findByText("报价行")).closest("tr") as HTMLElement;
		expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual([
			en["gate.change.added"], en["gate.kind.element"], "报价行", "",
		]);
		expect(within(changes).getByText("评审人")).toBeInTheDocument();
		expect(screen.getByText(new RegExp(`${head.slice(0, 7)}`))).toBeInTheDocument();
		const check = screen.getByRole("region", { name: en["gate.check.title"] });
		// A gate on a commit snapshot (§3.3) is the slow call: give it room on a loaded machine.
		expect(await within(check).findByText(en["gate.check.pass"], {}, { timeout: 400_000 })).toBeInTheDocument();
	}, 420_000);

	it("records an approval from the page, and the record is then found on the branch", async (ctx) => {
		const probe = await callMcpTool(server.url, "governance_record_approval", {}).catch((e: unknown) => e);
		if (probe instanceof McpProtocolError && probe.rpcCode === -32602) ctx.skip(); // server without slice S5

		renderGate();
		const approve = await screen.findByRole("button", { name: en["gate.approval.approve"] }, { timeout: 60_000 });
		await waitFor(() => expect(approve).toBeEnabled(), { timeout: 30_000 });
		await userEvent.click(approve);
		// record_approval runs the full gate again on headCommit (§5.9 step 3).
		const approval = screen.getByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("status", {}, { timeout: 500_000 })).toHaveTextContent(/approval-/);

		expect(approvals).toEqual([
			expect.objectContaining({
				// The first approver the server lists; both Stakeholders on the branch may approve.
				model: "procurement", gate: "GateArchitecture", decision: "Approved",
				approvedBy: expect.stringMatching(new RegExp(`^${M}(chiefArchitect|reviewer)$`)),
				approves: [`${M}quotationLine`], branch: BRANCH, headCommit: head,
			}),
		]);
		expect(git(repo, "rev-parse", `${BRANCH}~1`)).toBe(head); // the approval is one new commit on the approved one
		const found = asSelect(
			await live.query(
				`PREFIX aisep: <https://aisep.example/ont/aisep#>
SELECT ?r WHERE { ?r a aisep:ApprovalRecord ; aisep:approves <${M}quotationLine> ; aisep:evidence "${head}" }`,
				{ ref: BRANCH },
			),
		);
		expect(found.rows).toHaveLength(1);
		// Main is untouched: the approval lives on the session branch until it is merged (§2, Q2=A).
		const onMain = asSelect(
			await live.query(
				`PREFIX aisep: <https://aisep.example/ont/aisep#>
SELECT ?r WHERE { ?r a aisep:ApprovalRecord ; aisep:approves <${M}quotationLine> }`,
			),
		);
		expect(onMain.rows).toHaveLength(0);

		// A code commit after the approved one: approving the old head now is STALE_HEAD (§5.9 step 1, Q3=A).
		const wt = join(base, "wt-approve");
		appendModel(wt, "am4.ttl", businessObject("quotationNote", "报价备注"));
		commitAll(wt, "more work after the approval");
		const stale = await live
			.recordApproval({ ...(approvals[0] as ApprovalInput), gate: "GateDesign" })
			.catch((e: unknown) => e);
		expect(stale).toBeInstanceOf(AisepToolError);
		const { code, message, hint, retryable, details } = stale as AisepToolError;
		record("error-stale-head.json", { code, message, hint, retryable, details }, base);
		expect(code).toBe("STALE_HEAD");
	}, 520_000);

	it("T31: an approval that records an AI activity adds it to neither the element list nor the pending gates", async (ctx) => {
		const probe = await callMcpTool(server.url, "governance_record_approval", {}).catch((e: unknown) => e);
		if (probe instanceof McpProtocolError && probe.rpcCode === -32602) ctx.skip(); // server without slice S5

		const branch = "feat/activity";
		const wt = join(base, "wt-activity");
		git(repo, "worktree", "add", "-q", "-b", branch, wt);
		appendModel(wt, "am4.ttl", businessObject("quotationLine", "报价行"));
		commitAll(wt, "add quotationLine");
		const result = await live.recordApproval(
			{
				model: "procurement", gate: "GateArchitecture", decision: "Approved", approvedBy: `${M}chiefArchitect`,
				// quotation is Proposed on main: approving it here is what the pending gates mark as "approved on the branch".
				approves: [`${M}quotationLine`, `${M}quotation`], branch, headCommit: git(repo, "rev-parse", branch),
				activity: { agent: `${M}chiefArchitect`, sessionRef: "ao-session-1", startedAt: "2026-11-20T00:00:00Z" },
			},
			{ timeoutMs: 500_000 },
		);
		const activity = result.activity?.iri;
		expect(activity).toMatch(new RegExp(`^${M}activity-`));
		for (const query of [ELEMENTS_QUERY, PENDING_QUERY]) {
			const iris = elementsFromRows(await live.query(query, { ref: branch })).elements.map((e) => e.iri);
			expect(iris, query).not.toContain(activity);
			expect(iris, query).not.toContain(result.approval.iri);
		}
		// The approved element itself is still listed, now Approved on this branch.
		const { elements } = elementsFromRows(await live.query(ELEMENTS_QUERY, { ref: branch }));
		expect(elements.find((e) => e.iri === `${M}quotationLine`)?.approvalState).toBe("Approved");

		// §2 row 3: the branch reports what its records approve; main still has quotation pending.
		const approvedHere = await live.query(APPROVED_QUERY, { ref: branch });
		record("approved-on-branch.json", approvedHere, base);
		expect(iriColumn(approvedHere, "element")).toEqual(expect.arrayContaining([`${M}quotation`, `${M}quotationLine`]));
		const pendingOnMain = elementsFromRows(await live.query(PENDING_QUERY)).elements.map((e) => e.iri);
		expect(pendingOnMain).toContain(`${M}quotation`);
		expect(iriColumn(await live.query(APPROVED_QUERY), "element")).not.toContain(`${M}quotation`);
	}, 520_000);
});
