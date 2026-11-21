// The branch's approval progress on the gate page: 待批准 → 已批准待推送 → 已推送待合并 → 已合入 (data/approval-progress.ts).
// Unlike the rest of the gate page this one follows the branch, not the pinned commit: it polls and has a refresh
// button, so pushing and merging (done outside the workbench) show up without leaving the page.
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Check, RefreshCw } from "@/components/app-icons";
import { Button } from "@/components/ui/button";
import { APPROVAL_STAGES, DEFAULT_MAIN_REF, approvalProgress, type ApprovalStage } from "./data/approval-progress";
import { AisepToolError, type AisepModelClient } from "./data/client";
import { shouldRetryAisep } from "./data/mcp-client";
import { useAisepT, type AisepMessageKey } from "./i18n";

export const PROGRESS_POLL_MS = 15_000;

export function approvalProgressKey(branch: string) {
	return ["aisep", "approval-progress", branch] as const;
}

const STAGE_TEXT: Record<ApprovalStage, AisepMessageKey> = {
	pending: "gate.progress.stage.pending",
	approved: "gate.progress.stage.approved",
	pushed: "gate.progress.stage.pushed",
	merged: "gate.progress.stage.merged",
};

function errorMessage(error: unknown): string {
	if (error instanceof AisepToolError) return error.hint ? `${error.message}（${error.hint}）` : error.message;
	return error instanceof Error ? error.message : String(error);
}

export function AisepApprovalProgress({
	client,
	branch,
	mainRef,
}: {
	client: AisepModelClient;
	branch: string;
	/** The diff's resolved main (`base.mainRef`); origin/main when absent. */
	mainRef?: string | null;
}) {
	const t = useAisepT();
	const headingId = useId();
	const progress = useQuery({
		queryKey: [...approvalProgressKey(branch), mainRef ?? DEFAULT_MAIN_REF],
		queryFn: ({ signal }) => approvalProgress(client, branch, mainRef ?? DEFAULT_MAIN_REF, { signal }),
		retry: shouldRetryAisep,
		refetchInterval: PROGRESS_POLL_MS,
		refetchOnWindowFocus: true,
	});
	const current = progress.data ? APPROVAL_STAGES.indexOf(progress.data.stage) : -1;

	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<h2 id={headingId} className="text-control font-medium text-foreground">
					{t("gate.progress.title")}
				</h2>
				<Button
					variant="ghost"
					size="sm"
					disabled={progress.isFetching}
					onClick={() => void progress.refetch()}
				>
					<RefreshCw className="size-icon-sm" aria-hidden="true" />
					{t("gate.progress.refresh")}
				</Button>
			</div>
			{progress.isLoading ? (
				<p role="status" className="text-xs text-muted-foreground">{t("section.loading")}</p>
			) : null}
			{/* A failed poll keeps the last stage on screen (a brief disconnect must not blank it) and says it failed. */}
			{progress.data ? (
				<ol className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
					{APPROVAL_STAGES.map((stage, index) => {
						const done = index < current;
						const isCurrent = index === current;
						return (
							<li
								key={stage}
								aria-current={isCurrent ? "step" : undefined}
								className={
									isCurrent
										? "flex items-center gap-1 font-medium text-foreground"
										: done
											? "flex items-center gap-1 text-success"
											: "flex items-center gap-1 text-muted-foreground"
								}
							>
								{done ? (
									<Check className="size-icon-sm" aria-hidden="true" />
								) : (
									<span
										aria-hidden="true"
										className={isCurrent ? "size-2 rounded-full bg-logo-accent" : "size-2 rounded-full border border-border"}
									/>
								)}
								{t(STAGE_TEXT[stage])}
							</li>
						);
					})}
				</ol>
			) : null}
			{progress.isError ? (
				<p role="alert" className="text-xs text-destructive">{t("gate.error", { message: errorMessage(progress.error) })}</p>
			) : null}
			<p className="text-caption text-muted-foreground">{t("gate.progress.fetchNote")}</p>
		</section>
	);
}
