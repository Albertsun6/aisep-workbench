// Gate page (aisep docs/mcp-interface.md §8 step 5, §2 "关口页"): the branch's committed model changes against the
// main branch, the gate check on that same commit, and the one write the workbench does: record an approval.
import { useMutation, useMutationState, useQuery, useQueryClient, type MutationState } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Workflow } from "@/components/app-icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageTopbar, PageTopbarTitle } from "../components/PageTopbar";
import { APPROVAL_STAGE_TEXT, AisepApprovalProgress, aisepErrorMessage, approvalProgressKey } from "./AisepApprovalProgress";
import { DEFAULT_MAIN_REF, approvalCoverage, approvalProgress, coveringRecords, isCovered } from "./data/approval-progress";
import { modelClient } from "./AisepWorkbenchPage";
import {
	AisepToolError,
	QUERY_LIMIT_MAX,
	asSelect,
	iriColumn,
	type AisepModelClient,
	type ApprovalInput,
	type ApprovalResult,
	type Change,
	type DiffItem,
	type DiffKind,
	type DiffResult,
	type GateId,
	type Iri,
	type QueryResult,
} from "./data/client";
import { shouldRetryAisep } from "./data/mcp-client";
import { useAisepT, type AisepMessageKey } from "./i18n";

/** §5.9 approvedBy: an existing arch:Stakeholder that is not an aisep:AIAgent (AI cannot approve). */
export const APPROVERS_QUERY = `PREFIX aisep: <https://aisep.example/ont/aisep#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?approver ?prefLabel WHERE {
  ?approver a/rdfs:subClassOf* arch:Stakeholder ; skos:prefLabel ?prefLabel .
  FILTER NOT EXISTS { ?approver a/rdfs:subClassOf* aisep:AIAgent }
  FILTER(lang(?prefLabel) = "zh")
}`;

/**
 * §5.9 approves (R4-5): elements, models or ADRs, but never an approval record, an AI activity or a Stakeholder (nor
 * their subclasses). The diff's kind already drops relationships, views and governance records; this catches the
 * Stakeholders, which the diff counts as elements.
 */
export const NOT_APPROVABLE_QUERY = `PREFIX aisep: <https://aisep.example/ont/aisep#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?element WHERE {
  VALUES ?excluded { arch:Stakeholder aisep:ApprovalRecord aisep:AgentActivity arch:QualifiedRelationship }
  ?element arch:inModel ?model ; a/rdfs:subClassOf* ?excluded .
}`;

export interface Approver {
	iri: Iri;
	prefLabel: string;
}

export function approversFromRows(result: QueryResult): Approver[] {
	return asSelect(result).rows.map((row) => ({ iri: row.approver.value, prefLabel: row.prefLabel.value }));
}

/**
 * model_gate on a commit snapshot (§3.3) and record_approval (which runs the full gate again, §5.9 step 3) are the
 * slow calls: seconds on an idle machine, minutes on a loaded one. The default MCP timeout would cut them off.
 */
export const GATE_TIMEOUT_MS = 600_000;

/** A branch head is never on main, so GateRelease (mainline commits only, §5.9 step 1) is not offered here. */
export const BRANCH_GATES = ["GateRequirements", "GateArchitecture", "GateDesign", "GateMerge"] as const satisfies readonly GateId[];

