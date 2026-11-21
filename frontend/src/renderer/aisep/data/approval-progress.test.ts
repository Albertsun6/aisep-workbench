import { describe, expect, it } from "vitest";
import {
	APPROVAL_COVERAGE_QUERY,
	APPROVAL_RECORDS_QUERY,
	approvalCoverage,
	approvalProgress,
	coveringRecords,
	isCovered,
	progressRefs,
	stageOf,
	tipApprovals,
} from "./approval-progress";
import { AisepToolError, type AisepModelClient, type QueryResult } from "./client";
import { fixtureClient } from "./fixture-client";

const AISEP = "https://aisep.example/ont/aisep#";
const APPROVED = `${AISEP}DecisionApproved`;
const REJECTED = `${AISEP}DecisionRejected`;
const BASELINE = "https://aisep.example/model/procurement/approval-20261119-arch-baseline";
const OURS = "https://aisep.example/model/workbench/approval-20261121T101500Z-GateArchitecture-abc1234";
const BRANCH = "claude/workbench-model";
const refs = progressRefs(BRANCH, "refs/remotes/origin/main");

type Records = Record<string, string>;
/** A server answering APPROVAL_RECORDS_QUERY per ref; a ref left out is REF_NOT_FOUND, as on the real server. */
function serverWith(byRef: Record<string, Records>) {
	const calls: { sparql: string; target: unknown }[] = [];
	const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
		query: async (sparql: string, target: { ref: string }): Promise<QueryResult> => {
			calls.push({ sparql, target });
			const records = byRef[target.ref];
			if (!records) throw new AisepToolError("REF_NOT_FOUND", `找不到提交 ${target.ref}`, false, undefined, { ref: target.ref });
			return {
				kind: "select",
				variables: ["record", "decision"],
				truncated: false,
				rows: Object.entries(records).map(([record, decision]) => ({
					record: { type: "iri", value: record },
					decision: { type: "iri", value: decision },
				})),
			};
		},
	});
	return { client, calls };
}

const before = { [BASELINE]: APPROVED };
const after = { ...before, [OURS]: APPROVED };

