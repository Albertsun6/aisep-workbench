import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../i18n";
import { approvalProgressKey } from "./AisepApprovalProgress";
import {
	AGENT_SESSIONS_REFRESH_MS,
	AisepWorkbenchPage,
	CHANGED_ELEMENTS_REFRESH_MS,
	GATE_BRANCHES_REFRESH_MS,
	defaultModelClient,
	gateHref,
} from "./AisepWorkbenchPage";
import type { AgentSessionRow, AgentSessionSource } from "./data/ao-sessions";
import {
	APPROVED_QUERY,
	AisepToolError,
	ELEMENTS_QUERY,
	type AisepModelClient,
	type BranchInfo,
	type DiffInput,
	type DiffResult,
	type FindingsResult,
	type QueryResult,
} from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import diffNoModels from "./data/fixtures/diff-no-models.json";
import diffRefFallback from "./data/fixtures/diff-ref-fallback.json";
import diffWtClean from "./data/fixtures/diff-wt-clean.json";
import diffWtDirty from "./data/fixtures/diff-wt-dirty.json";
import diffWtIncomplete from "./data/fixtures/diff-wt-incomplete.json";
import approvedOnBranch from "./data/fixtures/approved-on-branch.json";
import elementsQuery from "./data/fixtures/elements-query.json";
import refNotFound from "./data/fixtures/error-ref-not-found.json";
import worktreeNotFound from "./data/fixtures/error-worktree-not-found.json";
import findingsViolation from "./data/fixtures/findings-violation.json";
import { APPROVAL_RECORDS_QUERY } from "./data/approval-progress";
import { McpModelClient } from "./data/mcp-client";
import { aisepCatalogs } from "./i18n";

const fakeSessions = (rows: AgentSessionRow[]): AgentSessionSource => ({ list: () => Promise.resolve(rows) });

const sampleRows: AgentSessionRow[] = [
	{ sessionRef: "a", agent: "Codex", task: "补报价单字段", branch: "feat/quote-fields", bucket: "inProgress", rawStatus: "working" },
	{ sessionRef: "b", agent: "Claude Code", task: "审批流程建模", branch: "feat/approval", bucket: "inReview", rawStatus: "pr_open" },
	{ sessionRef: "c", agent: "Claude Code", task: "修复 CI", branch: "fix/ci", bucket: "needsYou", rawStatus: "ci_failed" },
	{ sessionRef: "d", task: "整理术语表", bucket: "finished", rawStatus: "merged" },
	{ sessionRef: "e", agent: "Codex", task: "回答问题", branch: "feat/q", bucket: "needsYou", rawStatus: "needs_input" },
];

function renderPage(
	client: AisepModelClient = fixtureClient,
	sessions: AgentSessionSource = fakeSessions([]),
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
	return render(
		<QueryClientProvider client={queryClient}>
			<AisepWorkbenchPage client={client} sessions={sessions} />
		</QueryClientProvider>,
	);
}

afterEach(async () => {
	cleanup();
	await act(() => appI18n.changeLanguage("en"));
});

describe("AisepWorkbenchPage", () => {
	it("shows the three placeholder regions with counts and titles from the client", async () => {
		renderPage();
		const en = aisepCatalogs.en;
		expect(screen.getByRole("heading", { level: 1, name: en["page.title"] })).toBeInTheDocument();

		const architecture = screen.getByRole("region", { name: en["section.architecture.title"] });
		expect(await within(architecture).findByText("Total: 26")).toBeInTheDocument();
		expect(within(architecture).getAllByRole("listitem")).toHaveLength(26);

		const gates = screen.getByRole("region", { name: en["section.gates.title"] });
		// 26 elements, minus 报价审批 (Approved) and 首席架构师 (a Stakeholder: no state since aisep#29).
		expect(await within(gates).findByText("Total: 24")).toBeInTheDocument();
		expect(within(gates).queryByTitle("https://aisep.example/model/procurement/chiefArchitect")).toBeNull();
		expect(within(gates).getByText("单笔超过10万需二级审批")).toBeInTheDocument();
		// Approved, so not pending; the approval record itself has no approvalState and is not an element row at all.
		expect(within(gates).queryByText("报价审批")).toBeNull();
		expect(within(architecture).getByText("报价审批")).toBeInTheDocument();

		const ai = screen.getByRole("region", { name: en["section.aiActivity.title"] });
		expect(await within(ai).findByText(en["section.aiActivity.empty"])).toBeInTheDocument();
	});

	it("does not tell the user the whole page is placeholder data, since the AI area is live", () => {
		renderPage();
		const notice = screen.getByText(aisepCatalogs.en["page.fixtureNotice"]);
		expect(notice.textContent).toContain(aisepCatalogs.en["section.aiActivity.title"]);
		expect(notice.textContent).toContain("orchestrator");
	});

	it("re-renders in the selected app language", async () => {
		renderPage();
		await act(() => appI18n.changeLanguage("zh-CN"));
		expect(screen.getByRole("heading", { level: 1, name: "AISEP 工作台" })).toBeInTheDocument();
		expect(await screen.findByText("共 26 项")).toBeInTheDocument();
	});

	it("uses the MCP server when its URL is configured, else the offline fixtures", () => {
		const client = defaultModelClient("http://127.0.0.1:8765/mcp");
		expect(client).toBeInstanceOf(McpModelClient);
		expect((client as McpModelClient).endpoint).toBe("http://127.0.0.1:8765/mcp");
		expect(defaultModelClient(undefined)).toBe(fixtureClient);
		expect(defaultModelClient("")).toBe(fixtureClient);
	});

	it("shows the placeholder-data notice only for the fixture client", async () => {
		const live = new McpModelClient("http://127.0.0.1:1/mcp", () => Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { kind: "select", variables: [], rows: [], truncated: false } } }))));
		renderPage(live);
		const architecture = screen.getByRole("region", { name: aisepCatalogs.en["section.architecture.title"] });
		expect(await within(architecture).findByText(aisepCatalogs.en["section.empty"])).toBeInTheDocument();
		expect(screen.queryByText(aisepCatalogs.en["page.fixtureNotice"])).toBeNull();
	});

	it("shows an error state when the client fails", async () => {
		renderPage({ ...fixtureClient, query: () => Promise.reject(new Error("down")) } as AisepModelClient);
		expect(await screen.findAllByText(aisepCatalogs.en["section.error"])).toHaveLength(2);
	});
});

