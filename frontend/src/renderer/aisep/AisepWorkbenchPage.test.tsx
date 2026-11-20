import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../i18n";
import { AGENT_SESSIONS_REFRESH_MS, AisepWorkbenchPage, CHANGED_ELEMENTS_REFRESH_MS, defaultModelClient, gateHref } from "./AisepWorkbenchPage";
import type { AgentSessionRow, AgentSessionSource } from "./data/ao-sessions";
import { AisepToolError, type AisepModelClient, type DiffInput, type DiffResult, type FindingsResult, type QueryResult } from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import diffNoModels from "./data/fixtures/diff-no-models.json";
import diffRefFallback from "./data/fixtures/diff-ref-fallback.json";
import diffWtClean from "./data/fixtures/diff-wt-clean.json";
import diffWtDirty from "./data/fixtures/diff-wt-dirty.json";
import diffWtIncomplete from "./data/fixtures/diff-wt-incomplete.json";
import elementsQuery from "./data/fixtures/elements-query.json";
import refNotFound from "./data/fixtures/error-ref-not-found.json";
import worktreeNotFound from "./data/fixtures/error-worktree-not-found.json";
import findingsViolation from "./data/fixtures/findings-violation.json";
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
		expect(within(gates).getByText("Total: 25")).toBeInTheDocument();
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

	it("links each branch to its gate page", async () => {
		renderPage(diffingClient().client, fakeSessions([branchRow("feat/edit")]));
		expect(await screen.findByRole("link", { name: "feat/edit" })).toHaveAttribute("href", "#/aisep/gate/feat/edit");
		expect(gateHref("feat/a b")).toBe("#/aisep/gate/feat/a%20b");
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
