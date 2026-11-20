// "改动元素" column of the AI activity area (aisep docs/mcp-interface.md §8 step 4, §5.8 "两个用途怎么调").
import { AisepToolError, type AisepModelClient, type CallOptions, type DiffResult } from "./client";

/** The branch's worktree is not usable (cleaned up, only on the remote, outside --allow-root): use the Git ref. */
const FALLBACK_TO_REF = new Set(["WORKTREE_NOT_FOUND", "PATH_OUTSIDE_ROOT"]);

export interface BranchChanges {
	result: DiffResult;
	/** True when the worktree was not usable and the result counts committed content only. */
	viaRef: boolean;
}

/** Worktree mode first (includes uncommitted edits), then the Git ref; any other error propagates. */
export async function branchChanges(client: AisepModelClient, branch: string, options?: CallOptions): Promise<BranchChanges> {
	try {
		return { result: await client.diff({ head: { worktree: branch }, detail: "summary" }, options), viaRef: false };
	} catch (error) {
		if (!(error instanceof AisepToolError && FALLBACK_TO_REF.has(error.code))) throw error;
		return { result: await client.diff({ head: branch, detail: "summary" }, options), viaRef: true };
	}
}

export type ChangedElementsView =
	| { kind: "count"; count: number; dirty: boolean; incomplete: boolean; failedFiles: string[]; viaRef: boolean;
		baseCommit: string; counts: DiffResult["counts"] }
	| { kind: "noModels" }
	| { kind: "branchNotInRepo" }
	| { kind: "cannotCompare" }
	| { kind: "parseFailed" }
	| { kind: "unavailable" };

/** §5.8 error table, worktree-mode column; anything unknown is "unavailable". */
export function changedElementsView(data: BranchChanges | undefined, error: unknown): ChangedElementsView {
	// TanStack keeps the last data on a failed refetch. Only WORKTREE_CHANGED keeps showing it ("保留上次的数字");
	// any other error (the branch was deleted, the merge base became ambiguous …) replaces the stale number.
	const keepLast = error == null || (error instanceof AisepToolError && error.code === "WORKTREE_CHANGED");
	if (data && keepLast) {
		const { result, viaRef } = data;
		if (!result.baseHasModels && !result.headHasModels) return { kind: "noModels" };
		return {
			kind: "count",
			count: result.changedElementCount,
			dirty: result.head.kind === "worktree" && result.head.dirty,
			incomplete: result.incomplete,
			failedFiles: result.failedFiles.map((f) => f.file),
			viaRef,
			baseCommit: result.base.commit,
			counts: result.counts,
		};
	}
	const code = error instanceof AisepToolError ? error.code : undefined;
	switch (code) {
		case "REF_NOT_FOUND":
		case "WORKTREE_NOT_FOUND":
			return { kind: "branchNotInRepo" };
		case "NO_MERGE_BASE":
		case "AMBIGUOUS_MERGE_BASE":
			return { kind: "cannotCompare" };
		case "DIFF_PARSE_FAILED":
		case "DIFF_BNODE_UNSUPPORTED":
			return { kind: "parseFailed" };
		default:
			return { kind: "unavailable" };
	}
}
