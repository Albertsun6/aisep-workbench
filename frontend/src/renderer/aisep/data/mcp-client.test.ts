// McpModelClient with a fake fetch fed real server responses (aisep §8 step 2). The live-server run is
// mcp-client.integration.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AisepToolError, elementsFromRows, type QueryResult } from "./client";
import elementsQuery from "./fixtures/elements-query.json";
import gateFixture from "./fixtures/gate.json";
import { MCP_PROTOCOL_VERSION, McpModelClient, McpProtocolError, shouldRetryAisep } from "./mcp-client";

const URL = "http://127.0.0.1:8765/mcp";

type Seen = { url: string; headers: Record<string, string>; body: { method: string; params: Record<string, unknown> } };

function fakeFetch(respond: () => Response): { fetch: typeof fetch; seen: Seen[] } {
	const seen: Seen[] = [];
	return {
		seen,
		fetch: async (input, init) => {
			seen.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
			return respond();
		},
	};
}

const ok = (structuredContent: unknown) =>
	() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent, isError: false } }));

/** Recorded from the S7 server: model_impact on an unknown element. */
const ELEMENT_NOT_FOUND = {
	jsonrpc: "2.0", id: 1,
	result: {
		isError: true,
		content: [{ type: "text", text: "procurement:nope 不是已加载模型里的元素\n提示：从 details.candidates 里选一个 IRI 重试" }],
		structuredContent: { error: {
			code: "ELEMENT_NOT_FOUND", message: "procurement:nope 不是已加载模型里的元素", retryable: false,
			hint: "从 details.candidates 里选一个 IRI 重试",
			details: { candidates: [{ iri: "https://aisep.example/model/procurement/supplier", label: "供应商" }] },
		} },
	},
};

describe("McpModelClient", () => {
	it("sends one 2026-07-28 tools/call per call, without initialize, with the version in headers and _meta", async () => {
		const f = fakeFetch(ok(gateFixture));
		const client = new McpModelClient(URL, f.fetch);
		await client.gate();
		await client.impact("procurement:quotation", { mode: "ripple", depth: undefined });
		expect(f.seen.map((s) => s.body.method)).toEqual(["tools/call", "tools/call"]);
		const [gate, impact] = f.seen;
		expect(gate.url).toBe(URL);
		expect(gate.headers).toEqual({
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
			"Mcp-Method": "tools/call",
			"Mcp-Name": "model_gate",
		});
		expect(gate.body.params).toMatchObject({
			name: "model_gate",
			arguments: {},
			_meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
		});
		expect(impact.headers["Mcp-Name"]).toBe("model_impact");
		// undefined optionals are dropped: the server rejects unknown fields and does not accept null for them.
		expect(impact.body.params.arguments).toEqual({ focus: "procurement:quotation", mode: "ripple" });
	});

	it("maps each method to its workbench tool", async () => {
		const f = fakeFetch(ok({}));
		const client = new McpModelClient(URL, f.fetch);
		await client.query("ASK {}", { limit: 5 });
		await client.findings({ model: "procurement" });
		await client.diff({ head: { worktree: "feat/x" }, detail: "summary" });
		await client.recordApproval({ model: "procurement", gate: "GateArchitecture", decision: "Approved",
			approvedBy: "x", approves: ["y"], branch: "feat/x", headCommit: "0".repeat(40) });
		expect(f.seen.map((s) => [s.headers["Mcp-Name"], s.body.params.arguments])).toEqual([
			["model_query", { sparql: "ASK {}", limit: 5 }],
			["model_findings", { model: "procurement" }],
			["model_diff", { head: { worktree: "feat/x" }, detail: "summary" }],
			["governance_record_approval", { model: "procurement", gate: "GateArchitecture", decision: "Approved",
				approvedBy: "x", approves: ["y"], branch: "feat/x", headCommit: "0".repeat(40) }],
		]);
	});

	it("returns structuredContent as the typed result", async () => {
		const client = new McpModelClient(URL, fakeFetch(ok(elementsQuery)).fetch);
		const { elements } = elementsFromRows(await client.query("SELECT …"));
		expect(elements).toHaveLength(26);
	});

	it("turns isError into AisepToolError with code, message, hint, retryable and details", async () => {
		const client = new McpModelClient(URL, fakeFetch(() => new Response(JSON.stringify(ELEMENT_NOT_FOUND))).fetch);
		const error = await client.impact("procurement:nope").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AisepToolError);
		expect(error).toMatchObject({
			code: "ELEMENT_NOT_FOUND",
			message: "procurement:nope 不是已加载模型里的元素",
			retryable: false,
			hint: "从 details.candidates 里选一个 IRI 重试",
			details: { candidates: [{ label: "供应商" }] },
		});
	});

	it("turns JSON-RPC errors and HTTP refusals into McpProtocolError", async () => {
		const unknownTool = () =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown tool: x" } }));
		await expect(new McpModelClient(URL, fakeFetch(unknownTool).fetch).gate()).rejects.toMatchObject({
			name: "McpProtocolError",
			rpcCode: -32602,
		});
		const forbidden = () => new Response("Origin not allowed", { status: 403 });
		const error = await new McpModelClient(URL, fakeFetch(forbidden).fetch).gate().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(McpProtocolError);
		expect(error).toMatchObject({ status: 403, rpcCode: undefined });
	});
});

