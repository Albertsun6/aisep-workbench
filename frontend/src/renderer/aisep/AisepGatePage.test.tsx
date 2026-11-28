// The gate page (§8 step 5) on answers recorded from a real server (AisepGatePage.integration.test.tsx and
// data/mcp-client.integration.test.ts with AISEP_RECORD_FIXTURES=1).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../i18n";
import { Store as OxStore } from "oxigraph";
import { APPROVED_MODELS_QUERY, APPROVERS_QUERY, AisepGatePage, NOT_APPROVABLE_QUERY, approvalCandidates, changedModels } from "./AisepGatePage";
import {
	AisepToolError,
	iriColumn,
	type AisepModelClient,
	type ApprovalInput,
	type ApprovalResult,
	type DiffResult,
	type GateResult,
	type QueryResult,
} from "./data/client";
import { APPROVAL_COVERAGE_QUERY, APPROVAL_RECORDS_QUERY } from "./data/approval-progress";
import { fixtureClient } from "./data/fixture-client";
import staleHead from "./data/fixtures/error-stale-head.json";
import gateApproval from "./data/fixtures/gate-approval.json";
import gateApprovers from "./data/fixtures/gate-approvers.json";
import gateCheck from "./data/fixtures/gate-check.json";
import gateDiff from "./data/fixtures/gate-diff.json";
import gateDiffViews from "./data/fixtures/gate-diff-views.json";
import gateFail from "./data/fixtures/gate-fail.json";
import gateNotApprovable from "./data/fixtures/gate-not-approvable.json";
import { aisepCatalogs } from "./i18n";

const en = aisepCatalogs.en;
const M = "https://aisep.example/model/procurement/";
const BRANCH = "feat/approve";
const diff = gateDiff as DiffResult;
/** A branch that only changes arch:inView (model_diff on a real probe branch of the procurement model). */
const viewsDiff = gateDiffViews as DiffResult;
const head = diff.head.kind === "ref" ? diff.head.commit : "";

/** Before approving no ref holds a record (nothing pushed: origin/<branch> missing); after it the branch tip added one. */
function progressRecords(ref: string, approved: boolean): QueryResult {
	if (ref.startsWith("refs/remotes/origin/feat/") || ref.endsWith("^2")) {
		throw new AisepToolError("REF_NOT_FOUND", `找不到提交 ${ref}`, false);
	}
	const rows =
		approved && ref === `refs/heads/${BRANCH}`
			? [{ record: { type: "iri" as const, value: gateApproval.approval.iri }, decision: { type: "iri" as const, value: DECISION_APPROVED } }]
			: [];
	return { kind: "select", variables: ["record", "decision"], rows, truncated: false };
}
const DECISION_APPROVED = "https://aisep.example/ont/aisep#DecisionApproved";

function approvedModels(models: string[]): QueryResult {
	return { kind: "select", variables: ["model"], truncated: false, rows: models.map((m) => ({ model: { type: "iri", value: m } })) };
}

/** gateClient whose main has these models Approved (aisep #95), and whose diff is `changes` when given. */
function approvedOnMainClient(models: string[], changes: DiffResult = diff) {
	const made = gateClient({ diff: async () => changes });
	const query = made.client.query.bind(made.client);
	made.client.query = async (sparql, target, options) => {
		if (sparql === APPROVED_MODELS_QUERY) return (made.calls.query.push([sparql, target]), approvedModels(models));
		return query(sparql, target, options);
	};
	return made;
}

