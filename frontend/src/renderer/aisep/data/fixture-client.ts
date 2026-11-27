// Offline fallback: answers from fixtures recorded off a real AISEP MCP Server on the procurement example
// (mcp-client.integration.test.ts with AISEP_RECORD_FIXTURES=1). Read-only; answers only the calls it has a fixture for.
import {
	AisepToolError,
	ELEMENTS_QUERY,
	PENDING_QUERY,
	type AisepModelClient,
	type ApprovalResult,
	type BranchesResult,
	type CallLogResult,
	type DiffInput,
	type DiffResult,
	type FindingsResult,
	type GateResult,
	type ImpactResult,
	type Iri,
	type ListActionsResult,
	type QueryResult,
} from "./client";
import branchesFixture from "./fixtures/branches.json";
import diffMain from "./fixtures/diff-main.json";
import elementsQuery from "./fixtures/elements-query.json";
import findingsFixture from "./fixtures/findings.json";
import gateFixture from "./fixtures/gate.json";
import pendingQuery from "./fixtures/pending-query.json";
import quotationImpact from "./fixtures/impact-quotation.json";

const impacts: Record<Iri, ImpactResult> = {
	[quotationImpact.focus.iri]: quotationImpact as ImpactResult,
};

function noFixture(what: string): never {
	throw new AisepToolError("NO_FIXTURE", `fixture client has no answer for ${what}`, false);
}

export class FixtureClient implements AisepModelClient {
	async query(sparql: string): Promise<QueryResult> {
		if (sparql === ELEMENTS_QUERY) return elementsQuery as QueryResult;
		if (sparql === PENDING_QUERY) return pendingQuery as QueryResult;
		return noFixture("this query (only ELEMENTS_QUERY and PENDING_QUERY)");
	}

	async gate(): Promise<GateResult> {
		return gateFixture as GateResult;
	}

	async findings(): Promise<FindingsResult> {
		return findingsFixture as FindingsResult;
	}

	async impact(focus: Iri): Promise<ImpactResult> {
		return impacts[focus] ?? noFixture(`impact of ${focus}`);
	}

	async diff(input: DiffInput): Promise<DiffResult> {
		if (input.head !== "main") noFixture(`diff of ${JSON.stringify(input.head)}`);
		return diffMain as DiffResult;
	}

	async recordApproval(): Promise<ApprovalResult> {
		throw new AisepToolError("READ_ONLY_FIXTURE", "fixture client is read-only", false);
	}

	async branches(): Promise<BranchesResult> {
		return branchesFixture as BranchesResult;
	}

	// No recording yet: model_call_log does not exist and model_list_actions is not in the workbench profile, so there
	// is nothing to record from (fixtures are never hand-written). The pages fall back to data/samples.ts and say so.
	async callLog(): Promise<CallLogResult> {
		return noFixture("model_call_log (not on the server yet)");
	}

	async listActions(): Promise<ListActionsResult> {
		return noFixture("model_list_actions (not in the workbench profile yet)");
	}
}

export const fixtureClient: AisepModelClient = new FixtureClient();
