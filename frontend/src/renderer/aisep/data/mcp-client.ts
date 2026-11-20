// AISEP MCP Server over Streamable HTTP (aisep docs/mcp-interface.md §3.2, §8 step 2). Hand-written for protocol
// 2026-07-28 only: no initialize, no session; every POST carries the version in a header and in params._meta.
// No @modelcontextprotocol/sdk dependency: it would change upstream's package.json and lockfile (P10).
import {
	AisepToolError,
	type AisepModelClient,
	type ApprovalInput,
	type CallOptions,
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

/**
 * The request did not produce a tool result: HTTP refusal (400 headers), a JSON-RPC error (-32602 unknown tool), or
 * no HTTP response at all (status 0: server down, timeout, or, in a browser, an Origin outside the server's
 * --allow-origin list, whose 403 carries no CORS headers and so reaches fetch only as a network error).
 */
export class McpProtocolError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly rpcCode?: number,
		readonly timedOut = false,
	) {
		super(message);
		this.name = "McpProtocolError";
	}
}

/** model_gate takes ≈5 s on the procurement example (§5.4); the server's own query timeout is 10 s (§5.6). */
export const MCP_DEFAULT_TIMEOUT_MS = 60_000;

type ErrorEnvelope = { code: string; message: string; hint?: string; retryable: boolean; details?: Record<string, unknown> };
type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

let nextId = 1;

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
	const e = value as ErrorEnvelope | undefined;
	return typeof e?.code === "string" && typeof e.message === "string" && typeof e.retryable === "boolean";
}

/** One tools/call. Returns structuredContent; isError -> AisepToolError (§5.0: structuredContent is authoritative). */
export async function callMcpTool(
	endpoint: string,
	name: string,
	args: Record<string, unknown>,
	fetchImpl: typeof fetch = fetch,
	{ signal, timeoutMs = MCP_DEFAULT_TIMEOUT_MS }: CallOptions = {},
): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	signal?.addEventListener("abort", onAbort);
	let response: Response;
	let text: string;
	try {
		response = await fetchImpl(endpoint, {
			method: "POST",
			signal: controller.signal,
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
		text = await response.text();
	} catch (cause) {
		// A caller's own cancellation stays an AbortError, so TanStack Query treats it as cancelled, not failed.
		if (signal?.aborted && !timedOut) throw cause;
		const why = timedOut
			? `timed out after ${timeoutMs} ms`
			: `no response (server not running, or this page's Origin is not in its --allow-origin list): ${String(cause)}`;
		throw new McpProtocolError(`${name}: ${why}`, 0, undefined, timedOut);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
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
		const e = result.structuredContent.error;
		if (!isErrorEnvelope(e)) {
			throw new McpProtocolError(`${name}: isError without a §7.1 error envelope in structuredContent`, response.status);
		}
		throw new AisepToolError(e.code, e.message, e.retryable, e.hint, e.details);
	}
	return result.structuredContent;
}

/**
 * TanStack Query `retry` for AISEP calls: a tool error is retried only when the server says it is retryable (§7.1:
 * LOCKED, CONFLICT, WORKTREE_CHANGED, QUERY_TIMEOUT …); a protocol error only when no response came back or the
 * server failed (5xx); a 4xx or JSON-RPC refusal, and anything thrown while reading the result, never.
 */
export function shouldRetryAisep(failureCount: number, error: unknown): boolean {
	if (failureCount >= 3) return false;
	if (error instanceof AisepToolError) return error.retryable;
	if (error instanceof McpProtocolError) return error.rpcCode === undefined && (error.status === 0 || error.status >= 500);
	return false;
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

	private call<T>(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<T> {
		return callMcpTool(this.endpoint, name, defined(args), this.fetchImpl, options) as Promise<T>;
	}

	query(sparql: string, target: Target & { limit?: number } = {}, options?: CallOptions): Promise<QueryResult> {
		return this.call("model_query", { sparql, ...target }, options);
	}

	gate(target: Target & { model?: string } = {}, options?: CallOptions): Promise<GateResult> {
		return this.call("model_gate", { ...target }, options);
	}

	findings(target: Target & { model?: string } = {}, options?: CallOptions): Promise<FindingsResult> {
		return this.call("model_findings", { ...target }, options);
	}

	impact(
		focus: Iri,
		options: Target & { mode?: ImpactMode; depth?: number; allowInvalid?: boolean } = {},
		callOptions?: CallOptions,
	): Promise<ImpactResult> {
		return this.call("model_impact", { focus, ...options }, callOptions);
	}

	diff(input: DiffInput, options?: CallOptions): Promise<DiffResult> {
		return this.call("model_diff", { ...input }, options);
	}

	recordApproval(input: ApprovalInput, options?: CallOptions): Promise<ApprovalResult> {
		return this.call("governance_record_approval", { ...input }, options);
	}
}
