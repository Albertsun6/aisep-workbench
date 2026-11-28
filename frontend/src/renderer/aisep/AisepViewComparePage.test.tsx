import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { Store as OxStore } from "oxigraph";
import { afterEach, describe, expect, it } from "vitest";
import { AisepViewComparePage, memberChanges, viewMembersQuery } from "./AisepViewComparePage";
import type { AisepModelClient, QueryResult, RenderedView, RenderViewInput, Target } from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import layered from "./data/fixtures/view-procurement-layered.json";
import { aisepCatalogs } from "./i18n";

const en = aisepCatalogs.en;
const P = "https://aisep.example/model/procurement/";
const VIEW = `${P}view-quote-approval-app-usage`;
const BASE = "8f184ea559625aaa41dcdf967de1b62556ff90da";
const HEAD = "78068baa7461362e81850970fd6d4aee799e4462";
const OLD = "0000000000000000000000000000000000000000";
const EMPTY = "1111111111111111111111111111111111111111";
const SUBTYPE = "2222222222222222222222222222222222222222";
const CATALOG = "3333333333333333333333333333333333333333";
const CROSS = "4444444444444444444444444444444444444444";

const PREFIXES = `@prefix arch: <https://meta.linked.archi/core#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix : <${P}> .
`;
// The probe branch of ADR-032 P1b exit ①: only arch:inView changes (reqTwoLevelApproval out, submitQuotation in).
const COMMON = `:view-quote-approval-app-usage a arch:Diagram ; arch:inModel <${P}> ; skos:prefLabel "报价审批的应用使用"@zh .
:quoteApproval arch:inView :view-quote-approval-app-usage ; skos:prefLabel "报价审批"@zh , "Quote approval"@en .
:quotation arch:inView :view-quote-approval-app-usage .
:submitQuotation skos:prefLabel "提交报价"@zh .
:reqTwoLevelApproval skos:prefLabel "单笔超过10万需二级审批"@zh .
`;
const SNAPSHOTS: Record<string, string> = {
	[BASE]: `${PREFIXES}${COMMON}:reqTwoLevelApproval arch:inView :view-quote-approval-app-usage .`,
	[HEAD]: `${PREFIXES}${COMMON}:submitQuotation arch:inView :view-quote-approval-app-usage .`,
	// A commit before the view existed.
	[OLD]: `${PREFIXES}:quotation skos:prefLabel "报价"@zh .`,
	// The view with no members.
	[EMPTY]: `${PREFIXES}:view-quote-approval-app-usage a arch:Diagram .`,
	// A view typed by a subclass of arch:Diagram (as vendor di:Diagram is), its label tagged zh-CN.
	[SUBTYPE]: `${PREFIXES}<https://example.org/di#Diagram> rdfs:subClassOf arch:Diagram .
:view-quote-approval-app-usage a <https://example.org/di#Diagram> .
:quotation arch:inView :view-quote-approval-app-usage ; skos:prefLabel "报价"@zh-CN .`,
	// A catalog view (aisep/diff.py VIEW_TYPES).
	[CATALOG]: `${PREFIXES}:view-quote-approval-app-usage a arch:Catalog .
:quotation arch:inView :view-quote-approval-app-usage .`,
	// HEAD plus a member from another model, written by hand (ADR-032 §4).
	[CROSS]: `${PREFIXES}${COMMON}:submitQuotation arch:inView :view-quote-approval-app-usage .
<https://aisep.example/model/workbench/reqApproverPerGate> arch:inView :view-quote-approval-app-usage ; skos:prefLabel "按关口分配批准人"@zh .`,
};

