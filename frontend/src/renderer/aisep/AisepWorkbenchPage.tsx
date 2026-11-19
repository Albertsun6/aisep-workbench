import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Workflow } from "@/components/app-icons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageTopbar, PageTopbarTitle } from "../components/PageTopbar";
import { aoSessionSource, type AgentSessionBucket, type AgentSessionRow, type AgentSessionSource } from "./data/ao-sessions";
import { ELEMENTS_QUERY, elementsFromRows, type AisepModelClient, type ModelElement } from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import { useAisepT, type AisepMessageKey } from "./i18n";

/** Placeholder workbench: three regions; "AI 进行中" reads live orchestrator sessions (ADR-013). */
export function AisepWorkbenchPage({
	client = fixtureClient,
	sessions = aoSessionSource,
}: {
	client?: AisepModelClient;
	sessions?: AgentSessionSource;
}) {
	const t = useAisepT();
	const elements = useQuery({
		queryKey: ["aisep", "elements"],
		queryFn: async () => elementsFromRows(await client.query(ELEMENTS_QUERY)),
	});
	const pending = elements.data?.filter((element) => element.approvalState === "Proposed");

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
					<p className="text-xs text-muted-foreground">{t("page.fixtureNotice")}</p>
					<ElementSection
						titleKey="section.architecture.title"
						items={elements.data}
						isLoading={elements.isLoading}
						isError={elements.isError}
					/>
					<ElementSection
						titleKey="section.gates.title"
						items={pending}
						isLoading={elements.isLoading}
						isError={elements.isError}
					/>
					<AiActivitySection source={sessions} />
				</div>
			</div>
		</div>
	);
}

function Section({ titleKey, children }: { titleKey: AisepMessageKey; children: React.ReactNode }) {
	const t = useAisepT();
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className="flex flex-col gap-2">
			<h2 id={headingId} className="text-control font-medium text-foreground">
				{t(titleKey)}
			</h2>
			{children}
		</section>
	);
}

function ElementSection({
	titleKey,
	items,
	isLoading,
	isError,
}: {
	titleKey: AisepMessageKey;
	items: ModelElement[] | undefined;
	isLoading: boolean;
	isError: boolean;
}) {
	const t = useAisepT();
	return (
		<Section titleKey={titleKey}>
			{isLoading ? (
				<p role="status" className="text-xs text-muted-foreground">{t("section.loading")}</p>
			) : isError ? (
				<p role="alert" className="text-xs text-destructive">{t("section.error")}</p>
			) : items?.length ? (
				<>
					<p className="text-caption tabular-nums text-muted-foreground">{t("section.count", { count: items.length })}</p>
					<ul className="divide-y divide-border">
						{items.map((item) => (
							<li key={item.iri} className="truncate py-2 text-xs text-foreground" title={item.iri}>
								{item.prefLabel}
							</li>
						))}
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

function AiActivitySection({ source }: { source: AgentSessionSource }) {
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
									{row.branch ?? (
										<span className="font-sans text-muted-foreground">{t("section.aiActivity.noBranch")}</span>
									)}
								</TableCell>
								{/* model.diff (spec §8.3) does not exist yet. */}
								<TableCell className="text-muted-foreground">
									{t("section.aiActivity.changedElementsUnavailable")}
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
