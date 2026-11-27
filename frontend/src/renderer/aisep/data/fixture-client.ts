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
	type RenderViewInput,
	type RenderedView,
	type ViewsResult,
} from "./client";
import branchesFixture from "./fixtures/branches.json";
import diffMain from "./fixtures/diff-main.json";
import elementsQuery from "./fixtures/elements-query.json";
import findingsFixture from "./fixtures/findings.json";
import gateFixture from "./fixtures/gate.json";
import pendingQuery from "./fixtures/pending-query.json";
import quotationImpact from "./fixtures/impact-quotation.json";
import viewProcurementLayered from "./fixtures/view-procurement-layered.json";
import viewWorkbenchMotivation from "./fixtures/view-workbench-motivation.json";
import viewWorkbenchStakeholder from "./fixtures/view-workbench-stakeholder.json";
import viewsList from "./fixtures/views-list.json";

const impacts: Record<Iri, ImpactResult> = {
	[quotationImpact.focus.iri]: quotationImpact as ImpactResult,
};

/**
 * Views recorded off aisep PR #174's server on the real models (not the procurement-only test repo): the SVGs are
 * byte-identical to `tools/aisep.py diagram`. Keyed by renderKey of the item's `render`.
 */
const renderedViews: Record<string, RenderedView> = {
	"viewpoint=LayeredViewpoint&model=procurement": viewProcurementLayered as RenderedView,
	"viewpoint=MotivationViewpoint&model=workbench": viewWorkbenchMotivation as RenderedView,
	"viewpoint=StakeholderViewpoint&model=workbench": viewWorkbenchStakeholder as RenderedView,
};

/** A stable key for one model_render_view input. */
export function renderKey(input: RenderViewInput): string {
	return (["view", "viewpoint", "c4viewpoint", "of", "model"] as const)
		.flatMap((field) => (input[field] === undefined ? [] : [`${field}=${input[field]}`]))
		.join("&");
}

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

	/** The recorded list, cut down to the items that have a recorded SVG, so every listed item opens. */
	async listViews(target: { model?: string } = {}): Promise<ViewsResult> {
		const recorded = viewsList as ViewsResult;
		const models = recorded.models
			.filter((model) => target.model === undefined || model.slug === target.model)
			.map((model) => ({
				...model,
				views: model.views.filter((view) => renderKey(view.render) in renderedViews),
				projections: model.projections.filter((projection) => renderKey(projection.render) in renderedViews),
			}));
		return { ...recorded, models };
	}

	async renderView(input: RenderViewInput): Promise<RenderedView> {
		return renderedViews[renderKey(input)] ?? noFixture(`view ${renderKey(input)}`);
	}
}

export const fixtureClient: AisepModelClient = new FixtureClient();
