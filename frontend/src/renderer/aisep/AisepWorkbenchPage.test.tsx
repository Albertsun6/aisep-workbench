import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../i18n";
import { AGENT_SESSIONS_REFRESH_MS, AisepWorkbenchPage, CHANGED_ELEMENTS_REFRESH_MS, defaultModelClient, gateHref } from "./AisepWorkbenchPage";
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

function renderPage(client: AisepModelClient = fixtureClient, sessions: AgentSessionSource = fakeSessions([])) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
	const BRANCHES = [
		info("feat/approved", { head: sha("a") }),
		info("feat/docs", { hasModelChanges: false }),
		info("feat/merged", { mergedIntoMain: true, unpushed: false, remoteHead: sha("1") }),
		info("feat/model", { head: sha("b"), remoteHead: sha("b"), unpushed: false }),
		info("main", { mergedIntoMain: true, hasModelChanges: false, unpushed: false, remoteHead: sha("1") }),
	];
	const MAIN = { ref: "refs/remotes/origin/main", commit: sha("1") };
	const APPROVED = "https://aisep.example/ont/aisep#DecisionApproved";
	const select = (records: string[]): QueryResult => ({
		kind: "select", variables: ["record", "decision"], truncated: false,
		rows: records.map((r) => ({ record: { type: "iri", value: r }, decision: { type: "iri", value: APPROVED } })),
	});
	/** feat/approved's tip adds one Approved record (not pushed yet); feat/model's tip adds none. */
	function branchClient(): { client: AisepModelClient; refs: string[] } {
		const refs: string[] = [];
		const client = liveLike(Object.assign(Object.create(fixtureClient) as AisepModelClient, {
			branches: async () => ({ branches: BRANCHES, main: MAIN }),
			query: async (sparql: string, target: { ref?: string } = {}) => {
				if (sparql !== APPROVAL_RECORDS_QUERY) return fixtureClient.query(sparql);
				const ref = target.ref ?? "";
				refs.push(ref);
				if (ref.endsWith("^2") || ref.startsWith("refs/remotes/origin/feat/approved")) throw toolError(refNotFound);
				if (ref === "refs/heads/feat/approved") return select(["urn:r1"]);
				return select([]);
			},
		}));
		return { client, refs };
	}
	const region = () => screen.getByRole("region", { name: en["section.gates.title"] });

	it("lists only unmerged branches with model changes, each row a link to its gate page with its approval stage", async () => {
		const { client, refs } = branchClient();
		renderPage(client);
		const list = await within(region()).findByRole("list", { name: en["section.gates.branches.title"] });
		const links = within(list).getAllByRole("link");
		expect(links.map((a) => a.getAttribute("href"))).toEqual([gateHref("feat/approved"), gateHref("feat/model")]);
		expect(links[0]).toHaveAttribute("title", en["section.aiActivity.openGate"].replace("{{branch}}", "feat/approved"));
		expect(await within(links[0]).findByText(en["gate.progress.stage.approved"])).toBeInTheDocument();
		expect(within(links[0]).getByText(en["section.gates.branches.unpushed"])).toBeInTheDocument();
		expect(within(links[0]).getByText("aaaaaaa")).toBeInTheDocument();
		expect(await within(links[1]).findByText(en["gate.progress.stage.pending"])).toBeInTheDocument();
		expect(within(links[1]).queryByText(en["section.gates.branches.unpushed"])).toBeNull();
		// Progress is judged against the main the server resolved.
		expect(refs).toContain(MAIN.ref);
		expect(within(region()).queryByText("feat/docs")).toBeNull();
		expect(within(region()).queryByText("feat/merged")).toBeNull();
	});

	it("says so when no branch is waiting", async () => {
		const client = liveLike(Object.assign(Object.create(fixtureClient) as AisepModelClient, {
			branches: async () => ({ branches: [BRANCHES[1], BRANCHES[2]], main: MAIN }),
		}));
		renderPage(client);
		expect(await within(region()).findByText(en["section.gates.branches.empty"])).toBeInTheDocument();
	});

	it("says the branch list is unavailable when the server cannot list branches", async () => {
		const client = liveLike(Object.assign(Object.create(fixtureClient) as AisepModelClient, {
			branches: () => Promise.reject(new Error("unknown tool")),
		}));
		renderPage(client);
		expect(await within(region()).findByText(en["section.gates.branches.error"])).toBeInTheDocument();
		// The pending elements still load.
		expect(await within(region()).findByText("Total: 24")).toBeInTheDocument();
	});

	it("with the offline fixtures shows the recorded branches without links or progress, and says why", async () => {
		renderPage(fixtureClient);
		const list = await within(region()).findByRole("list", { name: en["section.gates.branches.title"] });
		expect(within(list).queryByRole("link")).toBeNull();
		const rows = within(list).getAllByTitle(en["section.aiActivity.gateNeedsServer"]);
		expect(rows.length).toBeGreaterThan(0);
		expect(within(list).queryByText(en["gate.progress.stage.pending"])).toBeNull();
	});
});