describe("AisepWorkbenchPage AI activity area", () => {
	const en = aisepCatalogs.en;
	const aiRegion = () => screen.getByRole("region", { name: en["section.aiActivity.title"] });

	it("shows one row per session with agent, task, bucket, branch and the placeholder column", async () => {
		renderPage(fixtureClient, fakeSessions(sampleRows));
		const ai = aiRegion();
		expect(await within(ai).findByText("审批流程建模")).toBeInTheDocument();
		const headers = within(ai).getAllByRole("columnheader").map((cell) => cell.textContent);
		expect(headers).toEqual([
			en["section.aiActivity.column.agent"],
			en["section.aiActivity.column.task"],
			en["section.aiActivity.column.status"],
			en["section.aiActivity.column.branch"],
			en["section.aiActivity.column.changedElements"],
		]);
		const rows = within(ai).getAllByRole("row").slice(1);
		expect(rows).toHaveLength(5);
		const approval = rows.find((row) => row.textContent?.includes("审批流程建模"));
		await vi.waitFor(() => expect(approval?.lastElementChild?.textContent).not.toBe("…"));
		expect(approval && within(approval).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
			"Claude Code",
			"审批流程建模",
			en["section.aiActivity.bucket.inReview"],
			"feat/approval",
			// The fixture client has no diff for this branch.
			en["section.aiActivity.changedElementsUnavailable"],
		]);
		await vi.waitFor(() => expect(within(ai).getAllByText(en["section.aiActivity.changedElementsUnavailable"])).toHaveLength(4));
		// No branch, no call.
		expect(within(ai).getByText("整理术语表").closest("tr")?.lastElementChild?.textContent).toBe("—");
	});

	it("lists sessions that need the user first, then in progress, in review, finished", async () => {
		renderPage(fixtureClient, fakeSessions(sampleRows));
		const ai = aiRegion();
		await within(ai).findByText("审批流程建模");
		const tasks = within(ai)
			.getAllByRole("row")
			.slice(1)
			.map((row) => within(row).getAllByRole("cell")[1].textContent);
		expect(tasks).toEqual(["修复 CI", "回答问题", "补报价单字段", "审批流程建模", "整理术语表"]);
	});

	it("shows no-branch and unknown-agent text instead of an error", async () => {
		renderPage(fixtureClient, fakeSessions(sampleRows));
		const ai = aiRegion();
		const row = (await within(ai).findByText("整理术语表")).closest("tr");
		expect(row).not.toBeNull();
		const cells = within(row as HTMLElement).getAllByRole("cell");
		expect(cells[0].textContent).toBe(en["section.aiActivity.unknownAgent"]);
		expect(cells[3].textContent).toBe(en["section.aiActivity.noBranch"]);
		expect(within(ai).queryByRole("alert")).toBeNull();
	});

	it("shows explicit error text when the orchestrator is unreachable", async () => {
		renderPage(fixtureClient, { list: () => Promise.reject(new Error("ECONNREFUSED")) });
		expect(await within(aiRegion()).findByRole("alert")).toHaveTextContent(en["section.aiActivity.error"]);
	});

	it("picks up session changes after mount without a reload", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let current: AgentSessionRow[] = [sampleRows[0]];
			renderPage(fixtureClient, { list: () => Promise.resolve(current) });
			const ai = aiRegion();
			const row = (await within(ai).findByText("补报价单字段")).closest("tr") as HTMLElement;
			expect(within(row).getAllByRole("cell")[2].textContent).toBe(en["section.aiActivity.bucket.inProgress"]);

			// AO moves the session to needs_input and a new session starts.
			current = [{ ...sampleRows[0], bucket: "needsYou", rawStatus: "needs_input" }, sampleRows[1]];
			await act(() => vi.advanceTimersByTimeAsync(AGENT_SESSIONS_REFRESH_MS));
			expect(await within(ai).findByText("审批流程建模")).toBeInTheDocument();
			const updated = within(ai).getByText("补报价单字段").closest("tr") as HTMLElement;
			expect(within(updated).getAllByRole("cell")[2].textContent).toBe(en["section.aiActivity.bucket.needsYou"]);

			// The session ends (archived), so it leaves the list.
			current = [sampleRows[1]];
			await act(() => vi.advanceTimersByTimeAsync(AGENT_SESSIONS_REFRESH_MS));
			await vi.waitFor(() => expect(within(ai).queryByText("补报价单字段")).toBeNull());
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows explicit empty text when there are no sessions", async () => {
		renderPage(fixtureClient, fakeSessions([]));
		expect(await within(aiRegion()).findByText(en["section.aiActivity.empty"])).toBeInTheDocument();
	});

	it("shows a loading state while sessions are being read", () => {
		renderPage(fixtureClient, { list: () => new Promise(() => {}) });
		expect(within(aiRegion()).getByRole("status")).toHaveTextContent(en["section.loading"]);
	});

	it("renders in the selected app language", async () => {
		renderPage(fixtureClient, fakeSessions(sampleRows));
		await act(() => appI18n.changeLanguage("zh-CN"));
		const ai = screen.getByRole("region", { name: aisepCatalogs["zh-CN"]["section.aiActivity.title"] });
		expect(await within(ai).findAllByText("等你处理")).toHaveLength(2);
		expect(within(ai).getByText("无分支")).toBeInTheDocument();
		await vi.waitFor(() => expect(within(ai).getAllByText("暂不可用")).toHaveLength(4));
	});
});