function gateClient(overrides: Partial<AisepModelClient> = {}) {
	const calls = {
		diff: [] as unknown[],
		gate: [] as unknown[],
		query: [] as unknown[],
		progress: [] as string[],
		approve: [] as ApprovalInput[],
	};
	const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
		diff: async (input: unknown) => (calls.diff.push(input), diff),
		gate: async (target: unknown) => (calls.gate.push(target), gateCheck as GateResult),
		query: async (sparql: string, target: { ref: string }) => {
			// The approval progress follows the branch refs, not the pinned commit (AisepApprovalProgress).
			if (sparql === APPROVAL_RECORDS_QUERY) return (calls.progress.push(target.ref), progressRecords(target.ref, calls.approve.length > 0));
			calls.query.push([sparql, target]);
			if (sparql === APPROVERS_QUERY) return gateApprovers as QueryResult;
			if (sparql === NOT_APPROVABLE_QUERY) return gateNotApprovable as QueryResult;
			if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
			throw new Error(`unexpected query ${sparql}`);
		},
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
		expect(calls.query).toEqual(
			expect.arrayContaining([
				[APPROVERS_QUERY, { ref: head }],
				[NOT_APPROVABLE_QUERY, { ref: head, limit: 10_000 }],
				// main's approval state, not the pinned commit's (aisep #95)
				[APPROVED_MODELS_QUERY, { ref: diff.base.mainRef }],
			]),
		);
		expect(calls.query).toHaveLength(3);
		const progress = screen.getByRole("region", { name: en["gate.progress.title"] });
		expect(await within(progress).findByText(en["gate.progress.stage.pending"])).toHaveAttribute("aria-current", "step");
		expect(calls.progress).toEqual(
			expect.arrayContaining([`refs/heads/${BRANCH}`, `refs/heads/${BRANCH}^`, `refs/remotes/origin/${BRANCH}`]),
		);
	});

	it("approves exactly the commit that was shown, with the prefilled elements and the approver the user chose", async () => {
		const { client, calls } = gateClient();
		renderGate(client);
		await chooseApprover(await screen.findByRole("region", { name: en["gate.approval.title"] }), "评审人");
		const approve = await screen.findByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		const approval = screen.getByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("status")).toHaveTextContent(
			`Recorded ${gateApproval.approval.iri.slice(M.length)} in commit ${gateApproval.commit.slice(0, 7)}.`,
		);
		expect(calls.approve).toEqual([
			{
				model: "procurement", gate: "GateArchitecture", decision: "Approved", approvedBy: (gateApprovers as QueryResult & { kind: "select" }).rows[0].approver.value,
				approves: [`${M}quotationLine`], branch: BRANCH, headCommit: head, expectedBaseCommit: diff.base.commit,
			},
		]);
		// One decision per page visit: the buttons stay off after it is recorded.
		expect(approve).toBeDisabled();
		// The progress is read again right away, not at the next poll: the branch tip now adds the record.
		const progress = screen.getByRole("region", { name: en["gate.progress.title"] });
		await waitFor(() =>
			expect(within(progress).getByText(en["gate.progress.stage.approved"])).toHaveAttribute("aria-current", "step"),
		);
		// The tip is now this approval, but it is the one just recorded: no "already approved" warning under "Recorded".
		expect(within(approval).getByText(/^Recorded /)).toBeInTheDocument();
		expect(within(approval).queryByRole("note")).toBeNull();
	});

	it("does not prefill a Stakeholder the branch added: it can never be approved (R4-5)", async () => {
		renderGate(gateClient().client);
		const changes = await screen.findByRole("region", { name: en["gate.diff.title"] });
		expect(within(changes).getByText("评审人")).toBeInTheDocument();
		const approval = screen.getByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("checkbox", { name: "报价行" })).toBeInTheDocument();
		expect(within(approval).queryByRole("checkbox", { name: "评审人" })).toBeNull();
		expect(within(approval).getAllByRole("checkbox")).toHaveLength(1);
	});

	it("diffs the branch again on every visit (§2: once per page entry, never cached across visits)", async () => {
		const { client, calls } = gateClient();
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const page = (
			<QueryClientProvider client={queryClient}>
				<AisepGatePage branch={BRANCH} client={client} />
			</QueryClientProvider>
		);
		const first = render(page);
		await screen.findByRole("region", { name: en["gate.diff.title"] });
		first.unmount();
		render(page);
		await waitFor(() => expect(calls.diff).toHaveLength(2));
	});

	it.each([
		["fails", () => Promise.reject(new Error("socket hang up"))],
		["is truncated", () => Promise.resolve({ ...(gateNotApprovable as QueryResult), truncated: true } as QueryResult)],
	])("prefills nothing when the not-approvable query %s (a Stakeholder would slip in)", async (_, answer) => {
		const { client } = gateClient({
			query: async (sparql: string) => {
				if (sparql === NOT_APPROVABLE_QUERY) return answer();
				return gateApprovers as QueryResult;
			},
		});
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("alert")).toHaveTextContent(
			en["gate.approval.notApprovableFailed"].split("{{message}}")[0],
		);
		expect(within(approval).queryByRole("checkbox")).toBeNull();
		expect(within(approval).queryByRole("button", { name: en["gate.approval.approve"] })).toBeNull();
	});

	it("cannot approve once every element is unchecked", async () => {
		renderGate(gateClient().client);
		await chooseApprover(await screen.findByRole("region", { name: en["gate.approval.title"] }), "评审人");
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
		await chooseApprover(screen.getByRole("region", { name: en["gate.approval.title"] }), "评审人");
		const reject = screen.getByRole("button", { name: en["gate.approval.reject"] });
		await waitFor(() => expect(reject).toBeEnabled());
		await userEvent.click(reject);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0].decision).toBe("Rejected");
	});

	it("tells the user to refresh when the branch moved on (STALE_HEAD)", async () => {
		const e = staleHead as { code: string; message: string; hint?: string; retryable: boolean; details?: Record<string, unknown> };
		const { client, calls } = gateClient({
			recordApproval: (input: ApprovalInput) => (
				calls.approve.push(input), Promise.reject(new AisepToolError(e.code, e.message, e.retryable, e.hint, e.details))
			),
		});
		renderGate(client);
		await chooseApprover(await screen.findByRole("region", { name: en["gate.approval.title"] }), "评审人");
		const approve = await screen.findByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		expect(await screen.findByRole("alert")).toHaveTextContent(en["gate.approval.staleHead"]);
		// A failed write frees the buttons again, and a retry really sends a second call.
		expect(approve).toBeEnabled();
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(2));
	});

	it("shows the write in progress and sends one approval however fast the buttons are clicked", async () => {
		let finish: (result: ApprovalResult) => void = () => {};
		const { client, calls } = gateClient({
			recordApproval: (input: ApprovalInput) => (calls.approve.push(input), new Promise<ApprovalResult>((done) => (finish = done))),
		});
		renderGate(client);
		await chooseApprover(await screen.findByRole("region", { name: en["gate.approval.title"] }), "评审人");
		const approve = await screen.findByRole("button", { name: en["gate.approval.approve"] });
		const reject = screen.getByRole("button", { name: en["gate.approval.reject"] });
		await waitFor(() => expect(approve).toBeEnabled());
		// Several clicks in one task, before React re-renders the button as disabled.
		act(() => {
			fireEvent.click(approve);
			fireEvent.click(approve);
			fireEvent.click(reject);
		});
		const approval = screen.getByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("status")).toHaveTextContent(en["gate.approval.writing"]);
		expect(approve).toBeDisabled();
		expect(reject).toBeDisabled();
		fireEvent.click(approve);
		await new Promise((r) => setTimeout(r, 20));
		expect(calls.approve).toHaveLength(1);
		expect(calls.approve[0].decision).toBe("Approved");
		await act(async () => finish(gateApproval as ApprovalResult));
		expect(await within(approval).findByText(/^Recorded /)).toBeInTheDocument();
		expect(approve).toBeDisabled();
		expect(calls.approve).toHaveLength(1);
	});

	it.each([
		[
			"the branch tip is already an approval commit (M3: a second click on the new head wrote a second approval)",
			(ref: string) => progressRecords(ref, true),
			() => en["gate.approval.alreadyApproved"].replace("{{stage}}", en["gate.progress.stage.approved"]),
		],
		[
			"the approval progress cannot be read",
			() => Promise.reject(new Error("socket hang up")),
			() => en["gate.approval.progressUnknown"],
		],
	])("holds both buttons until the user confirms when %s", async (_, records, note) => {
		const { client, calls } = gateClient({
			query: async (sparql: string, target: { ref: string }) => {
				if (sparql === APPROVAL_RECORDS_QUERY) return records(target.ref);
				if (sparql === APPROVERS_QUERY) return gateApprovers as QueryResult;
				if (sparql === NOT_APPROVABLE_QUERY) return gateNotApprovable as QueryResult;
				if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
				throw new Error(`unexpected query ${sparql}`);
			},
		});
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("note")).toHaveTextContent(note());
		// Everything else is ready (approver loaded, gate PASS): only the missing confirmation keeps the buttons off.
		await chooseApprover(approval, "评审人");
		await screen.findByText(en["gate.check.pass"]);
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		const reject = within(approval).getByRole("button", { name: en["gate.approval.reject"] });
		expect(approve).toBeDisabled();
		expect(reject).toBeDisabled();
		fireEvent.click(approve);
		await userEvent.click(within(approval).getByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		expect(approve).toBeEnabled();
		expect(calls.approve).toHaveLength(0);
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
	});

	it("holds both buttons while the approval progress is still being read", async () => {
		let release: () => void = () => {};
		const read = new Promise<void>((done) => (release = done));
		const { client, calls } = gateClient({
			query: async (sparql: string, target: { ref: string }) => {
				if (sparql === APPROVAL_RECORDS_QUERY) return read.then(() => progressRecords(target.ref, false));
				if (sparql === APPROVERS_QUERY) return gateApprovers as QueryResult;
				if (sparql === NOT_APPROVABLE_QUERY) return gateNotApprovable as QueryResult;
				if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
				throw new Error(`unexpected query ${sparql}`);
			},
		});
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		// Everything else is ready (approver loaded, gate PASS): only the unread progress keeps the buttons off.
		await chooseApprover(approval, "评审人");
		await screen.findByText(en["gate.check.pass"]);
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		const reject = within(approval).getByRole("button", { name: en["gate.approval.reject"] });
		expect(approve).toBeDisabled();
		expect(reject).toBeDisabled();
		fireEvent.click(reject);
		fireEvent.click(approve);
		await new Promise((r) => setTimeout(r, 20));
		expect(calls.approve).toHaveLength(0);
		await act(async () => release());
		await waitFor(() => expect(reject).toBeEnabled());
		expect(approve).toBeEnabled();
	});

	it("asks again when the warning changes from 'progress unknown' to 'already approved'", async () => {
		let readable = false;
		const { client, calls } = gateClient({
			query: async (sparql: string, target: { ref: string }) => {
				if (sparql === APPROVAL_RECORDS_QUERY) {
					if (!readable) throw new Error("socket hang up");
					return progressRecords(target.ref, true);
				}
				if (sparql === APPROVERS_QUERY) return gateApprovers as QueryResult;
				if (sparql === NOT_APPROVABLE_QUERY) return gateNotApprovable as QueryResult;
				if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
				throw new Error(`unexpected query ${sparql}`);
			},
		});
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("note")).toHaveTextContent(en["gate.approval.progressUnknown"]);
		await chooseApprover(approval, "评审人");
		await screen.findByText(en["gate.check.pass"]);
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		await userEvent.click(within(approval).getByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		expect(approve).toBeEnabled();
		// The progress can be read now, and the tip turns out to be an approval commit already.
		readable = true;
		const progress = screen.getByRole("region", { name: en["gate.progress.title"] });
		await userEvent.click(within(progress).getByRole("button", { name: en["gate.progress.refresh"] }));
		expect(await within(approval).findByText(
			en["gate.approval.alreadyApproved"].replace("{{stage}}", en["gate.progress.stage.approved"]),
		)).toBeInTheDocument();
		expect(within(approval).getByRole("checkbox", { name: en["gate.approval.confirmRepeat"] })).not.toBeChecked();
		expect(approve).toBeDisabled();
		expect(within(approval).getByRole("button", { name: en["gate.approval.reject"] })).toBeDisabled();
		expect(calls.approve).toHaveLength(0);
	});

	it("still shows the running write after leaving the page and coming back, and does not send another", async () => {
		let finish: (result: ApprovalResult) => void = () => {};
		const { client, calls } = gateClient({
			recordApproval: (input: ApprovalInput) => (calls.approve.push(input), new Promise<ApprovalResult>((done) => (finish = done))),
		});
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const page = (
			<QueryClientProvider client={queryClient}>
				<AisepGatePage branch={BRANCH} client={client} />
			</QueryClientProvider>
		);
		const first = render(page);
		await chooseApprover(await screen.findByRole("region", { name: en["gate.approval.title"] }), "评审人");
		const approve = await screen.findByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		first.unmount();
		render(page);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByText(en["gate.approval.writing"])).toBeInTheDocument();
		const again = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		// The approvers and the gate have loaded: only the running write keeps the button off.
		await chooseApprover(approval, "评审人");
		expect(again).toBeDisabled();
		expect(within(approval).getByRole("button", { name: en["gate.approval.reject"] })).toBeDisabled();
		await act(async () => finish(gateApproval as ApprovalResult));
		expect(await within(approval).findByText(/^Recorded /)).toBeInTheDocument();
		expect(again).toBeDisabled();
		expect(calls.approve).toHaveLength(1);
	});

	it("shows the server's message when the diff fails", async () => {
		const { client } = gateClient({
			diff: () => Promise.reject(new AisepToolError("REF_NOT_FOUND", "找不到提交 feat/approve", false)),
		});
		renderGate(client);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("找不到提交 feat/approve");
		// Message (and hint) only, the same wording as the home page: no error code in front.
		expect(alert).not.toHaveTextContent("REF_NOT_FOUND");
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
		const notApprovable = new Set(iriColumn(gateNotApprovable as QueryResult, "element"));
		expect(notApprovable.has(`${M}reviewer`)).toBe(true);
		expect([...approvalCandidates({ ...diff, items }, new Set()).get("procurement") ?? []].map((i) => i.iri)).toContain(`${M}reviewer`);
		const byModel = approvalCandidates({ ...diff, items }, notApprovable);
		expect([...byModel.keys()]).toEqual(["procurement", "sales"]);
		expect(byModel.get("procurement")?.map((i) => i.iri)).toEqual([`${M}quotationLine`]);
	});

	// ADR-032 P1b exit ③ (R4-5): a view can never be approved on its own, so no view IRI is ever a candidate.
	it("never offers a view: not a changed one, an added one, nor one next to element changes", () => {
		const viewItem = (viewsDiff.items ?? [])[0];
		expect(viewItem.kind).toBe("view");
		const items = [
			...(diff.items ?? []),
			viewItem,
			{ ...viewItem, iri: `${M}view-new`, change: "added" as const, files: { base: [], head: ["models/procurement/views/new.ttl"] } },
		];
		const candidates = [...approvalCandidates({ ...diff, items }, new Set()).values()].flat().map((i) => i.iri);
		expect(candidates).toContain(`${M}quotationLine`);
		expect(candidates.filter((iri) => items.some((i) => i.kind === "view" && i.iri === iri))).toEqual([]);
		// A branch that only moves members in and out of a view (arch:inView, real model_diff output) offers nothing.
		expect(approvalCandidates(viewsDiff, new Set()).size).toBe(0);
	});
});

