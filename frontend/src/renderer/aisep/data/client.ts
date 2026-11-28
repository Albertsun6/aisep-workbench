// Workbench view of the AISEP MCP Server (aisep docs/mcp-interface.md §8; shapes per §5, errors per §7).
// The workbench does not write the model (§2): only the workbench-profile tools appear here.

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
	/** S7 sends mainRef: null when base was given explicitly. */
	base: { ref: string | null; commit: Sha; viaMergeBase: boolean; mainRef?: string | null };
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
	/** §5.8 lists it always; S7 sends it only with detail = items | triples. */
	truncated?: boolean;
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
	/** S5 (aisep#24) sends null when no activity was given. */
	activity?: { iri: Iri; reused: boolean } | null;
	evidence: string;
	baseCommit?: Sha;
	commit: Sha;
	branch: string;
	duplicate: boolean;
	gate: { result: "PASS" | "FAIL"; summary: Summary };
	derivedApprovalState: { iri: Iri; before: ApprovalState; after: ApprovalState }[];
	findings: Finding[];
}

/** model_branches (§5.11): Git facts of one local branch. The server never fetches: remote facts are as of the last fetch. */
export interface BranchInfo {
	/** Short name, as governance_record_approval's `branch`. */
	branch: string;
	head: Sha;
	/** refs/remotes/origin/<branch>; null when there is none. */
	remoteHead: Sha | null;
	/** The local head has commits the remote branch lacks (or there is no remote branch). */
	unpushed: boolean;
	mergedIntoMain: boolean;
	/** models/**.ttl changed between the merge-base with main and the head. */
	hasModelChanges: boolean;
}
export interface BranchesResult {
	/** Every local branch, sorted by name. */
	branches: BranchInfo[];
	/** The main branch the server resolved (§3.3: the remote-tracking branch first). */
	main: { ref: string; commit: Sha };
}

/**
 * The tools ADR-031 (aisep PR #171) audits: the five model_* write tools, model_apply_action and
 * governance_record_approval. model_call_log's `tools` filter takes only these names.
 */
export const AUDITED_TOOLS = [
	"model_add_element",
	"model_add_relationship",
	"model_remove",
	"model_set_attributes",
	"model_set_labels",
	"model_apply_action",
	"governance_record_approval",
] as const;

/**
 * model_call_log (PROPOSED, not on the server yet: coordination/workbench-readonly-contract-20261127.md §1.1). All
 * filters are optional and combine; `outcome` is "ok", "rejected" (anything but ok) or one exact code.
 */
export interface CallLogInput {
	limit?: number;
	cursor?: string;
	tools?: string[];
	outcome?: string;
	/** AISEP model slug (measured.request.model), not an LLM. */
	model?: string;
	actionId?: string;
	branch?: string;
	since?: string;
	until?: string;
}

/** One log line, v1 (contract §1.2). `measured` is what the server saw; `declared` is what the caller says. */
export interface CallLogEntry {
	/** Byte offset of the line in the log file: the row key. */
	offset: number;
	v: 1;
	measured: {
		time: string;
		durationMs: number;
		server: { pid: number; profile: string; transport: string; allowRoots: string[]; repo: string | null };
		tool: string;
		request: {
			argsSha256: string;
			model: string | null;
			iris: Iri[];
			actionId: string | null;
			actionVersion: string | null;
			definitionDigest: string | null;
			dryRun: boolean | null;
			planDigestGiven: boolean | null;
			repoArg: string | null;
		};
		/** "ok", a §7.2 code, or the log-only UNKNOWN_TOOL. */
		outcome: string;
		/** null when the call was refused before a repository was resolved. */
		target: { worktree: string; branch: string; head: Sha } | null;
		files: { path: string; before: string | null; after: string }[];
		/** governance_record_approval only. */
		approval?: { commit: Sha; activity: Iri | null };
	};
	declared: {
		clientInfo?: { name: string; version: string } | null;
		/** governance_record_approval only. */
		activity?: { agent: Iri; sessionRef: string };
	};
}

export interface CallLogResult {
	/** path null: the server found no log location; present false: no log written yet. */
	log: { path: string | null; present: boolean; sizeBytes: number; resolvedFrom: "allow-root" | "repo" | null };
	/** Newest first. */
	items: CallLogEntry[];
	skipped: { malformed: number; unknownVersion: number };
	/** Opaque; null when there is nothing older. */
	nextCursor: string | null;
}