type Envelope = { code: string; message: string; hint?: string; retryable: boolean; details?: Record<string, unknown> };
const toolError = (e: Envelope) => new AisepToolError(e.code, e.message, e.retryable, e.hint, e.details);

/** Recorded S7 answers per branch: worktree mode first, then Git ref mode (see data/mcp-client.integration.test.ts). */
const DIFFS: Record<string, { worktree: DiffResult | Envelope; ref?: DiffResult | Envelope }> = {
	"feat/clean": { worktree: diffWtClean as DiffResult },
	"feat/edit": { worktree: diffWtDirty as DiffResult },
	"feat/broken": { worktree: diffWtIncomplete as DiffResult },
	"feat/gone": { worktree: worktreeNotFound, ref: diffRefFallback as DiffResult },
	"feat/elsewhere": { worktree: worktreeNotFound, ref: refNotFound },
	main: { worktree: diffNoModels as DiffResult },
};

function diffingClient(overrides: Partial<AisepModelClient> = {}): { client: AisepModelClient; calls: DiffInput[] } {
	const calls: DiffInput[] = [];
	const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
		diff: async (input: DiffInput) => {
			calls.push(input);
			const branch = typeof input.head === "string" ? input.head : input.head.worktree;
			const answer = typeof input.head === "string" ? DIFFS[branch]?.ref : DIFFS[branch]?.worktree;
			if (!answer) throw new Error(`no recorded diff for ${JSON.stringify(input.head)}`);
			if ("code" in answer) throw toolError(answer);
			return answer;
		},
		...overrides,
	});
	return { client, calls };
}

/** The same answers, but not a FixtureClient: the page treats it as a connected model server. */
function liveLike(client: AisepModelClient): AisepModelClient {
	return {
		query: (...a) => client.query(...a),
		gate: (...a) => client.gate(...a),
		findings: (...a) => client.findings(...a),
		impact: (...a) => client.impact(...a),
		diff: (...a) => client.diff(...a),
		recordApproval: (...a) => client.recordApproval(...a),
		branches: (...a) => client.branches(...a),
		listViews: (...a) => client.listViews(...a),
		renderView: (...a) => client.renderView(...a),
	};
}

const branchRow = (branch: string): AgentSessionRow => ({
	sessionRef: branch, agent: "Codex", task: `task ${branch}`, branch, bucket: "inProgress", rawStatus: "working",
});

