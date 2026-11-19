// PROVISIONAL — placeholder until the MCP Server interface (ADR-008) is designed.
// This is not a standard. Field names and value sets come from
// "AISEP 第二步：元模型规范（草案）" (v0.2): §3 IRIs, §4 element skeleton,
// §6.6 approvalState, §8.3 MCP tools, §9 impact analysis. Nothing here is
// invented beyond the shapes needed to carry those fields.

/** §3: every model object is identified by an IRI, e.g. `https://aisep.example/model/procurement/quotation`. */
export type Iri = string;

/** §6.6: derived by the build from approval records; never written by hand. */
export type ApprovalState = "Proposed" | "Approved" | "Rejected" | "Superseded";

/** §9: dependency direction declared on each relationship class. */
export type Dependency = "Forward" | "Backward" | "Both" | "None";

/** §9: `depends` (default) follows dependency direction; `ripple` traverses both ways except Association. */
export type ImpactMode = "depends" | "ripple";

/** §4 element skeleton plus the derived §6.6 state. */
export interface ModelElement {
	iri: Iri;
	/** rdf:type — exactly one most specific class. */
	type: Iri;
	/** arch:inModel — exactly one. */
	inModel: Iri;
	/** skos:prefLabel, exactly one @zh. */
	prefLabel: string;
	/** skos:altLabel @en, optional. */
	altLabel?: string;
	/** arch:approvalState, derived (§6.6). */
	approvalState: ApprovalState;
}

/** §8.3 write tools: model.add_element / model.add_relationship / model.remove. */
export type WriteOperation =
	| { tool: "model.add_element"; type: Iri; inModel: Iri; prefLabel: string }
	| { tool: "model.add_relationship"; type: Iri; inModel: Iri; source: Iri; target: Iri }
	| { tool: "model.remove"; iri: Iri };

export interface WriteResult {
	accepted: boolean;
	/** IRI generated per §3 when accepted. */
	iri?: Iri;
	/** Why the write layer refused (§8.3: "拒绝写入并说明原因"). */
	reason?: string;
}

/** Problem levels printed by `aisep check` (L0–L2). */
export interface CheckFinding {
	level: "Violation" | "Warning" | "Info";
	message: string;
	focus?: Iri;
}

export interface CheckResult {
	ok: boolean;
	findings: CheckFinding[];
}

/** model.query: read-only SPARQL over the built graph. */
export interface QueryResult {
	variables: string[];
	rows: Record<string, string>[];
}

export interface ImpactItem {
	iri: Iri;
	/** Hops from the changed element. */
	depth: number;
	/** Relationship class the hop went through. */
	via: Iri;
	dependency: Dependency;
}

export interface ImpactResult {
	focus: Iri;
	mode: ImpactMode;
	depth: number;
	items: ImpactItem[];
}

/** The four ADR-008 capabilities: write layer, check, SPARQL query, impact analysis. */
export interface AisepModelClient {
	write(operation: WriteOperation): Promise<WriteResult>;
	check(): Promise<CheckResult>;
	query(sparql: string): Promise<QueryResult>;
	impact(focus: Iri, options?: { mode?: ImpactMode; depth?: number }): Promise<ImpactResult>;
}

/**
 * Elements with their derived approval state. Prefixes are the ones the
 * prototype CLI pre-declares (metamodel-prototype/CONTRACT.md).
 */
export const ELEMENTS_QUERY = `SELECT ?element ?type ?inModel ?prefLabel ?approvalState WHERE {
  ?element arch:inModel ?inModel ; a ?type ; skos:prefLabel ?prefLabel .
  FILTER(lang(?prefLabel) = "zh")
  OPTIONAL { ?element arch:approvalState ?approvalState }
}`;

export function elementsFromRows(result: QueryResult): ModelElement[] {
	return result.rows.map((row) => ({
		iri: row.element,
		type: row.type,
		inModel: row.inModel,
		prefLabel: row.prefLabel,
		approvalState: (row.approvalState ?? "Proposed") as ApprovalState,
	}));
}

/** §9 default depth. */
export const DEFAULT_IMPACT_DEPTH = 3;