// ADR-032 P1b exit ③ on the page: a view change never reaches the approval form; a model Approved on main is offered
// as a whole (the view is looked at with its model), never the view.
describe("AisepGatePage on a branch that only changes a view's members", () => {
	const VIEW = `${M}view-quote-approval-app-usage`;

	it("lists view changes in their own group, says they are not approved alone, and links to the member comparison", async () => {
		const items = [...(diff.items ?? []), ...(viewsDiff.items ?? [])];
		renderGate(gateClient({ diff: async () => ({ ...diff, items }) }).client);
		const changes = await screen.findByRole("region", { name: en["gate.diff.title"] });
		const group = within(changes).getByRole("region", { name: en["gate.views.title"].replace("{{count}}", "1") });
		expect(within(group).getByRole("note")).toHaveTextContent(en["gate.views.note"]);
		const row = within(group).getByText("报价审批的应用使用").closest("tr") as HTMLElement;
		expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual([
			en["gate.change.modified"], "报价审批的应用使用", "procurement", en["gate.views.compare"],
		]);
		const href = within(row).getByRole("link", { name: en["gate.views.compare"] }).getAttribute("href") ?? "";
		expect(href.startsWith("#/aisep/views/compare?")).toBe(true);
		expect(Object.fromEntries(new URLSearchParams(href.slice(href.indexOf("?") + 1)))).toEqual({
			view: VIEW, base: diff.base.commit, head, branch: BRANCH,
		});
		// The element table above no longer carries the view row.
		const tables = within(changes).getAllByRole("table");
		expect(within(tables[0]).queryByText("报价审批的应用使用")).toBeNull();
		expect(within(tables[0]).getByText("报价行")).toBeInTheDocument();
	});

	it("shows only the view group when the branch changes nothing else", async () => {
		renderGate(gateClient({ diff: async () => viewsDiff }).client);
		const changes = await screen.findByRole("region", { name: en["gate.diff.title"] });
		expect(within(changes).getAllByRole("table")).toHaveLength(1);
		expect(within(changes).queryByText(en["gate.diff.empty"])).toBeNull();
		expect(within(changes).getByRole("region", { name: en["gate.views.title"].replace("{{count}}", "1") })).toBeInTheDocument();
	});

	it("offers nothing to approve when the model is not Approved on main", async () => {
		const { client, calls } = gateClient({ diff: async () => viewsDiff });
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await waitFor(() => expect(calls.query.length).toBeGreaterThanOrEqual(3));
		expect(within(approval).queryByRole("checkbox")).toBeNull();
		expect(within(approval).queryByTitle(VIEW)).toBeNull();
	});

	it("offers the whole model, never the view, when the model is Approved on main", async () => {
		const { client, calls } = approvedOnMainClient([M], viewsDiff);
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		const whole = await within(approval).findByRole("checkbox", { name: en["gate.approval.wholeModel"].replace("{{model}}", "procurement") });
		expect(whole).toBeChecked();
		expect(within(approval).getAllByRole("checkbox")).toHaveLength(1);
		expect(within(approval).queryByTitle(VIEW)).toBeNull();
		await chooseApprover(approval, "评审人");
		const approve = screen.getByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0].approves).toEqual([M]);
	});
});

vi.setConfig({ testTimeout: 15_000 });

