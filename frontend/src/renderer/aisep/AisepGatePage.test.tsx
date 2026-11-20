// The gate page (§8 step 5) on answers recorded from a real server (AisepGatePage.integration.test.tsx and
// data/mcp-client.integration.test.ts with AISEP_RECORD_FIXTURES=1).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../i18n";
import { APPROVERS_QUERY, AisepGatePage, approvalCandidates } from "./AisepGatePage";
import {
	AisepToolError,
	type AisepModelClient,
	type ApprovalInput,
	type ApprovalResult,
	type DiffResult,
	type GateResult,
	type QueryResult,
} from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import staleHead from "./data/fixtures/error-stale-head.json";
import gateApproval from "./data/fixtures/gate-approval.json";
import gateApprovers from "./data/fixtures/gate-approvers.json";
import gateCheck from "./data/fixtures/gate-check.json";
import gateDiff from "./data/fixtures/gate-diff.json";
import gateFail from "./data/fixtures/gate-fail.json";
import { aisepCatalogs } from "./i18n";

const en = aisepCatalogs.en;
const M = "https://aisep.example/model/procurement/";
const BRANCH = "feat/approve";
const diff = gateDiff as DiffResult;
const head = diff.head.kind === "ref" ? diff.head.commit : "";

function gateClient(overrides: Partial<AisepModelClient> = {}) {
	const calls = { diff: [] as unknown[], gate: [] as unknown[], query: [] as unknown[], approve: [] as ApprovalInput[] };
	const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
		diff: async (input: unknown) => (calls.diff.push(input), diff),
		gate: async (target: unknown) => (calls.gate.push(target), gateCheck as GateResult),
		query: async (sparql: string, target: unknown) => (calls.query.push([sparql, target]), gateApprovers as QueryResult),
		recordApproval: async (input: ApprovalInput) => (calls.approve.push(input), gateApproval as ApprovalResult),
		...overrides,
	});
	return { client, calls };
}

function renderGate(client: AisepModelClient) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<AisepGatePage branch={BRANCH} client={client} />
		</QueryClientProvider>,
	);
}

afterEach(async () => {
	cleanup();
	await act(() => appI18n.changeLanguage("en"));
});

describe("AisepGatePage", () => {
	it("diffs the branch once (items), then runs the gate and reads approvers on that pinned commit", async () => {
		const { client, calls } = gateClient();
		renderGate(client);
		const changes = await screen.findByRole("region", { name: en["gate.diff.title"] });
		const row = within(changes).getByText("报价行").closest("tr") as HTMLElement;
		expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual([
			en["gate.change.added"], en["gate.kind.element"], "报价行", "",
		]);
		expect(screen.getByText(`Head ${head.slice(0, 7)} · base ${diff.base.commit.slice(0, 7)}`)).toBeInTheDocument();
		const check = screen.getByRole("region", { name: en["gate.check.title"] });
		expect(await within(check).findByText(en["gate.check.pass"])).toBeInTheDocument();
		expect(calls.diff).toEqual([{ head: BRANCH, detail: "items" }]);
		expect(calls.gate).toEqual([{ ref: head }]);
		expect(calls.query).toEqual([[APPROVERS_QUERY, { ref: head }]]);
	});

	it("approves exactly the commit that was shown, with the prefilled elements and the first approver", async () => {
		const { client, calls } = gateClient();
		renderGate(client);
		const approve = await screen.findByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		const approval = screen.getByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("status")).toHaveTextContent(
			`Recorded ${gateApproval.approval.iri.slice(M.length)} in commit ${gateApproval.commit.slice(0, 7)}.`,
		);
		expect(calls.approve).toEqual([
			{
				model: "procurement", gate: "GateArchitecture", decision: "Approved", approvedBy: `${M}chiefArchitect`,
				approves: [`${M}quotationLine`], branch: BRANCH, headCommit: head, expectedBaseCommit: diff.base.commit,
			},
		]);
		// One decision per page visit: the buttons stay off after it is recorded.
		expect(approve).toBeDisabled();
	});

	it("cannot approve once every element is unchecked", async () => {
		renderGate(gateClient().client);
		const approve = await screen.findByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(screen.getByRole("checkbox", { name: "报价行" }));
		expect(approve).toBeDisabled();
		expect(screen.getByRole("button", { name: en["gate.approval.reject"] })).toBeDisabled();
	});

	it("only offers Reject when the gate fails", async () => {
		const { client, calls } = gateClient({ gate: async () => gateFail as GateResult });
		renderGate(client);
		const check = await screen.findByRole("region", { name: en["gate.check.title"] });
		expect(await within(check).findByText(en["gate.check.fail"])).toBeInTheDocument();
		expect(within(check).getByText(/direct triple/)).toBeInTheDocument();
		expect(screen.getByText(en["gate.approval.gateFailed"])).toBeInTheDocument();
		expect(screen.getByRole("button", { name: en["gate.approval.approve"] })).toBeDisabled();
		const reject = screen.getByRole("button", { name: en["gate.approval.reject"] });
		await waitFor(() => expect(reject).toBeEnabled());
		await userEvent.click(reject);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0].decision).toBe("Rejected");
	});

	it("tells the user to refresh when the branch moved on (STALE_HEAD)", async () => {
		const e = staleHead as { code: string; message: string; hint?: string; retryable: boolean; details?: Record<string, unknown> };
		const { client } = gateClient({
			recordApproval: () => Promise.reject(new AisepToolError(e.code, e.message, e.retryable, e.hint, e.details)),
		});
		renderGate(client);
		const approve = await screen.findByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		expect(await screen.findByRole("alert")).toHaveTextContent(en["gate.approval.staleHead"]);
	});

	it("shows the server's message when the diff fails", async () => {
		const { client } = gateClient({
			diff: () => Promise.reject(new AisepToolError("REF_NOT_FOUND", "找不到提交 feat/approve", false)),
		});
		renderGate(client);
		expect(await screen.findByRole("alert")).toHaveTextContent("找不到提交 feat/approve");
	});
});

describe("approvalCandidates", () => {
	it("keeps added and modified elements, grouped by model, and drops relationships and removals", () => {
		const items = [
			...(diff.items ?? []),
			{ ...(diff.items ?? [])[0], iri: `${M}gone`, change: "removed" as const, files: { base: ["models/procurement/am4.ttl"], head: [] } },
			{ ...(diff.items ?? [])[0], iri: `${M}rel`, kind: "relationship" as const },
			{ ...(diff.items ?? [])[0], iri: "https://aisep.example/model/sales/x", files: { base: [], head: ["models/sales/am4.ttl"] } },
		];
		const byModel = approvalCandidates({ ...diff, items });
		expect([...byModel.keys()]).toEqual(["procurement", "sales"]);
		expect(byModel.get("procurement")?.map((i) => i.iri)).toEqual([`${M}quotationLine`]);
	});
});

vi.setConfig({ testTimeout: 15_000 });
