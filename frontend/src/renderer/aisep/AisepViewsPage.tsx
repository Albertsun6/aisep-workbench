// Views page (aisep docs/mcp-interface.md §5.15, §5.16; aisep PR #174, #193): browse each model's views, grouped by
// notation (ArchiMate, C4, BPMN, UML, DDD), and look at one. Read-only: writing views is not in this version (§1). An
// SVG is never put into the DOM as markup: it is shown as an <img> of a data: URL, where scripts never run and its
// <style> and ids stay inside the image. A BPMN process (BPMN 2.0 XML) goes to bpmn-js's read-only viewer.
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Download, LayoutGrid, Maximize2, ZoomIn, ZoomOut } from "@/components/app-icons";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { PageTopbar, PageTopbarTitle } from "../components/PageTopbar";
import { aoBridge } from "../lib/bridge";
import { aisepErrorMessage } from "./AisepApprovalProgress";
import { modelClient } from "./AisepWorkbenchPage";
import {
	AisepToolError,
	type AisepModelClient,
	type ModelViews,
	type RenderViewInput,
	type ViewNotation,
	type ViewsResult,
} from "./data/client";
import { FixtureClient, fixtureClient, renderKey } from "./data/fixture-client";
import { McpProtocolError, shouldRetryAisep } from "./data/mcp-client";
import { useAisepT, type AisepMessageKey, type AisepT } from "./i18n";

/** bpmn-js is large: loaded only when a BPMN process is opened. */
const AisepBpmnViewer = lazy(() => import("./AisepBpmnViewer"));

/** The sidebar's groups, in this order; a declared view goes into its notation's group. */
const NOTATIONS: { notation: ViewNotation; title: AisepMessageKey }[] = [
	{ notation: "archimate", title: "views.group.archimate" },
	{ notation: "c4", title: "views.group.c4" },
	{ notation: "bpmn", title: "views.group.bpmn" },
	{ notation: "uml", title: "views.group.uml" },
	{ notation: "ddd", title: "views.group.ddd" },
];

/** JSON-RPC "invalid params". */
const INVALID_PARAMS = -32602;

/**
 * A server without the view tools (before aisep PR #174) refuses the name: "invalid params" with the message
 * "Unknown tool: model_list_views" (aisep/server.py). The code alone is not enough: the same code also means the tool
 * is there and refused its arguments, a real failure that must be shown, not papered over with the examples.
 */
function hasNoViewTools(error: unknown): boolean {
	return (
		error instanceof McpProtocolError &&
		error.rpcCode === INVALID_PARAMS &&
		// The client prefixes every message with the tool it called, so the name must follow "Unknown tool".
		/Unknown tool:?\s*model_list_views\b/i.test(error.message)
	);
}

/** The listed views, and whether they are the recorded examples because the server has no view tools yet. */
interface ViewsListing {
	result: ViewsResult;
	fallback: boolean;
}

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;

/** An <img> source that cannot run anything in the SVG. */
export function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The SVG's own size from its root width/height (the renderers always write both), else its viewBox. */
export function svgSize(svg: string): { width: number; height: number } {
	const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? "";
	const width = Number(root.match(/\swidth="([\d.]+)"/)?.[1]);
	const height = Number(root.match(/\sheight="([\d.]+)"/)?.[1]);
	if (width > 0 && height > 0) return { width, height };
	const box = root.match(/\sviewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/);
	return { width: Number(box?.[1]) || 800, height: Number(box?.[2]) || 600 };
}

function clampZoom(scale: number): number {
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

function fileName(title: string): string {
	return `${title.replace(/[\\/:*?"<>|]+/g, "_").trim() || "view"}.svg`;
}

interface Selected {
	key: string;
	render: RenderViewInput;
}

export function AisepViewsPage({ client = modelClient }: { client?: AisepModelClient }) {
	const t = useAisepT();
	const listing = useQuery({
		queryKey: ["aisep", "views", "list"],
		queryFn: async ({ signal }): Promise<ViewsListing> => {
			try {
				return { result: await client.listViews({}, { signal }), fallback: false };
			} catch (error) {
				if (hasNoViewTools(error)) {
					return { result: await fixtureClient.listViews(), fallback: true };
				}
				throw error;
			}
		},
		retry: shouldRetryAisep,
	});
	const examples = client instanceof FixtureClient || listing.data?.fallback === true;
	const source = listing.data?.fallback ? fixtureClient : client;
	const [selected, setSelected] = useState<Selected>();

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<PageTopbar
				lead={
					<PageTopbarTitle as="h1" icon={<LayoutGrid className="size-icon-md" aria-hidden="true" />}>
						{t("views.title")}
					</PageTopbarTitle>
				}
			/>
			{examples ? (
				<p role="note" className="border-b border-border px-6 py-2 text-xs text-muted-foreground">
					{t(listing.data?.fallback ? "views.fallbackNotice" : "views.fixtureNotice")}
				</p>
			) : null}
			<div className="flex min-h-0 flex-1">
				<nav aria-label={t("views.listLabel")} className="w-72 shrink-0 overflow-y-auto border-r border-border px-3 py-3">
					{listing.isLoading ? <p className="text-xs text-muted-foreground">{t("views.loading")}</p> : null}
					{listing.isError ? (
						<p role="alert" className="text-xs text-destructive">
							{t("views.loadError", { message: aisepErrorMessage(listing.error) })}
						</p>
					) : null}
					{listing.data && listing.data.result.models.every((model) => model.views.length + model.projections.length === 0) ? (
						<p className="text-xs text-muted-foreground">{t("views.empty")}</p>
					) : null}
					{listing.data?.result.models.map((model) => (
						<ModelGroup key={model.model} model={model} selected={selected?.key} onSelect={setSelected} t={t} />
					))}
				</nav>
				<main className="flex min-w-0 flex-1 flex-col">
					{selected ? (
						<ViewPane client={source} selected={selected} t={t} />
					) : (
						<p className="px-6 pt-6 text-xs text-muted-foreground">{t("views.pick")}</p>
					)}
				</main>
			</div>
		</div>
	);
}