// Repeat approval guard (aisep models/workbench: acNoRepeatSameSelection, acOtherGateOrRejectAllowed,
// acCoverageUnknownConfirm). The page pinned `head`; history[k] is the record set at `${head}~${k}` (what a reload sees
// after earlier approvals made the head an approval commit), `approves` answers APPROVAL_COVERAGE_QUERY on `head`. The
// branch-ref progress reads as "approved" (the tip is an approval commit), as it does on a real reload.
const AISEP = "https://aisep.example/ont/aisep#";
const ARCH_RECORD = `${M}approval-20261121000001-architecture-1eb5dbc`;
const DESIGN_RECORD = `${M}approval-20261121000002-design-aaaaaaa`;
const QUOTATION_LINE = `${M}quotationLine`;
function guardClient(
	history: Record<string, string>[],
	approves: Record<string, [gate: string, elements: string[]]>,
) {
	const zero = { added: 0, modified: 0, removed: 0 };
	return gateClient({
		// The coverage walk diffs each commit against its parent (base given); history commits only add records here.
		diff: async (input: { base?: string }) =>
			input.base === undefined
				? diff
				: ({
						counts: { element: zero, relationship: zero, view: zero, governance: { ...zero, added: 1 }, schema: zero, other: zero },
					} as unknown as DiffResult),
		query: async (sparql: string, target: { ref: string }) => {
			if (sparql === APPROVERS_QUERY) return gateApprovers as QueryResult;
			if (sparql === NOT_APPROVABLE_QUERY) return gateNotApprovable as QueryResult;
			if (sparql === APPROVAL_COVERAGE_QUERY) {
				return {
					kind: "select",
					variables: ["record", "gate", "element"],
					truncated: false,
					rows: Object.entries(approves).flatMap(([record, [gate, elements]]) =>
						elements.map((element) => ({
							record: { type: "iri" as const, value: record },
							gate: { type: "iri" as const, value: `${AISEP}${gate}` },
							element: { type: "iri" as const, value: element },
						})),
					),
				};
			}
			if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
			if (sparql !== APPROVAL_RECORDS_QUERY) throw new Error(`unexpected query ${sparql}`);
			if (!target.ref.startsWith(`${head}~`)) return progressRecords(target.ref, true);
			const m = target.ref.slice(head.length).match(/^~(\d+)(\^2)?$/);
			const records = m && !m[2] ? history[Number(m[1])] : undefined;
			if (!records) throw new AisepToolError("REF_NOT_FOUND", `找不到提交 ${target.ref}`, false);
			const rows = Object.entries(records).map(([record, decision]) => ({
				record: { type: "iri" as const, value: record },
				decision: { type: "iri" as const, value: decision },
			}));
			return { kind: "select", variables: ["record", "decision"], rows, truncated: false } as QueryResult;
		},
	});
}
const APPROVED = DECISION_APPROVED;
/** The head is the Architecture approval of quotationLine, on top of the content commit. */
const approvedOnce = (): Record<string, string>[] => [{ [ARCH_RECORD]: APPROVED }, {}];

async function readyApproval() {
	const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
	await chooseApprover(approval, "评审人");
	await screen.findByText(en["gate.check.pass"]);
	return {
		approval,
		approve: within(approval).getByRole("button", { name: en["gate.approval.approve"] }),
		reject: within(approval).getByRole("button", { name: en["gate.approval.reject"] }),
	};
}

async function chooseGate(approval: HTMLElement, gate: string) {
	await userEvent.click(within(approval).getByRole("combobox", { name: en["gate.approval.gate"] }));
	await userEvent.click(await screen.findByRole("option", { name: gate }));
}

