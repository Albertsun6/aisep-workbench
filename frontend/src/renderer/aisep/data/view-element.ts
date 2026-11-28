// What the views page shows about a clicked shape (ADR-032 P1a exit ⑦): the element's details and the declared views
// it is in (arch:inView), and the refs it can be looked at on. All read through model_query (§5.6), so a ref works the
// same as for the views themselves.
import { asSelect, type Iri, type QueryResult, type Sha } from "./client";

/**
 * An absolute IRI that can go between < > in SPARQL text: the IRIs come from the server's own hits, but they are
 * still checked here before being spliced in (the SPARQL IRIREF production excludes these characters).
 */
export function isSparqlIri(iri: string): boolean {
	return /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]*$/.test(iri);
}

export function elementDetailsQuery(iri: Iri): string {
	if (!isSparqlIri(iri)) throw new Error(`not an IRI: ${iri}`);
	return `SELECT ?type ?prefLabel ?altLabel ?definition ?inModel WHERE {
  { <${iri}> a ?type } UNION { <${iri}> skos:prefLabel ?prefLabel } UNION { <${iri}> skos:altLabel ?altLabel }
  UNION { <${iri}> skos:definition ?definition } UNION { <${iri}> arch:inModel ?inModel }
}`;
}

export function elementViewsQuery(iri: Iri): string {
	if (!isSparqlIri(iri)) throw new Error(`not an IRI: ${iri}`);
	return `SELECT DISTINCT ?view ?label WHERE {
  <${iri}> arch:inView ?view .
  OPTIONAL { ?view skos:prefLabel ?label }
} ORDER BY ?view`;
}

/** A literal with its language tag, as the server returns it. */
export interface Text {
	value: string;
	lang?: string;
}

export interface ElementDetails {
	types: Iri[];
	prefLabels: Text[];
	altLabels: Text[];
	definitions: Text[];
	models: Iri[];
}

function distinct<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((item) => (seen.has(key(item)) ? false : (seen.add(key(item)), true)));
}

export function elementDetails(result: QueryResult): ElementDetails {
	const rows = asSelect(result).rows;
	const iris = (v: string) => distinct(rows.flatMap((row) => (row[v] ? [row[v].value] : [])), (x) => x).sort();
	const texts = (v: string) =>
		distinct(
			rows.flatMap((row) => (row[v] ? [{ value: row[v].value, lang: row[v].lang }] : [])),
			(t) => `${t.lang ?? ""}\u0000${t.value}`,
		);
	return {
		types: iris("type"),
		prefLabels: texts("prefLabel"),
		altLabels: texts("altLabel"),
		definitions: texts("definition"),
		models: iris("inModel"),
	};
}

export interface ElementView {
	iri: Iri;
	/** The zh label when there is one, else any label, else undefined. */
	label?: string;
}

export function elementViews(result: QueryResult): ElementView[] {
	const byView = new Map<Iri, Text[]>();
	for (const row of asSelect(result).rows) {
		const labels = byView.get(row.view.value) ?? [];
		if (row.label) labels.push({ value: row.label.value, lang: row.label.lang });
		byView.set(row.view.value, labels);
	}
	return [...byView].map(([iri, labels]) => ({ iri, label: (labels.find((l) => l.lang === "zh") ?? labels[0])?.value }));
}

/**
 * The commits approvals were given on: aisep:evidence of each approval record, which equals the headCommit of its
 * AI activity (aisep ext-governance EG26). Placeholder or non-commit evidence is left out.
 */
export const APPROVAL_COMMITS_QUERY = `PREFIX aisep: <https://aisep.example/ont/aisep#>
PREFIX prov: <http://www.w3.org/ns/prov#>
SELECT ?record ?label ?commit ?time WHERE {
  ?record a aisep:ApprovalRecord ; aisep:evidence ?commit .
  OPTIONAL { ?record skos:prefLabel ?label }
  OPTIONAL { ?record prov:generatedAtTime ?time }
  FILTER(REGEX(STR(?commit), "^[0-9a-f]{40}$"))
} ORDER BY DESC(?time) ?record`;

export interface ApprovalCommit {
	record: Iri;
	label: string;
	commit: Sha;
}

export function approvalCommits(result: QueryResult): ApprovalCommit[] {
	return distinct(
		asSelect(result).rows.map((row) => ({
			record: row.record.value,
			label: row.label?.value ?? row.record.value,
			commit: row.commit.value,
		})),
		(a) => a.record,
	);
}
