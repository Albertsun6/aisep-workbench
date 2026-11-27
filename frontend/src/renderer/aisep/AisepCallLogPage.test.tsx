import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AisepCallLogPage } from "./AisepCallLogPage";
import { AisepToolError, type AisepModelClient, type CallLogInput, type CallLogResult } from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import { McpModelClient, McpProtocolError } from "./data/mcp-client";
import { CALL_LOG_SAMPLE } from "./data/samples";
import { aisepCatalogs } from "./i18n";

const en = aisepCatalogs.en;

function renderPage(client: AisepModelClient) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<AisepCallLogPage client={client} />
		</QueryClientProvider>,
	);
}

/** A client whose callLog answers from `answer` (the other tools come from the fixture client). */
function clientWith(answer: (input: CallLogInput) => Promise<CallLogResult>) {
	const callLog = vi.fn(answer);
	return { client: Object.assign(Object.create(fixtureClient) as AisepModelClient, { callLog }), callLog };
}

const live = (items = CALL_LOG_SAMPLE.items, extra: Partial<CallLogResult> = {}): CallLogResult => ({
	...CALL_LOG_SAMPLE,
	items,
	nextCursor: null,
	...extra,
});

function rows() {
	// The header row is first.
	return screen.getAllByRole("row").slice(1);
}

async function choose(combobox: string, option: string) {
	await userEvent.click(screen.getByRole("combobox", { name: combobox }));
	await userEvent.click(await screen.findByRole("option", { name: option }));
}

afterEach(cleanup);