describe("repeat approval guard: same selection", () => {
	it("keeps Approve off after a reload when the same gate and elements are already approved, even after confirming", async () => {
		const { client, calls } = guardClient(approvedOnce(), { [ARCH_RECORD]: ["GateArchitecture", [QUOTATION_LINE]] });
		renderGate(client);
		const { approval, approve } = await readyApproval();
		expect(await within(approval).findByText(en["gate.approval.alreadyCovered"].replace("{{records}}", ARCH_RECORD.slice(M.length)))).toBeInTheDocument();
		await userEvent.click(within(approval).getByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		expect(approve).toBeDisabled();
		fireEvent.click(approve);
		await new Promise((r) => setTimeout(r, 20));
		expect(calls.approve).toHaveLength(0);
	});

	it("keeps Approve off for Architecture after Architecture then Design were approved (not only the tip's record)", async () => {
		const { client, calls } = guardClient(
			[{ [ARCH_RECORD]: APPROVED, [DESIGN_RECORD]: APPROVED }, { [ARCH_RECORD]: APPROVED }, {}],
			{ [ARCH_RECORD]: ["GateArchitecture", [QUOTATION_LINE]], [DESIGN_RECORD]: ["GateDesign", [QUOTATION_LINE]] },
		);
		renderGate(client);
		const { approval, approve } = await readyApproval();
		expect(await within(approval).findByText(en["gate.approval.alreadyCovered"].replace("{{records}}", ARCH_RECORD.slice(M.length)))).toBeInTheDocument();
		await userEvent.click(within(approval).getByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		expect(approve).toBeDisabled();
		expect(calls.approve).toHaveLength(0);
	});

	it("names only the records that cover the current selection, not every Approved record of the gate", async () => {
		const OTHER_RECORD = `${M}approval-20261121000003-architecture-bbbbbbb`;
		const { client } = guardClient(
			[{ [ARCH_RECORD]: APPROVED, [OTHER_RECORD]: APPROVED }, { [ARCH_RECORD]: APPROVED }, {}],
			{ [ARCH_RECORD]: ["GateArchitecture", [QUOTATION_LINE]], [OTHER_RECORD]: ["GateArchitecture", [`${M}somethingElse`]] },
		);
		renderGate(client);
		const { approval, approve } = await readyApproval();
		expect(await within(approval).findByText(en["gate.approval.alreadyCovered"].replace("{{records}}", ARCH_RECORD.slice(M.length)))).toBeInTheDocument();
		expect(within(approval).queryByText(new RegExp(OTHER_RECORD.slice(M.length)))).toBeNull();
		expect(approve).toBeDisabled();
	});
});

describe("repeat approval guard: other gate or reject", () => {
	it("approves another gate after the confirmation", async () => {
		const { client, calls } = guardClient(approvedOnce(), { [ARCH_RECORD]: ["GateArchitecture", [QUOTATION_LINE]] });
		renderGate(client);
		const { approval, approve } = await readyApproval();
		await within(approval).findByText(en["gate.approval.alreadyCovered"].replace("{{records}}", ARCH_RECORD.slice(M.length)));
		await chooseGate(approval, en["gate.gates.GateDesign"]);
		expect(within(approval).queryByText(/^This branch already approved/)).toBeNull();
		await userEvent.click(within(approval).getByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0]).toMatchObject({ gate: "GateDesign", decision: "Approved", approves: [QUOTATION_LINE] });
	});

	it("rejects the same selection after the confirmation", async () => {
		const { client, calls } = guardClient(approvedOnce(), { [ARCH_RECORD]: ["GateArchitecture", [QUOTATION_LINE]] });
		renderGate(client);
		const { approval, approve, reject } = await readyApproval();
		await within(approval).findByText(en["gate.approval.alreadyCovered"].replace("{{records}}", ARCH_RECORD.slice(M.length)));
		await userEvent.click(within(approval).getByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		expect(approve).toBeDisabled();
		await waitFor(() => expect(reject).toBeEnabled());
		await userEvent.click(reject);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0]).toMatchObject({ gate: "GateArchitecture", decision: "Rejected" });
	});

	it("approves elements the earlier record did not approve, after the confirmation", async () => {
		const { client, calls } = guardClient(approvedOnce(), { [ARCH_RECORD]: ["GateArchitecture", [`${M}somethingElse`]] });
		renderGate(client);
		const { approval, approve } = await readyApproval();
		await userEvent.click(await within(approval).findByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		await waitFor(() => expect(approve).toBeEnabled());
		expect(within(approval).queryByText(/^This branch already approved/)).toBeNull();
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
	});

	it("approves again once a content commit follows the earlier approval (that approval no longer counts)", async () => {
		const { client, calls } = guardClient([{ [ARCH_RECORD]: APPROVED }, { [ARCH_RECORD]: APPROVED }, {}], {
			[ARCH_RECORD]: ["GateArchitecture", [QUOTATION_LINE]],
		});
		renderGate(client);
		const { approval, approve } = await readyApproval();
		await userEvent.click(await within(approval).findByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		await waitFor(() => expect(approve).toBeEnabled());
		expect(within(approval).queryByText(/^This branch already approved/)).toBeNull();
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
	});
});

describe("repeat approval guard: coverage unknown", () => {
	it("falls back to the confirmation when the approval records cannot be read", async () => {
		const { client, calls } = gateClient({
			query: async (sparql: string, target: { ref: string }) => {
				if (sparql === APPROVERS_QUERY) return gateApprovers as QueryResult;
				if (sparql === NOT_APPROVABLE_QUERY) return gateNotApprovable as QueryResult;
				// The branch progress reads fine (pending); only the walk from the pinned head fails.
				if (sparql === APPROVAL_RECORDS_QUERY && !target.ref.startsWith(`${head}~`)) return progressRecords(target.ref, false);
				if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
				throw new Error("socket hang up");
			},
		});
		renderGate(client);
		const { approval, approve, reject } = await readyApproval();
		// The progress itself was read: the note names what is actually unknown, not the progress.
		expect(await within(approval).findByRole("note")).toHaveTextContent(en["gate.approval.coverageUnknown"]);
		expect(within(approval).queryByText(en["gate.approval.progressUnknown"])).toBeNull();
		expect(approve).toBeDisabled();
		expect(reject).toBeDisabled();
		await userEvent.click(within(approval).getByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		expect(approve).toBeEnabled();
		expect(reject).toBeEnabled();
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
	});

	it("falls back to the confirmation when the model diff of a walked commit fails", async () => {
		const { client, calls } = guardClient(approvedOnce(), { [ARCH_RECORD]: ["GateArchitecture", [QUOTATION_LINE]] });
		const pageDiff = client.diff;
		const guardQuery = client.query;
		// The branch progress reads fine and is pending, so only the coverage is unknown.
		client.query = async (sparql, target, options) =>
			sparql === APPROVAL_RECORDS_QUERY && target?.ref !== undefined && !target.ref.startsWith(`${head}~`)
				? progressRecords(target.ref, false)
				: guardQuery(sparql, target, options);
		const walked: unknown[] = [];
		client.diff = async (input, options) => {
			if (input.base === undefined) return pageDiff(input, options);
			walked.push(input);
			throw new AisepToolError("INTERNAL", "model_diff failed", false);
		};
		renderGate(client);
		const { approval, approve, reject } = await readyApproval();
		expect(await within(approval).findByRole("note")).toHaveTextContent(en["gate.approval.coverageUnknown"]);
		expect(walked).not.toHaveLength(0);
		// Unknown is not covered: no "already approved this selection" lock, only the confirmation.
		expect(within(approval).queryByText(/^This branch already approved/)).toBeNull();
		expect(approve).toBeDisabled();
		expect(reject).toBeDisabled();
		await userEvent.click(within(approval).getByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		expect(approve).toBeEnabled();
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
	});
});

// Approver choices (aisep models/workbench: the #68 approval was signed by procurement:chiefArchitect, a Stakeholder of
// another model): only the approved model's own Stakeholders are offered; the only one is chosen for the user, of two or
// more none is.
const WB_LEAD = {
	approver: { type: "iri" as const, value: "https://aisep.example/model/workbench/projectLead" },
	prefLabel: { type: "literal" as const, value: "项目负责人", lang: "zh" },
	model: { type: "iri" as const, value: "https://aisep.example/model/workbench/" },
};
function approversClient(rows: unknown[]) {
	const answer = { ...(gateApprovers as QueryResult & { kind: "select" }), rows } as QueryResult;
	return gateClient({
		query: async (sparql: string, target: { ref: string }) => {
			if (sparql === APPROVAL_RECORDS_QUERY) return progressRecords(target.ref, false);
			if (sparql === APPROVERS_QUERY) return answer;
			if (sparql === NOT_APPROVABLE_QUERY) return gateNotApprovable as QueryResult;
			if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
			throw new Error(`unexpected query ${sparql}`);
		},
	});
}
const procurementApprovers = (gateApprovers as QueryResult & { kind: "select" }).rows;
const WB_REVIEWER = {
	...WB_LEAD,
	approver: { type: "iri" as const, value: "https://aisep.example/model/workbench/reviewer" },
	prefLabel: { type: "literal" as const, value: "工作台评审人", lang: "zh" },
};
// The branch changes an element of each model: the model picker appears.
function twoModelClient(rows: unknown[]) {
	const WB_ITEM = {
		...diff.items![0],
		iri: "https://aisep.example/model/workbench/gatePage",
		label: undefined,
		files: { base: [], head: ["models/workbench/elements.ttl"] },
	};
	const twoModels = { ...diff, items: [...(diff.items ?? []), WB_ITEM] } as DiffResult;
	const { client } = approversClient(rows);
	client.diff = async () => twoModels;
	return client;
}

describe("approver choices", () => {
	it("offers only the Stakeholders of the model being approved", async () => {
		renderGate(approversClient([...procurementApprovers, WB_LEAD]).client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await userEvent.click(await within(approval).findByRole("combobox", { name: en["gate.approval.approver"] }));
		const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
		expect(options).toEqual(["评审人", "首席架构师"]);
	});

	it("says so instead of showing an empty list when the model has no Stakeholder", async () => {
		renderGate(approversClient([WB_LEAD]).client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByText(en["gate.approval.noApprovers"])).toBeInTheDocument();
		expect(within(approval).queryByRole("combobox", { name: en["gate.approval.approver"] })).toBeNull();
		expect(within(approval).getByRole("button", { name: en["gate.approval.approve"] })).toBeDisabled();
	});

	it("chooses no approver for the user: nothing can be sent until one is picked", async () => {
		const { client, calls } = approversClient([...procurementApprovers, WB_LEAD]);
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		const picker = await within(approval).findByRole("combobox", { name: en["gate.approval.approver"] });
		await screen.findByText(en["gate.check.pass"]);
		expect(picker).toHaveTextContent(en["gate.approval.approverPlaceholder"]);
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		const reject = within(approval).getByRole("button", { name: en["gate.approval.reject"] });
		expect(approve).toBeDisabled();
		expect(reject).toBeDisabled();
		fireEvent.click(approve);
		await new Promise((r) => setTimeout(r, 20));
		expect(calls.approve).toHaveLength(0);
		await chooseApprover(approval, "首席架构师");
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0].approvedBy).toBe("https://aisep.example/model/procurement/chiefArchitect");
	});

	it("shows the placeholder again, not a blank picker, after switching to a model with two Stakeholders", async () => {
		renderGate(twoModelClient([...procurementApprovers, WB_LEAD, WB_REVIEWER]));
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await chooseApprover(approval, "首席架构师");
		const picker = within(approval).getByRole("combobox", { name: en["gate.approval.approver"] });
		expect(picker).toHaveTextContent("首席架构师");
		await userEvent.click(within(approval).getByRole("combobox", { name: en["gate.approval.model"] }));
		await userEvent.click(await screen.findByRole("option", { name: "workbench" }));
		await waitFor(() =>
			expect(within(approval).getByRole("combobox", { name: en["gate.approval.approver"] })).toHaveTextContent(
				en["gate.approval.approverPlaceholder"],
			),
		);
		expect(within(approval).getByRole("button", { name: en["gate.approval.approve"] })).toBeDisabled();
	});

	// aisep models/workbench :acSingleApproverPreselected
	it("chooses the only Stakeholder of the model being approved for the user", async () => {
		const { client, calls } = approversClient([procurementApprovers[0], WB_LEAD]);
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await screen.findByText(en["gate.check.pass"]);
		expect(await within(approval).findByRole("combobox", { name: en["gate.approval.approver"] })).toHaveTextContent("评审人");
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0].approvedBy).toBe(procurementApprovers[0].approver.value);
	});

	// With the approver chosen for the user, a failing gate is all that keeps Approve off.
	it("still only offers Reject when the gate fails and the only Stakeholder is chosen", async () => {
		const { client, calls } = approversClient([procurementApprovers[0]]);
		client.gate = async () => gateFail as GateResult;
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await screen.findByText(en["gate.approval.gateFailed"])).toBeInTheDocument();
		expect(within(approval).getByRole("combobox", { name: en["gate.approval.approver"] })).toHaveTextContent("评审人");
		const reject = within(approval).getByRole("button", { name: en["gate.approval.reject"] });
		await waitFor(() => expect(reject).toBeEnabled());
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		expect(approve).toBeDisabled();
		fireEvent.click(approve);
		await new Promise((r) => setTimeout(r, 20));
		expect(calls.approve).toHaveLength(0);
	});

	// aisep models/workbench :acApproversUnreadable
	it("offers no approver and no decision when the Stakeholders cannot be read", async () => {
		let asked = 0;
		const { client, calls } = gateClient({
			query: async (sparql: string, target: { ref: string }) => {
				if (sparql === APPROVAL_RECORDS_QUERY) return progressRecords(target.ref, false);
				if (sparql === APPROVERS_QUERY) {
					asked++;
					throw new Error("approvers unreadable");
				}
				if (sparql === NOT_APPROVABLE_QUERY) return gateNotApprovable as QueryResult;
				if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
				throw new Error(`unexpected query ${sparql}`);
			},
		});
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await screen.findByText(en["gate.check.pass"]);
		await waitFor(() => expect(asked).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 20));
		expect(within(approval).queryByRole("combobox", { name: en["gate.approval.approver"] })).toBeNull();
		expect(within(approval).queryByText(en["gate.approval.noApprovers"])).toBeNull();
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		const reject = within(approval).getByRole("button", { name: en["gate.approval.reject"] });
		expect(approve).toBeDisabled();
		expect(reject).toBeDisabled();
		fireEvent.click(approve);
		fireEvent.click(reject);
		await new Promise((r) => setTimeout(r, 20));
		expect(calls.approve).toHaveLength(0);
	});

	// aisep models/workbench :acNoAIAgentApprover (aisep #84): the real APPROVERS_QUERY, run on the same engine as the server
	// (oxigraph = pyoxigraph 0.5.13), drops a Stakeholder that is an aisep:AIAgent, directly or through a subclass.
	it("never offers an AI agent as approver: the approvers query itself leaves it out", async () => {
		const store = new OxStore();
		store.load(
			`@prefix arch: <https://meta.linked.archi/core#> .
			@prefix aisep: <https://aisep.example/ont/aisep#> .
			@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
			@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
			@prefix p: <https://aisep.example/model/procurement/> .
			p:CodeBot rdfs:subClassOf aisep:AIAgent .
			p:reviewer a arch:Stakeholder ; skos:prefLabel "评审人"@zh ; arch:inModel <https://aisep.example/model/procurement/> .
			p:chiefArchitect a arch:Stakeholder ; skos:prefLabel "首席架构师"@zh ; arch:inModel <https://aisep.example/model/procurement/> .
			p:aiReviewer a arch:Stakeholder , aisep:AIAgent ; skos:prefLabel "AI 评审代理"@zh ; arch:inModel <https://aisep.example/model/procurement/> .
			p:codeBot a arch:Stakeholder , p:CodeBot ; skos:prefLabel "代码机器人"@zh ; arch:inModel <https://aisep.example/model/procurement/> .`,
			{ format: "text/turtle" },
		);
		// The server runs queries with its prefix table (aisep core.NS: arch, skos, ...) and the default graph as the union of
		// all graphs; oxigraph's JS binding takes no prefix table, so the two the query relies on are declared up front.
		const serverPrefixes = "PREFIX arch: <https://meta.linked.archi/core#>\nPREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n";
		const bindings = store.query(serverPrefixes + APPROVERS_QUERY, { use_default_graph_as_union: true }) as Map<
			string,
			{ termType: string; value: string; language?: string }
		>[];
		const rows = bindings.map((b) =>
			Object.fromEntries(
				[...b.entries()].map(([name, term]) => [
					name,
					term.termType === "NamedNode"
						? { type: "iri" as const, value: term.value }
						: { type: "literal" as const, value: term.value, ...(term.language ? { lang: term.language } : {}) },
				]),
			),
		);
		expect(rows.map((r) => r.prefLabel.value).sort()).toEqual(["评审人", "首席架构师"].sort());
		renderGate(approversClient(rows).client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await userEvent.click(await within(approval).findByRole("combobox", { name: en["gate.approval.approver"] }));
		// SELECT has no ORDER BY: compare as sets.
		const options = (await screen.findAllByRole("option")).map((o) => o.textContent ?? "");
		expect(options.sort()).toEqual(["评审人", "首席架构师"].sort());
	});

	it("chooses the only Stakeholder of the model switched to, not the one chosen before", async () => {
		renderGate(twoModelClient([...procurementApprovers, WB_LEAD]));
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await chooseApprover(approval, "首席架构师");
		await userEvent.click(within(approval).getByRole("combobox", { name: en["gate.approval.model"] }));
		await userEvent.click(await screen.findByRole("option", { name: "workbench" }));
		await waitFor(() =>
			expect(within(approval).getByRole("combobox", { name: en["gate.approval.approver"] })).toHaveTextContent("项目负责人"),
		);
	});
});

