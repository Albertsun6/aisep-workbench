import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { appI18n } from "../i18n";
import { AisepWorkbenchPage } from "./AisepWorkbenchPage";
import type { AgentSessionRow, AgentSessionSource } from "./data/ao-sessions";
import type { AisepModelClient } from "./data/client";
import { fixtureClient } from "./data/fixture-client";
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
		expect(await within(architecture).findByText("Total: 8")).toBeInTheDocument();
		expect(within(architecture).getAllByRole("listitem")).toHaveLength(8);

		const gates = screen.getByRole("region", { name: en["section.gates.title"] });
		expect(within(gates).getByText("Total: 2")).toBeInTheDocument();
		expect(within(gates).getByText("报价审批")).toBeInTheDocument();
		expect(within(gates).getByText("单笔超过10万需二级审批")).toBeInTheDocument();

		const ai = screen.getByRole("region", { name: en["section.aiActivity.title"] });
		expect(await within(ai).findByText(en["section.aiActivity.empty"])).toBeInTheDocument();
	});

	it("re-renders in the selected app language", async () => {
		renderPage();
		await act(() => appI18n.changeLanguage("zh-CN"));
		expect(screen.getByRole("heading", { level: 1, name: "AISEP 工作台" })).toBeInTheDocument();
		expect(await screen.findByText("共 8 项")).toBeInTheDocument();
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
		expect(approval && within(approval).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
			"Claude Code",
			"审批流程建模",
			en["section.aiActivity.bucket.inReview"],
			"feat/approval",
			en["section.aiActivity.changedElementsUnavailable"],
		]);
		expect(within(ai).getAllByText(en["section.aiActivity.changedElementsUnavailable"])).toHaveLength(5);
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
		expect(within(ai).getAllByText("暂不可用")).toHaveLength(5);
	});
});
