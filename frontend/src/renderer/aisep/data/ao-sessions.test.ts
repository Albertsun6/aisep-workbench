import { describe, expect, it } from "vitest";
import type { components } from "../../../api/schema";
import {
	agentSessionRows,
	aoSessionSource,
	STATUS_BUCKETS,
	toAgentSessionRow,
	type AgentSessionBucket,
	type AoSessionStatus,
} from "./ao-sessions";

type AoSession = components["schemas"]["ControllersSessionView"];

function aoSession(overrides: Partial<AoSession> = {}): AoSession {
	return {
		id: "s-1",
		status: "working",
		isTerminated: false,
		kanbanColumn: "building",
		harness: "claude-code",
		branch: "feat/quotation",
		displayName: "补报价审批流程",
		...overrides,
	} as AoSession;
}

// Written out by hand (not derived from STATUS_BUCKETS) so the test pins the proposal.
const expected: [AoSessionStatus, AgentSessionBucket][] = [
	["working", "inProgress"],
	["idle", "inProgress"],
	["needs_input", "needsYou"],
	["exited", "needsYou"],
	["no_signal", "needsYou"],
	["pr_open", "inReview"],
	["draft", "inReview"],
	["review_pending", "inReview"],
	["ci_failed", "needsYou"],
	["changes_requested", "needsYou"],
	["commented", "needsYou"],
	["approved", "needsYou"],
	["mergeable", "needsYou"],
	["merged", "finished"],
	["terminated", "finished"],
];

describe("AO session adapter", () => {
	it("covers all 15 AO statuses, no more and no fewer", () => {
		expect(expected).toHaveLength(15);
		expect(Object.keys(STATUS_BUCKETS).sort()).toEqual(expected.map(([status]) => status).sort());
	});

	it.each(expected)("maps status %s to bucket %s", (status, bucket) => {
		const row = toAgentSessionRow(aoSession({ status }));
		expect(row.bucket).toBe(bucket);
		expect(row.rawStatus).toBe(status);
	});

	it("maps AO fields to the AISEP row", () => {
		expect(toAgentSessionRow(aoSession())).toEqual({
			sessionRef: "s-1",
			agent: "Claude Code",
			task: "补报价审批流程",
			branch: "feat/quotation",
			bucket: "inProgress",
			rawStatus: "working",
		});
	});

	it("uses AO's title precedence and tolerates missing agent and branch", () => {
		const row = toAgentSessionRow(
			aoSession({ terminalTitle: "terminal title", harness: undefined, branch: "", displayName: "x" }),
		);
		expect(row.task).toBe("terminal title");
		expect(row.agent).toBeUndefined();
		expect(row.branch).toBeUndefined();
		expect(toAgentSessionRow(aoSession({ displayName: undefined, issueId: "ISS-7" })).task).toBe("ISS-7");
		expect(toAgentSessionRow(aoSession({ displayName: undefined })).task).toBe("s-1");
	});

	it("leaves archived sessions out, including a terminated one whose PR merged", () => {
		const rows = agentSessionRows([
			aoSession({ id: "live" }),
			aoSession({ id: "terminated", status: "terminated", isTerminated: true, kanbanColumn: "archive" }),
			aoSession({ id: "merged-then-terminated", status: "merged", isTerminated: true, kanbanColumn: "archive" }),
			aoSession({ id: "archive-column", kanbanColumn: "archive" }),
			aoSession({ id: "merged-live", status: "merged", kanbanColumn: "ready" }),
		]);
		expect(rows.map((row) => row.sessionRef)).toEqual(["live", "merged-live"]);
	});

	it("rejects when the AO daemon is not reachable", async () => {
		await expect(aoSessionSource.list()).rejects.toThrow();
	});
});
