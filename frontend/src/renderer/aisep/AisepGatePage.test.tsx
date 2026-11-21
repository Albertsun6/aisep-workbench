// The gate page (§8 step 5) on answers recorded from a real server (AisepGatePage.integration.test.tsx and
// data/mcp-client.integration.test.ts with AISEP_RECORD_FIXTURES=1).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../i18n";
import { APPROVERS_QUERY, AisepGatePage, NOT_APPROVABLE_QUERY, approvalCandidates } from "./AisepGatePage";
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
import gateFail from "./data/fixtures/gate-fail.json";
import gateNotApprovable from "./data/fixtures/gate-not-approvable.json";
import { aisepCatalogs } from "./i18n";

const en = aisepCatalogs.en;
const M = "https://aisep.example/model/procurement/";
const BRANCH = "feat/approve";
const diff = gateDiff as DiffResult;
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
			expect.arrayContaining([[APPROVERS_QUERY, { ref: head }], [NOT_APPROVABLE_QUERY, { ref: head, limit: 10_000 }]]),
		);
		expect(calls.query).toHaveLength(2);
		const progress = screen.getByRole("region", { name: en["gate.progress.title"] });
		expect(await within(progress).findByText(en["gate.progress.stage.pending"])).toHaveAttribute("aria-current", "step");
		expect(calls.progress).toEqual(
			expect.arrayContaining([`refs/heads/${BRANCH}`, `refs/heads/${BRANCH}^`, `refs/remotes/origin/${BRANCH}`]),
		);
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
		const { client, calls } = gateClient({
			recordApproval: (input: ApprovalInput) => (
				calls.approve.push(input), Promise.reject(new AisepToolError(e.code, e.message, e.retryable, e.hint, e.details))
			),
		});
		renderGate(client);
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
				throw new Error(`unexpected query ${sparql}`);
			},
		});
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("note")).toHaveTextContent(note());
		// Everything else is ready (approver loaded, gate PASS): only the missing confirmation keeps the buttons off.
		await within(approval).findByRole("combobox", { name: en["gate.approval.approver"] });
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
				throw new Error(`unexpected query ${sparql}`);
			},
		});
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		// Everything else is ready (approver loaded, gate PASS): only the unread progress keeps the buttons off.
		await within(approval).findByRole("combobox", { name: en["gate.approval.approver"] });
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
				throw new Error(`unexpected query ${sparql}`);
			},
		});
		renderGate(client);
		const approval = await screen.findByRole("region", { name: en["gate.approval.title"] });
		expect(await within(approval).findByRole("note")).toHaveTextContent(en["gate.approval.progressUnknown"]);
		await within(approval).findByRole("combobox", { name: en["gate.approval.approver"] });
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
		await within(approval).findByRole("combobox", { name: en["gate.approval.approver"] });
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
	return gateClient({
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
	await within(approval).findByRole("combobox", { name: en["gate.approval.approver"] });
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
				throw new Error("socket hang up");
			},
		});
		renderGate(client);
		const { approval, approve, reject } = await readyApproval();
		expect(await within(approval).findByRole("note")).toHaveTextContent(en["gate.approval.progressUnknown"]);
		expect(approve).toBeDisabled();
		expect(reject).toBeDisabled();
		await userEvent.click(within(approval).getByRole("checkbox", { name: en["gate.approval.confirmRepeat"] }));
		expect(approve).toBeEnabled();
		expect(reject).toBeEnabled();
		await userEvent.click(approve);
		await waitFor(() => expect(calls.approve).toHaveLength(1));
	});
});