/** Runs the page's SPARQL on an oxigraph store per commit, with the server's prefixes (aisep core.NS). */
function snapshotQuery(sparql: string, ref: string): QueryResult {
	const store = new OxStore();
	store.load(SNAPSHOTS[ref], { format: "text/turtle" });
	const prefixes =
		"PREFIX arch: <https://meta.linked.archi/core#>\nPREFIX skos: <http://www.w3.org/2004/02/skos/core#>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n";
	const bindings = store.query(prefixes + sparql) as Map<string, { termType: string; value: string; language?: string }>[];
	return {
		kind: "select",
		variables: ["member", "label"],
		truncated: false,
		rows: bindings.map((b) =>
			Object.fromEntries(
				[...b.entries()].map(([name, term]) => [
					name,
					term.termType === "NamedNode" ? { type: "iri" as const, value: term.value } : { type: "literal" as const, value: term.value },
				]),
			),
		),
	};
}

function compareClient(rendered: RenderedView = layered as RenderedView) {
	const calls = { query: [] as [string, unknown][], render: [] as unknown[] };
	const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
		query: async (sparql: string, target: Target & { limit?: number }) => (
			calls.query.push([sparql, target]), snapshotQuery(sparql, target.ref as string)
		),
		renderView: async (input: RenderViewInput & Target) => (calls.render.push(input), rendered),
	});
	return { client, calls };
}

function renderCompare(client: AisepModelClient, props: { view?: string; base?: string; head?: string; branch?: string } = {}) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<AisepViewComparePage view={VIEW} base={BASE} head={HEAD} client={client} {...props} />
		</QueryClientProvider>,
	);
}

afterEach(cleanup);

describe("viewMembersQuery", () => {
	it("refuses anything that is not a plain IRI (it comes from the address bar)", () => {
		expect(() => viewMembersQuery(`${VIEW}> } ; DROP ALL ; <x`)).toThrow();
		// No whitespace: only the excluded characters can stop it from leaving the <>.
		for (const char of [">", "<", '"', "{", "}", "|", "\\", "^", "`"]) {
			expect(() => viewMembersQuery(`https://x/a${char}}UNION{?member<p>?o}#`)).toThrow();
		}
		expect(() => viewMembersQuery("view-quote-approval-app-usage")).toThrow();
		expect(viewMembersQuery(VIEW)).toContain(`<${VIEW}> a/rdfs:subClassOf* ?viewType`);
	});

	it("finds a view typed by a subclass of arch:Diagram, or typed arch:Catalog, and a zh-CN label", () => {
		expect(rows(snapshotQuery(viewMembersQuery(VIEW), SUBTYPE))).toEqual([
			{ member: { type: "iri", value: `${P}quotation` }, label: { type: "literal", value: "报价" } },
		]);
		expect(rows(snapshotQuery(viewMembersQuery(VIEW), CATALOG))).toEqual([{ member: { type: "iri", value: `${P}quotation` } }]);
	});

	it("answers no rows for a commit without the view, one empty row for a view without members", () => {
		expect(rows(snapshotQuery(viewMembersQuery(VIEW), OLD))).toEqual([]);
		expect(rows(snapshotQuery(viewMembersQuery(VIEW), EMPTY))).toEqual([{}]);
	});
});

function rows(result: QueryResult) {
	return result.kind === "select" ? result.rows : [];
}

describe("memberChanges", () => {
	it("is head minus base (added) and base minus head (removed), by IRI", () => {
		const view = (iris: string[]) => ({ exists: true, members: new Map(iris.map((iri) => [iri, iri.slice(-1)])) });
		expect(memberChanges(view(["a", "b", "c"]), view(["b", "c", "d", "e"]))).toEqual({
			added: [["d", "d"], ["e", "e"]],
			removed: [["a", "a"]],
		});
		expect(memberChanges(view([]), view([]))).toEqual({ added: [], removed: [] });
	});
});

