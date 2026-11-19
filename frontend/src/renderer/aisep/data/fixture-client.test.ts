import { describe, expect, it } from "vitest";
import { DEFAULT_IMPACT_DEPTH, ELEMENTS_QUERY, elementsFromRows } from "./client";
import { fixtureClient } from "./fixture-client";

const MODEL = "https://aisep.example/model/procurement/";
const APPROVAL_STATES = ["Proposed", "Approved", "Rejected", "Superseded"];

describe("FixtureClient (PROVISIONAL)", () => {
	it("returns the procurement elements with §3 IRIs and §6.6 approval states", async () => {
		const elements = elementsFromRows(await fixtureClient.query(ELEMENTS_QUERY));
		expect(elements).toHaveLength(8);
		for (const element of elements) {
			expect(element.inModel).toBe(MODEL);
			expect(element.iri.startsWith(MODEL)).toBe(true);
			expect(element.iri.slice(MODEL.length)).toMatch(/^[a-z][A-Za-z0-9]*$/);
			expect(APPROVAL_STATES).toContain(element.approvalState);
		}
	});

	it("answers impact of 报价单 with the §9 depends-mode set (5 elements within the default depth)", async () => {
		const result = await fixtureClient.impact(`${MODEL}quotation`);
		expect(result.mode).toBe("depends");
		expect(result.depth).toBe(DEFAULT_IMPACT_DEPTH);
		expect(result.items.map((item) => item.iri.slice(MODEL.length)).sort()).toEqual(
			["procurementManager", "quoteApproval", "reqTwoLevelApproval", "submitQuotation", "supplier"],
		);
		for (const item of result.items) expect(item.depth).toBeLessThanOrEqual(DEFAULT_IMPACT_DEPTH);
	});

	it("is read-only and rejects queries it has no fixture for", async () => {
		await expect(fixtureClient.write({ tool: "model.remove", iri: `${MODEL}supplier` })).resolves.toMatchObject({ accepted: false });
		await expect(fixtureClient.query("SELECT * WHERE { ?s ?p ?o }")).rejects.toThrow();
	});
});
