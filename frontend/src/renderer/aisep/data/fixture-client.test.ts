import { describe, expect, it } from "vitest";
import { AisepToolError, ELEMENTS_QUERY, PENDING_QUERY, elementsFromRows } from "./client";
import { fixtureClient } from "./fixture-client";

const MODEL = "https://aisep.example/model/procurement/";
const APPROVAL_STATES = ["Proposed", "Approved", "Rejected", "Superseded"];

describe("FixtureClient (recorded from the real server)", () => {
	it("returns the procurement elements with §3 IRIs and derived approval states, without the approval record", async () => {
		const { elements } = elementsFromRows(await fixtureClient.query(ELEMENTS_QUERY));
		expect(elements).toHaveLength(26);
		for (const element of elements) {
			expect(element.inModel).toBe(MODEL);
			expect(element.iri.startsWith(MODEL)).toBe(true);
			if (element.approvalState !== undefined) expect(APPROVAL_STATES).toContain(element.approvalState);
		}
		expect(elements.map((e) => e.prefLabel)).toContain("首席架构师");
		expect(elements.map((e) => e.iri)).not.toContain(`${MODEL}approval-20261119-arch-baseline`);
		expect(elements.filter((e) => e.approvalState === "Approved").map((e) => e.prefLabel)).toEqual(["报价审批"]);
	});

	it("answers the pending query with Proposed elements only, without the approval record", async () => {
		const { elements } = elementsFromRows(await fixtureClient.query(PENDING_QUERY));
		expect(elements.length).toBeGreaterThan(0);
		for (const element of elements) expect(element.approvalState).toBe("Proposed");
		expect(elements.map((e) => e.prefLabel)).not.toContain("报价审批");
		expect(elements.map((e) => e.iri)).not.toContain(`${MODEL}approval-20261119-arch-baseline`);
	});

	it("answers impact of 报价单 with structured paths within the default depth", async () => {
		const result = await fixtureClient.impact(`${MODEL}quotation`);
		expect(result.mode).toBe("depends");
		expect(result.depth).toBe(3);
		expect(result.items.map((item) => item.iri.slice(MODEL.length))).toEqual(
			expect.arrayContaining(["procurementManager", "quoteApproval", "reqTwoLevelApproval", "submitQuotation", "supplier"]),
		);
		for (const item of result.items) {
			expect(item.depth).toBeLessThanOrEqual(3);
			expect(item.path[0].from).toBe(`${MODEL}quotation`);
			expect(item.path.at(-1)?.to).toBe(item.iri);
		}
	});

	it("answers gate, findings and the main diff", async () => {
		expect((await fixtureClient.gate()).result).toBe("PASS");
		expect((await fixtureClient.findings()).openViolations.count).toBe(0);
		expect((await fixtureClient.diff({ head: "main" })).changedElementCount).toBe(0);
	});

	it("answers model_branches with branches recorded off a live server", async () => {
		const { branches, main } = await fixtureClient.branches();
		expect(main.ref).toBe("refs/heads/main");
		expect(branches.map((b) => b.branch)).toEqual([...branches.map((b) => b.branch)].sort());
		expect(branches.find((b) => b.branch === "feat/clean")).toMatchObject({ hasModelChanges: true, mergedIntoMain: false });
	});

	it("is read-only and rejects calls it has no fixture for", async () => {
		const approval = fixtureClient.recordApproval({
			model: "procurement", gate: "GateArchitecture", decision: "Approved", approvedBy: `${MODEL}x`,
			approves: [], branch: "main", headCommit: "0".repeat(40),
		});
		await expect(approval).rejects.toMatchObject({ code: "READ_ONLY_FIXTURE" });
		await expect(fixtureClient.query("SELECT * WHERE { ?s ?p ?o }")).rejects.toBeInstanceOf(AisepToolError);
		await expect(fixtureClient.impact(`${MODEL}supplier`)).rejects.toMatchObject({ code: "NO_FIXTURE" });
		await expect(fixtureClient.diff({ head: { worktree: "feat/x" } })).rejects.toMatchObject({ code: "NO_FIXTURE" });
	});
});