describe("AisepWorkbenchPage changed-elements column (§8 step 4)", () => {
	const en = aisepCatalogs.en;
	const cell = async (branch: string) => {
		const row = (await screen.findByText(`task ${branch}`)).closest("tr") as HTMLElement;
		return within(row).getAllByRole("cell")[4];
	};

	it("shows the count, the uncommitted and incomplete markers, the Git ref fallback and the no-model states", async () => {
		const { client, calls } = diffingClient();
		renderPage(client, fakeSessions(Object.keys(DIFFS).map(branchRow)));

		const clean = await cell("feat/clean");
		await vi.waitFor(() => expect(clean.textContent).toBe("1"));
		expect(clean.querySelector("[title]")?.getAttribute("title")).toContain("base");

		const dirty = await cell("feat/edit");
		await vi.waitFor(() => expect(dirty.textContent).toBe(`2${en["section.aiActivity.changed.dirty"]}`));

		const broken = await cell("feat/broken");
		await vi.waitFor(() => expect(broken).toHaveTextContent(en["section.aiActivity.changed.incomplete"]));
		expect(broken.querySelector("[title]")?.getAttribute("title")).toContain("models/procurement/code.ttl");

		const gone = await cell("feat/gone");
		await vi.waitFor(() => expect(gone.textContent).toBe("1"));
		expect(gone.querySelector("[title]")?.getAttribute("title")).toContain(en["section.aiActivity.changed.viaRef"]);

		const elsewhere = await cell("feat/elsewhere");
		await vi.waitFor(() => expect(elsewhere.textContent).toBe(en["section.aiActivity.changed.branchNotInRepo"]));

		const main = await cell("main");
		await vi.waitFor(() => expect(main.textContent).toBe(en["section.aiActivity.changed.noModels"]));

		expect(calls.filter((c) => typeof c.head === "string").map((c) => c.head).sort()).toEqual(["feat/elsewhere", "feat/gone"]);
		for (const c of calls) expect(c.detail).toBe("summary");
	});

	it("shows 'not available' for any other error", async () => {
		const { client } = diffingClient({ diff: () => Promise.reject(new Error("socket hang up")) });
		renderPage(client, fakeSessions([branchRow("feat/clean")]));
		const c = await cell("feat/clean");
		await vi.waitFor(() => expect(c.textContent).toBe(en["section.aiActivity.changedElementsUnavailable"]));
	});

	it("refetches on an interval and keeps the last number when the worktree keeps changing (WORKTREE_CHANGED)", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let answer: () => Promise<DiffResult> = () => Promise.resolve(diffWtDirty as DiffResult);
			const { client, calls } = diffingClient({ diff: (input) => (calls.push(input), answer()) });
			renderPage(client, fakeSessions([branchRow("feat/edit")]));
			const c = await cell("feat/edit");
			await vi.waitFor(() => expect(c.textContent).toContain("2"));
			answer = () => Promise.reject(new AisepToolError("WORKTREE_CHANGED", "changing", true));
			await act(() => vi.advanceTimersByTimeAsync(CHANGED_ELEMENTS_REFRESH_MS + 10_000));
			expect(calls.length).toBeGreaterThan(2); // the interval refetched, and the retryable error was retried
			expect(c.textContent).toContain("2");
		} finally {
			vi.useRealTimers();
		}
	});

	it("links each branch to its gate page when a model server is connected", async () => {
		renderPage(liveLike(diffingClient().client), fakeSessions([branchRow("feat/edit")]));
		expect(await screen.findByRole("link", { name: "feat/edit" })).toHaveAttribute("href", "#/aisep/gate/feat/edit");
		expect(gateHref("feat/a b")).toBe("#/aisep/gate/feat/a%20b");
	});
});

describe("AisepWorkbenchPage with the offline fixtures", () => {
	it("does not link branches to a gate page that could only fail, and says why", async () => {
		renderPage(fixtureClient, fakeSessions([branchRow("feat/edit")]));
		const ai = screen.getByRole("region", { name: aisepCatalogs.en["section.aiActivity.title"] });
		const branch = await within(ai).findByText("feat/edit");
		expect(screen.queryByRole("link", { name: "feat/edit" })).toBeNull();
		expect(branch).toHaveAttribute("title", aisepCatalogs.en["section.aiActivity.gateNeedsServer"]);
	});
});