describe("McpModelClient timeouts, cancellation and malformed results", () => {
	afterEach(() => vi.useRealTimers());

	/** A fetch that never answers until its signal aborts, like a hung server. */
	const hanging: typeof fetch = (_input, init) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
		});

	it("gives up after timeoutMs with a retryable McpProtocolError (status 0, timedOut)", async () => {
		vi.useFakeTimers();
		const pending = new McpModelClient(URL, hanging).gate({}, { timeoutMs: 1_000 }).catch((e: unknown) => e);
		await vi.advanceTimersByTimeAsync(999);
		let settled = false;
		void pending.then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const error = await pending;
		expect(error).toBeInstanceOf(McpProtocolError);
		expect(error).toMatchObject({ status: 0, timedOut: true });
		expect(shouldRetryAisep(0, error)).toBe(true);
	});

	it("passes the caller's cancellation through as an AbortError, not a protocol error", async () => {
		const controller = new AbortController();
		const pending = new McpModelClient(URL, hanging).gate({}, { signal: controller.signal }).catch((e: unknown) => e);
		controller.abort();
		const error = await pending;
		expect(error).not.toBeInstanceOf(McpProtocolError);
		expect(error).toMatchObject({ name: "AbortError" });
	});

	it("does not even send when the caller's signal is already aborted", async () => {
		const f = fakeFetch(ok(gateFixture));
		const controller = new AbortController();
		controller.abort();
		const seenSignal: AbortSignal[] = [];
		const error = await new McpModelClient(URL, (input, init) => {
			if (init?.signal) seenSignal.push(init.signal);
			return init?.signal?.aborted ? Promise.reject(new DOMException("aborted", "AbortError")) : f.fetch(input, init);
		})
			.gate({}, { signal: controller.signal })
			.catch((e: unknown) => e);
		expect(seenSignal[0]?.aborted).toBe(true);
		expect(error).toMatchObject({ name: "AbortError" });
	});

	it("turns a fetch that rejects without a response (browser: Origin refused, no CORS headers) into McpProtocolError(0)", async () => {
		const error = await new McpModelClient(URL, () => Promise.reject(new TypeError("Failed to fetch"))).gate().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(McpProtocolError);
		expect(error).toMatchObject({ status: 0, timedOut: false });
		expect((error as Error).message).toMatch(/allow-origin/);
	});

	it("turns isError without a §7.1 error envelope into McpProtocolError, not a TypeError", async () => {
		for (const structuredContent of [{}, { error: "boom" }, { error: { code: "X" } }]) {
			const body = { jsonrpc: "2.0", id: 1, result: { isError: true, content: [], structuredContent } };
			const error = await new McpModelClient(URL, fakeFetch(() => new Response(JSON.stringify(body))).fetch)
				.gate()
				.catch((e: unknown) => e);
			expect(error, JSON.stringify(structuredContent)).toBeInstanceOf(McpProtocolError);
		}
	});
});

describe("shouldRetryAisep (§7.1 retryable)", () => {
	const tool = (code: string, retryable: boolean) => new AisepToolError(code, code, retryable);

	it("retries a tool error only when the server marks it retryable, at most 3 times", () => {
		expect(shouldRetryAisep(0, tool("WORKTREE_CHANGED", true))).toBe(true);
		expect(shouldRetryAisep(2, tool("LOCKED", true))).toBe(true);
		expect(shouldRetryAisep(3, tool("LOCKED", true))).toBe(false);
		expect(shouldRetryAisep(0, tool("REF_NOT_FOUND", false))).toBe(false);
		expect(shouldRetryAisep(0, tool("INVALID_ARGUMENT", false))).toBe(false);
	});

	it("retries no-response and 5xx protocol errors, never 4xx or JSON-RPC refusals", () => {
		expect(shouldRetryAisep(0, new McpProtocolError("x", 0))).toBe(true);
		expect(shouldRetryAisep(0, new McpProtocolError("x", 502))).toBe(true);
		expect(shouldRetryAisep(0, new McpProtocolError("x", 403))).toBe(false);
		expect(shouldRetryAisep(0, new McpProtocolError("x", 200, -32602))).toBe(false);
	});

	it("never retries other errors (e.g. a result that does not parse)", () => {
		expect(shouldRetryAisep(0, new Error("unknown approvalState"))).toBe(false);
	});
});

describe("elementsFromRows", () => {
	const row = (approvalState?: string) => ({
		element: { type: "iri", value: "https://aisep.example/model/procurement/a" },
		type: { type: "iri", value: "https://meta.linked.archi/archimate4/onto#Role" },
		inModel: { type: "iri", value: "https://aisep.example/model/procurement/" },
		prefLabel: { type: "literal", value: "甲", lang: "zh" },
		...(approvalState ? { approvalState: { type: "iri", value: approvalState } } : {}),
	});
	const select = (rows: ReturnType<typeof row>[]) => ({ kind: "select", variables: [], rows, truncated: false }) as QueryResult;

	it("reports truncation instead of passing a partial list off as the whole model", () => {
		const rows = [row("https://meta.linked.archi/core#Proposed")];
		expect(elementsFromRows({ kind: "select", variables: [], rows, truncated: true } as QueryResult).truncated).toBe(true);
		expect(elementsFromRows(select(rows)).truncated).toBe(false);
	});

	it("maps approvalState IRIs (F7)", () => {
		expect(elementsFromRows(select([row("https://aisep.example/ont/aisep#Superseded")])).elements[0].approvalState).toBe("Superseded");
	});

	it("leaves a missing approvalState undefined (never Proposed) and throws on an unknown one", () => {
		expect(elementsFromRows(select([row()])).elements[0].approvalState).toBeUndefined();
		expect(() => elementsFromRows(select([row("https://example.invalid/Approved")]))).toThrow(/approvalState/);
	});

	it("throws UNEXPECTED_RESULT_KIND for a non-SELECT result", () => {
		expect(() => elementsFromRows({ kind: "ask", value: true })).toThrow(
			expect.objectContaining({ code: "UNEXPECTED_RESULT_KIND" }),
		);
	});
});
