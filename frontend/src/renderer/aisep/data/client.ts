// Workbench view of the AISEP MCP Server (aisep docs/mcp-interface.md §8; shapes per §5, errors per §7).
// The workbench does not write the model (§2): only the six workbench-profile tools appear here.

export type Iri = string;
/** 40 hex characters. */
export type Sha = string;
export type ApprovalState = "Proposed" | "Approved" | "Rejected" | "Superseded";
export type ImpactMode = "depends" | "ripple";
export type GateId = "GateRequirements" | "GateArchitecture" | "GateDesign" | "GateMerge" | "GateRelease";
export type Layer = "L0" | "build" | "L1" | "L2" | "L3" | "L4";
export type DiffKind = "element" | "relationship" | "view" | "governance" | "schema" | "other";
export type Change = "added" | "modified" | "removed";

/** §3.3: both optional; the workbench server is started with --repo, so the workbench normally sends neither. */
export interface Target {
	repo?: string;
	ref?: string;
}

export interface Source {
	repo: string;
	ref: string | null;
	commit: Sha | null;
}

/** §7.3 */
export interface Finding {
	severity: "Violation" | "Warning" | "Info";
	layer: Layer;
	rule: string | null;
	focus: Iri | null;
	file: string | null;
	message: string;
	/** Only on write-tool results (§7.3); the workbench ignores it. */
	preexisting?: boolean;
}

export interface Term {
	type: "iri" | "literal" | "bnode";
	value: string;
	datatype?: string;
	lang?: string;
}
export type QueryResult =
	| { kind: "select"; variables: string[]; rows: Record<string, Term>[]; truncated: boolean }
	| { kind: "ask"; value: boolean }
	| { kind: "triples"; triples: [Term, Term, Term][]; truncated: boolean };
export type SelectResult = Extract<QueryResult, { kind: "select" }>;

export interface Summary {
	violations: number;
	warnings: number;
	infos: number;
	violationsByLayer: Record<Layer, number>;
	seconds: number;
}

export interface GateResult {
	result: "PASS" | "FAIL";
	summary: Summary;
	findings: Finding[];
	source: Source;
}

export interface ImpactHop {
	from: Iri;
	relationship: Iri;
	via: Iri;
	direction: "forward" | "backward" | "related";
	to: Iri;
}
export interface ImpactItem {
	iri: Iri;
	label?: string;
	types: Iri[];
	depth: number;
	related: boolean;
	path: ImpactHop[];
}
export interface ImpactResult {
	focus: { iri: Iri; label?: string; types: Iri[] };
	mode: ImpactMode;
	depth: number;
	invalidModel: { violations: number } | null;
	items: ImpactItem[];
}

/** model_findings (§5.4). The workbench uses openViolations for the architecture violation badge. */
export interface OpenViolations {
	count: number;
	byLayer: Record<"L0" | "build" | "L1" | "L2", number>;
	/** severity is always Violation. */
	items: Finding[];
}
export interface FindingsResult {
	partial: true;
	summary: Summary;
	/** L4 */
	findings: Finding[];
	openViolations: OpenViolations;
	source: Source;
}

export type Counts = Record<Change, number>;
export interface Endpoint {
	iri: Iri;
	label?: string;
}
export interface DiffItem {
	iri: Iri;
	kind: DiffKind;
	change: Change;
	types: Iri[];
	label?: string;
	source?: Endpoint;
	target?: Endpoint;
	files: { base: string[]; head: string[] };
	typeChanged?: boolean;
	changedPredicates?: Iri[];
	triples?: { added: [string, Term][]; removed: [string, Term][] };
}
export interface DiffResult {
	base: { ref: string | null; commit: Sha; viaMergeBase: boolean; mainRef?: string };
	head:
		| { kind: "ref"; ref: string | null; commit: Sha }
		| { kind: "worktree"; branch: string; headCommit: Sha; dirty: boolean };
	baseHasModels: boolean;
	headHasModels: boolean;
	/** Only worktree mode can be true. */
	incomplete: boolean;
	failedFiles: { file: string; error: string }[];
	/** Subjects of failed files; not in items or counts. */
	indeterminate: Iri[];
	counts: Record<DiffKind, Counts>;
	changedElementCount: number;
	touchedElementCount: number;
	/** detail = items | triples */
	items?: DiffItem[];
	touchedElements?: Iri[];
	moves?: { iri: Iri; files: { base: string[]; head: string[] } }[];
	truncated: boolean;
}
export interface DiffInput {
	repo?: string;
	head: string | { worktree: string };
	base?: string;
	mainRef?: string;
	model?: string;
	detail?: "summary" | "items" | "triples";
}

