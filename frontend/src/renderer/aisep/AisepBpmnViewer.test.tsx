import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aoBridge } from "../lib/bridge";
import AisepBpmnViewer from "./AisepBpmnViewer";
import bpmnQuote from "./data/fixtures/view-procurement-bpmn-quote-approval.json";
import { aisepCatalogs, type AisepT } from "./i18n";

// jsdom cannot lay out SVG text, so bpmn-js itself is replaced; the e2e spec loads the real NavigatedViewer.
const viewer = vi.hoisted(() => ({
	instances: [] as { container: HTMLElement; imported: string[]; destroyed: boolean; zoomCalls: unknown[][] }[],
	fail: undefined as Error | undefined,
}));
vi.mock("bpmn-js/lib/NavigatedViewer", () => ({
	default: class {
		state;
		constructor({ container }: { container: HTMLElement }) {
			this.state = { container, imported: [] as string[], destroyed: false, zoomCalls: [] as unknown[][] };
			viewer.instances.push(this.state);
		}
		on() {}
		async importXML(xml: string) {
			if (viewer.fail) throw viewer.fail;
			this.state.imported.push(xml);
			return { warnings: [] };
		}
		get() {
			return { zoom: (...a: unknown[]) => (this.state.zoomCalls.push(a), 1), resized: () => undefined };
		}
		destroy() {
			this.state.destroyed = true;
		}
	},
}));

const en = aisepCatalogs.en;
const t: AisepT = (key, options) =>
	en[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String((options as Record<string, unknown>)?.[name] ?? ""));

beforeEach(() => {
	viewer.instances = [];
	viewer.fail = undefined;
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("AisepBpmnViewer", () => {
	it("imports the server's BPMN XML unchanged into a read-only NavigatedViewer, fits it, and destroys it on unmount", async () => {
		const { unmount } = render(<AisepBpmnViewer xml={bpmnQuote.content} title={bpmnQuote.title} t={t} />);
		await waitFor(() => expect(viewer.instances[0]?.zoomCalls).toEqual([["fit-viewport", "auto"]]));
		expect(viewer.instances).toHaveLength(1);
		expect(viewer.instances[0].imported).toEqual([bpmnQuote.content]);
		expect(viewer.instances[0].container).toBe(screen.getByTestId("aisep-bpmn-viewer"));
		expect(screen.getByRole("img", { name: `${en["views.bpmnViewer"]}: 报价审批流程` })).toBeInTheDocument();
		unmount();
		expect(viewer.instances[0].destroyed).toBe(true);
	});

	it("downloads the server's XML byte for byte as a .bpmn file", async () => {
		const save = vi.spyOn(aoBridge.chatImage, "save").mockResolvedValue(true);
		render(<AisepBpmnViewer xml={bpmnQuote.content} title={bpmnQuote.title} t={t} />);
		await userEvent.click(screen.getByRole("button", { name: en["views.downloadBpmn"] }));
		const { name, bytes } = save.mock.calls[0][0];
		expect(name).toBe("报价审批流程.bpmn");
		expect(new TextDecoder().decode(bytes)).toBe(bpmnQuote.content);
	});

	it("shows the viewer's import error", async () => {
		viewer.fail = new Error("unparsable content <x> detected");
		render(<AisepBpmnViewer xml="<x/>" title="坏流程" t={t} />);
		expect(await screen.findByRole("alert")).toHaveTextContent("The BPMN viewer could not show this process: unparsable content");
	});

	it("uses the bpmn-js viewer, not the modeler, and never hides the bpmn.io watermark (license)", () => {
		const source = readFileSync(path.resolve(process.cwd(), "src/renderer/aisep/AisepBpmnViewer.tsx"), "utf8");
		expect(source).toContain('from "bpmn-js/lib/NavigatedViewer"');
		expect(source).not.toMatch(/bpmn-js\/lib\/Modeler|bjs-powered-by|dangerouslySetInnerHTML|\.innerHTML/);
		const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { dependencies: Record<string, string> };
		expect(pkg.dependencies["bpmn-js"]).toBe("18.33.1");
	});
});
