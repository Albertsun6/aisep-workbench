// Example data for the two pages whose server tool is not reachable yet, kept apart from ./fixtures/ (fixtures are
// recorded off a real server, never hand-written). Source: coordination/workbench-readonly-contract-20261127.md
//   samples/call-log.json     = example A: the PROPOSED model_call_log shape, illustrative values, not a recording.
//   samples/list-actions.ts   = example B: model_list_actions run on aisep main (not via the workbench profile, which
//                               does not list the tool yet), typed as ListActionsResult.
// Once the tools are live, record real fixtures (AISEP_RECORD_FIXTURES=1) and delete these.
import { AisepToolError, type CallLogInput, type CallLogResult } from "./client";
import { McpProtocolError } from "./mcp-client";
import callLogJson from "./samples/call-log.json";

export { LIST_ACTIONS_SAMPLE } from "./samples/list-actions";
export const CALL_LOG_SAMPLE = callLogJson as CallLogResult;

/** JSON-RPC INVALID_PARAMS: what the server answers for a tool its profile does not list ("Unknown tool: …"). */
const INVALID_PARAMS = -32602;

/**
 * The tool is not there to call: the fixture client has no recording (NO_FIXTURE), or the server refused the tool
 * name. Anything else (server down, a tool error) is a real failure and must be shown as one, not papered over.
 */
export function isUnconnected(error: unknown): boolean {
	if (error instanceof AisepToolError) return error.code === "NO_FIXTURE";
	return error instanceof McpProtocolError && error.rpcCode === INVALID_PARAMS && /Unknown tool/i.test(error.message);
}

/** A page's data and whether it is the example data (the page must then say so). */
export interface Sourced<T> {
	data: T;
	sample: boolean;
}

export async function orSample<T>(load: () => Promise<T>, sample: () => T): Promise<Sourced<T>> {
	try {
		return { data: await load(), sample: false };
	} catch (error) {
		if (isUnconnected(error)) return { data: sample(), sample: true };
		throw error;
	}
}

/**
 * The call-log sample answered as the proposed tool would (contract §1.1): same filters, newest first. The sample is
 * the whole log, so there is never an older page.
 */
export function callLogSample(input: CallLogInput = {}): CallLogResult {
	const { tools, outcome, model } = input;
	const items = CALL_LOG_SAMPLE.items.filter(({ measured }) => {
		if (tools?.length && !tools.includes(measured.tool)) return false;
		if (model && measured.request.model !== model) return false;
		if (outcome === "rejected") return measured.outcome !== "ok";
		return !outcome || measured.outcome === outcome;
	});
	return { ...CALL_LOG_SAMPLE, items, nextCursor: null };
}