describe("AisepViewComparePage", () => {
	it("queries the members on each commit and shows what was added and removed", async () => {
		const { client, calls } = compareClient();
		renderCompare(client, { branch: "feat/view-members" });
		const added = await screen.findByRole("region", { name: en["gate.compare.added"].replace("{{count}}", "1") });
		expect(within(added).getByText("提交报价")).toHaveAttribute("title", `${P}submitQuotation`);
		const removed = screen.getByRole("region", { name: en["gate.compare.removed"].replace("{{count}}", "1") });
		expect(within(removed).getByText("单笔超过10万需二级审批")).toHaveAttribute("title", `${P}reqTwoLevelApproval`);
		expect(calls.query.map(([, target]) => target)).toEqual([
			{ ref: BASE, limit: 10_000 },
			{ ref: HEAD, limit: 10_000 },
		]);
		expect(screen.getByRole("link", { name: en["gate.compare.backToGate"] })).toHaveAttribute("href", "#/aisep/gate/feat/view-members");
	});

	it("draws both commits side by side as images, never as inline SVG (each keeps its own arrow markers)", async () => {
		const { client, calls } = compareClient();
		const { container } = renderCompare(client);
		const before = await screen.findByRole("img", { name: en["gate.compare.base"].replace("{{commit}}", BASE.slice(0, 7)) });
		const after = await screen.findByRole("img", { name: en["gate.compare.head"].replace("{{commit}}", HEAD.slice(0, 7)) });
		for (const img of [before, after]) expect(img.getAttribute("src")?.startsWith("data:image/svg+xml;")).toBe(true);
		expect(container.querySelector("svg marker, svg [marker-end]")).toBeNull();
		expect(calls.render).toEqual(expect.arrayContaining([{ view: VIEW, ref: BASE }, { view: VIEW, ref: HEAD }]));
	});

	it("says a commit has no such view instead of drawing it (an added view: everything is added)", async () => {
		const { client, calls } = compareClient();
		renderCompare(client, { base: OLD });
		const added = await screen.findByRole("region", { name: en["gate.compare.added"].replace("{{count}}", "3") });
		expect(within(added).getAllByRole("listitem")).toHaveLength(3);
		expect(await screen.findByText(en["gate.compare.absent"])).toBeInTheDocument();
		expect(calls.render).toEqual([{ view: VIEW, ref: HEAD }]);
	});

	it("marks a member from another model and says the drawing leaves it out (ADR-032 §4)", async () => {
		const { client } = compareClient();
		renderCompare(client, { head: CROSS });
		const added = await screen.findByRole("region", { name: en["gate.compare.added"].replace("{{count}}", "2") });
		const other = within(added).getByText("按关口分配批准人");
		expect(other).toHaveTextContent(en["gate.compare.otherModel"].replace("{{model}}", "workbench"));
		expect(within(added).getByText("提交报价")).not.toHaveTextContent("workbench");
		expect(screen.getByRole("note")).toHaveTextContent(en["gate.compare.otherModelNote"].replace("{{model}}", "procurement"));
	});

	it("has no note when every member is in the view's model", async () => {
		const { client } = compareClient();
		renderCompare(client);
		await screen.findByRole("region", { name: en["gate.compare.added"].replace("{{count}}", "1") });
		expect(screen.queryByRole("note")).toBeNull();
	});

	it("says the view does not draw as SVG instead of rendering forever", async () => {
		const { client } = compareClient({ ...layered, format: "bpmn-xml", content: "<definitions/>" } as unknown as RenderedView);
		renderCompare(client);
		await waitFor(() => expect(screen.getAllByText(en["gate.compare.noSvg"])).toHaveLength(2));
		expect(screen.queryByText(en["views.rendering"])).toBeNull();
	});

	it("refuses a link without a usable view IRI or commit, and asks the server nothing", () => {
		const { client, calls } = compareClient();
		renderCompare(client, { view: "not-an-iri" });
		expect(screen.getByRole("alert")).toHaveTextContent(en["gate.compare.invalid"]);
		cleanup();
		renderCompare(client, { head: "main" });
		expect(screen.getByRole("alert")).toHaveTextContent(en["gate.compare.invalid"]);
		expect(calls.query).toEqual([]);
		expect(calls.render).toEqual([]);
	});
});
