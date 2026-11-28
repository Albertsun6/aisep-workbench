import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// bpmn-js needs a real browser (SVG text measuring); the page's contract is what it hands the viewer. The viewer
// itself is covered by AisepBpmnViewer.test.tsx and the e2e spec.
vi.mock("./AisepBpmnViewer", () => ({
	default: ({ xml, title }: { xml: string; title: string }) => (
		<div data-testid="bpmn-viewer-stub" data-title={title}>
			{xml.length}
		</div>
	),
}));
import { aoBridge } from "../lib/bridge";
import { AisepViewsPage, svgDataUrl, svgSize } from "./AisepViewsPage";
import { AisepToolError, type AisepModelClient, type QueryResult, type RenderedView, type ViewsResult } from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import unknownViewpoint from "./data/fixtures/error-unknown-viewpoint.json";
import bpmnQuote from "./data/fixtures/view-procurement-bpmn-quote-approval.json";
import contextMap from "./data/fixtures/view-procurement-ddd-context-map.json";
import layered from "./data/fixtures/view-procurement-layered.json";
import { McpProtocolError } from "./data/mcp-client";
import { aisepCatalogs } from "./i18n";

const en = aisepCatalogs.en;

/** Not a FixtureClient: the page treats it as a connected model server. */
function liveClient(overrides: Partial<AisepModelClient>): AisepModelClient {
	return Object.assign(Object.create(null) as AisepModelClient, {
		listViews: (...a: Parameters<AisepModelClient["listViews"]>) => fixtureClient.listViews(...a),
		renderView: (...a: Parameters<AisepModelClient["renderView"]>) => fixtureClient.renderView(...a),
		...overrides,
	});
}

function renderPage(client: AisepModelClient = fixtureClient) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<AisepViewsPage client={client} />
		</QueryClientProvider>,
	);
}

async function open(name: RegExp | string) {
	await userEvent.click(await screen.findByRole("button", { name }));
}

