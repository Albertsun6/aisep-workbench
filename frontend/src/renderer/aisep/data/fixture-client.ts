// PROVISIONAL fixture-backed client: read-only, answers only the queries the
// workbench issues. Swap for the MCP Server client once ADR-008 lands.
import {
	ELEMENTS_QUERY,
	type AisepModelClient,
	type CheckResult,
	type ImpactResult,
	type Iri,
	type ModelElement,
	type QueryResult,
	type WriteResult,
} from "./client";
import elementsFixture from "./fixtures/elements.json";
import quotationImpact from "./fixtures/impact-quotation.json";

const elements = elementsFixture.elements as ModelElement[];
const impacts: Record<Iri, ImpactResult> = {
	[quotationImpact.focus]: quotationImpact as ImpactResult,
};

export class FixtureClient implements AisepModelClient {
	async write(): Promise<WriteResult> {
		return { accepted: false, reason: "fixture client is read-only" };
	}

	async check(): Promise<CheckResult> {
		return { ok: true, findings: [] };
	}

	async query(sparql: string): Promise<QueryResult> {
		if (sparql !== ELEMENTS_QUERY) throw new Error("fixture client only answers ELEMENTS_QUERY");
		return {
			variables: ["element", "type", "inModel", "prefLabel", "approvalState"],
			rows: elements.map((element) => ({
				element: element.iri,
				type: element.type,
				inModel: element.inModel,
				prefLabel: element.prefLabel,
				approvalState: element.approvalState,
			})),
		};
	}

	async impact(focus: Iri): Promise<ImpactResult> {
		const result = impacts[focus];
		if (!result) throw new Error(`no impact fixture for ${focus}`);
		return result;
	}
}

export const fixtureClient: AisepModelClient = new FixtureClient();
