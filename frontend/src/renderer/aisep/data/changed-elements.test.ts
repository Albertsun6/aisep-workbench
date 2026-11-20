// branchChanges / changedElementsView on answers recorded from the S7 server (mcp-client.integration.test.ts).
import { describe, expect, it } from "vitest";
import { branchChanges, changedElementsView } from "./changed-elements";
import { AisepToolError, type AisepModelClient, type DiffInput, type DiffResult } from "./client";
import { fixtureClient } from "./fixture-client";
import diffRefFallback from "./fixtures/diff-ref-fallback.json";
import diffWtDirty from "./fixtures/diff-wt-dirty.json";
import refNotFound from "./fixtures/error-ref-not-found.json";
import worktreeNotFound from "./fixtures/error-worktree-not-found.json";

type Envelope = { code: string; message: string; hint?: string; retryable: boolean; details?: Record<string, unknown> };
const toolError = (e: Envelope) => new AisepToolError(e.code, e.message, e.retryable, e.hint, e.details);

function diffClient(answer: (input: DiffInput) => DiffResult | Error): { client: AisepModelClient; calls: DiffInput[] } {
	const calls: DiffInput[] = [];
	const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
		diff: async (input: DiffInput) => {
			calls.push(input);
			const result = answer(input);
			if (result instanceof Error) throw result;
			return result;
		},
	});
	return { client, calls };
}

describe("branchChanges", () => {
	it("asks for the worktree (summary) first", async () => {
		const { client, calls } = diffClient(() => diffWtDirty as DiffResult);
		const { result, viaRef } = await branchChanges(client, "feat/edit");
		expect(calls).toEqual([{ head: { worktree: "feat/edit" }, detail: "summary" }]);
		expect(viaRef).toBe(false);
		expect(result.changedElementCount).toBe(2);
	});

	it("falls back to the Git ref on WORKTREE_NOT_FOUND and PATH_OUTSIDE_ROOT", async () => {
		for (const code of ["WORKTREE_NOT_FOUND", "PATH_OUTSIDE_ROOT"]) {
			const { client, calls } = diffClient((input) =>
				typeof input.head === "string"
					? (diffRefFallback as DiffResult)
					: toolError({ ...(worktreeNotFound as Envelope), code }),
			);
			const { viaRef, result } = await branchChanges(client, "feat/gone");
			expect(calls.map((c) => c.head), code).toEqual([{ worktree: "feat/gone" }, "feat/gone"]);
			expect(viaRef).toBe(true);
			expect(result.changedElementCount).toBe(1);
		}
	});

	it("does not fall back on other errors", async () => {
		const { client, calls } = diffClient(() => toolError(refNotFound as Envelope));
		await expect(branchChanges(client, "x")).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
		expect(calls).toHaveLength(1);
	});
});

describe("changedElementsView (§5.8 error table)", () => {
	it.each([
		["REF_NOT_FOUND", "branchNotInRepo"],
		["WORKTREE_NOT_FOUND", "branchNotInRepo"],
		["NO_MERGE_BASE", "cannotCompare"],
		["AMBIGUOUS_MERGE_BASE", "cannotCompare"],
		["DIFF_PARSE_FAILED", "parseFailed"],
		["DIFF_BNODE_UNSUPPORTED", "parseFailed"],
		["INTERNAL", "unavailable"],
	])("%s -> %s", (code, kind) => {
		expect(changedElementsView(undefined, new AisepToolError(code, code, false)).kind).toBe(kind);
	});

	it("shows the error, not the last count, when a later refetch fails otherwise", () => {
		const last = { result: diffWtDirty as DiffResult, viaRef: false };
		expect(changedElementsView(last, toolError(refNotFound as Envelope)).kind).toBe("branchNotInRepo");
		expect(changedElementsView(last, new Error("socket hang up")).kind).toBe("unavailable");
		expect(changedElementsView(last, null)).toMatchObject({ kind: "count", count: 2 });
	});

	it("keeps the last count when a refetch fails (WORKTREE_CHANGED)", () => {
		const view = changedElementsView({ result: diffWtDirty as DiffResult, viaRef: false }, new AisepToolError("WORKTREE_CHANGED", "", true));
		expect(view).toMatchObject({ kind: "count", count: 2, dirty: true });
	});
});