/** "models/<slug>/…" -> slug. */
function modelSlug(file: string | undefined): string | undefined {
	return file?.match(/^models\/([^/]+)\//)?.[1];
}

/** §5.9 approves: prefilled with the diff's added and modified elements, grouped by the model whose files hold them. */
export function approvalCandidates(diff: DiffResult, notApprovable: ReadonlySet<Iri>): Map<string, DiffItem[]> {
	const byModel = new Map<string, DiffItem[]>();
	for (const item of diff.items ?? []) {
		if (item.kind !== "element" || item.change === "removed" || notApprovable.has(item.iri)) continue;
		const slug = modelSlug(item.files.head[0]);
		if (!slug) continue;
		byModel.set(slug, [...(byModel.get(slug) ?? []), item]);
	}
	return byModel;
}

/** The approval for exactly the commit the user saw (headCommit) and the base it was compared with. */
export function approvalInput(
	branch: string,
	diff: DiffResult,
	choice: { model: string; gate: GateId; decision: "Approved" | "Rejected"; approvedBy: Iri; approves: Iri[] },
): ApprovalInput {
	if (diff.head.kind !== "ref") throw new Error("a gate approves a commit, never a worktree (§5.8)");
	return { ...choice, branch, headCommit: diff.head.commit, expectedBaseCommit: diff.base.commit };
}

type Decision = "Approved" | "Rejected";

/**
 * One approval write per branch head. The key lives in the shared mutation cache, so a page that is left and entered
 * again while the write is still running (the server runs the whole gate first: tens of seconds) sees it and waits.
 */
export function approvalMutationKey(branch: string, commit: string) {
	return ["aisep", "approval", branch, commit] as const;
}

const CHANGE_TEXT: Record<Change, AisepMessageKey> = {
	added: "gate.change.added",
	modified: "gate.change.modified",
	removed: "gate.change.removed",
};
const CHANGE_CLASS: Record<Change, string> = {
	added: "text-success",
	modified: "text-warning",
	removed: "text-destructive",
};
const KIND_TEXT: Record<DiffKind, AisepMessageKey> = {
	element: "gate.kind.element",
	relationship: "gate.kind.relationship",
	view: "gate.kind.view",
	governance: "gate.kind.governance",
	schema: "gate.kind.schema",
	other: "gate.kind.other",
};
const GATE_TEXT: Record<(typeof BRANCH_GATES)[number], AisepMessageKey> = {
	GateRequirements: "gate.gates.GateRequirements",
	GateArchitecture: "gate.gates.GateArchitecture",
	GateDesign: "gate.gates.GateDesign",
	GateMerge: "gate.gates.GateMerge",
};

function localName(iri: Iri): string {
	return iri.slice(Math.max(iri.lastIndexOf("/"), iri.lastIndexOf("#")) + 1);
}

export function AisepGatePage({ branch, client = modelClient }: { branch: string; client?: AisepModelClient }) {
	const t = useAisepT();
	// Entered once (§2): resolving the branch here pins head.commit; gate and approval use that commit, not the branch.
	const diff = useQuery({
		queryKey: ["aisep", "gate", "diff", branch],
		queryFn: ({ signal }) => client.diff({ head: branch, detail: "items" }, { signal }),
		retry: shouldRetryAisep,
		// §2 "进入页面一次": every visit diffs the branch head again; nothing refetches while the page is open, so the
		// commit on screen stays the one being approved.
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const head = diff.data?.head.kind === "ref" ? diff.data.head.commit : undefined;

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<PageTopbar
				lead={
					<PageTopbarTitle as="h1" icon={<Workflow className="size-icon-md" aria-hidden="true" />}>
						{t("gate.title", { branch })}
					</PageTopbarTitle>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-3 pb-6">
					<a href="#/aisep" className={`${buttonVariants({ variant: "link" })} self-start text-xs`}>
						{t("gate.back")}
					</a>
					{diff.isLoading ? (
						<p role="status" className="text-xs text-muted-foreground">{t("section.loading")}</p>
					) : diff.isError ? (
						<p role="alert" className="text-xs text-destructive">{t("gate.error", { message: aisepErrorMessage(diff.error) })}</p>
					) : diff.data && head ? (
						<>
							<p className="font-mono text-caption text-muted-foreground">
								{t("gate.commits", { head: head.slice(0, 7), base: diff.data.base.commit.slice(0, 7) })}
							</p>
							<AisepApprovalProgress client={client} branch={branch} mainRef={diff.data.base.mainRef} />
							<DiffSection diff={diff.data} />
							<CheckSection client={client} commit={head} />
							<ApprovalSection client={client} branch={branch} diff={diff.data} commit={head} />
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}

function GateSection({ titleKey, children }: { titleKey: AisepMessageKey; children: React.ReactNode }) {
	const t = useAisepT();
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-2">
			<h2 id={headingId} className="text-control font-medium text-foreground">
				{t(titleKey)}
			</h2>
			{children}
		</section>
	);
}

function DiffSection({ diff }: { diff: DiffResult }) {
	const t = useAisepT();
	const items = diff.items ?? [];
	return (
		<GateSection titleKey="gate.diff.title">
			{diff.truncated ? <p role="note" className="text-caption text-warning">{t("section.truncated", { count: items.length })}</p> : null}
			{items.length === 0 ? (
				<p className="text-xs text-muted-foreground">{t("gate.diff.empty")}</p>
			) : (
				<Table className="text-xs">
					<TableHeader>
						<TableRow>
							<TableHead>{t("gate.diff.column.change")}</TableHead>
							<TableHead>{t("gate.diff.column.kind")}</TableHead>
							<TableHead>{t("gate.diff.column.name")}</TableHead>
							<TableHead>{t("gate.diff.column.endpoints")}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{items.map((item) => (
							<TableRow key={item.iri}>
								<TableCell className={CHANGE_CLASS[item.change]}>{t(CHANGE_TEXT[item.change])}</TableCell>
								<TableCell>{t(KIND_TEXT[item.kind])}</TableCell>
								<TableCell title={item.iri}>{item.label ?? localName(item.iri)}</TableCell>
								<TableCell>
									{item.source && item.target
										? `${item.source.label ?? localName(item.source.iri)} → ${item.target.label ?? localName(item.target.iri)}`
										: ""}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</GateSection>
	);
}

function CheckSection({ client, commit }: { client: AisepModelClient; commit: string }) {
	const t = useAisepT();
	const gate = useGateCheck(client, commit);
	return (
		<GateSection titleKey="gate.check.title">
			{gate.isLoading ? (
				<p role="status" className="text-xs text-muted-foreground">{t("section.loading")}</p>
			) : gate.isError ? (
				<p role="alert" className="text-xs text-destructive">{t("gate.error", { message: aisepErrorMessage(gate.error) })}</p>
			) : gate.data ? (
				<>
					<p className="text-xs">
						<span className={gate.data.result === "PASS" ? "font-medium text-success" : "font-medium text-destructive"}>
							{t(gate.data.result === "PASS" ? "gate.check.pass" : "gate.check.fail")}
						</span>{" "}
						<span className="tabular-nums text-muted-foreground">
							{t("gate.check.summary", {
								violations: gate.data.summary.violations,
								warnings: gate.data.summary.warnings,
								infos: gate.data.summary.infos,
							})}
						</span>
					</p>
					{gate.data.findings.length ? (
						<ul className="flex flex-col gap-1 text-xs">
							{gate.data.findings.map((finding, index) => (
								<li
									key={`${finding.focus}-${index}`}
									className={finding.severity === "Violation" ? "break-words text-destructive" : "break-words text-muted-foreground"}
								>
									[{finding.severity}] {finding.layer} {finding.message}
								</li>
							))}
						</ul>
					) : null}
				</>
			) : null}
		</GateSection>
	);
}

/** model_gate on the pinned commit (§2: `ref = head.commit`). */
function useGateCheck(client: AisepModelClient, commit: string) {
	return useQuery({
		queryKey: ["aisep", "gate", "check", commit],
		queryFn: ({ signal }) => client.gate({ ref: commit }, { signal, timeoutMs: GATE_TIMEOUT_MS }),
		retry: shouldRetryAisep,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
}

function ApprovalSection({
	client,
	branch,
	diff,
	commit,
}: {
	client: AisepModelClient;
	branch: string;
	diff: DiffResult;
	commit: string;
}) {
	const t = useAisepT();
	const queryClient = useQueryClient();
	const notApprovable = useQuery({
		queryKey: ["aisep", "gate", "not-approvable", commit],
		// The set only grows (every approval record and AI activity is in it): ask for the largest page (§5.6).
		queryFn: async ({ signal }) =>
			new Set(iriColumn(await client.query(NOT_APPROVABLE_QUERY, { ref: commit, limit: QUERY_LIMIT_MAX }, { signal }), "element")),
		retry: shouldRetryAisep,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	// Without the exclusion set there is no safe prefill (a Stakeholder would slip in): the form waits for it.
	const candidates = approvalCandidates(diff, notApprovable.data ?? new Set());
	const models = [...candidates.keys()];
	const gateCheck = useGateCheck(client, commit);
	const approvers = useQuery({
		queryKey: ["aisep", "gate", "approvers", commit],
		queryFn: async ({ signal }) => approversFromRows(await client.query(APPROVERS_QUERY, { ref: commit }, { signal })),
		retry: shouldRetryAisep,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	const [chosenModel, setModel] = useState<string>();
	const model = chosenModel !== undefined && models.includes(chosenModel) ? chosenModel : models[0];
	const [gate, setGate] = useState<GateId>("GateArchitecture");
	const [approver, setApprover] = useState<Iri | undefined>();
	const [unchecked, setUnchecked] = useState<ReadonlySet<Iri>>(new Set());
	// The branch tip may already be an approval commit (an approval written earlier, from this page or elsewhere): then
	// the head on screen is that commit, and approving it writes a second approval on top. Same query (and cache entry)
	// as the progress bar above (AisepApprovalProgress), which polls it.
	const mainRef = diff.base.mainRef ?? DEFAULT_MAIN_REF;
	const progress = useQuery({
		queryKey: [...approvalProgressKey(branch), mainRef],
		queryFn: ({ signal }) => approvalProgress(client, branch, mainRef, { signal }),
		retry: shouldRetryAisep,
	});
	// What the pinned head already approved (repeat approval guard): a reload after an approval pins the approval commit,
	// whose own diff still offers the same elements. Read on the pinned commit, not the branch: the head never moves here.
	const coverage = useQuery({
		queryKey: ["aisep", "gate", "coverage", commit],
		queryFn: ({ signal }) => approvalCoverage(client, commit, { signal }),
		retry: shouldRetryAisep,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	// Which warning the user confirmed: a confirmation of "progress unknown" does not carry over to "already approved".
	const [confirmedFor, setConfirmedFor] = useState<"approved" | "unknown">();
	useEffect(() => {
		if (approver === undefined && approvers.data?.length) setApprover(approvers.data[0].iri);
	}, [approver, approvers.data]);

	const items = model ? (candidates.get(model) ?? []) : [];
	const approves = items.map((item) => item.iri).filter((iri) => !unchecked.has(iri));
	const mutationKey = approvalMutationKey(branch, commit);
	// Set in the click handler itself: a second click before React re-renders the disabled button must not write again.
	const submitting = useRef(false);
	const record = useMutation({
		mutationKey,
		mutationFn: (decision: Decision) =>
			client.recordApproval(
				approvalInput(branch, diff, { model: model as string, gate, decision, approvedBy: approver as Iri, approves }),
				{ timeoutMs: GATE_TIMEOUT_MS },
			),
		// Main-branch rows stay Proposed until merge (§2); only the branch's own reads change: its changed-elements
		// count and its "approved on the branch, not merged" marks in the pending gates.
		// Only a failure frees the buttons again; a recorded decision is final for this head.
		onError: () => {
			submitting.current = false;
		},
		onSuccess: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: ["aisep", "diff"] }),
				queryClient.invalidateQueries({ queryKey: ["aisep", "approved-on-branch", branch] }),
				queryClient.invalidateQueries({ queryKey: approvalProgressKey(branch) }),
			]),
	});
	// Every write for this head in this app, including one started by an earlier visit of the page.
	const attempts = useMutationState({
		filters: { mutationKey, exact: true },
		select: (mutation) => mutation.state as MutationState<ApprovalResult, Error, Decision>,
	});
	const writing = attempts.some((state) => state.status === "pending");
	const recorded = attempts.find((state) => state.status === "success")?.data;
	const last = attempts.at(-1);
	const failure = !writing && !recorded && last?.status === "error" ? last.error : null;
	const submit = (decision: Decision) => {
		if (submitting.current || writing || recorded) return;
		submitting.current = true;
		record.mutate(decision);
	};

	if (notApprovable.isError) {
		return (
			<GateSection titleKey="gate.approval.title">
				<p role="alert" className="text-xs text-destructive">
					{t("gate.approval.notApprovableFailed", { message: aisepErrorMessage(notApprovable.error) })}
				</p>
			</GateSection>
		);
	}
	if (notApprovable.isLoading) {
		return (
			<GateSection titleKey="gate.approval.title">
				<p role="status" className="text-xs text-muted-foreground">{t("section.loading")}</p>
			</GateSection>
		);
	}
	if (models.length === 0) {
		return (
			<GateSection titleKey="gate.approval.title">
				<p className="text-xs text-muted-foreground">{t("gate.approval.none")}</p>
			</GateSection>
		);
	}
	const gateFailed = gateCheck.data?.result === "FAIL";
	// Already approved (tip adds Approved records), or unknown because the progress or what the head already approved
	// could not be read: ask first.
	const alreadyStage = progress.data && progress.data.stage !== "pending" ? progress.data.stage : undefined;
	const unknown = (progress.isError && !progress.data) || coverage.isError;
	const confirmReason = alreadyStage !== undefined ? "approved" : unknown ? "unknown" : undefined;
	// The same gate and elements are already approved on this head: approving again only writes a second record (the
	// server dedupes by head commit, and the head is now the approval commit). No confirmation lifts this; a rejection,
	// another gate or other elements still go through the confirmation above.
	const covered = !recorded && coverage.data !== undefined && isCovered(coverage.data, gate, approves);
	const needsConfirm = confirmReason !== undefined;
	const confirmedRepeat = confirmReason !== undefined && confirmedFor === confirmReason;
	const ready =
		approves.length > 0 &&
		approver !== undefined &&
		!writing &&
		!recorded &&
		(progress.data !== undefined || progress.isError) &&
		(coverage.data !== undefined || coverage.isError) &&
		(!needsConfirm || confirmedRepeat);
	return (
		<GateSection titleKey="gate.approval.title">
			<div className="flex flex-wrap items-end gap-3 text-xs">
				{models.length > 1 ? (
					<LabeledSelect label={t("gate.approval.model")} value={model} onValueChange={setModel}
						options={models.map((slug) => ({ value: slug, label: slug }))} />
				) : null}
				<LabeledSelect label={t("gate.approval.gate")} value={gate} onValueChange={(value) => setGate(value as GateId)}
					options={BRANCH_GATES.map((id) => ({ value: id, label: t(GATE_TEXT[id]) }))} />
				{approvers.data?.length ? (
					<LabeledSelect label={t("gate.approval.approver")} value={approver} onValueChange={setApprover}
						options={approvers.data.map((a) => ({ value: a.iri, label: a.prefLabel }))} />
				) : approvers.isSuccess ? (
					<p className="text-destructive">{t("gate.approval.noApprovers")}</p>
				) : null}
			</div>
			<fieldset className="flex flex-col gap-1 text-xs">
				<legend className="mb-1 text-muted-foreground">{t("gate.approval.approves")}</legend>
				{items.map((item) => (
					<label key={item.iri} className="flex items-center gap-2" title={item.iri}>
						<Checkbox
							checked={!unchecked.has(item.iri)}
							onCheckedChange={(checked) =>
								setUnchecked((prev) => {
									const next = new Set(prev);
									if (checked === true) next.delete(item.iri);
									else next.add(item.iri);
									return next;
								})
							}
						/>
						{item.label ?? localName(item.iri)}
					</label>
				))}
			</fieldset>
			{gateFailed ? <p className="text-xs text-destructive">{t("gate.approval.gateFailed")}</p> : null}
			{covered && coverage.data ? (
				<p role="note" className="text-xs text-warning">
					{t("gate.approval.alreadyCovered", { records: coveringRecords(coverage.data, gate).map(localName).join(", ") })}
				</p>
			) : null}
			{needsConfirm && !recorded ? (
				<div role="note" className="flex flex-col gap-1 text-xs text-warning">
					<p>
						{alreadyStage
							? t("gate.approval.alreadyApproved", { stage: t(APPROVAL_STAGE_TEXT[alreadyStage]) })
							: t("gate.approval.progressUnknown")}
					</p>
					<label className="flex items-center gap-2 text-foreground">
						<Checkbox checked={confirmedRepeat} disabled={writing} onCheckedChange={(checked) => setConfirmedFor(checked === true ? confirmReason : undefined)} />
						{t("gate.approval.confirmRepeat")}
					</label>
				</div>
			) : null}
			<div className="flex gap-2">
				<Button variant="accent" size="sm" disabled={!ready || gateFailed || !gateCheck.isSuccess || covered}
					onClick={() => submit("Approved")}>
					{t("gate.approval.approve")}
				</Button>
				<Button variant="secondary" size="sm" disabled={!ready} onClick={() => submit("Rejected")}>
					{t("gate.approval.reject")}
				</Button>
			</div>
			{writing ? (
				<p role="status" className="text-xs text-muted-foreground">{t("gate.approval.writing")}</p>
			) : recorded ? (
				<p role="status" className="text-xs text-success">
					{t(recorded.duplicate ? "gate.approval.duplicate" : "gate.approval.recorded", {
						record: localName(recorded.approval.iri),
						commit: recorded.commit.slice(0, 7),
					})}
				</p>
			) : failure ? (
				<p role="alert" className="text-xs text-destructive">
					{failure instanceof AisepToolError && failure.code === "STALE_HEAD"
						? t("gate.approval.staleHead")
						: t("gate.approval.failed", { message: aisepErrorMessage(failure) })}
				</p>
			) : null}
		</GateSection>
	);
}

function LabeledSelect({
	label,
	value,
	onValueChange,
	options,
}: {
	label: string;
	value: string | undefined;
	onValueChange: (value: string) => void;
	options: { value: string; label: string }[];
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1">
			<span id={id} className="text-muted-foreground">{label}</span>
			<Select value={value} onValueChange={onValueChange}>
				<SelectTrigger size="sm" aria-labelledby={id} className="min-w-40">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