async function chooseApprover(approval: HTMLElement, name: string) {
	await userEvent.click(await within(approval).findByRole("combobox", { name: en["gate.approval.approver"] }));
	await userEvent.click(await screen.findByRole("option", { name }));
}

// A model Approved on main (e.g. by a release) needs re-approval as a whole when the branch changes it (aisep #95).
describe("AisepGatePage on a branch that changes a model Approved on main", () => {
	it("offers the whole model, checked, ahead of the elements, and reads main's approval state", async () => {
		const { client, calls } = approvedOnMainClient([M]);
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		const whole = await within(approval).findByRole("checkbox", { name: en["gate.approval.wholeModel"].replace("{{model}}", "procurement") });
		expect(whole).toBeChecked();
		expect(calls.query).toContainEqual([APPROVED_MODELS_QUERY, { ref: diff.base.mainRef ?? "refs/remotes/origin/main" }]);
		await chooseApprover(approval, "评审人");
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0].approves).toEqual([M, `${M}quotationLine`]);
	});

	it("leaves the whole model out when the user unchecks it", async () => {
		const { client, calls } = approvedOnMainClient([M]);
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await userEvent.click(await within(approval).findByRole("checkbox", { name: en["gate.approval.wholeModel"].replace("{{model}}", "procurement") }));
		await chooseApprover(approval, "评审人");
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0].approves).toEqual([`${M}quotationLine`]);
	});

	it("offers the model even when the branch changes only its relationships", async () => {
		const onlyRelationships: DiffResult = {
			...diff,
			items: [{ ...(diff.items ?? [])[0], iri: `${M}rel-a-assigned-b`, kind: "relationship", change: "added", files: { base: [], head: ["models/procurement/am4.ttl"] } }],
		};
		const { client, calls } = approvedOnMainClient([M], onlyRelationships);
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("checkbox", { name: en["gate.approval.wholeModel"].replace("{{model}}", "procurement") })).toBeChecked();
		await chooseApprover(approval, "评审人");
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0]).toMatchObject({ model: "procurement", approves: [M] });
	});

	it("does not offer the whole model when it is not Approved on main", async () => {
		renderGate(approvedOnMainClient(["https://aisep.example/model/sales/"]).client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("button", { name: en["gate.approval.approve"] })).toBeInTheDocument();
		expect(within(approval).queryByText(en["gate.approval.wholeModel"].split("{{")[0], { exact: false })).toBeNull();
	});

	it("cannot approve until main's approval state is read", async () => {
		const made = gateClient();
		const query = made.client.query.bind(made.client);
		made.client.query = async (sparql, target, options) =>
			sparql === APPROVED_MODELS_QUERY ? new Promise<QueryResult>(() => {}) : query(sparql, target, options);
		renderGate(made.client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await chooseApprover(approval, "评审人");
		await new Promise((done) => setTimeout(done, 50));
		expect(within(approval).getByRole("button", { name: en["gate.approval.approve"] })).toBeDisabled();
		expect(within(approval).getByRole("button", { name: en["gate.approval.reject"] })).toBeDisabled();
	});

	it("says main's approval state could not be read and offers no approval, even for a relationship-only change", async () => {
		for (const changes of [diff, { ...diff, items: [{ ...(diff.items ?? [])[0], kind: "relationship" as const, files: { base: [], head: ["models/procurement/am4.ttl"] } }] }]) {
			const made = gateClient({ diff: async () => changes });
			const query = made.client.query.bind(made.client);
			made.client.query = async (sparql, target, options) => {
				if (sparql === APPROVED_MODELS_QUERY) throw new AisepToolError("QUERY_FAILED", "boom", false);
				return query(sparql, target, options);
			};
			renderGate(made.client);
			const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
			expect(await within(approval).findByRole("alert")).toHaveTextContent(en["gate.approval.approvedModelsFailed"].split("{{")[0]);
			expect(within(approval).queryByRole("button", { name: en["gate.approval.approve"] })).toBeNull();
			expect(within(approval).queryByText(en["gate.approval.none"])).toBeNull();
			cleanup();
		}
	});

	it("counts a model as changed by anything but its approval records", () => {
		const item = (diff.items ?? [])[0];
		const at = (file: string) => ({ ...item, files: { base: [], head: [file] } });
		expect([...changedModels({ ...diff, items: [at("models/workbench/governance/approval-x.ttl")] })]).toEqual([]);
		expect([...changedModels({ ...diff, items: [at("models/workbench/governance.ttl"), at("models/sales/am4.ttl")] })]).toEqual(["workbench", "sales"]);
		expect([...changedModels({ ...diff, items: [{ ...item, change: "removed", files: { base: ["models/sales/bpmn.ttl"], head: [] } }] })]).toEqual(["sales"]);
		// moved between models: both change; schema items are not model content
		expect([...changedModels({ ...diff, items: [{ ...item, files: { base: ["models/sales/am4.ttl"], head: ["models/workbench/am4.ttl"] } }] })].sort()).toEqual(["sales", "workbench"]);
		expect([...changedModels({ ...diff, items: [{ ...at("models/sales/am4.ttl"), kind: "schema" as const }] })]).toEqual([]);
	});
});