describe("AisepCallLogPage", () => {
	it("always says the log is diagnostic and not tamper-proof", async () => {
		renderPage(clientWith(async () => live()).client);
		expect(screen.getByRole("note")).toHaveTextContent(en["callLog.notice.lead"].trim());
		await screen.findByText("PRECONDITION_FAILED");
		expect(screen.getByRole("note")).toHaveTextContent(en["callLog.notice.lead"].trim());
	});

	it("renders the sample with an 'interface not connected' notice when the fixture client has no recording", async () => {
		renderPage(fixtureClient);
		expect(await screen.findByText(en["sample.badge"])).toHaveAttribute("role", "status");
		expect(screen.getByText(en["callLog.unconnected"])).toBeInTheDocument();
		expect(rows()).toHaveLength(3);
		expect(screen.getByText("ok")).toBeInTheDocument();
		expect(screen.getByText("PRECONDITION_FAILED")).toBeInTheDocument();
		expect(screen.getByText("UNKNOWN_TOOL")).toBeInTheDocument();
		// No older page for the sample: it is the whole log.
		expect(screen.queryByRole("button", { name: en["callLog.older"] })).toBeNull();
	});

	it("falls back to the sample when the live server refuses the tool name, and says so", async () => {
		const fetchImpl = vi.fn(async () =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown tool: model_call_log" } })),
		);
		renderPage(new McpModelClient("http://127.0.0.1:1/mcp", fetchImpl as unknown as typeof fetch));
		expect(await screen.findByText(en["sample.badge"])).toHaveAttribute("role", "status");
		expect(rows()).toHaveLength(3);
	});

	it("shows -32602 that is not an unknown tool (bad parameters) as an error, not as sample data", async () => {
		const fetchImpl = vi.fn(async () =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params: limit must be at most 500" } })),
		);
		renderPage(new McpModelClient("http://127.0.0.1:1/mcp", fetchImpl as unknown as typeof fetch));
		expect(await screen.findByRole("alert")).toHaveTextContent("limit must be at most 500");
		expect(screen.queryByText(en["sample.badge"])).toBeNull();
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("does not fall back on an 'Unknown tool' message that comes with another JSON-RPC code", async () => {
		renderPage(clientWith(async () => {
			throw new McpProtocolError("Unknown tool: model_call_log", 200, -32603);
		}).client);
		expect(await screen.findByRole("alert")).toHaveTextContent("Unknown tool: model_call_log");
		expect(screen.queryByText(en["sample.badge"])).toBeNull();
	});

	it("does not dress any other failure up as sample data", async () => {
		renderPage(clientWith(async () => {
			// A JSON-RPC internal error: not retried, and not an unknown tool.
			throw new McpProtocolError("model_call_log: internal error", 200, -32603);
		}).client);
		expect(await screen.findByRole("alert")).toHaveTextContent("model_call_log: internal error");
		expect(screen.queryByText(en["sample.badge"])).toBeNull();
		expect(screen.queryByText(en["callLog.unconnected"])).toBeNull();
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("shows live data without the sample notice", async () => {
		renderPage(clientWith(async () => live(CALL_LOG_SAMPLE.items.slice(0, 1))).client);
		expect(await screen.findByText("ok")).toBeInTheDocument();
		expect(screen.queryByText(en["sample.badge"])).toBeNull();
		expect(screen.queryByText(en["callLog.unconnected"])).toBeNull();
		expect(rows()).toHaveLength(1);
	});

	it("lists branch, files changed and duration, and marks the client as self-reported", async () => {
		renderPage(fixtureClient);
		await screen.findByText("PRECONDITION_FAILED");
		const header = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
		expect(header).toEqual([
			en["callLog.column.time"],
			en["callLog.column.tool"],
			en["callLog.column.outcome"],
			en["callLog.column.model"],
			en["callLog.column.branch"],
			en["callLog.column.files"],
			en["callLog.detail.duration"],
			en["callLog.column.client"],
		]);
		const cells = rows().map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
		// Newest first: a write with one file, a refused write, and a call refused before any repository was found.
		expect(cells.map((row) => row.slice(4, 7))).toEqual([
			["claude/req-ac", "1", "184 ms"],
			["claude/req-ac", "0", "96 ms"],
			["—", "0", "1 ms"],
		]);
		for (const row of cells) expect(row[7]?.endsWith(en["callLog.selfReported"])).toBe(true);
		expect(cells[0][7]).toBe(`claude-code 2.3.1${en["callLog.selfReported"]}`);
	});

	it("sends the outcome, tool and model filters to the server", async () => {
		const { client, callLog } = clientWith(async () => live());
		renderPage(client);
		await screen.findByText("PRECONDITION_FAILED");
		await choose(en["callLog.filter.outcome"], en["callLog.filter.rejected"]);
		await waitFor(() => expect(callLog).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "rejected" }), expect.anything()));
		await choose(en["callLog.filter.tool"], "model_apply_action");
		await waitFor(() =>
			expect(callLog).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "rejected", tools: ["model_apply_action"] }), expect.anything()),
		);
		await userEvent.type(screen.getByLabelText(en["callLog.filter.model"]), "procurement{Enter}");
		await waitFor(() => expect(callLog).toHaveBeenLastCalledWith(expect.objectContaining({ model: "procurement" }), expect.anything()));
	});

	it("filters the sample by model, applied on Enter", async () => {
		renderPage(fixtureClient);
		await screen.findByText("PRECONDITION_FAILED");
		const field = screen.getByLabelText(en["callLog.filter.model"]);
		await userEvent.type(field, "procurement");
		// Not applied per keystroke.
		expect(rows()).toHaveLength(3);
		await userEvent.type(field, "{Enter}");
		await waitFor(() => expect(rows()).toHaveLength(2));
		expect(screen.queryByText("UNKNOWN_TOOL")).toBeNull();
		await userEvent.clear(field);
		await userEvent.type(field, "no-such-model{Enter}");
		expect(await screen.findByText(en["callLog.empty.filtered"])).toBeInTheDocument();
	});

	it("filters the sample the way the server would", async () => {
		renderPage(fixtureClient);
		await screen.findByText("PRECONDITION_FAILED");
		await choose(en["callLog.filter.outcome"], en["callLog.filter.rejected"]);
		await waitFor(() => expect(rows()).toHaveLength(2));
		expect(screen.queryByText("ok")).toBeNull();
		await choose(en["callLog.filter.tool"], "governance_record_approval");
		await waitFor(() => expect(rows()).toHaveLength(1));
		expect(screen.getByText("UNKNOWN_TOOL")).toBeInTheDocument();
		await choose(en["callLog.filter.outcome"], en["callLog.filter.ok"]);
		expect(await screen.findByText(en["callLog.empty.filtered"])).toBeInTheDocument();
	});

	it("expands a row to the measured and declared fields, declared marked as the caller's own claim", async () => {
		renderPage(fixtureClient);
		await screen.findByText("PRECONDITION_FAILED");
		const toggles = screen.getAllByRole("button", { expanded: false });
		await userEvent.click(toggles[0]);
		expect(toggles[0]).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByRole("heading", { name: en["callLog.detail.measured"] })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: en["callLog.detail.declared"] })).toBeInTheDocument();
		expect(screen.getByText("models/procurement/requirements.ttl")).toBeInTheDocument();
		expect(screen.getByText("register-acceptance-criterion", { selector: "dd" })).toBeInTheDocument();
		await userEvent.click(toggles[0]);
		expect(screen.queryByRole("heading", { name: en["callLog.detail.measured"] })).toBeNull();
	});

	it("says when there is no log yet, and when the server found no log location", async () => {
		renderPage(clientWith(async () => live([], { log: { path: "/x/calls.jsonl", present: false, sizeBytes: 0, resolvedFrom: "repo" } })).client);
		expect(await screen.findByText(en["callLog.empty.noLog"])).toBeInTheDocument();
		cleanup();
		renderPage(clientWith(async () => live([], { log: { path: null, present: false, sizeBytes: 0, resolvedFrom: null } })).client);
		expect(await screen.findByText(en["callLog.empty.noPath"])).toBeInTheDocument();
	});

	it("counts skipped lines across pages and pages to older entries with the cursor", async () => {
		const [newest, ...older] = CALL_LOG_SAMPLE.items;
		const { client, callLog } = clientWith(async (input) =>
			input.cursor === "c1"
				? live(older, { skipped: { malformed: 3, unknownVersion: 0 } })
				: live([newest], { nextCursor: "c1", skipped: { malformed: 1, unknownVersion: 2 } }),
		);
		const skippedText = (malformed: number, unknownVersion: number) =>
			en["callLog.skipped"].replace("{{malformed}}", String(malformed)).replace("{{unknownVersion}}", String(unknownVersion));
		renderPage(client);
		expect(await screen.findByText(skippedText(1, 2))).toBeInTheDocument();
		expect(rows()).toHaveLength(1);
		await userEvent.click(screen.getByRole("button", { name: en["callLog.older"] }));
		await waitFor(() => expect(rows()).toHaveLength(3));
		expect(screen.getByText(skippedText(4, 2))).toBeInTheDocument();
		expect(callLog).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c1" }), expect.anything());
		expect(screen.queryByRole("button", { name: en["callLog.older"] })).toBeNull();
	});

	it("treats only NO_FIXTURE among tool errors as not connected", async () => {
		renderPage(clientWith(async () => {
			throw new AisepToolError("INVALID_ARGUMENT", "cursor is stale", false);
		}).client);
		expect(within(await screen.findByRole("alert")).getByText(/cursor is stale/)).toBeInTheDocument();
	});
});