describe("approval progress", () => {
	it("is pending while the branch tip added no approval record", async () => {
		const { client, calls } = serverWith({ [refs.local]: before, [refs.parent]: before, [refs.main]: before });
		expect(await approvalProgress(client, BRANCH, refs.main)).toEqual({ stage: "pending", records: [], remoteBranch: false });
		// Every read is one SELECT on an explicit full ref, so a tag or an abbreviation never shadows the branch.
		expect(calls.map((call) => call.target)).toEqual(
			[refs.local, refs.parent, refs.secondParent, refs.remote, refs.main].map((ref) => ({ ref, limit: 10_000 })),
		);
		expect(new Set(calls.map((call) => call.sparql))).toEqual(new Set([APPROVAL_RECORDS_QUERY]));
	});

	it("is approved, not pushed, when the tip added a record and origin/<branch> does not exist", async () => {
		const { client } = serverWith({ [refs.local]: after, [refs.parent]: before, [refs.main]: before });
		expect(await approvalProgress(client, BRANCH, refs.main)).toEqual({ stage: "approved", records: [OURS], remoteBranch: false });
	});

	it("is still approved, not pushed, when origin/<branch> exists but lacks the record (pushed before approving)", async () => {
		const { client } = serverWith({ [refs.local]: after, [refs.parent]: before, [refs.remote]: before, [refs.main]: before });
		expect(await approvalProgress(client, BRANCH, refs.main)).toEqual({ stage: "approved", records: [OURS], remoteBranch: true });
	});

	it("needs every record the tip added: one of two pushed is still approved, one of two merged is still pushed", async () => {
		const SECOND = `${OURS}-second`;
		const both = { ...after, [SECOND]: APPROVED };
		const partlyPushed = serverWith({ [refs.local]: both, [refs.parent]: before, [refs.remote]: after, [refs.main]: before });
		expect(await approvalProgress(partlyPushed.client, BRANCH, refs.main)).toEqual({
			stage: "approved",
			records: [OURS, SECOND],
			remoteBranch: true,
		});
		const partlyMerged = serverWith({ [refs.local]: both, [refs.parent]: before, [refs.remote]: both, [refs.main]: after });
		expect((await approvalProgress(partlyMerged.client, BRANCH, refs.main)).stage).toBe("pushed");
	});

	it("is pushed when origin/<branch> has the record and main does not", async () => {
		const { client } = serverWith({ [refs.local]: after, [refs.parent]: before, [refs.remote]: after, [refs.main]: before });
		expect((await approvalProgress(client, BRANCH, refs.main)).stage).toBe("pushed");
	});

	it("is merged when main has the record, even after the remote branch was deleted", async () => {
		const merged = serverWith({ [refs.local]: after, [refs.parent]: before, [refs.remote]: after, [refs.main]: after });
		expect((await approvalProgress(merged.client, BRANCH, refs.main)).stage).toBe("merged");
		const pruned = serverWith({ [refs.local]: after, [refs.parent]: before, [refs.main]: after });
		expect((await approvalProgress(pruned.client, BRANCH, refs.main)).stage).toBe("merged");
	});

	it("is pending when commits follow the approval (the approval is stale, merge check rejects it)", async () => {
		// The record is on the branch but not added by its tip: the tip's parent already has it.
		const { client } = serverWith({ [refs.local]: after, [refs.parent]: after, [refs.remote]: after, [refs.main]: before });
		expect((await approvalProgress(client, BRANCH, refs.main)).stage).toBe("pending");
	});

	it("is pending on a branch cut at a merge commit of main that brought another branch's approval in", async () => {
		const { client } = serverWith({ [refs.local]: after, [refs.parent]: before, [refs.secondParent]: after, [refs.main]: after });
		expect(await approvalProgress(client, BRANCH, refs.main)).toEqual({ stage: "pending", records: [], remoteBranch: false });
	});

	it("does not count a Rejected record as an approval", async () => {
		const { client } = serverWith({ [refs.local]: { ...before, [OURS]: REJECTED }, [refs.parent]: before, [refs.main]: before });
		expect((await approvalProgress(client, BRANCH, refs.main)).stage).toBe("pending");
	});

	it("fails when the local branch or main does not exist, instead of showing a stage", async () => {
		await expect(approvalProgress(serverWith({ [refs.main]: before }).client, BRANCH, refs.main)).rejects.toMatchObject({
			code: "REF_NOT_FOUND",
		});
		await expect(
			approvalProgress(serverWith({ [refs.local]: after, [refs.parent]: before }).client, BRANCH, refs.main),
		).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
	});

	it("passes other server errors through", async () => {
		const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
			query: async () => {
				throw new AisepToolError("INTERNAL", "boom", true);
			},
		});
		await expect(approvalProgress(client, BRANCH)).rejects.toMatchObject({ code: "INTERNAL" });
	});

	it("refuses a truncated record list rather than reading a partial one", async () => {
		const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
			query: async (): Promise<QueryResult> => ({ kind: "select", variables: ["record", "decision"], rows: [], truncated: true }),
		});
		await expect(approvalProgress(client, BRANCH)).rejects.toMatchObject({ code: "RESULT_TRUNCATED" });
	});

	it("treats a root tip (no parent) as having added every record it holds", () => {
		expect(tipApprovals(new Map([[OURS, APPROVED]]), null)).toEqual([OURS]);
		expect(stageOf([], null, null)).toBe("pending");
	});

	it("reads origin/main unless told otherwise", () => {
		expect(progressRefs("a/b")).toEqual({
			local: "refs/heads/a/b",
			parent: "refs/heads/a/b^",
			secondParent: "refs/heads/a/b^2",
			remote: "refs/remotes/origin/a/b",
			main: "refs/remotes/origin/main",
		});
	});
});

// A commit's history for approvalCoverage: history[k] is the record set at `${HEAD}~${k}`; `merges` lists the k whose
// commit has a second parent. `approves` answers APPROVAL_COVERAGE_QUERY at HEAD (record -> gate, elements).
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const ARCH = `${AISEP}GateArchitecture`;
const DESIGN = `${AISEP}GateDesign`;
const W = "https://aisep.example/model/workbench/";
const A1 = `${W}approval-1-architecture`;
const D1 = `${W}approval-2-design`;
const R1 = `${W}approval-3-architecture-rejected`;
function historyServer(
	history: Records[],
	approves: Record<string, [gate: string, elements: string[]]>,
	merges: number[] = [],
) {
	const refs: string[] = [];
	const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
		query: async (sparql: string, target: { ref: string }): Promise<QueryResult> => {
			refs.push(target.ref);
			if (sparql === APPROVAL_COVERAGE_QUERY) {
				expect(target.ref).toBe(HEAD);
				return {
					kind: "select",
					variables: ["record", "gate", "element"],
					truncated: false,
					rows: Object.entries(approves).flatMap(([record, [gate, elements]]) =>
						elements.map((element) => ({
							record: { type: "iri" as const, value: record },
							gate: { type: "iri" as const, value: gate },
							element: { type: "iri" as const, value: element },
						})),
					),
				};
			}
			expect(sparql).toBe(APPROVAL_RECORDS_QUERY);
			const m = target.ref.match(/^([0-9a-f]{40})~(\d+)(\^2)?$/);
			if (!m || m[1] !== HEAD) throw new Error(`unexpected ref ${target.ref}`);
			const k = Number(m[2]);
			const records = m[3] ? (merges.includes(k) ? {} : undefined) : history[k];
			if (!records) throw new AisepToolError("REF_NOT_FOUND", `找不到提交 ${target.ref}`, false);
			return {
				kind: "select",
				variables: ["record", "decision"],
				truncated: false,
				rows: Object.entries(records).map(([record, decision]) => ({
					record: { type: "iri" as const, value: record },
					decision: { type: "iri" as const, value: decision },
				})),
			};
		},
	});
	return { client, refs };
}