describe("AisepWorkbenchPage approval states (§2, T31)", () => {
	const en = aisepCatalogs.en;
	const M = "https://aisep.example/model/procurement/";
	const item = (local: string) =>
		within(screen.getByRole("region", { name: en["section.architecture.title"] })).findByTitle(`${M}${local}`);

	it("shows each element's derived approval state", async () => {
		renderPage();
		expect(await item("quoteApproval")).toHaveTextContent(`报价审批${en["state.Approved"]}`);
		expect(await item("quotation")).toHaveTextContent(`报价单${en["state.Proposed"]}`);
	});

	it("keeps an element the server derives no state for, and says it has none instead of calling it Proposed", async () => {
		// Recorded after aisep#29: the server derives no state for Stakeholders.
		renderPage();
		const architect = await item("chiefArchitect");
		expect(architect).toHaveTextContent("首席架构师");
		expect(architect).toHaveTextContent(en["state.none"]);
		expect(architect).not.toHaveTextContent(en["state.Proposed"]);
	});

	it("ELEMENTS_QUERY never requires approvalState (only inside OPTIONAL)", () => {
		const required = ELEMENTS_QUERY.replace(/OPTIONAL\s*\{[^}]*\}/g, "");
		expect(ELEMENTS_QUERY).toMatch(/OPTIONAL\s*\{[^}]*arch:approvalState/);
		expect(required).not.toMatch(/approvalState\s+\?approvalState/);
	});

	it("marks a pending element already approved on a session branch, and asks that branch, not main", async () => {
		const calls: [string, unknown][] = [];
		const { client } = diffingClient({
			query: (sparql, target) => {
				calls.push([sparql, target]);
				if (sparql === APPROVED_QUERY) {
					return target?.ref === "feat/activity"
						? Promise.resolve(approvedOnBranch as QueryResult)
						: Promise.reject(toolError(refNotFound as Envelope));
				}
				return fixtureClient.query(sparql);
			},
		});
		renderPage(client, fakeSessions([branchRow("feat/activity"), branchRow("feat/elsewhere")]));
		const gates = screen.getByRole("region", { name: en["section.gates.title"] });
		const quotation = await within(gates).findByTitle(`${M}quotation`);
		await vi.waitFor(() =>
			expect(quotation).toHaveTextContent(en["section.gates.approvedOnBranch"].replace("{{branch}}", "feat/activity")),
		);
		const supplier = within(gates).getByTitle(`${M}supplier`);
		expect(supplier.textContent).toBe("供应商");
		expect(calls.filter(([q]) => q === APPROVED_QUERY).map(([, t]) => t)).toEqual(
			// limit: the server's default page is only 1000 rows (§5.6).
			expect.arrayContaining([{ ref: "feat/activity", limit: 10_000 }, { ref: "feat/elsewhere", limit: 10_000 }]),
		);
		// A branch the model repo does not have is not an unknown: it simply has no approvals.
		expect(within(gates).queryByRole("alert")).toBeNull();
	});

	it.each([
		["the server fails", () => Promise.reject(new Error("socket hang up"))],
		["the answer is truncated", () => Promise.resolve({ ...(approvedOnBranch as QueryResult), truncated: true } as QueryResult)],
	])("says the marks of a branch are unknown when %s, instead of showing it as not approved", async (_, answer) => {
		const { client } = diffingClient({
			query: (sparql) => (sparql === APPROVED_QUERY ? answer() : fixtureClient.query(sparql)),
		});
		renderPage(client, fakeSessions([branchRow("feat/activity")]));
		const gates = screen.getByRole("region", { name: en["section.gates.title"] });
		expect(await within(gates).findByRole("alert")).toHaveTextContent(
			en["section.gates.branchMarksUnknown"].replace("{{branches}}", "feat/activity"),
		);
		expect(within(gates).getByTitle(`${M}quotation`).textContent).toBe("报价单");
	});
});

describe("AisepWorkbenchPage open-violation badge (§8 step 4b)", () => {
	const en = aisepCatalogs.en;

	it("shows the count of a planted legacy L1 violation and highlights its focus when opened", async () => {
		renderPage(diffingClient({ findings: () => Promise.resolve(findingsViolation as FindingsResult) }).client);
		const architecture = screen.getByRole("region", { name: en["section.architecture.title"] });
		const badge = await within(architecture).findByRole("button", { name: "Open violations: 1" });
		expect(badge).toHaveAttribute("aria-expanded", "false");
		const quoteApproval = within(architecture).getByTitle("https://aisep.example/model/procurement/quoteApproval");
		expect(quoteApproval).not.toHaveAttribute("data-violation");

		await userEvent.click(badge);
		expect(badge).toHaveAttribute("aria-expanded", "true");
		const list = within(architecture).getByRole("list", { name: en["section.architecture.violationsList"] });
		expect(within(list).getAllByRole("listitem")).toHaveLength(1);
		expect(list).toHaveTextContent("direct triple");
		expect(quoteApproval).toHaveAttribute("data-violation", "true");
		expect(architecture.querySelectorAll("[data-violation]")).toHaveLength(1);
	});

	it("shows no badge when there are no open violations", async () => {
		renderPage();
		const architecture = screen.getByRole("region", { name: en["section.architecture.title"] });
		await within(architecture).findByText("Total: 26");
		await act(() => Promise.resolve());
		expect(within(architecture).queryByRole("button")).toBeNull();
	});
});

describe("AisepWorkbenchPage truncated element list", () => {
	it("says the list is cut off when the server truncated the query", async () => {
		const truncated = { ...(elementsQuery as QueryResult), truncated: true } as QueryResult;
		renderPage(diffingClient({ query: () => Promise.resolve(truncated) }).client);
		const architecture = screen.getByRole("region", { name: aisepCatalogs.en["section.architecture.title"] });
		expect(await within(architecture).findByRole("note")).toHaveTextContent("first 26");
	});
});

