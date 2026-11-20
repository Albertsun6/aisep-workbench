import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Workflow } from "@/components/app-icons";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageTopbar, PageTopbarTitle } from "../components/PageTopbar";
import { aoSessionSource, type AgentSessionBucket, type AgentSessionRow, type AgentSessionSource } from "./data/ao-sessions";
import { branchChanges, changedElementsView } from "./data/changed-elements";
import { ELEMENTS_QUERY, PENDING_QUERY, elementsFromRows, type AisepModelClient, type Iri, type ModelElement } from "./data/client";
import { FixtureClient, fixtureClient } from "./data/fixture-client";
import { McpModelClient, shouldRetryAisep } from "./data/mcp-client";
import { useAisepT, type AisepMessageKey } from "./i18n";

/** §8 step 3: the AISEP MCP Server when its URL is configured (e.g. http://127.0.0.1:8765/mcp), else offline fixtures. */
export function defaultModelClient(url: string | undefined = import.meta.env.VITE_AISEP_MCP_URL): AisepModelClient {
	return url ? new McpModelClient(url) : fixtureClient;
}

export const modelClient = defaultModelClient();

/** The gate page of a branch (§8 step 5), under the `/aisep/*` splat route (hash history). */
export function gateHref(branch: string): string {
	return `#/aisep/gate/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

/** Placeholder workbench: three regions; "AI 进行中" reads live orchestrator sessions (ADR-013). */
export function AisepWorkbenchPage({
	client = modelClient,
	sessions = aoSessionSource,
}: {
	client?: AisepModelClient;
	sessions?: AgentSessionSource;
}) {
	const t = useAisepT();
	const elements = useQuery({
		queryKey: ["aisep", "elements"],
		queryFn: async ({ signal }) => elementsFromRows(await client.query(ELEMENTS_QUERY, {}, { signal })),
		retry: shouldRetryAisep,
	});
	// §5.4: L0–L2 violations already on the main branch; normally none.
	const findings = useQuery({
		queryKey: ["aisep", "findings"],
		queryFn: ({ signal }) => client.findings({}, { signal }),
		retry: shouldRetryAisep,
	});
	const [showViolations, setShowViolations] = useState(false);
	const openViolations = findings.data?.openViolations;
	const violationFocus = new Set(showViolations ? openViolations?.items.flatMap((item) => item.focus ?? []) : []);
	const pending = useQuery({
		queryKey: ["aisep", "pending"],
		queryFn: async ({ signal }) => elementsFromRows(await client.query(PENDING_QUERY, {}, { signal })),
		retry: shouldRetryAisep,
	});

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<PageTopbar
				lead={
					<PageTopbarTitle as="h1" icon={<Workflow className="size-icon-md" aria-hidden="true" />}>
						{t("page.title")}
					</PageTopbarTitle>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-3 pb-6">
					{client instanceof FixtureClient ? (
						<p className="text-xs text-muted-foreground">{t("page.fixtureNotice")}</p>
					) : null}
					<ElementSection
						titleKey="section.architecture.title"
						items={elements.data?.elements}
						truncated={elements.data?.truncated}
						highlight={violationFocus}
						isLoading={elements.isLoading}
						isError={elements.isError}
						adornment={
							openViolations && openViolations.count > 0 ? (
								<button
									type="button"
									aria-expanded={showViolations}
									onClick={() => setShowViolations((open) => !open)}
									className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
								>
									<Badge variant="error" className="tabular-nums">
										{t("section.architecture.violations", { count: openViolations.count })}
									</Badge>
								</button>
							) : null
						}
					>
						{showViolations && openViolations ? (
							<ul aria-label={t("section.architecture.violationsList")} className="flex flex-col gap-1 text-xs text-destructive">
								{openViolations.items.map((item, index) => (
									<li key={`${item.focus}-${index}`} className="break-words">
										{item.layer} {item.message}
									</li>
								))}
							</ul>
						) : null}
					</ElementSection>
					<ElementSection
						titleKey="section.gates.title"
						items={pending.data?.elements}
						truncated={pending.data?.truncated}
						isLoading={pending.isLoading}
						isError={pending.isError}
					/>
					<AiActivitySection source={sessions} client={client} />
				</div>
			</div>
		</div>
	);
}

function Section({
	titleKey,
	adornment,
	children,
}: {
	titleKey: AisepMessageKey;
	adornment?: React.ReactNode;
	children: React.ReactNode;
}) {
	const t = useAisepT();
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<h2 id={headingId} className="text-control font-medium text-foreground">
					{t(titleKey)}
				</h2>
				{adornment}
			</div>
			{children}
		</section>
	);
}

function ElementSection({
	titleKey,
	items,
	truncated,
	highlight,
	isLoading,
	isError,
	adornment,
	children,
}: {
	titleKey: AisepMessageKey;
	items: ModelElement[] | undefined;
	truncated?: boolean;
	highlight?: ReadonlySet<Iri>;
	isLoading: boolean;
	isError: boolean;
	adornment?: React.ReactNode;
	children?: React.ReactNode;
}) {
	const t = useAisepT();
	return (
		<Section titleKey={titleKey} adornment={adornment}>
			{children}
			{isLoading ? (
				<p role="status" className="text-xs text-muted-foreground">{t("section.loading")}</p>
			) : isError ? (
				<p role="alert" className="text-xs text-destructive">{t("section.error")}</p>
			) : items?.length ? (
				<>
					<p className="text-caption tabular-nums text-muted-foreground">{t("section.count", { count: items.length })}</p>
					{truncated ? (
						<p role="note" className="text-caption text-warning">{t("section.truncated", { count: items.length })}</p>
					) : null}
					<ul className="divide-y divide-border">
						{items.map((item) => {
							const flagged = highlight?.has(item.iri) ?? false;
							return (
								<li
									key={item.iri}
									data-violation={flagged || undefined}
									className={flagged ? "truncate py-2 text-xs font-medium text-destructive" : "truncate py-2 text-xs text-foreground"}
									title={item.iri}
								>
									{item.prefLabel}
								</li>
							);
						})}
					</ul>
				</>
			) : (
				<p className="text-xs text-muted-foreground">{t("section.empty")}</p>
			)}
		</Section>
	);
}

/** AO pushes session changes over SSE to its own views; this area polls the same endpoint instead (ADR-013: read-only). */
export const AGENT_SESSIONS_REFRESH_MS = 5_000;

const BUCKET_ORDER: Record<AgentSessionBucket, number> = { needsYou: 0, inProgress: 1, inReview: 2, finished: 3 };

const BUCKET_LABEL: Record<AgentSessionBucket, AisepMessageKey> = {
	needsYou: "section.aiActivity.bucket.needsYou",
	inProgress: "section.aiActivity.bucket.inProgress",
	inReview: "section.aiActivity.bucket.inReview",
	finished: "section.aiActivity.bucket.finished",
};

/** Rows that need the user come first; the sort is stable inside a bucket. */
function orderAgentSessions(rows: readonly AgentSessionRow[]): AgentSessionRow[] {
	return [...rows].sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket]);
}

function AiActivitySection({ source, client }: { source: AgentSessionSource; client: AisepModelClient }) {
	const t = useAisepT();
	const sessions = useQuery({
		queryKey: ["aisep", "agent-sessions"],
		queryFn: async () => orderAgentSessions(await source.list()),
		refetchInterval: AGENT_SESSIONS_REFRESH_MS,
	});
	return (
		<Section titleKey="section.aiActivity.title">
			{sessions.isLoading ? (
				<p role="status" className="text-xs text-muted-foreground">{t("section.loading")}</p>
			) : sessions.isError ? (
				<p role="alert" className="text-xs text-destructive">{t("section.aiActivity.error")}</p>
			) : sessions.data?.length ? (
				<Table className="text-xs">
					<TableHeader>
						<TableRow>
							<TableHead>{t("section.aiActivity.column.agent")}</TableHead>
							<TableHead>{t("section.aiActivity.column.task")}</TableHead>
							<TableHead>{t("section.aiActivity.column.status")}</TableHead>
							<TableHead>{t("section.aiActivity.column.branch")}</TableHead>
							<TableHead>{t("section.aiActivity.column.changedElements")}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sessions.data.map((row) => (
							<TableRow key={row.sessionRef}>
								<TableCell>{row.agent ?? t("section.aiActivity.unknownAgent")}</TableCell>
								<TableCell className="max-w-80 truncate" title={row.task}>
									{row.task}
								</TableCell>
								<TableCell title={row.rawStatus}>{t(BUCKET_LABEL[row.bucket])}</TableCell>
								<TableCell className="font-mono">
									{row.branch ? (
										<a
											href={gateHref(row.branch)}
											title={t("section.aiActivity.openGate", { branch: row.branch })}
											className={buttonVariants({ variant: "link" })}
										>
											{row.branch}
										</a>
									) : (
										<span className="font-sans text-muted-foreground">{t("section.aiActivity.noBranch")}</span>
									)}
								</TableCell>
								<TableCell>
									{row.branch ? (
										<ChangedElementsCell client={client} branch={row.branch} />
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<p className="text-xs text-muted-foreground">{t("section.aiActivity.empty")}</p>
			)}
		</Section>
	);
}

/** Worktree edits do not move the branch head, so there is no other invalidation signal (§8 step 4). */
export const CHANGED_ELEMENTS_REFRESH_MS = 15_000;

const CHANGED_ELEMENTS_TEXT = {
	noModels: "section.aiActivity.changed.noModels",
	branchNotInRepo: "section.aiActivity.changed.branchNotInRepo",
	cannotCompare: "section.aiActivity.changed.cannotCompare",
	parseFailed: "section.aiActivity.changed.parseFailed",
	unavailable: "section.aiActivity.changedElementsUnavailable",
} as const satisfies Record<string, AisepMessageKey>;

function ChangedElementsCell({ client, branch }: { client: AisepModelClient; branch: string }) {
	const t = useAisepT();
	const diff = useQuery({
		queryKey: ["aisep", "diff", "wt", branch],
		queryFn: ({ signal }) => branchChanges(client, branch, { signal }),
		refetchInterval: CHANGED_ELEMENTS_REFRESH_MS,
		retry: shouldRetryAisep,
	});
	if (diff.isLoading) return <span className="text-muted-foreground">…</span>;
	const view = changedElementsView(diff.data, diff.error);
	if (view.kind !== "count") return <span className="text-muted-foreground">{t(CHANGED_ELEMENTS_TEXT[view.kind])}</span>;
	const { element: el, relationship: rel } = view.counts;
	const title = [
		t("section.aiActivity.changed.detail", {
			added: el.added, modified: el.modified, removed: el.removed,
			relAdded: rel.added, relModified: rel.modified, relRemoved: rel.removed, base: view.baseCommit.slice(0, 7),
		}),
		view.viaRef ? t("section.aiActivity.changed.viaRef") : null,
		view.incomplete ? t("section.aiActivity.changed.failedFiles", { files: view.failedFiles.join(", ") }) : null,
	].filter(Boolean).join("\n");
	return (
		<span title={title} className="inline-flex items-center gap-2">
			<span className="tabular-nums">{view.count}</span>
			{view.dirty ? <span className="text-muted-foreground">{t("section.aiActivity.changed.dirty")}</span> : null}
			{view.incomplete ? <span className="text-warning">{t("section.aiActivity.changed.incomplete")}</span> : null}
		</span>
	);
}
