// PROVISIONAL — the only AISEP file that knows about Agent Orchestrator (AO).
// ADR-013: the "AI 进行中" area reads runtime state from the orchestrator; it is
// never stored in the model repo. Everything AO-specific (API client, generated
// schema types, status vocabulary) stays in this file, so swapping
// orchestrators means replacing this file only. The AO fields and status values
// used here are registered in workbench/UPSTREAM.md and checked on every sync.
import type { components } from "../../../api/schema";
import { apiClient, hasTrustedApiBaseUrl } from "../../lib/api-client";
import { agentLabel } from "../../lib/agent-options";

type AoSession = components["schemas"]["ControllersSessionView"];
/** AO's raw session status: the 15 values of `ControllersSessionView.status`. */
export type AoSessionStatus = AoSession["status"];

/** AISEP's own buckets for the area; AO's vocabulary does not leak past this file. */
export type AgentSessionBucket = "needsYou" | "inProgress" | "inReview" | "finished";

/** One orchestrator session as the AISEP workbench sees it (AISEP-owned shape). */
export interface AgentSessionRow {
	/** Opaque orchestrator session id; becomes `aisep:sessionRef` (spec §6.7) at a gate. */
	sessionRef: string;
	/** Display name of the agent; undefined when the orchestrator does not say. */
	agent?: string;
	/** What the session is working on. */
	task: string;
	/** Shared key with `model.diff` (ADR-013); a session may not have one yet. */
	branch?: string;
	bucket: AgentSessionBucket;
	/** Orchestrator status, kept for tooltips and debugging only. */
	rawStatus: string;
}

export interface AgentSessionSource {
	/** Live (non-archived) sessions. Rejects when the orchestrator cannot be reached. */
	list(): Promise<AgentSessionRow[]>;
}

/**
 * PROPOSAL — needs confirmation in the design session before it is final.
 *
 * Buckets follow what AO itself shows: its attention zones (product-ui
 * `attentionZone`: merge / action / pending / working / done) and the backend's
 * DeriveStatus / DeriveKanbanPresentation. "等你处理" = AO's `merge` + `action`
 * zones (the next step is the user's); "评审中" = AO's `pending` zone; "进行中" =
 * AO's `working` zone; "已结束" = merged or terminated. No fifth bucket was
 * needed: idle and no_signal both have a home in AO's own zones.
 *
 * Typed as a Record over AO's status union on purpose: if upstream adds a
 * status, typecheck fails here until someone decides its bucket (same gate as
 * the AppLocale-typed AISEP i18n).
 */
export const STATUS_BUCKETS: Record<AoSessionStatus, AgentSessionBucket> = {
	// Agent activity is active (DeriveStatus: ActivityActive).
	working: "inProgress",
	// No PR, agent settled and not silent past grace; AO zone `working`, sidebar stays quiet.
	idle: "inProgress",
	// Agent asked a question or is blocked; AO zone `action`, sidebar "attention".
	needs_input: "needsYou",
	// Agent process exited without the session ending; AO zone `action`.
	exited: "needsYou",
	// Agent never reported past the grace period; AO zone `action` ("cannot carry on by itself").
	no_signal: "needsYou",
	// PR open, waiting on review; AO zone `pending`.
	pr_open: "inReview",
	// Draft PR; AO zone `pending` (still the author's, so not the user's turn yet).
	draft: "inReview",
	// A reviewer was requested on the PR; AO zone `pending`.
	review_pending: "inReview",
	// CI is failing; AO zone `action`, sidebar "attention".
	ci_failed: "needsYou",
	// Formal "changes requested" review; AO zone `action`, sidebar "attention".
	changes_requested: "needsYou",
	// Unresolved review comments; AO zone `action`.
	commented: "needsYou",
	// Approved by a person; AO zone `merge`, ranked first in AO's attention order — merging is the user's step.
	approved: "needsYou",
	// PR can be merged; AO zone `merge` — merging is the user's step.
	mergeable: "needsYou",
	// PR merged; AO zone `merge`, but nothing is left to do.
	merged: "finished",
	// Session ended; AO zone `done`. Normally filtered out by isArchived before mapping.
	terminated: "finished",
};

/**
 * Archived sessions are left out of the area. AO's own rule (backend
 * DeriveKanbanPresentation) puts a session in the `archive` column exactly
 * when it is terminated, so `isTerminated` / `kanbanColumn` decide it, not
 * `status`: a terminated session whose PR merged reports status `merged`.
 */
export function isArchived(session: Pick<AoSession, "isTerminated" | "kanbanColumn">): boolean {
	return session.isTerminated || session.kanbanColumn === "archive";
}

export function toAgentSessionRow(session: AoSession): AgentSessionRow {
	return {
		sessionRef: session.id,
		agent: session.harness ? agentLabel(session.harness) : undefined,
		// Same title precedence as AO's own session list (useWorkspaceQuery).
		task: session.terminalTitle ?? session.displayName ?? session.issueId ?? session.id,
		branch: session.branch || undefined,
		bucket: STATUS_BUCKETS[session.status],
		rawStatus: session.status,
	};
}

export function agentSessionRows(sessions: readonly AoSession[]): AgentSessionRow[] {
	return sessions.filter((session) => !isArchived(session)).map(toAgentSessionRow);
}

/** Reads the local AO daemon: GET /api/v1/sessions. */
export const aoSessionSource: AgentSessionSource = {
	async list() {
		if (!hasTrustedApiBaseUrl()) throw new Error("AO daemon is not reachable yet");
		const { data, error } = await apiClient.GET("/api/v1/sessions");
		if (error) throw error;
		return agentSessionRows(data?.sessions ?? []);
	},
};
