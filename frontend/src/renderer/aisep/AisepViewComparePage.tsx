// One declared view on two commits (ADR-032 P1b "能比"): the members added and removed between them, each answered by
// its own model_query on that commit (§5.6), and the two drawings side by side (model_render_view on each ref, §5.16).
// Read-only. Each SVG is an <img> of a data: URL, as on the views page: its ids (arrow markers) stay inside the image,
// so the two drawings never resolve each other's markers.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { LayoutGrid } from "@/components/app-icons";
import { buttonVariants } from "@/components/ui/button";
import { PageTopbar, PageTopbarTitle } from "../components/PageTopbar";
import { aisepErrorMessage } from "./AisepApprovalProgress";
import { svgDataUrl } from "./AisepViewsPage";
import { modelClient } from "./AisepWorkbenchPage";
import { QUERY_LIMIT_MAX, asSelect, type AisepModelClient, type Iri } from "./data/client";
import { shouldRetryAisep } from "./data/mcp-client";
import { useAisepT, type AisepT } from "./i18n";

/** An IRI that can go between <> in SPARQL as is (it comes from the address bar). */
const SAFE_IRI = /^https?:\/\/[^\s<>"{}|\\^`]+$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

/** Rows: none when `view` is not an arch:Diagram on that commit; one with no ?member when it has no members. */
export function viewMembersQuery(view: Iri): string {
	if (!SAFE_IRI.test(view)) throw new Error(`not an IRI: ${view}`);
	return `SELECT ?member ?label WHERE {
  <${view}> a arch:Diagram .
  OPTIONAL { ?member arch:inView <${view}> OPTIONAL { ?member skos:prefLabel ?label FILTER(lang(?label) = "zh") } }
}`;
}

export interface ViewMembers {
	/** False when the commit has no such view. */
	exists: boolean;
	/** Member IRI -> label (the IRI's local name when it has no Chinese label). */
	members: Map<Iri, string>;
}

function localName(iri: Iri): string {
	return iri.slice(Math.max(iri.lastIndexOf("/"), iri.lastIndexOf("#")) + 1);
}

async function viewMembers(client: AisepModelClient, view: Iri, ref: string, signal: AbortSignal): Promise<ViewMembers> {
	const result = asSelect(await client.query(viewMembersQuery(view), { ref, limit: QUERY_LIMIT_MAX }, { signal }));
	if (result.truncated) throw new Error(`the server truncated the members at ${result.rows.length} rows`);
	const members = new Map<Iri, string>();
	for (const row of result.rows) {
		if (row.member && !members.has(row.member.value)) members.set(row.member.value, row.label?.value ?? localName(row.member.value));
	}
	return { exists: result.rows.length > 0, members };
}

/** Members in `head` and not in `base` (added), and the other way round (removed), by IRI. */
export function memberChanges(base: ViewMembers, head: ViewMembers): { added: [Iri, string][]; removed: [Iri, string][] } {
	const only = (a: ViewMembers, b: ViewMembers) =>
		[...a.members].filter(([iri]) => !b.members.has(iri)).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
	return { added: only(head, base), removed: only(base, head) };
}

export function AisepViewComparePage({
	view,
	base,
	head,
	branch,
	client = modelClient,
}: {
	view: string;
	base: string;
	head: string;
	branch?: string;
	client?: AisepModelClient;
}) {
	const t = useAisepT();
	const valid = SAFE_IRI.test(view) && COMMIT.test(base) && COMMIT.test(head);
	const back = branch ? `#/aisep/gate/${branch.split("/").map(encodeURIComponent).join("/")}` : "#/aisep";
	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<PageTopbar
				lead={
					<PageTopbarTitle as="h1" icon={<LayoutGrid className="size-icon-md" aria-hidden="true" />}>
						{t("gate.compare.title")}
					</PageTopbarTitle>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="flex w-full flex-col gap-4 px-6 pt-3 pb-6">
					<a href={back} className={`${buttonVariants({ variant: "link" })} self-start text-xs`}>
						{t(branch ? "gate.compare.backToGate" : "gate.back")}
					</a>
					{valid ? (
						<Compare client={client} view={view} base={base} head={head} t={t} />
					) : (
						<p role="alert" className="text-xs text-destructive">{t("gate.compare.invalid")}</p>
					)}
				</div>
			</div>
		</div>
	);
}

function Compare({ client, view, base, head, t }: { client: AisepModelClient; view: Iri; base: string; head: string; t: AisepT }) {
	const members = (ref: string) => ({
		queryKey: ["aisep", "views", "members", view, ref],
		queryFn: ({ signal }: { signal: AbortSignal }) => viewMembers(client, view, ref, signal),
		retry: shouldRetryAisep,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const before = useQuery(members(base));
	const after = useQuery(members(head));
	const error = before.error ?? after.error;
	const changes = before.data && after.data ? memberChanges(before.data, after.data) : undefined;
	return (
		<>
			<p className="break-all font-mono text-caption text-muted-foreground" title={view}>
				{view}
			</p>
			<p className="font-mono text-caption text-muted-foreground">
				{t("gate.compare.refs", { base: base.slice(0, 7), head: head.slice(0, 7) })}
			</p>
			{error ? (
				<p role="alert" className="text-xs text-destructive">{t("gate.error", { message: aisepErrorMessage(error) })}</p>
			) : !changes ? (
				<p role="status" className="text-xs text-muted-foreground">{t("section.loading")}</p>
			) : (
				<div className="grid grid-cols-1 gap-4 text-xs md:grid-cols-2">
					<MemberList title={t("gate.compare.added", { count: changes.added.length })} members={changes.added} className="text-success" t={t} />
					<MemberList title={t("gate.compare.removed", { count: changes.removed.length })} members={changes.removed} className="text-destructive" t={t} />
				</div>
			)}
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				<Drawing client={client} view={view} commit={base} exists={before.data?.exists} title={t("gate.compare.base", { commit: base.slice(0, 7) })} t={t} />
				<Drawing client={client} view={view} commit={head} exists={after.data?.exists} title={t("gate.compare.head", { commit: head.slice(0, 7) })} t={t} />
			</div>
		</>
	);
}

function MemberList({ title, members, className, t }: { title: string; members: [Iri, string][]; className: string; t: AisepT }) {
	return (
		<section aria-label={title} className="flex flex-col gap-1">
			<h2 className="font-medium text-foreground">{title}</h2>
			{members.length === 0 ? (
				<p className="text-muted-foreground">{t("gate.compare.none")}</p>
			) : (
				<ul className="flex flex-col gap-0.5">
					{members.map(([iri, label]) => (
						<li key={iri} title={iri} className={className}>
							{label}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function Drawing({
	client,
	view,
	commit,
	exists,
	title,
	t,
}: {
	client: AisepModelClient;
	view: Iri;
	commit: string;
	exists: boolean | undefined;
	title: string;
	t: AisepT;
}) {
	const drawing = useQuery({
		queryKey: ["aisep", "views", "render", "compare", view, commit],
		queryFn: ({ signal }) => client.renderView({ view, ref: commit }, { signal }),
		enabled: exists === true,
		retry: shouldRetryAisep,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const svg = drawing.data && drawing.data.format !== "bpmn-xml" ? drawing.data.svg : undefined;
	const src = useMemo(() => (svg ? svgDataUrl(svg) : undefined), [svg]);
	return (
		<section aria-label={title} className="flex min-w-0 flex-col gap-1">
			<h2 className="text-xs font-medium text-foreground">{title}</h2>
			{exists === false ? (
				<p className="text-xs text-muted-foreground">{t("gate.compare.absent")}</p>
			) : drawing.isError ? (
				<p role="alert" className="text-xs text-destructive">{t("views.renderError", { message: aisepErrorMessage(drawing.error) })}</p>
			) : src ? (
				// White in both themes, as on the views page: the notations are drawn for a light background.
				<div className="overflow-auto rounded-md border border-border bg-white p-2">
					<img src={src} alt={title} className="max-w-full" />
				</div>
			) : (
				<p role="status" className="text-xs text-muted-foreground">{t("views.rendering")}</p>
			)}
		</section>
	);
}