function ModelGroup({
	model,
	selected,
	onSelect,
	t,
}: {
	model: ModelViews;
	selected?: string;
	onSelect: (selected: Selected) => void;
	t: AisepT;
}) {
	const groups = NOTATIONS.map(({ notation, title }) => ({
		id: notation,
		title: t(title),
		items: [
			...model.views
				.filter((view) => view.notation === notation)
				.map((view) => ({
					render: view.render,
					label: view.label,
					meta: [t("views.group.declared"), view.viewpointLabel, t("views.members", { count: view.memberCount })]
						.filter(Boolean)
						.join(" · "),
				})),
			...model.projections
				.filter((projection) => projection.notation === notation)
				.map((projection) => ({
					render: projection.render,
					label: projection.scopeLabel ? `${projection.label}：${projection.scopeLabel}` : projection.label,
					meta: t("views.counts", { elements: projection.elementCount, relationships: projection.relationshipCount }),
				})),
		],
	})).filter((group) => group.items.length > 0);
	return (
		<section aria-label={model.label} className="mb-4">
			<h2 className="px-2 pb-1 text-xs font-semibold text-foreground">
				{model.label} <span className="font-normal text-muted-foreground">{model.slug}</span>
			</h2>
			{groups.length === 0 ? <p className="px-2 text-xs text-muted-foreground">{t("views.modelEmpty")}</p> : null}
			{groups.map((group) => (
				<div key={group.id} className="mb-2">
					<h3 className="px-2 py-1 text-caption text-muted-foreground">{group.title}</h3>
					<ul>
						{group.items.map((item) => {
							const key = `${model.slug}|${renderKey(item.render)}`;
							return (
								<li key={key}>
									<Pressable
										aria-current={selected === key ? "true" : undefined}
										onClick={() => onSelect({ key, render: item.render })}
										className="flex w-full flex-col rounded-md px-2 py-1 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 aria-[current=true]:bg-muted"
									>
										<span className="text-foreground">{item.label}</span>
										<span className="text-caption text-muted-foreground">{item.meta}</span>
									</Pressable>
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</section>
	);
}

function ViewPane({ client, selected, t }: { client: AisepModelClient; selected: Selected; t: AisepT }) {
	const view = useQuery({
		queryKey: ["aisep", "views", "render", selected.key],
		queryFn: ({ signal }) => client.renderView(selected.render, { signal }),
		retry: shouldRetryAisep,
	});
	if (view.isLoading) return <p className="px-6 pt-6 text-xs text-muted-foreground">{t("views.rendering")}</p>;
	if (view.isError) {
		const unavailable = view.error instanceof AisepToolError && view.error.code === "RENDERER_UNAVAILABLE";
		return (
			<div role="alert" className="flex flex-col gap-1 px-6 pt-6 text-xs">
				<p className="text-destructive">
					{unavailable ? t("views.rendererUnavailable") : t("views.renderError", { message: aisepErrorMessage(view.error) })}
				</p>
				{unavailable ? <p className="text-muted-foreground">{aisepErrorMessage(view.error)}</p> : null}
			</div>
		);
	}
	if (!view.data) return null;
	const { title, elementCount, relationshipCount, warnings } = view.data;
	return (
		<>
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-2">
				<h2 className="text-sm font-semibold text-foreground">{title}</h2>
				<span className="text-xs text-muted-foreground">
					{t("views.counts", { elements: elementCount, relationships: relationshipCount })}
				</span>
				{warnings.length > 0 ? (
					<div className="w-full text-xs text-warning">
						<span className="font-medium">{t("views.warnings")}</span>
						<ul className="list-disc pl-4">
							{warnings.map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					</div>
				) : null}
			</div>
			{view.data.format === "bpmn-xml" ? (
				<Suspense fallback={<p className="px-6 pt-6 text-xs text-muted-foreground">{t("views.rendering")}</p>}>
					<AisepBpmnViewer key={selected.key} xml={view.data.content} title={title} t={t} />
				</Suspense>
			) : (
				<SvgViewer key={selected.key} svg={view.data.svg} title={title} t={t} />
			)}
		</>
	);
}

/**
 * Zoom with the buttons, pan by dragging; opens fitted to the pane and stays fitted when the window or the panes are
 * resized, until the user zooms or pans (fit goes back to that).
 */
function SvgViewer({ svg, title, t }: { svg: string; title: string; t: AisepT }) {
	const viewport = useRef<HTMLDivElement>(null);
	// Computed once per SVG, not on every drag move (a large SVG is hundreds of KB to encode).
	const size = useMemo(() => svgSize(svg), [svg]);
	const src = useMemo(() => svgDataUrl(svg), [svg]);
	const [scale, setScale] = useState(1);
	const [offset, setOffset] = useState({ x: 0, y: 0 });
	const drag = useRef<{ x: number; y: number; ox: number; oy: number } | undefined>(undefined);
	/** The user zoomed or panned: a resize must not undo that. */
	const adjusted = useRef(false);
	const [downloadError, setDownloadError] = useState("");

	const fit = useCallback(() => {
		adjusted.current = false;
		const box = viewport.current;
		const width = box?.clientWidth ?? 0;
		const height = box?.clientHeight ?? 0;
		// No layout (hidden pane, tests): show it at 100 %.
		const next = width > 0 && height > 0 ? clampZoom(Math.min(width / size.width, height / size.height)) : 1;
		setScale(next);
		setOffset({ x: Math.max(0, (width - size.width * next) / 2), y: Math.max(0, (height - size.height * next) / 2) });
	}, [size.width, size.height]);
	useLayoutEffect(() => {
		fit();
		const box = viewport.current;
		if (!box || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (!adjusted.current) fit();
		});
		observer.observe(box);
		return () => observer.disconnect();
	}, [fit]);

	/** Zoom about the pane's centre, so what is in the middle stays there. */
	const zoomTo = (next: number) => {
		const box = viewport.current;
		const cx = (box?.clientWidth ?? 0) / 2;
		const cy = (box?.clientHeight ?? 0) / 2;
		const clamped = clampZoom(next);
		adjusted.current = true;
		setOffset((o) => ({ x: cx - ((cx - o.x) * clamped) / scale, y: cy - ((cy - o.y) * clamped) / scale }));
		setScale(clamped);
	};

	useEffect(() => {
		const end = () => (drag.current = undefined);
		window.addEventListener("pointerup", end);
		return () => window.removeEventListener("pointerup", end);
	}, []);
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		adjusted.current = true;
		setOffset({ x: d.ox + event.clientX - d.x, y: d.oy + event.clientY - d.y });
	};
	/**
	 * Saved through the app's own save path (a save dialog in the desktop app, a blob download on the web), as other
	 * downloads are: the desktop window blocks navigation, so a data: link may not download there. The file is the
	 * server's SVG byte for byte.
	 */
	const download = async () => {
		setDownloadError("");
		try {
			await aoBridge.chatImage.save({ name: fileName(title), bytes: new TextEncoder().encode(svg) });
		} catch (error) {
			setDownloadError(t("views.downloadError", { message: aisepErrorMessage(error) }));
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div role="toolbar" aria-label={t("views.toolbar")} className="flex items-center gap-1 border-b border-border px-3 py-1">
				<Button variant="ghost" size="icon-sm" aria-label={t("views.zoomOut")} onClick={() => zoomTo(scale / ZOOM_STEP)}>
					<ZoomOut aria-hidden="true" />
				</Button>
				<output aria-label={t("views.zoomLevelLabel")} className="w-12 text-center text-xs tabular-nums text-muted-foreground">
					{t("views.zoomLevel", { percent: Math.round(scale * 100) })}
				</output>
				<Button variant="ghost" size="icon-sm" aria-label={t("views.zoomIn")} onClick={() => zoomTo(scale * ZOOM_STEP)}>
					<ZoomIn aria-hidden="true" />
				</Button>
				<Button variant="ghost" size="sm" onClick={fit}>
					<Maximize2 aria-hidden="true" />
					{t("views.fit")}
				</Button>
				<Button variant="ghost" size="sm" onClick={() => zoomTo(1)}>
					{t("views.actualSize")}
				</Button>
				<Button variant="ghost" size="sm" onClick={() => void download()}>
					<Download aria-hidden="true" />
					{t("views.download")}
				</Button>
				{downloadError ? (
					<p role="alert" className="text-xs text-destructive">
						{downloadError}
					</p>
				) : null}
			</div>
			{/*
			  White in both themes on purpose: the diagrams are drawn in the light ArchiMate/C4 notation (dark text and
			  pale fills, no background of their own), so on a dark backdrop they would be unreadable. The theme border
			  sets the white area off from a dark page.
			*/}
			<div className="flex min-h-0 flex-1 p-3">
				<div
					ref={viewport}
					data-testid="aisep-view-viewport"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden rounded-md border border-border bg-white select-none active:cursor-grabbing"
				>
					<img
						src={src}
						alt={title}
						draggable={false}
						width={size.width}
						height={size.height}
						style={{
							position: "absolute",
							left: 0,
							top: 0,
							maxWidth: "none",
							transformOrigin: "0 0",
							transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
						}}
					/>
				</div>
			</div>
		</div>
	);
}
