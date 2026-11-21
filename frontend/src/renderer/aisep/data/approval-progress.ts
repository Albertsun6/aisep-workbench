// Approval progress of one branch (ADR-013: derived from Git only, nothing in progress is stored anywhere):
// 待批准 → 已批准待推送 → 已推送待合并 → 已合入.
//
// What "this branch's approval" is: the approval records added by the branch's tip commit, i.e. the records at
// `refs/heads/<branch>` that are not at `refs/heads/<branch>^`. An approval is a single commit adding one record
// (aisep approval.py), and merge checking only accepts approval commits after the evidence (mergecheck.py
// `not-approval-commit`); so when the tip is not an approval commit, the branch has no approval that could still be
// merged and it is pending. A merge commit is never an approval commit: a tip with a second parent is pending. This
// keeps a fresh branch cut at main's tip (a PR merge commit, merged with `gh pr merge --merge`) from claiming the
// approval that PR brought in. This deliberately does not use "every Approved element in the model" (APPROVED_QUERY is
// not limited to the branch) nor "the diff is empty" (after a merge the merge-base is the branch head, exactly like a
// branch with no changes).
//
// The tip's Approved records are then looked up by IRI on the remote branch and on main. The server never runs
// `git fetch`: the remote stages are only as fresh as the last fetch of the repository the server reads.
import { AisepToolError, QUERY_LIMIT_MAX, asSelect, type AisepModelClient, type CallOptions, type Iri } from "./client";

export type ApprovalStage = "pending" | "approved" | "pushed" | "merged";
export const APPROVAL_STAGES = ["pending", "approved", "pushed", "merged"] as const satisfies readonly ApprovalStage[];

export const APPROVAL_RECORDS_QUERY = `PREFIX aisep: <https://aisep.example/ont/aisep#>
SELECT ?record ?decision WHERE { ?record a aisep:ApprovalRecord ; aisep:decision ?decision . }`;

const DECISION_APPROVED = "https://aisep.example/ont/aisep#DecisionApproved";

/** Main as the server resolves it for diffs (`base.mainRef`); origin/main when the diff did not say. */
export const DEFAULT_MAIN_REF = "refs/remotes/origin/main";

export interface ApprovalProgress {
	stage: ApprovalStage;
	/** The Approved records the branch tip added; empty while pending. */
	records: Iri[];
	/** origin/<branch> exists locally (as of the last fetch). */
	remoteBranch: boolean;
}

export interface ProgressRefs {
	local: string;
	parent: string;
	/** Exists only when the tip is a merge commit. */
	secondParent: string;
	remote: string;
	main: string;
}

export function progressRefs(branch: string, mainRef: string = DEFAULT_MAIN_REF): ProgressRefs {
	const local = `refs/heads/${branch}`;
	return { local, parent: `${local}^`, secondParent: `${local}^2`, remote: `refs/remotes/origin/${branch}`, main: mainRef };
}

/** record IRI -> decision IRI at one ref; null when the ref does not exist (REF_NOT_FOUND). */
async function recordsAt(
	client: AisepModelClient,
	ref: string,
	options: CallOptions,
): Promise<Map<Iri, Iri> | null> {
	let result;
	try {
		result = await client.query(APPROVAL_RECORDS_QUERY, { ref, limit: QUERY_LIMIT_MAX }, options);
	} catch (error) {
		if (error instanceof AisepToolError && error.code === "REF_NOT_FOUND") return null;
		throw error;
	}
	const select = asSelect(result);
	if (select.truncated) {
		throw new AisepToolError("RESULT_TRUNCATED", `the server truncated the result at ${select.rows.length} rows`, false);
	}
	return new Map(select.rows.map((row) => [row.record.value, row.decision.value]));
}

/** The Approved records added by the tip commit (tip minus its parent). A root tip has no parent: everything is new. */
export function tipApprovals(tip: ReadonlyMap<Iri, Iri>, parent: ReadonlyMap<Iri, Iri> | null): Iri[] {
	return [...tip].filter(([iri, decision]) => decision === DECISION_APPROVED && !parent?.has(iri)).map(([iri]) => iri);
}

/** Pure stage rule over the record sets; `remote` / `main` null = that ref does not exist. */
export function stageOf(records: readonly Iri[], remote: ReadonlyMap<Iri, Iri> | null, main: ReadonlyMap<Iri, Iri> | null): ApprovalStage {
	if (records.length === 0) return "pending";
	const hasAll = (at: ReadonlyMap<Iri, Iri> | null) => at !== null && records.every((iri) => at.has(iri));
	// Merged wins: the remote branch may be deleted after the merge.
	if (hasAll(main)) return "merged";
	if (hasAll(remote)) return "pushed";
	return "approved";
}