/** model_list_actions (§5.13): a valid definition. */
export interface ActionDefinition {
	id: string;
	iri: Iri;
	title: string;
	description: string;
	version: string;
	valid: true;
	/** JSON Schema of the parameters. */
	params: {
		type: "object";
		properties: Record<string, { type?: string; description?: string }>;
		required?: string[];
		additionalProperties?: boolean;
	};
	/** Parameters whose value is an IRI. */
	iriParams: string[];
	destructive: boolean;
	requiresPlanDigest: boolean;
	guards: { id: string; hint: string }[];
	steps: { id: string; op: string }[];
	definitionDigest: string;
}
/** A definition the server could not use; id and iri may be null. */
export interface InvalidActionDefinition {
	id: string | null;
	iri: Iri | null;
	valid: false;
	problems: string[];
}
export interface ListActionsResult {
	catalogVersion: string;
	operations: string[];
	actions: (ActionDefinition | InvalidActionDefinition)[];
}
/**
 * model_render_view's entries (aisep §5.16): {view} | {viewpoint, model} | {c4viewpoint, of} (C4Deployment may add
 * model) | {umldiagram, model} | {dddviewpoint: "ContextMap", model} | {dddviewpoint: "AggregateDiagram", of} | {process}.
 */
export interface RenderViewInput {
	view?: string;
	viewpoint?: string;
	model?: string;
	c4viewpoint?: string;
	of?: string;
	umldiagram?: string;
	dddviewpoint?: string;
	process?: string;
}
export type ViewNotation = "archimate" | "c4" | "bpmn" | "uml" | "ddd";
/** A declared view (arch:Diagram) of model_list_views (§5.15). */
export interface DeclaredView {
	iri: Iri;
	label: string;
	notation: ViewNotation;
	viewpoint: Iri | null;
	viewpointLabel: string | null;
	memberCount: number;
	render: RenderViewInput;
}
/** A projection that draws at least one element (§5.15); scope on C4 projections, BPMN processes and DDD aggregate diagrams. */
export interface ViewProjection {
	notation: ViewNotation;
	viewpoint: string;
	label: string;
	scope?: string;
	scopeLabel?: string;
	elementCount: number;
	relationshipCount: number;
	render: RenderViewInput;
}
export interface ModelViews {
	model: Iri;
	slug: string;
	label: string;
	views: DeclaredView[];
	projections: ViewProjection[];
}
export interface ViewsResult {
	models: ModelViews[];
	source: Source;
}
/** model_render_view (§5.16): the same output as `tools/aisep.py diagram`, SVG or (a BPMN process) BPMN 2.0 XML. */
interface RenderedViewBase {
	title: string;
	notation: ViewNotation;
	elementCount: number;
	relationshipCount: number;
	warnings: string[];
	source: Source;
}
/**
 * A shape of the SVG that names a model IRI, with its box in SVG user units (§5.16 "命中框", aisep PR #201), in
 * drawing order: a later one is drawn over an earlier one (a boundary comes before what it contains).
 */
export interface ViewHit {
	iri: Iri;
	kind: string;
	x: number;
	y: number;
	width: number;
	height: number;
}
/** An SVG; `format` is absent on servers before the BPMN/UML/DDD views (aisep PR #193), `hits` before aisep PR #201. */
export interface RenderedSvgView extends RenderedViewBase {
	format?: "svg";
	svg: string;
	hits?: ViewHit[];
}
/** A BPMN process as BPMN 2.0 XML with BPMNDI, for a BPMN viewer (bpmn-js). */
export interface RenderedBpmnView extends RenderedViewBase {
	format: "bpmn-xml";
	content: string;
}
export type RenderedView = RenderedSvgView | RenderedBpmnView;

/** Client-side, never sent to the server: a caller signal (TanStack Query passes one per query) and a timeout. */
export interface CallOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * The workbench tools. The four model-writing tools are not part of the workbench (phase one).
 * The trailing CallOptions is a workbench addition to the §8 sketch: cancellation and a timeout per call.
 */
