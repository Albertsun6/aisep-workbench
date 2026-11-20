// McpModelClient with a fake fetch fed real server responses (aisep §8 step 2). The live-server run is
// mcp-client.integration.test.ts.
import { describe, expect, it } from "vitest";
import { AisepToolError, elementsFromRows, type QueryResult } from "./client";
import elementsQuery from "./fixtures/elements-query.json";
import gateFixture from "./fixtures/gate.json";
import { MCP_PROTOCOL_VERSION, McpModelClient, McpProtocolError } from "./mcp-client";

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
		const elements = elementsFromRows(await client.query("SELECT …"));
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

describe("elementsFromRows", () => {
	const row = (approvalState?: string) => ({
		element: { type: "iri", value: "https://aisep.example/model/procurement/a" },
		type: { type: "iri", value: "https://meta.linked.archi/archimate4/onto#Role" },
		inModel: { type: "iri", value: "https://aisep.example/model/procurement/" },
		prefLabel: { type: "literal", value: "甲", lang: "zh" },
		...(approvalState ? { approvalState: { type: "iri", value: approvalState } } : {}),
	});
	const select = (rows: ReturnType<typeof row>[]) => ({ kind: "select", variables: [], rows, truncated: false }) as QueryResult;

	it("maps approvalState IRIs (F7)", () => {
		expect(elementsFromRows(select([row("https://aisep.example/ont/aisep#Superseded")]))[0].approvalState).toBe("Superseded");
	});

	it("throws on a missing or unknown approvalState instead of defaulting to Proposed", () => {
		expect(() => elementsFromRows(select([row()]))).toThrow(/approvalState/);
		expect(() => elementsFromRows(select([row("https://example.invalid/Approved")]))).toThrow(/approvalState/);
	});

	it("throws UNEXPECTED_RESULT_KIND for a non-SELECT result", () => {
		expect(() => elementsFromRows({ kind: "ask", value: true })).toThrow(
			expect.objectContaining({ code: "UNEXPECTED_RESULT_KIND" }),
		);
	});
});
