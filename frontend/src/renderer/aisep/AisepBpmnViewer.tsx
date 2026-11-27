// A BPMN process (aisep model_render_view, format "bpmn-xml": BPMN 2.0 XML with BPMNDI, aisep docs/mcp-interface.md
// §5.16) shown read-only by bpmn-js's NavigatedViewer: pan and zoom, no editing, no palette (aisep docs/specs/bpmn-view.md
// §1). bpmn-js is pinned (package.json, 18.33.1). Its license requires the bpmn.io watermark that the viewer draws to
// stay fully visible: nothing here hides or covers it. Loaded lazily by AisepViewsPage, so the SVG views do not pay
// for it. bpmn-js reads the XML as data (bpmn-moddle) and draws its own SVG; no server markup reaches the DOM.
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Maximize2, ZoomIn, ZoomOut } from "@/components/app-icons";
import { Button } from "@/components/ui/button";
import { aoBridge } from "../lib/bridge";
import { aisepErrorMessage } from "./AisepApprovalProgress";
import type { AisepT } from "./i18n";

const ZOOM_STEP = 1.25;

interface Canvas {
	zoom(level?: number | "fit-viewport", center?: "auto"): number;
	resized(): void;
}

function fileName(title: string): string {
	return `${title.replace(/[\\/:*?"<>|]+/g, "_").trim() || "process"}.bpmn`;
}

export default function AisepBpmnViewer({ xml, title, t }: { xml: string; title: string; t: AisepT }) {
	const host = useRef<HTMLDivElement>(null);
	const canvas = useRef<Canvas | undefined>(undefined);
	const [scale, setScale] = useState(1);
	const [error, setError] = useState("");
	const [downloadError, setDownloadError] = useState("");

	useEffect(() => {
		const container = host.current;
		if (!container) return;
		const viewer = new NavigatedViewer({ container });
		let live = true;
		viewer.on("canvas.viewbox.changed", (event: { viewbox: { scale: number } }) => setScale(event.viewbox.scale));
		setError("");
		viewer
			.importXML(xml)
			.then(() => {
				if (!live) return;
				canvas.current = viewer.get<Canvas>("canvas");
				canvas.current.zoom("fit-viewport", "auto");
			})
			.catch((reason: unknown) => {
				if (live) setError(aisepErrorMessage(reason));
			});
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => canvas.current?.resized());
		observer?.observe(container);
		return () => {
			live = false;
			observer?.disconnect();
			canvas.current = undefined;
			viewer.destroy();
		};
	}, [xml]);

	const zoomBy = useCallback((factor: number) => {
		const c = canvas.current;
		if (c) c.zoom(c.zoom() * factor, "auto");
	}, []);

	/** The server's XML byte for byte, through the app's own save path (as the SVG download). */
	const download = async () => {
		setDownloadError("");
		try {
			await aoBridge.chatImage.save({ name: fileName(title), bytes: new TextEncoder().encode(xml) });
		} catch (reason) {
			setDownloadError(t("views.downloadBpmnError", { message: aisepErrorMessage(reason) }));
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div role="toolbar" aria-label={t("views.toolbar")} className="flex items-center gap-1 border-b border-border px-3 py-1">
				<Button variant="ghost" size="icon-sm" aria-label={t("views.zoomOut")} onClick={() => zoomBy(1 / ZOOM_STEP)}>
					<ZoomOut aria-hidden="true" />
				</Button>
				<output aria-label={t("views.zoomLevelLabel")} className="w-12 text-center text-xs tabular-nums text-muted-foreground">
					{t("views.zoomLevel", { percent: Math.round(scale * 100) })}
				</output>
				<Button variant="ghost" size="icon-sm" aria-label={t("views.zoomIn")} onClick={() => zoomBy(ZOOM_STEP)}>
					<ZoomIn aria-hidden="true" />
				</Button>
				<Button variant="ghost" size="sm" onClick={() => canvas.current?.zoom("fit-viewport", "auto")}>
					<Maximize2 aria-hidden="true" />
					{t("views.fit")}
				</Button>
				<Button variant="ghost" size="sm" onClick={() => canvas.current?.zoom(1, "auto")}>
					{t("views.actualSize")}
				</Button>
				<Button variant="ghost" size="sm" onClick={() => void download()}>
					<Download aria-hidden="true" />
					{t("views.downloadBpmn")}
				</Button>
				{downloadError ? (
					<p role="alert" className="text-xs text-destructive">
						{downloadError}
					</p>
				) : null}
			</div>
			{error ? (
				<p role="alert" className="px-6 pt-6 text-xs text-destructive">
					{t("views.bpmnError", { message: error })}
				</p>
			) : null}
			{/* White in both themes, as the SVG views: bpmn-js draws dark strokes on no background of its own. */}
			<div className="flex min-h-0 flex-1 p-3">
				<div
					ref={host}
					role="img"
					aria-label={`${t("views.bpmnViewer")}: ${title}`}
					data-testid="aisep-bpmn-viewer"
					className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-white"
				/>
			</div>
		</div>
	);
}