/** The list shapes of aisep PR #174 (§5.15) for a declared view and two C4 projections, as its examples give them. */
const MIXED: ViewsResult = {
	models: [
		{
			model: "https://aisep.example/model/t/",
			slug: "t",
			label: "订单",
			views: [
				{
					iri: "https://aisep.example/model/t/view-probe",
					label: "探针视图",
					notation: "archimate",
					viewpoint: "https://meta.linked.archi/archimate4/viewpoints#LayeredViewpoint",
					viewpointLabel: "Layered Viewpoint",
					memberCount: 3,
					render: { view: "https://aisep.example/model/t/view-probe" },
				},
			],
			projections: [
				{
					notation: "archimate",
					viewpoint: "LayeredViewpoint",
					label: "Layered Viewpoint",
					elementCount: 7,
					relationshipCount: 8,
					render: { viewpoint: "LayeredViewpoint", model: "t" },
				},
				{
					notation: "c4",
					viewpoint: "SystemContext",
					label: "系统上下文图",
					scope: "https://aisep.example/model/t/orderSys",
					scopeLabel: "订单管理系统",
					elementCount: 3,
					relationshipCount: 2,
					render: { c4viewpoint: "SystemContext", of: "https://aisep.example/model/t/orderSys" },
				},
				{
					notation: "c4",
					viewpoint: "C4Deployment",
					label: "部署图",
					scope: "Production",
					scopeLabel: "Production",
					elementCount: 1,
					relationshipCount: 0,
					render: { c4viewpoint: "C4Deployment", of: "Production", model: "t" },
				},
			],
		},
		{ model: "https://aisep.example/model/empty/", slug: "empty", label: "空模型", views: [], projections: [] },
	],
	source: { repo: "/fixture/repo", ref: null, commit: null },
};

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("AisepViewsPage list", () => {
	it("lists the recorded views by model and says it is example data", async () => {
		renderPage();
		expect(await screen.findByText(en["views.fixtureNotice"])).toBeInTheDocument();
		const procurement = await screen.findByRole("region", { name: "采购" });
		expect(within(procurement).getByText(en["views.group.archimate"])).toBeInTheDocument();
		expect(within(procurement).getByRole("button", { name: /Layered Viewpoint/ })).toHaveTextContent("7 elements · 8 relationships");
		const workbench = screen.getByRole("region", { name: "AISEP 工作台" });
		expect(within(workbench).getAllByRole("button").map((b) => b.textContent)).toEqual([
			"Motivation Viewpoint22 elements · 10 relationships",
			"Stakeholder Viewpoint6 elements · 4 relationships",
			"BPMN 流程：批准或驳回发布并打 release 标签12 elements · 12 relationships",
			"上下文映射图3 elements · 2 relationships",
		]);
		expect(screen.getByText(en["views.pick"])).toBeInTheDocument();
	});

	it("groups by notation, a declared view in its notation's group first, and says when a model has none", async () => {
		renderPage(liveClient({ listViews: async () => MIXED }));
		const model = await screen.findByRole("region", { name: "订单" });
		expect(within(model).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
			en["views.group.archimate"],
			en["views.group.c4"],
		]);
		expect(within(model).getAllByRole("button")[0]).toHaveTextContent(`探针视图${en["views.group.declared"]} · Layered Viewpoint · 3 members`);
		expect(within(model).getByRole("button", { name: /系统上下文图：订单管理系统/ })).toHaveTextContent("3 elements · 2 relationships");
		expect(within(model).getByRole("button", { name: /部署图：Production/ })).toBeInTheDocument();
		expect(within(screen.getByRole("region", { name: "空模型" })).getByText(en["views.modelEmpty"])).toBeInTheDocument();
		// A connected server: no example-data notice.
		expect(screen.queryByText(en["views.fixtureNotice"])).toBeNull();
		expect(screen.queryByText(en["views.fallbackNotice"])).toBeNull();
	});

	it("says so when no model has a view", async () => {
		renderPage(liveClient({ listViews: async () => ({ models: [MIXED.models[1]], source: MIXED.source }) }));
		expect(await screen.findByText(en["views.empty"])).toBeInTheDocument();
	});

	it("shows the list error", async () => {
		renderPage(liveClient({ listViews: async () => Promise.reject(new McpProtocolError("model_list_views: HTTP 400: bad request", 400)) }));
		expect(await screen.findByRole("alert")).toHaveTextContent("model_list_views: HTTP 400: bad request");
	});

	it("falls back to the recorded examples, and says so, when the server has no view tools (unknown tool)", async () => {
		const unknown = new McpProtocolError("model_list_views: Unknown tool: model_list_views", 200, -32602);
		renderPage(liveClient({ listViews: async () => Promise.reject(unknown), renderView: async () => Promise.reject(unknown) }));
		expect(await screen.findByText(en["views.fallbackNotice"])).toBeInTheDocument();
		await open(/Layered Viewpoint/);
		expect(await screen.findByRole("img", { name: "Layered Viewpoint" })).toBeInTheDocument();
	});

	it("shows a refused argument as an error, not the examples: invalid params is not always an unknown tool", async () => {
		const badArgs = new McpProtocolError("model_list_views: Invalid arguments: model: Input should be a valid string", 200, -32602);
		renderPage(liveClient({ listViews: async () => Promise.reject(badArgs) }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Invalid arguments");
		expect(screen.queryByText(en["views.fallbackNotice"])).toBeNull();
		expect(screen.queryByRole("region", { name: "采购" })).toBeNull();
	});

	it("does not fall back when another tool is unknown", async () => {
		const other = new McpProtocolError("model_list_views: Unknown tool: model_query", 200, -32602);
		renderPage(liveClient({ listViews: async () => Promise.reject(other) }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Unknown tool: model_query");
		expect(screen.queryByText(en["views.fallbackNotice"])).toBeNull();
	});
});

describe("AisepViewsPage notations", () => {
	it("groups the recorded procurement views as ArchiMate, BPMN, UML, DDD, in that order", async () => {
		renderPage();
		const procurement = await screen.findByRole("region", { name: "采购" });
		expect(within(procurement).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
			en["views.group.archimate"],
			en["views.group.bpmn"],
			en["views.group.uml"],
			en["views.group.ddd"],
		]);
		expect(within(procurement).getByRole("button", { name: /BPMN 流程：报价审批流程/ })).toHaveTextContent("6 elements · 6 relationships");
		expect(within(procurement).getByRole("button", { name: /UML 类图/ })).toHaveTextContent("1 elements · 0 relationships");
		expect(within(procurement).getByRole("button", { name: /聚合图：报价上下文/ })).toBeInTheDocument();
	});

	it("puts a declared UML view in the UML group", async () => {
		const uml: ViewsResult = {
			...MIXED,
			models: [
				{
					...MIXED.models[0],
					views: [
						{ ...MIXED.models[0].views[0], iri: "https://aisep.example/model/t/view-uml", label: "UML 声明视图", notation: "uml",
							viewpointLabel: "UML 类图", render: { view: "https://aisep.example/model/t/view-uml" } },
					],
				},
			],
		};
		renderPage(liveClient({ listViews: async () => uml }));
		const model = await screen.findByRole("region", { name: "订单" });
		expect(within(model).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
			en["views.group.archimate"],
			en["views.group.c4"],
			en["views.group.uml"],
		]);
	});

	it("hands a BPMN process's XML to the BPMN viewer, not to an <img>", async () => {
		const calls: unknown[] = [];
		renderPage(liveClient({ renderView: async (input) => (calls.push(input), fixtureClient.renderView(input)) }));
		await open(/BPMN 流程：报价审批流程/);
		const stub = await screen.findByTestId("bpmn-viewer-stub");
		expect(stub).toHaveTextContent(String(bpmnQuote.content.length));
		expect(stub).toHaveAttribute("data-title", "报价审批流程");
		expect(calls).toEqual([{ process: "https://aisep.example/model/procurement/bpmnQuoteApproval" }]);
		expect(screen.queryByRole("img")).toBeNull();
		expect(screen.getByRole("heading", { level: 2, name: "报价审批流程" })).toBeInTheDocument();
	});

	it("shows a DDD context map as an <img> of the server's SVG", async () => {
		const { container } = renderPage();
		const procurement = await screen.findByRole("region", { name: "采购" });
		await userEvent.click(within(procurement).getByRole("button", { name: /上下文映射图/ }));
		const image = await screen.findByRole("img", { name: contextMap.title });
		expect(image.tagName).toBe("IMG");
		expect(image).toHaveAttribute("src", svgDataUrl(contextMap.svg));
		expect(container.innerHTML).not.toContain("<svg xmlns");
	});

	it("treats a result without format (servers before aisep #193) as SVG", async () => {
		const { format: _format, ...old } = layered;
		renderPage(liveClient({ renderView: async () => old as RenderedView }));
		await open(/Layered Viewpoint/);
		expect(await screen.findByRole("img", { name: "Layered Viewpoint" })).toHaveAttribute("src", svgDataUrl(layered.svg));
	});
});

describe("AisepViewsPage viewer", () => {
	it("shows the selected view as an <img> of the server's SVG, with its counts and a download", async () => {
		renderPage();
		await open(/Layered Viewpoint/);
		const image = await screen.findByRole("img", { name: "Layered Viewpoint" });
		expect(image.tagName).toBe("IMG");
		expect(image).toHaveAttribute("src", svgDataUrl(layered.svg));
		expect(decodeURIComponent((image.getAttribute("src") as string).split(",").slice(1).join(","))).toBe(layered.svg);
		expect(image).toHaveAttribute("width", "814");
		expect(image).toHaveAttribute("height", "726");
		expect(screen.getByRole("heading", { level: 2, name: "Layered Viewpoint" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Layered Viewpoint/ })).toHaveAttribute("aria-current", "true");
	});

	it("downloads the server's SVG unchanged through the app's save path, not a data: link", async () => {
		const save = vi.spyOn(aoBridge.chatImage, "save").mockResolvedValue(true);
		renderPage();
		await open(/Layered Viewpoint/);
		await screen.findByRole("img", { name: "Layered Viewpoint" });
		expect(screen.queryByRole("link", { name: en["views.download"] })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: en["views.download"] }));
		expect(save).toHaveBeenCalledTimes(1);
		const { name, bytes } = save.mock.calls[0][0];
		expect(name).toBe("Layered Viewpoint.svg");
		expect(new TextDecoder().decode(bytes)).toBe(layered.svg);
	});

	it("says so when the SVG cannot be saved", async () => {
		vi.spyOn(aoBridge.chatImage, "save").mockRejectedValue(new Error("disk full"));
		renderPage();
		await open(/Layered Viewpoint/);
		await userEvent.click(await screen.findByRole("button", { name: en["views.download"] }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the SVG: disk full");
	});

	it("does not re-encode the SVG while it is dragged", async () => {
		renderPage();
		await open(/Layered Viewpoint/);
		await screen.findByRole("img", { name: "Layered Viewpoint" });
		const viewport = screen.getByTestId("aisep-view-viewport");
		const encode = vi.spyOn(globalThis, "encodeURIComponent");
		fireEvent.pointerDown(viewport, { clientX: 10, clientY: 10 });
		for (let i = 1; i <= 5; i++) fireEvent.pointerMove(viewport, { clientX: 10 + i * 10, clientY: 10 });
		fireEvent.pointerUp(window);
		expect(screen.getByRole("img", { name: "Layered Viewpoint" }).style.transform).toContain("translate(50px, 0px)");
		expect(encode).not.toHaveBeenCalled();
	});

	it("refits when the pane is resized, until the user zooms; fit resumes it", async () => {
		let resize: () => void = () => undefined;
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(private readonly callback: ResizeObserverCallback) {}
				// Only an observed box reports its resizes.
				observe() {
					resize = () => this.callback([], this as unknown as ResizeObserver);
				}
				disconnect() {
					resize = () => undefined;
				}
			},
		);
		const box = { width: 0, height: 0 };
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => box.width);
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => box.height);
		renderPage();
		await open(/Layered Viewpoint/);
		await screen.findByRole("img", { name: "Layered Viewpoint" });
		const level = screen.getByRole("status", { name: en["views.zoomLevelLabel"] });
		expect(level).toHaveTextContent("100%");
		// 814 × 726 into 407 × 900: half size.
		box.width = 407;
		box.height = 900;
		act(resize);
		expect(level).toHaveTextContent("50%");
		await userEvent.click(screen.getByRole("button", { name: en["views.zoomIn"] }));
		expect(level).toHaveTextContent("63%");
		box.width = 814;
		act(resize);
		expect(level).toHaveTextContent("63%");
		await userEvent.click(screen.getByRole("button", { name: en["views.fit"] }));
		expect(level).toHaveTextContent("100%");
		box.width = 407;
		act(resize);
		expect(level).toHaveTextContent("50%");
	});

	it("never puts the SVG markup into the page", async () => {
		const { container } = renderPage();
		await open(/Layered Viewpoint/);
		await screen.findByRole("img", { name: "Layered Viewpoint" });
		// The diagram's own root (aria-label "Layered Vi…", viewBox 0 0 814 726) is not in the DOM, nor any of its text.
		expect(container.querySelector('svg[viewBox="0 0 814 726"]')).toBeNull();
		expect(container.querySelector("svg[role=img]")).toBeNull();
		expect(container.innerHTML).not.toContain("<svg xmlns");
		const source = readFileSync(path.resolve(process.cwd(), "src/renderer/aisep/AisepViewsPage.tsx"), "utf8");
		expect(source).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|createContextualFragment/);
	});

	it("zooms with the buttons and resets to actual size", async () => {
		renderPage();
		await open(/Layered Viewpoint/);
		const image = await screen.findByRole("img", { name: "Layered Viewpoint" });
		const level = screen.getByRole("status", { name: en["views.zoomLevelLabel"] });
		// jsdom has no layout, so "fit" falls back to 100 %.
		expect(level).toHaveTextContent("100%");
		await userEvent.click(screen.getByRole("button", { name: en["views.zoomIn"] }));
		expect(level).toHaveTextContent("125%");
		expect(image.style.transform).toContain("scale(1.25)");
		await userEvent.click(screen.getByRole("button", { name: en["views.zoomOut"] }));
		await userEvent.click(screen.getByRole("button", { name: en["views.zoomOut"] }));
		expect(level).toHaveTextContent("80%");
		await userEvent.click(screen.getByRole("button", { name: en["views.actualSize"] }));
		expect(level).toHaveTextContent("100%");
		for (let i = 0; i < 30; i++) await userEvent.click(screen.getByRole("button", { name: en["views.zoomOut"] }));
		expect(level).toHaveTextContent("10%");
		await userEvent.click(screen.getByRole("button", { name: en["views.fit"] }));
		expect(level).toHaveTextContent("100%");
	});

	it("lists the server's warnings", async () => {
		const warned: RenderedView = { ...(layered as RenderedView), warnings: ["视图里没有元素"] };
		renderPage(liveClient({ renderView: async () => warned }));
		await open(/Layered Viewpoint/);
		expect(await screen.findByText("视图里没有元素")).toBeInTheDocument();
		expect(screen.getByText(en["views.warnings"])).toBeInTheDocument();
	});

	it("explains a missing Node/elkjs in plain words, with the server's fix", async () => {
		const hint = "在模型仓库根目录跑 `npm ci --prefix tools/elk --ignore-scripts`（需要 Node ≥ 20 在 PATH 上），再重试";
		const error = new AisepToolError("RENDERER_UNAVAILABLE", "出图器不可用：elkjs is not installed", false, hint, { reason: "elkjs-missing" });
		renderPage(liveClient({ renderView: async () => Promise.reject(error) }));
		await open(/Layered Viewpoint/);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(en["views.rendererUnavailable"]);
		expect(alert).toHaveTextContent("npm ci --prefix tools/elk");
		expect(screen.queryByRole("img", { name: "Layered Viewpoint" })).toBeNull();
	});

	it("shows any other render error with the server's message", async () => {
		// Recorded off aisep PR #174's server: {"viewpoint":"Nope","model":"workbench"}.
		const error = new AisepToolError(unknownViewpoint.code, unknownViewpoint.message, unknownViewpoint.retryable, undefined, unknownViewpoint.details);
		renderPage(liveClient({ renderView: async () => Promise.reject(error) }));
		await open(/Layered Viewpoint/);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not draw this view: 没有 ArchiMate 视点 'Nope'");
		expect(alert).not.toHaveTextContent(en["views.rendererUnavailable"]);
	});
});