describe("AisepWorkbenchPage gate entries (model_branches, §5.11)", () => {
	const en = aisepCatalogs.en;
	const sha = (c: string) => c.repeat(40);
	const info = (branch: string, facts: Partial<BranchInfo>): BranchInfo => ({
		branch, head: sha("1"), remoteHead: null, unpushed: true, mergedIntoMain: false, hasModelChanges: true, ...facts,
	});
	/** Space, #, ? and CJK: the link must carry it percent-encoded per segment. */
	const ODD = "feat/报价 #1?";
	const BRANCHES = [
		info("feat/approved", { head: sha("a") }),
		info("feat/docs", { hasModelChanges: false }),
		info("feat/merged", { mergedIntoMain: true, unpushed: false, remoteHead: sha("1") }),
		info("feat/model", { head: sha("b"), remoteHead: sha("b"), unpushed: false }),
		info(ODD, { head: sha("c") }),
		info("main", { mergedIntoMain: true, hasModelChanges: false, unpushed: false, remoteHead: sha("1") }),
	];
	/** Not origin/main (the client's default), so the test shows the server's main is the one used. */
	const MAIN = { ref: "refs/heads/main", commit: sha("1") };
	const APPROVED = "https://aisep.example/ont/aisep#DecisionApproved";
	const select = (records: string[]): QueryResult => ({
		kind: "select", variables: ["record", "decision"], truncated: false,
		rows: records.map((r) => ({ record: { type: "iri", value: r }, decision: { type: "iri", value: APPROVED } })),
	});
	/** feat/approved's tip adds one Approved record (not pushed yet); the others' tips add none. */
	function branchClient(list: () => Promise<{ branches: BranchInfo[]; main: typeof MAIN }> = async () => ({ branches: BRANCHES, main: MAIN })) {
		const refs: string[] = [];
		const client = liveLike(Object.assign(Object.create(fixtureClient) as AisepModelClient, {
			branches: list,
			query: async (sparql: string, target: { ref?: string } = {}) => {
				if (sparql !== APPROVAL_RECORDS_QUERY) return fixtureClient.query(sparql);
				const ref = target.ref ?? "";
				refs.push(ref);
				if (ref.endsWith("^2") || ref.startsWith("refs/remotes/origin/")) throw toolError(refNotFound);
				if (ref === "refs/heads/feat/approved") return select(["urn:r1"]);
				return select([]);
			},
		}));
		return { client, refs };
	}
	const region = () => screen.getByRole("region", { name: en["section.gates.title"] });
	const list = () => within(region()).findByRole("list", { name: en["section.gates.branches.title"] });
	const tipQueries = (refs: string[], branch: string) => refs.filter((r) => r === `refs/heads/${branch}`).length;

	it("lists only unmerged branches with model changes, each row a link to its gate page with its approval stage", async () => {
		const { client, refs } = branchClient();
		renderPage(client);
		const links = within(await list()).getAllByRole("link");
		expect(links.map((a) => a.getAttribute("href"))).toEqual([
			"#/aisep/gate/feat/approved",
			"#/aisep/gate/feat/model",
			"#/aisep/gate/feat/%E6%8A%A5%E4%BB%B7%20%231%3F",
		]);
		expect(links[0]).toHaveAttribute("title", en["section.aiActivity.openGate"].replace("{{branch}}", "feat/approved"));
		expect(within(links[2]).getByText(ODD)).toBeInTheDocument();
		expect(await within(links[0]).findByText(en["gate.progress.stage.approved"])).toBeInTheDocument();
		expect(within(links[0]).getByText(en["section.gates.branches.unpushed"])).toBeInTheDocument();
		expect(within(links[0]).getByText("aaaaaaa")).toBeInTheDocument();
		expect(await within(links[1]).findByText(en["gate.progress.stage.pending"])).toBeInTheDocument();
		expect(within(links[1]).queryByText(en["section.gates.branches.unpushed"])).toBeNull();
		// Progress is judged against the main the server resolved, never the client's default.
		expect(refs).toContain(MAIN.ref);
		expect(refs).not.toContain("refs/remotes/origin/main");
		expect(within(region()).queryByText("feat/docs")).toBeNull();
		expect(within(region()).queryByText("feat/merged")).toBeNull();
	});

	it("lists a release approval branch while it waits for a decision or for its merge (acReleaseBranchListed)", async () => {
		const R = sha("1");
		const waiting = `approval/release-${R.slice(0, 7)}-20261125120000`;
		const decided = `approval/release-${R.slice(0, 7)}-20261125130000`;
		const merged = `approval/release-${R.slice(0, 7)}-20261124120000`;
		const release = (branch: string, facts: Partial<BranchInfo>) =>
			info(branch, { hasModelChanges: false, mergedIntoMain: true, unpushed: false, remoteHead: R, head: R, ...facts });
		const { client } = branchClient(async () => ({
			branches: [
				release(waiting, {}),
				release(decided, { head: sha("d"), mergedIntoMain: false, unpushed: true, remoteHead: null }),
				release(merged, { head: sha("e") }),
				info("approval/release-nothex-20261125120000", { hasModelChanges: false, mergedIntoMain: true }),
			],
			main: MAIN,
		}));
		renderPage(client);
		const links = within(await list()).getAllByRole("link");
		expect(links.map((a) => a.getAttribute("href"))).toEqual([
			"#/aisep/gate/approval/release-1111111-20261125120000",
			"#/aisep/gate/approval/release-1111111-20261125130000",
		]);
		for (const link of links) expect(within(link).getByText(en["section.gates.branches.release"])).toBeInTheDocument();
		expect(within(region()).queryByText(merged)).toBeNull();
	});

	it("recomputes a row's progress when its head moves, and only then", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let branches = BRANCHES;
			const { client, refs } = branchClient(async () => ({ branches, main: MAIN }));
			renderPage(client);
			const links = within(await list()).getAllByRole("link");
			await within(links[1]).findByText(en["gate.progress.stage.pending"]);
			await vi.waitFor(() => expect(tipQueries(refs, "feat/approved")).toBe(1));
			expect(tipQueries(refs, "feat/model")).toBe(1);

			branches = BRANCHES.map((b) => (b.branch === "feat/approved" ? { ...b, head: sha("d") } : b));
			await act(() => vi.advanceTimersByTimeAsync(GATE_BRANCHES_REFRESH_MS));
			await vi.waitFor(() => expect(tipQueries(refs, "feat/approved")).toBe(2));
			expect(within(await list()).getByText("ddddddd")).toBeInTheDocument();
			expect(tipQueries(refs, "feat/model")).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the list when a later poll fails, and says the refresh failed", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let fail = false;
			const { client } = branchClient(async () => {
				if (fail) throw new AisepToolError("INTERNAL", "boom", false);
				return { branches: BRANCHES, main: MAIN };
			});
			renderPage(client);
			expect(within(await list()).getAllByRole("link")).toHaveLength(3);
			fail = true;
			await act(() => vi.advanceTimersByTimeAsync(GATE_BRANCHES_REFRESH_MS));
			const alert = await within(region()).findByText(en["section.gates.branches.refreshFailed"]);
			// Same wording as the gate page's errors: message (and hint), no code in front.
			expect(alert).toHaveAttribute("title", "boom");
			expect(within(await list()).getAllByRole("link")).toHaveLength(3);
			expect(within(region()).queryByText(en["section.gates.branches.error"])).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries a row whose progress failed after the next list refresh", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let progressDown = true;
			const { client } = branchClient();
			const query = client.query.bind(client);
			client.query = async (sparql, target) => {
				if (sparql === APPROVAL_RECORDS_QUERY && progressDown) throw new AisepToolError("INTERNAL", "boom", false);
				return query(sparql, target);
			};
			renderPage(client);
			const links = within(await list()).getAllByRole("link");
			expect(await within(links[1]).findByText(en["section.gates.branches.progressUnknown"])).toBeInTheDocument();
			progressDown = false;
			await act(() => vi.advanceTimersByTimeAsync(GATE_BRANCHES_REFRESH_MS));
			expect(await within(links[1]).findByText(en["gate.progress.stage.pending"])).toBeInTheDocument();
			expect(await within(links[0]).findByText(en["gate.progress.stage.approved"])).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("while the server stays down, only the list asks again: the rows do not multiply the calls; once it is back each row asks once", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let listDown = false;
			let progressDown = true;
			let listCalls = 0;
			let rowCalls = 0;
			const { client, refs } = branchClient(async () => {
				listCalls++;
				if (listDown) throw new AisepToolError("INTERNAL", "boom", false);
				return { branches: BRANCHES, main: MAIN };
			});
			const query = client.query.bind(client);
			client.query = async (sparql, target) => {
				if (sparql !== APPROVAL_RECORDS_QUERY) return query(sparql, target);
				rowCalls++;
				if (progressDown) throw new AisepToolError("INTERNAL", "boom", false);
				return query(sparql, target);
			};
			renderPage(client);
			const links = within(await list()).getAllByRole("link");
			for (const link of links) await within(link).findByText(en["section.gates.branches.progressUnknown"]);
			listDown = true;
			await act(() => vi.advanceTimersByTimeAsync(GATE_BRANCHES_REFRESH_MS));
			await within(region()).findByText(en["section.gates.branches.refreshFailed"]);
			const [lists, rows] = [listCalls, rowCalls];
			await act(() => vi.advanceTimersByTimeAsync(5 * GATE_BRANCHES_REFRESH_MS));
			// Five more intervals: five list calls, and none from the three failed rows.
			expect(listCalls - lists).toBe(5);
			expect(rowCalls - rows).toBe(0);
			// The server is back: the next list read makes each failed row read its progress again.
			listDown = false;
			progressDown = false;
			await act(() => vi.advanceTimersByTimeAsync(GATE_BRANCHES_REFRESH_MS));
			const back = within(await list()).getAllByRole("link");
			expect(await within(back[0]).findByText(en["gate.progress.stage.approved"])).toBeInTheDocument();
			expect(await within(back[1]).findByText(en["gate.progress.stage.pending"])).toBeInTheDocument();
			expect(await within(back[2]).findByText(en["gate.progress.stage.pending"])).toBeInTheDocument();
			expect(within(region()).queryByText(en["section.gates.branches.refreshFailed"])).toBeNull();
			// Asks once: after the server came back each row's tip was read exactly once (failed reads never reach refs),
			// and a later list read does not make a row that has its stage ask again.
			await act(() => vi.advanceTimersByTimeAsync(GATE_BRANCHES_REFRESH_MS));
			for (const branch of ["feat/approved", "feat/model", ODD]) expect(tipQueries(refs, branch)).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves a row's progress read alone while it is still running when the list refreshes again (no cancel and resend)", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let mode: "down" | "slow" | "up" = "up";
			let listCalls = 0;
			const held: { ref: string; release: () => void }[] = [];
			const { client } = branchClient(async () => {
				listCalls++;
				return { branches: BRANCHES, main: MAIN };
			});
			const query = client.query.bind(client);
			client.query = async (sparql, target) => {
				if (sparql !== APPROVAL_RECORDS_QUERY || mode === "up") return query(sparql, target);
				if (mode === "down") throw new AisepToolError("INTERNAL", "boom", false);
				// Slow: the read stays open until the test lets it go, then gets the server's answer.
				return new Promise((resolve, reject) =>
					held.push({ ref: target?.ref ?? "", release: () => void query(sparql, target).then(resolve, reject) }));
			};
			const heldTips = (branch: string) => held.filter((h) => h.ref === `refs/heads/${branch}`).length;
			const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
			renderPage(client, undefined, queryClient);
			const links = within(await list()).getAllByRole("link");
			expect(await within(links[0]).findByText(en["gate.progress.stage.approved"])).toBeInTheDocument();
			// The row has a stage, then a reread fails (as after the gate page invalidates it while the server is down).
			// Only a query that already has data is cancelled and resent by refetch(), so this is the case the guard is for.
			mode = "down";
			await act(() => queryClient.invalidateQueries({ queryKey: approvalProgressKey("feat/approved") }));
			// The next list read makes the failed row read again; that read outlasts one interval.
			mode = "slow";
			let lists = listCalls;
			await act(() => vi.advanceTimersByTimeAsync(GATE_BRANCHES_REFRESH_MS));
			await vi.waitFor(() => expect(listCalls).toBe(lists + 1));
			await vi.waitFor(() => expect(heldTips("feat/approved")).toBe(1));
			// Another list read while the row is still failed and reading: nothing is cancelled and sent again.
			lists = listCalls;
			await act(() => vi.advanceTimersByTimeAsync(GATE_BRANCHES_REFRESH_MS));
			await vi.waitFor(() => expect(listCalls).toBe(lists + 1));
			expect(heldTips("feat/approved")).toBe(1);
			mode = "up";
			for (const h of held.splice(0)) h.release();
			expect(await within(links[0]).findByText(en["gate.progress.stage.approved"])).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("says so when no branch is waiting", async () => {
		const { client } = branchClient(async () => ({ branches: [BRANCHES[1], BRANCHES[2]], main: MAIN }));
		renderPage(client);
		expect(await within(region()).findByText(en["section.gates.branches.empty"])).toBeInTheDocument();
	});

	it("says the branch list is unavailable, with the original error, when the first call fails", async () => {
		const { client } = branchClient(() => Promise.reject(new Error("unknown tool")));
		renderPage(client);
		const alert = await within(region()).findByText(en["section.gates.branches.error"]);
		expect(alert).toHaveAttribute("title", "unknown tool");
		expect(within(region()).queryByRole("list", { name: en["section.gates.branches.title"] })).toBeNull();
		// The pending elements still load.
		expect(await within(region()).findByText("Total: 24")).toBeInTheDocument();
	});

	it("with the offline fixtures shows the recorded branches without links or progress, and says why", async () => {
		renderPage(fixtureClient);
		const l = await list();
		expect(within(l).queryByRole("link")).toBeNull();
		expect(within(l).getAllByTitle(en["section.aiActivity.gateNeedsServer"]).length).toBeGreaterThan(0);
		expect(within(l).queryByText(en["gate.progress.stage.pending"])).toBeNull();
	});
});