describe("approval coverage", () => {
	it("covers the same gate and elements after the head itself became the approval commit (a reload)", async () => {
		const { client } = historyServer([{ ...before, [A1]: APPROVED }, before, before], { [A1]: [ARCH, [`${W}a`, `${W}b`]] });
		const coverage = await approvalCoverage(client, HEAD);
		expect(coverage.records).toEqual([A1]);
		expect(isCovered(coverage, "GateArchitecture", [`${W}a`, `${W}b`])).toBe(true);
		expect(isCovered(coverage, "GateArchitecture", [`${W}a`])).toBe(true);
		expect(coveringRecords(coverage, "GateArchitecture")).toEqual([A1]);
	});

	it("looks past the tip: after Architecture then Design, Architecture is still covered", async () => {
		const { client } = historyServer(
			[{ ...before, [A1]: APPROVED, [D1]: APPROVED }, { ...before, [A1]: APPROVED }, before],
			{ [A1]: [ARCH, [`${W}a`]], [D1]: [DESIGN, [`${W}a`]] },
		);
		const coverage = await approvalCoverage(client, HEAD);
		expect(coverage.records).toEqual([D1, A1]);
		expect(isCovered(coverage, "GateArchitecture", [`${W}a`])).toBe(true);
		expect(isCovered(coverage, "GateDesign", [`${W}a`])).toBe(true);
	});

	it("covers by the union of one gate's records: a then b approved separately covers {a, b}", async () => {
		const A2 = `${W}approval-4-architecture`;
		const { client } = historyServer(
			[{ ...before, [A1]: APPROVED, [A2]: APPROVED }, { ...before, [A1]: APPROVED }, before],
			{ [A1]: [ARCH, [`${W}a`]], [A2]: [ARCH, [`${W}b`]] },
		);
		const coverage = await approvalCoverage(client, HEAD);
		expect(isCovered(coverage, "GateArchitecture", [`${W}a`, `${W}b`])).toBe(true);
		expect(isCovered(coverage, "GateArchitecture", [`${W}a`, `${W}c`])).toBe(false);
		expect(coveringRecords(coverage, "GateArchitecture")).toEqual([A2, A1]);
	});

	it("does not cover another gate, an element outside the approved set, or nothing at all", async () => {
		const { client } = historyServer([{ ...before, [A1]: APPROVED }, before], { [A1]: [ARCH, [`${W}a`]] });
		const coverage = await approvalCoverage(client, HEAD);
		expect(isCovered(coverage, "GateDesign", [`${W}a`])).toBe(false);
		expect(isCovered(coverage, "GateArchitecture", [`${W}a`, `${W}b`])).toBe(false);
		expect(isCovered(coverage, "GateArchitecture", [])).toBe(false);
	});

	it("stops at the effective content commit: an approval followed by new content covers nothing", async () => {
		// head~0 is a content commit (adds no record) on top of the approval commit head~1.
		const { client, refs } = historyServer(
			[{ ...before, [A1]: APPROVED }, { ...before, [A1]: APPROVED }, before],
			{ [A1]: [ARCH, [`${W}a`]] },
		);
		const coverage = await approvalCoverage(client, HEAD);
		expect(coverage.records).toEqual([]);
		expect(isCovered(coverage, "GateArchitecture", [`${W}a`])).toBe(false);
		expect(refs).not.toContain(HEAD); // nothing to look up when no record was added
	});

	it("walks over a Rejected record but lets only Approved ones cover", async () => {
		const { client } = historyServer([{ ...before, [R1]: REJECTED }, before], {});
		const coverage = await approvalCoverage(client, HEAD);
		expect(coverage.records).toEqual([R1]);
		expect(isCovered(coverage, "GateArchitecture", [`${W}a`])).toBe(false);
	});

	it("stops at a merge commit, like the merge check (merge-commit-in-range)", async () => {
		const { client } = historyServer([{ ...before, [A1]: APPROVED }, before], { [A1]: [ARCH, [`${W}a`]] }, [0]);
		const coverage = await approvalCoverage(client, HEAD);
		expect(coverage.records).toEqual([]);
	});

	it("fails rather than guess when the records cannot be read", async () => {
		const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
			query: async () => {
				throw new AisepToolError("INTERNAL", "boom", true);
			},
		});
		await expect(approvalCoverage(client, HEAD)).rejects.toMatchObject({ code: "INTERNAL" });
	});
});