describe("AisepViewsPage picking a shape (ADR-032 P1a exit ⑦)", () => {
	const M = "https://aisep.example/model/procurement/";
	const VIEW = `${M}view-quoteApprovalAppUsage`;
	const LIST: ViewsResult = {
		models: [
			{
				model: M,
				slug: "procurement",
				label: "采购",
				views: [
					{
						iri: VIEW,
						label: "报价审批应用使用视图",
						notation: "archimate",
						viewpoint: "https://meta.linked.archi/archimate4/viewpoints#ApplicationUsageViewpoint",
						viewpointLabel: "Application Usage",
						memberCount: 2,
						render: { view: VIEW },
					},
				],
				projections: [],
			},
		],
		source: { repo: "/fixture/repo", ref: null, commit: null },
	};
	/** Two boxes: an outer one drawn first, then one inside it (on top). */
	const HITS = [
		{ iri: `${M}procurementSystem`, kind: "boundary", x: 10, y: 10, width: 300, height: 200 },
		{ iri: `${M}quoteApp`, kind: "element", x: 40, y: 40, width: 120, height: 60 },
	];
	function sparqlRows(sparql: string): QueryResult {
		if (sparql.includes("arch:inView")) {
			return { kind: "select" as const, variables: ["view", "label"], truncated: false, rows: [
				{ view: { type: "iri" as const, value: VIEW }, label: { type: "literal" as const, value: "报价审批应用使用视图", lang: "zh" } },
				{ view: { type: "iri" as const, value: `${M}view-elsewhere` } },
			] };
		}
		if (sparql.includes("aisep:ApprovalRecord")) {
			return { kind: "select" as const, variables: ["record", "label", "commit"], truncated: false, rows: [
				{ record: { type: "iri" as const, value: `${M}approval-1` }, label: { type: "literal" as const, value: "架构基线" },
					commit: { type: "literal" as const, value: "1cac09cbec36a695311081f4876677f73a41229c" } },
			] };
		}
		return { kind: "select" as const, variables: ["type", "prefLabel"], truncated: false, rows: [
			{ type: { type: "iri" as const, value: "https://meta.linked.archi/archimate4/onto#ApplicationComponent" } },
			{ prefLabel: { type: "literal" as const, value: "报价应用", lang: "zh" } },
		] };
	}
	function client(calls: { list: unknown[]; render: unknown[]; query: [string, unknown][] }) {
		return liveClient({
			listViews: async (target) => (calls.list.push(target), LIST),
			renderView: async (input) => (calls.render.push(input), { ...(layered as RenderedView), hits: HITS }),
			query: async (sparql, target) => (calls.query.push([sparql, target]), sparqlRows(sparql)),
			branches: async () => ({
				branches: [
					{ branch: "main", head: "a".repeat(40), remoteHead: null, unpushed: false, mergedIntoMain: true, hasModelChanges: false },
					{ branch: "claude/p1a-views", head: "b".repeat(40), remoteHead: null, unpushed: false, mergedIntoMain: false, hasModelChanges: true },
				],
				main: { ref: "refs/remotes/origin/main", commit: "a".repeat(40) },
			}),
		});
	}

	it("lays the server's hit boxes over the <img>, innermost on top, and shows IRI, details and 所在视图", async () => {
		const calls = { list: [] as unknown[], render: [] as unknown[], query: [] as [string, unknown][] };
		renderPage(client(calls));
		await open(/报价审批应用使用视图/);
		await screen.findByRole("img", { name: "Layered Viewpoint" });
		const layer = screen.getByTestId("aisep-view-hits");
		// The SVG is still an <img>; the layer is buttons, in drawing order, under the image's own transform.
		expect(layer.querySelectorAll("button")).toHaveLength(2);
		expect([...layer.querySelectorAll("button")].map((b) => b.getAttribute("data-iri"))).toEqual(HITS.map((h) => h.iri));
		expect(layer.style.transform).toBe(screen.getByRole("img", { name: "Layered Viewpoint" }).style.transform);
		const app = screen.getByRole("button", { name: `Select ${M}quoteApp` });
		expect(app.style.left).toBe("40px");
		expect(app.style.width).toBe("120px");
		await userEvent.click(app);
		expect(app).toHaveAttribute("aria-pressed", "true");
		const panel = screen.getByRole("complementary", { name: en["views.element.label"] });
		expect(within(panel).getByText(`${M}quoteApp`)).toBeInTheDocument();
		expect(await within(panel).findByRole("heading", { level: 2, name: "报价应用" })).toBeInTheDocument();
		expect(within(panel).getByText("ApplicationComponent")).toBeInTheDocument();
		const views = within(panel).getByRole("region", { name: en["views.element.views"] });
		// A listed declared view opens; one the list does not have is shown, not a button.
		expect(await within(views).findByRole("button", { name: /报价审批应用使用视图/ })).toBeInTheDocument();
		expect(within(views).getByText(`${M}view-elsewhere`)).toBeInTheDocument();
		expect(within(views).getAllByRole("button")).toHaveLength(1);
		// The element queries name the clicked IRI and read the same content as the view (no ref here).
		expect(calls.query.filter(([q]) => q.includes(`<${M}quoteApp>`)).map(([, target]) => target)).toEqual([{}, {}]);
	});

	it("does not pick when the press was a pan", async () => {
		renderPage(client({ list: [], render: [], query: [] }));
		await open(/报价审批应用使用视图/);
		const app = await screen.findByRole("button", { name: `Select ${M}quoteApp` });
		fireEvent.pointerDown(app, { clientX: 50, clientY: 50 });
		fireEvent.pointerMove(app, { clientX: 90, clientY: 50 });
		fireEvent.pointerUp(window);
		fireEvent.click(app, { detail: 1 });
		expect(screen.queryByRole("complementary", { name: en["views.element.label"] })).toBeNull();
		// The keyboard never goes through pointerdown: Enter on the focused shape still picks after a pan.
		app.focus();
		await userEvent.keyboard("{Enter}");
		expect(app).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("complementary", { name: en["views.element.label"] })).toBeInTheDocument();
	});

	it("switches the ref: main, a branch, an approval's headCommit; list, view and details all read it", async () => {
		const calls = { list: [] as unknown[], render: [] as unknown[], query: [] as [string, unknown][] };
		renderPage(client(calls));
		await open(/报价审批应用使用视图/);
		await userEvent.click(await screen.findByRole("button", { name: `Select ${M}quoteApp` }));
		expect(calls.list).toEqual([{}]);
		const picker = screen.getByRole("combobox", { name: en["views.ref.label"] });
		await userEvent.click(picker);
		expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
			en["views.ref.worktree"],
			"Main branch (refs/remotes/origin/main)",
			"Branch claude/p1a-views",
			"Approval: 架构基线 (1cac09c)",
		]);
		await userEvent.click(screen.getByRole("option", { name: "Approval: 架构基线 (1cac09c)" }));
		const head = "1cac09cbec36a695311081f4876677f73a41229c";
		await vi.waitFor(() => expect(calls.list.at(-1)).toEqual({ ref: head }));
		await vi.waitFor(() => expect(calls.render.at(-1)).toEqual({ view: VIEW, ref: head }));
		await vi.waitFor(() =>
			expect(calls.query.filter(([q]) => q.includes(`<${M}quoteApp>`)).slice(-2).map(([, t]) => t)).toEqual([{ ref: head }, { ref: head }]),
		);
		await userEvent.click(picker);
		await userEvent.click(await screen.findByRole("option", { name: "Branch claude/p1a-views" }));
		await vi.waitFor(() => expect(calls.render.at(-1)).toEqual({ view: VIEW, ref: "claude/p1a-views" }));
	});

	it("a hostile SVG stays an inert <img>; a hostile hit IRI is never spliced into SPARQL (exit ④)", async () => {
		const hostile =
			'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" onload="window.__pwned=1"><script>window.__pwned=2</script>' +
			'<foreignObject><iframe src="javascript:window.__pwned=3"></iframe></foreignObject><a href="javascript:window.__pwned=4"><rect width="9" height="9"/></a></svg>';
		const evil = `${M}x> } ; DROP <y`;
		const query = vi.fn(async (sparql: string) => sparqlRows(sparql));
		const { container } = renderPage(
			liveClient({
				listViews: async () => LIST,
				renderView: async () => ({ ...(layered as RenderedView), svg: hostile, hits: [{ iri: evil, kind: "element", x: 1, y: 1, width: 10, height: 10 }] }),
				query,
				branches: async () => Promise.reject(new Error("no branches")),
			}),
		);
		await open(/报价审批应用使用视图/);
		const image = await screen.findByRole("img", { name: "Layered Viewpoint" });
		expect(image.tagName).toBe("IMG");
		expect(image).toHaveAttribute("src", svgDataUrl(hostile));
		expect(container.querySelector("script, foreignObject, iframe, svg[onload]")).toBeNull();
		// Only inside the image's (percent-encoded) data: URL, nowhere as markup.
		expect(container.innerHTML.split(svgDataUrl(hostile)).join("")).not.toContain("__pwned");
		expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
		await userEvent.click(screen.getByRole("button", { name: `Select ${evil}` }));
		expect(within(screen.getByRole("complementary", { name: en["views.element.label"] })).getByText(evil)).toBeInTheDocument();
		expect(query.mock.calls.filter(([q]) => q.includes("DROP"))).toEqual([]);
	});
});

describe("svgSize", () => {
	it("reads the root width and height, else the viewBox", () => {
		expect(svgSize(layered.svg)).toEqual({ width: 814, height: 726 });
		expect(svgSize('<svg viewBox="0 0 30 40"><rect width="5" height="6"/></svg>')).toEqual({ width: 30, height: 40 });
	});
});