export interface AisepModelClient {
	query(sparql: string, target?: Target & { limit?: number }, options?: CallOptions): Promise<QueryResult>;
	gate(target?: Target & { model?: string }, options?: CallOptions): Promise<GateResult>;
	findings(target?: Target & { model?: string }, options?: CallOptions): Promise<FindingsResult>;
	impact(
		focus: Iri,
		options?: Target & { mode?: ImpactMode; depth?: number; allowInvalid?: boolean },
		callOptions?: CallOptions,
	): Promise<ImpactResult>;
	diff(input: DiffInput, options?: CallOptions): Promise<DiffResult>;
	recordApproval(input: ApprovalInput, options?: CallOptions): Promise<ApprovalResult>;
	branches(target?: { repo?: string }, options?: CallOptions): Promise<BranchesResult>;
	/** Not on the server yet (contract §1.1; needs aisep #170 and a new ADR). */
	callLog(input?: CallLogInput, options?: CallOptions): Promise<CallLogResult>;
	/** Today only in the agent profile; the workbench profile still has to list it (contract §2.1). */
	listActions(options?: CallOptions): Promise<ListActionsResult>;
	/** Read-only views (aisep §5.15, §5.16; aisep PR #174). Writing views is not in this version (§1). */
	listViews(target?: Target & { model?: string }, options?: CallOptions): Promise<ViewsResult>;
	renderView(input: RenderViewInput & Target, options?: CallOptions): Promise<RenderedView>;
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

/** An element with its derived (§6.6) approval state, when the server derives one for its type. */
export interface ModelElement {
	iri: Iri;
	type: Iri;
	inModel: Iri;
	prefLabel: string;
	/** undefined: the server derives no state for this element (e.g. arch:Stakeholder). Never read as Proposed. */
	approvalState?: ApprovalState;
}

/**
 * "架构全景": every model member with a zh label except the governance kinds of §5.8 step 9 (approval records and AI
 * activities are arch:Elements with an inModel and a zh label, but they are records, not architecture). Not filtered
 * on arch:approvalState: the server derives no state for some element types (Stakeholder), and they still belong here.
 */
export const ELEMENTS_QUERY = `PREFIX aisep: <https://aisep.example/ont/aisep#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?element ?type ?inModel ?prefLabel ?approvalState WHERE {
  ?element arch:inModel ?inModel ; a ?type ; skos:prefLabel ?prefLabel .
  FILTER(lang(?prefLabel) = "zh")
  FILTER NOT EXISTS { ?element a/rdfs:subClassOf* aisep:ApprovalRecord }
  FILTER NOT EXISTS { ?element a/rdfs:subClassOf* aisep:AgentActivity }
  OPTIONAL { ?element arch:approvalState ?approvalState }
}`;

/**
 * "待批准关口": only subjects whose DERIVED state is Proposed (P4: a state the server did not derive is never shown
 * as Proposed), still without the governance kinds.
 */
export const PENDING_QUERY = `PREFIX aisep: <https://aisep.example/ont/aisep#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?element ?type ?inModel ?prefLabel ?approvalState WHERE {
  ?element arch:inModel ?inModel ; a ?type ; skos:prefLabel ?prefLabel ; arch:approvalState ?approvalState .
  FILTER(?approvalState = arch:Proposed)
  FILTER(lang(?prefLabel) = "zh")
  FILTER NOT EXISTS { ?element a/rdfs:subClassOf* aisep:ApprovalRecord }
  FILTER NOT EXISTS { ?element a/rdfs:subClassOf* aisep:AgentActivity }
}`;

/**
 * "已在分支批准、待合并" (§2 row 3, Q2=A): run on a session branch (ref = branch), the elements whose state DERIVED
 * there is Approved. The state comes from the approval records in that branch's content (P4), so a later Rejected on
 * the branch wins over an earlier Approved.
 */
export const APPROVED_QUERY = `SELECT ?element WHERE { ?element arch:approvalState arch:Approved . }`;

/** model_query's largest `limit` (§5.6); its default is only 1000 rows. */
export const QUERY_LIMIT_MAX = 10_000;

/**
 * One IRI column of a SELECT whose answer must be complete (a set the caller acts on: approved elements, elements that
 * cannot be approved). A result the server cut off at its row limit (§5.6) throws instead of passing a partial set off
 * as the whole one.
 */
export function iriColumn(result: QueryResult, variable: string): Iri[] {
	const select = asSelect(result);
	if (select.truncated) {
		throw new AisepToolError("RESULT_TRUNCATED", `the server truncated the result at ${select.rows.length} rows`, false);
	}
	return select.rows.flatMap((row) => (row[variable] ? [row[variable].value] : []));
}

/** The workbench only sends SELECT. */
export function asSelect(result: QueryResult): SelectResult {
	if (result.kind !== "select") {
		throw new AisepToolError("UNEXPECTED_RESULT_KIND", `expected a SELECT result, got ${result.kind}`, false);
	}
	return result;
}

/** truncated: the server stopped at its row limit (§5.6), so `elements` is not the whole model. */
export function elementsFromRows(result: QueryResult): { elements: ModelElement[]; truncated: boolean } {
	const select = asSelect(result);
	const elements = select.rows.map((row) => {
		const stateIri = row.approvalState?.value;
		const approvalState = stateIri === undefined ? undefined : APPROVAL_STATE_IRI[stateIri];
		if (stateIri !== undefined && !approvalState) throw new Error(`unknown approvalState for ${row.element?.value}: ${stateIri}`);
		return {
			iri: row.element.value,
			type: row.type.value,
			inModel: row.inModel.value,
			prefLabel: row.prefLabel.value,
			approvalState,
		};
	});
	return { elements, truncated: select.truncated };
}
