import { describe, expect, it } from "vitest";
import { APPROVAL_RECORDS_QUERY, approvalProgress, progressRefs, stageOf, tipApprovals } from "./approval-progress";
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