export interface ActivityInput {
	agent: Iri;
	sessionRef: string;
	/** When given it must equal ApprovalInput.branch. */
	branch?: string;
	startedAt: string;
	endedAt?: string;
	label?: string;
}
export interface ApprovalInput {
	repo?: string;
	model: string;
	gate: GateId;
	decision: "Approved" | "Rejected";
	approvedBy: Iri;
	approves: Iri[];
	branch: string;
	headCommit: Sha;
	expectedBaseCommit?: Sha;
	mainRef?: string;
	slug?: string;
	prefLabel?: string;
	activity?: ActivityInput;
}
export interface ApprovalResult {
	approval: { iri: Iri; file: string };
	activity?: { iri: Iri; reused: boolean };
	evidence: string;
	baseCommit?: Sha;
	commit: Sha;
	branch: string;
	duplicate: boolean;
	gate: { result: "PASS" | "FAIL"; summary: Summary };
	derivedApprovalState: { iri: Iri; before: ApprovalState; after: ApprovalState }[];
	findings: Finding[];
}

/** The six workbench tools. The four model-writing tools are not part of the workbench (phase one). */
export interface AisepModelClient {
	query(sparql: string, target?: Target & { limit?: number }): Promise<QueryResult>;
	gate(target?: Target & { model?: string }): Promise<GateResult>;
	findings(target?: Target & { model?: string }): Promise<FindingsResult>;
	impact(focus: Iri, options?: Target & { mode?: ImpactMode; depth?: number; allowInvalid?: boolean }): Promise<ImpactResult>;
	diff(input: DiffInput): Promise<DiffResult>;
	recordApproval(input: ApprovalInput): Promise<ApprovalResult>;
}

/** A tool result with isError: true; code is one of §7.2 (or a client-side code such as UNEXPECTED_RESULT_KIND). */
export class AisepToolError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable: boolean,
		readonly hint?: string,
		readonly details?: { findings?: Finding[] } & Record<string, unknown>,
	) {
		super(message);
		this.name = "AisepToolError";
	}
}

/** F7: approvalState is an IRI, not a string. */
export const APPROVAL_STATE_IRI: Record<string, ApprovalState> = {
	"https://meta.linked.archi/core#Proposed": "Proposed",
	"https://meta.linked.archi/core#Approved": "Approved",
	"https://aisep.example/ont/aisep#Rejected": "Rejected",
	"https://aisep.example/ont/aisep#Superseded": "Superseded",
};

/** An element with its derived (§6.6) approval state. */
export interface ModelElement {
	iri: Iri;
	type: Iri;
	inModel: Iri;
	prefLabel: string;
	approvalState: ApprovalState;
}

/**
 * Only subjects that HAVE arch:approvalState (§8): approval records and AI activities are arch:Elements with an
 * inModel and a zh label but no approvalState, and must not show up as Proposed.
 */
export const ELEMENTS_QUERY = `SELECT ?element ?type ?inModel ?prefLabel ?approvalState WHERE {
  ?element arch:inModel ?inModel ; a ?type ; skos:prefLabel ?prefLabel ; arch:approvalState ?approvalState .
  FILTER(lang(?prefLabel) = "zh")
}`;

/** The workbench only sends SELECT. */
export function asSelect(result: QueryResult): SelectResult {
	if (result.kind !== "select") {
		throw new AisepToolError("UNEXPECTED_RESULT_KIND", `expected a SELECT result, got ${result.kind}`, false);
	}
	return result;
}

export function elementsFromRows(result: QueryResult): ModelElement[] {
	return asSelect(result).rows.map((row) => {
		const stateIri = row.approvalState?.value;
		const approvalState = stateIri === undefined ? undefined : APPROVAL_STATE_IRI[stateIri];
		if (!approvalState) throw new Error(`unknown or missing approvalState for ${row.element?.value}: ${stateIri}`);
		return {
			iri: row.element.value,
			type: row.type.value,
			inModel: row.inModel.value,
			prefLabel: row.prefLabel.value,
			approvalState,
		};
	});
}
