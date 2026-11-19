import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Workflow } from "@/components/app-icons";
import { PageTopbar, PageTopbarTitle } from "../components/PageTopbar";
import { ELEMENTS_QUERY, elementsFromRows, type AisepModelClient, type ModelElement } from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import { useAisepT, type AisepMessageKey } from "./i18n";

/** Placeholder workbench: three regions that only show counts and titles. */
export function AisepWorkbenchPage({ client = fixtureClient }: { client?: AisepModelClient }) {
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
					<Section titleKey="section.aiActivity.title">
						<p className="text-xs text-muted-foreground">{t("section.aiActivity.unsourced")}</p>
					</Section>
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