export async function approvalProgress(
	client: AisepModelClient,
	branch: string,
	mainRef: string = DEFAULT_MAIN_REF,
	options: CallOptions = {},
): Promise<ApprovalProgress> {
	const refs = progressRefs(branch, mainRef);
	const [tip, parent, secondParent, remote, main] = await Promise.all([
		recordsAt(client, refs.local, options),
		recordsAt(client, refs.parent, options),
		recordsAt(client, refs.secondParent, options),
		recordsAt(client, refs.remote, options),
		recordsAt(client, refs.main, options),
	]);
	if (tip === null) throw new AisepToolError("REF_NOT_FOUND", `refs/heads/${branch} does not exist`, false);
	if (main === null) throw new AisepToolError("REF_NOT_FOUND", `${mainRef} does not exist`, false);
	const records = secondParent === null ? tipApprovals(tip, parent) : [];
	return { stage: stageOf(records, remote, main), records, remoteBranch: remote !== null };
}

// Repeat approval guard (aisep models/workbench reqApprovalProgress, acNoRepeatSameSelection): which gate and elements
// the pinned head already approved. A reload after an approval pins the approval commit itself, so the tip's single
// record is not enough: after Architecture then Design, re-approving Architecture must still be caught. Like the merge
// check's effective content (mergecheck.py `_effective_content`), walk first parents from the head over approval commits
// (each adds exactly one record and has one parent) down to the content commit; every record added on the way counts.
// A commit that adds no record is the content commit: an approval below it was for older content and does not count.
export const APPROVAL_COVERAGE_QUERY = `PREFIX aisep: <https://aisep.example/ont/aisep#>
SELECT ?record ?gate ?element WHERE {
  ?record a aisep:ApprovalRecord ; aisep:decision aisep:DecisionApproved ; aisep:gate ?gate ; aisep:approves ?element .
}`;

/** More approval commits than this in a row is not a page reload: refuse rather than read on. */
export const COVERAGE_WALK_LIMIT = 20;

const AISEP_NS = "https://aisep.example/ont/aisep#";

export interface ApprovalCoverage {
	/** Every record (any decision) the approval commits above the content commit added, newest first. */
	records: Iri[];
	/** The Approved ones among them, with what they approved. */
	approved: { record: Iri; gate: Iri; elements: Set<Iri> }[];
}

export async function approvalCoverage(client: AisepModelClient, commit: string, options: CallOptions = {}): Promise<ApprovalCoverage> {
	let tip = await recordsAt(client, `${commit}~0`, options);
	if (tip === null) throw new AisepToolError("REF_NOT_FOUND", `${commit} does not exist`, false);
	const records: Iri[] = [];
	for (let k = 0; ; k++) {
		if (k === COVERAGE_WALK_LIMIT) {
			throw new AisepToolError("RESULT_TRUNCATED", `more than ${COVERAGE_WALK_LIMIT} approval commits in a row`, false);
		}
		const [parent, secondParent] = await Promise.all([
			recordsAt(client, `${commit}~${k + 1}`, options),
			recordsAt(client, `${commit}~${k}^2`, options),
		]);
		if (parent === null || secondParent !== null) break;
		const added = [...tip.keys()].filter((iri) => !parent.has(iri));
		if (added.length !== 1) break;
		records.push(added[0]);
		tip = parent;
	}
	if (records.length === 0) return { records, approved: [] };
	const select = asSelect(await client.query(APPROVAL_COVERAGE_QUERY, { ref: commit, limit: QUERY_LIMIT_MAX }, options));
	if (select.truncated) {
		throw new AisepToolError("RESULT_TRUNCATED", `the server truncated the result at ${select.rows.length} rows`, false);
	}
	const byRecord = new Map<Iri, { record: Iri; gate: Iri; elements: Set<Iri> }>();
	for (const row of select.rows) {
		const record = row.record.value;
		if (!records.includes(record)) continue;
		const entry = byRecord.get(record) ?? { record, gate: row.gate.value, elements: new Set<Iri>() };
		entry.elements.add(row.element.value);
		byRecord.set(record, entry);
	}
	return { records, approved: records.flatMap((record) => byRecord.get(record) ?? []) };
}

/** Every element of `approves` is in some Approved record of `gate` (a GateId such as "GateArchitecture"). */
export function isCovered(coverage: ApprovalCoverage, gate: string, approves: readonly Iri[]): boolean {
	const ofGate = coverage.approved.filter((entry) => entry.gate === `${AISEP_NS}${gate}`);
	return approves.length > 0 && approves.every((iri) => ofGate.some((entry) => entry.elements.has(iri)));
}

/** The Approved records of `gate` in the coverage, newest first. */
export function coveringRecords(coverage: ApprovalCoverage, gate: string): Iri[] {
	return coverage.approved.filter((entry) => entry.gate === `${AISEP_NS}${gate}`).map((entry) => entry.record);
}
