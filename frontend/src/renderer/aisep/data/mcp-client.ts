// AISEP MCP Server over Streamable HTTP (aisep docs/mcp-interface.md §3.2, §8 step 2). Hand-written for protocol
// 2026-07-28 only: no initialize, no session; every POST carries the version in a header and in params._meta.
// No @modelcontextprotocol/sdk dependency: it would change upstream's package.json and lockfile (P10).
import {
	AisepToolError,
	type AisepModelClient,
	type ApprovalInput,
	type ApprovalResult,
	type DiffInput,
	type DiffResult,
	type FindingsResult,
	type GateResult,
	type ImpactMode,
	type ImpactResult,
	type Iri,
	type QueryResult,
	type Target,
} from "./client";

export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** The request was not a tool result: HTTP refusal (403 Origin, 400 headers) or a JSON-RPC error (-32602 unknown tool). */
export class McpProtocolError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly rpcCode?: number,
	) {
		super(message);
		this.name = "McpProtocolError";
	}
}

type ErrorEnvelope = { code: string; message: string; hint?: string; retryable: boolean; details?: Record<string, unknown> };
type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

let nextId = 1;

/** One tools/call. Returns structuredContent; isError -> AisepToolError (§5.0: structuredContent is authoritative). */
export async function callMcpTool(
	endpoint: string,
	name: string,
	args: Record<string, unknown>,
	fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
			"Mcp-Method": "tools/call",
			"Mcp-Name": name,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: nextId++,
			method: "tools/call",
			params: {
				name,
				arguments: args,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
					"io.modelcontextprotocol/clientCapabilities": {},
					"io.modelcontextprotocol/clientInfo": { name: "aisep-workbench", version: "0.1.0" },
				},
			},
		}),
	});
	const text = await response.text();
	let body: { result?: ToolResult; error?: { code: number; message: string } } | undefined;
	try {
		body = JSON.parse(text);
	} catch {
		throw new McpProtocolError(`${name}: HTTP ${response.status}: ${text.slice(0, 200)}`, response.status);
	}
	if (body?.error) throw new McpProtocolError(`${name}: ${body.error.message}`, response.status, body.error.code);
	const result = body?.result;
	if (!response.ok || !result?.structuredContent) {
		throw new McpProtocolError(`${name}: HTTP ${response.status}: no structuredContent`, response.status);
	}
	if (result.isError) {
		const e = result.structuredContent.error as ErrorEnvelope;
		throw new AisepToolError(e.code, e.message, e.retryable, e.hint, e.details);
	}
	return result.structuredContent;
}

/** Drops undefined values so optional parameters are left out (the server rejects unknown or null fields). */
function defined(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

export class McpModelClient implements AisepModelClient {
	constructor(
		readonly endpoint: string,
		private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
	) {}

	private call<T>(name: string, args: Record<string, unknown>): Promise<T> {
		return callMcpTool(this.endpoint, name, defined(args), this.fetchImpl) as Promise<T>;
	}

	query(sparql: string, target: Target & { limit?: number } = {}): Promise<QueryResult> {
		return this.call("model_query", { sparql, ...target });
	}

	gate(target: Target & { model?: string } = {}): Promise<GateResult> {
		return this.call("model_gate", { ...target });
	}

	findings(target: Target & { model?: string } = {}): Promise<FindingsResult> {
		return this.call("model_findings", { ...target });
	}

	impact(
		focus: Iri,
		options: Target & { mode?: ImpactMode; depth?: number; allowInvalid?: boolean } = {},
	): Promise<ImpactResult> {
		return this.call("model_impact", { focus, ...options });
	}

	diff(input: DiffInput): Promise<DiffResult> {
		return this.call("model_diff", { ...input });
	}

	recordApproval(input: ApprovalInput): Promise<ApprovalResult> {
		return this.call("governance_record_approval", { ...input });
	}
}