async function chooseModel(approval: HTMLElement, name: string) {
	await userEvent.click(await within(approval).findByRole("combobox", { name: en["gate.approval.model"] }));
	await userEvent.click(await screen.findByRole("option", { name }));
}

// Release approval branches (aisep models/workbench :reqApproveRelease): cut by the session from origin/main's tip R.
describe("AisepGatePage on a release approval branch", () => {
	const RELEASE = `approval/release-${head.slice(0, 7)}-20261125120000`;
	const OTHER = "0123456789abcdef0123456789abcdef01234567";

	function renderRelease(overrides: Partial<AisepModelClient> = {}, mainCommit: string = head) {
		const { client, calls } = gateClient({
			branches: async () => ({ branches: [], main: { ref: "refs/remotes/origin/main", commit: mainCommit } }),
			...overrides,
		});
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={queryClient}>
				<AisepGatePage branch={RELEASE} client={client} />
			</QueryClientProvider>,
		);
		return calls;
	}

	it("offers the release gate only and approves the whole model on R (acReleaseOnlyReleaseGate, acReleaseApproveRecorded)", async () => {
		const calls = renderRelease();
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await userEvent.click(await within(approval).findByRole("combobox", { name: en["gate.approval.gate"] }));
		expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([en["gate.gates.GateRelease"]]);
		await userEvent.keyboard("{Escape}");
		await chooseModel(approval, "procurement");
		await chooseApprover(approval, "评审人");
		expect(within(approval).queryByRole("checkbox")).toBeNull();
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0]).toEqual({
			model: "procurement",
			gate: "GateRelease",
			decision: "Approved",
			approvedBy: (gateApprovers as QueryResult & { rows: { approver: { value: string }; prefLabel: { value: string } }[] }).rows.find(
				(row) => row.prefLabel.value === "评审人",
			)?.approver.value,
			approves: [M],
			branch: RELEASE,
			headCommit: head,
			expectedBaseCommit: diff.base.commit,
		});
		expect(calls.approve[0]).not.toHaveProperty("activity");
	});

	it("preselects no model, even when only one has approvers, and names model and approver before approving (#93)", async () => {
		const calls = renderRelease();
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		const model = await within(approval).findByRole("combobox", { name: en["gate.approval.model"] });
		expect(model).toHaveTextContent(en["gate.approval.releaseModelPlaceholder"]);
		await userEvent.click(model);
		expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["procurement"]);
		await userEvent.keyboard("{Escape}");
		expect(within(approval).queryByRole("combobox", { name: en["gate.approval.approver"] })).toBeNull();
		expect(within(approval).queryByText(en["gate.approval.noApprovers"])).toBeNull();
		expect(within(approval).queryByText(en["gate.approval.releaseApproves"].split("{{")[0], { exact: false })).toBeNull();
		await new Promise((done) => setTimeout(done, 50));
		expect(within(approval).getByRole("button", { name: en["gate.approval.approve"] })).toBeDisabled();
		expect(within(approval).getByRole("button", { name: en["gate.approval.reject"] })).toBeDisabled();
		await chooseModel(approval, "procurement");
		await chooseApprover(approval, "评审人");
		expect(
			within(approval).getByText(
				en["gate.approval.releaseApproves"].replace("{{model}}", "procurement").replace("{{approver}}", "评审人"),
			),
		).toBeInTheDocument();
		await waitFor(() => expect(within(approval).getByRole("button", { name: en["gate.approval.approve"] })).toBeEnabled());
		expect(calls.approve).toHaveLength(0);
	});

	it("names the single approver it fills in once the person picks the model (#93, reqSingleApproverPreselect)", async () => {
		const one: QueryResult = {
			kind: "select", variables: ["approver", "prefLabel", "model"], truncated: false,
			rows: [{ approver: { type: "iri", value: `${M}chiefArchitect` }, prefLabel: { type: "literal", value: "首席架构师" }, model: { type: "iri", value: M } }],
		};
		renderRelease({
			query: async (sparql: string) => {
				if (sparql === APPROVERS_QUERY) return one;
				if (sparql === APPROVAL_RECORDS_QUERY) return { kind: "select", variables: ["record", "decision"], rows: [], truncated: false };
				if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
				throw new Error(`unexpected query ${sparql}`);
			},
		});
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(within(approval).queryByText(en["gate.approval.releaseApproves"].split("{{")[0], { exact: false })).toBeNull();
		await chooseModel(approval, "procurement");
		expect(
			await within(approval).findByText(
				en["gate.approval.releaseApproves"].replace("{{model}}", "procurement").replace("{{approver}}", "首席架构师"),
			),
		).toBeInTheDocument();
	});

	it("rejects a release as a GateRelease record on R (acRejectReleaseRecorded)", async () => {
		const calls = renderRelease();
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await chooseModel(approval, "procurement");
		await chooseApprover(approval, "评审人");
		const reject = within(approval).getByRole("button", { name: en["gate.approval.reject"] });
		await waitFor(() => expect(reject).toBeEnabled());
		await userEvent.click(reject);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0]).toEqual({
			model: "procurement",
			gate: "GateRelease",
			decision: "Rejected",
			approvedBy: (gateApprovers as QueryResult & { rows: { approver: { value: string }; prefLabel: { value: string } }[] }).rows.find(
				(row) => row.prefLabel.value === "评审人",
			)?.approver.value,
			approves: [M],
			branch: RELEASE,
			headCommit: head,
			expectedBaseCommit: diff.base.commit,
		});
		expect(calls.approve[0]).not.toHaveProperty("activity");
	});

	it("can neither approve nor reject once origin/main moved past R (acReleaseStaleBlocks)", async () => {
		renderRelease({}, OTHER);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(
			await within(approval).findByText(
				en["gate.approval.releaseStale"].replace("{{commit}}", head.slice(0, 7)).replace("{{main}}", OTHER.slice(0, 7)),
			),
		).toBeInTheDocument();
		await chooseModel(approval, "procurement");
		await chooseApprover(approval, "评审人");
		expect(within(approval).getByRole("button", { name: en["gate.approval.approve"] })).toBeDisabled();
		expect(within(approval).getByRole("button", { name: en["gate.approval.reject"] })).toBeDisabled();
	});

	it("can neither approve nor reject while origin/main's tip cannot be read", async () => {
		renderRelease({
			branches: async () => {
				throw new AisepToolError("REF_NOT_FOUND", "no main", false);
			},
		});
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByText(en["gate.approval.releaseMainUnknown"])).toBeInTheDocument();
		await chooseModel(approval, "procurement");
		await chooseApprover(approval, "评审人");
		expect(within(approval).getByRole("button", { name: en["gate.approval.approve"] })).toBeDisabled();
		expect(within(approval).getByRole("button", { name: en["gate.approval.reject"] })).toBeDisabled();
	});

	it("can neither approve nor reject when the pinned head is not origin/main's tip, whatever the branch name says", async () => {
		// The name carries main's prefix but the head is another commit: a decided branch (its head is the approval
		// commit) or one cut elsewhere. The name only marks a release branch; the head itself is compared.
		const { client, calls } = gateClient({
			branches: async () => ({ branches: [], main: { ref: "refs/remotes/origin/main", commit: OTHER } }),
		});
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={queryClient}>
				<AisepGatePage branch={`approval/release-${OTHER.slice(0, 7)}-20261125120000`} client={client} />
			</QueryClientProvider>,
		);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(
			await within(approval).findByText(
				en["gate.approval.releaseHeadNotR"].replace("{{head}}", head.slice(0, 7)).replace("{{main}}", OTHER.slice(0, 7)),
			),
		).toBeInTheDocument();
		await chooseModel(approval, "procurement");
		await chooseApprover(approval, "评审人");
		expect(within(approval).getByRole("button", { name: en["gate.approval.approve"] })).toBeDisabled();
		expect(within(approval).getByRole("button", { name: en["gate.approval.reject"] })).toBeDisabled();
		expect(calls.approve).toHaveLength(0);
	});

	it("reads origin/main again right before writing and writes nothing if it moved meanwhile", async () => {
		let tip = head;
		const calls = renderRelease({
			branches: async () => ({ branches: [], main: { ref: "refs/remotes/origin/main", commit: tip } }),
		});
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await chooseModel(approval, "procurement");
		await chooseApprover(approval, "评审人");
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		tip = OTHER;
		await userEvent.click(approve);
		const stale = en["gate.approval.releaseStale"].replace("{{commit}}", head.slice(0, 7)).replace("{{main}}", OTHER.slice(0, 7));
		expect((await within(approval).findAllByText(stale, { exact: false })).length).toBeGreaterThan(0);
		expect(calls.approve).toHaveLength(0);
	});

	it("says the approvers could not be read instead of 'nothing to approve'", async () => {
		const { client } = gateClient({
			branches: async () => ({ branches: [], main: { ref: "refs/remotes/origin/main", commit: head } }),
		});
		const query = client.query.bind(client);
		client.query = async (sparql, target, options) => {
			if (sparql === APPROVERS_QUERY) throw new AisepToolError("QUERY_FAILED", "boom", false);
			return query(sparql, target, options);
		};
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={queryClient}>
				<AisepGatePage branch={RELEASE} client={client} />
			</QueryClientProvider>,
		);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("alert")).toHaveTextContent(en["gate.approval.releaseApproversFailed"].split("{{")[0]);
		expect(within(approval).queryByText(en["gate.approval.none"])).toBeNull();
		expect(within(approval).queryByRole("button", { name: en["gate.approval.approve"] })).toBeNull();
	});

	it("lets the user pick the model when several have approvers, and says none when no model has one", async () => {
		const W = "https://aisep.example/model/workbench/";
		const two: QueryResult = {
			kind: "select", variables: ["approver", "prefLabel", "model"], truncated: false,
			rows: [
				{ approver: { type: "iri", value: `${M}reviewer` }, prefLabel: { type: "literal", value: "评审人" }, model: { type: "iri", value: M } },
				{ approver: { type: "iri", value: `${W}projectLead` }, prefLabel: { type: "literal", value: "项目负责人" }, model: { type: "iri", value: W } },
			],
		};
		const calls = renderRelease({
			query: async (sparql: string) => {
				if (sparql === APPROVERS_QUERY) return two;
				if (sparql === APPROVAL_RECORDS_QUERY) return { kind: "select", variables: ["record", "decision"], rows: [], truncated: false };
				if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
				throw new Error(`unexpected query ${sparql}`);
			},
		});
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await userEvent.click(await within(approval).findByRole("combobox", { name: en["gate.approval.model"] }));
		await userEvent.click(await screen.findByRole("option", { name: "workbench" }));
		const approve = within(approval).getByRole("button", { name: en["gate.approval.approve"] });
		await waitFor(() => expect(approve).toBeEnabled());
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
		expect(calls.approve[0]).toMatchObject({ model: "workbench", approves: [W], approvedBy: `${W}projectLead` });
		cleanup();
		renderRelease({
			query: async (sparql: string) => {
				if (sparql === APPROVERS_QUERY) return { ...two, rows: [] };
				if (sparql === APPROVAL_RECORDS_QUERY) return { kind: "select", variables: ["record", "decision"], rows: [], truncated: false };
				if (sparql === APPROVED_MODELS_QUERY) return approvedModels([]);
				throw new Error(`unexpected query ${sparql}`);
			},
		});
		expect(await screen.findByText(en["gate.approval.none"])).toBeInTheDocument();
	});

	it("cannot approve a release whose gate fails (acReleaseGateFailBlocksApprove)", async () => {
		renderRelease({ gate: async () => gateFail as GateResult });
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		await chooseModel(approval, "procurement");
		await chooseApprover(approval, "评审人");
		expect(await within(approval).findByText(en["gate.approval.gateFailed"])).toBeInTheDocument();
		const reject = within(approval).getByRole("button", { name: en["gate.approval.reject"] });
		await waitFor(() => expect(reject).toBeEnabled());
		expect(within(approval).getByRole("button", { name: en["gate.approval.approve"] })).toBeDisabled();
	});
});
