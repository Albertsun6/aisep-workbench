// 动作: the action catalogue merged into main, from model_list_actions (aisep §5.13; contract §2). Read-only, like
// Foundry's Action type view: parameters, guards and steps, no "run" button. Actions are run by an AI through MCP.
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Zap } from "@/components/app-icons";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageTopbar, PageTopbarTitle } from "../components/PageTopbar";
import { aisepErrorMessage } from "./AisepApprovalProgress";
import { modelClient } from "./AisepWorkbenchPage";
import type { ActionDefinition, AisepModelClient, InvalidActionDefinition } from "./data/client";
import { shouldRetryAisep } from "./data/mcp-client";
import { LIST_ACTIONS_SAMPLE, orSample } from "./data/samples";
import { useAisepT } from "./i18n";

export function AisepActionsPage({ client = modelClient }: { client?: AisepModelClient }) {
	const t = useAisepT();
	const catalog = useQuery({
		queryKey: ["aisep", "actions"],
		queryFn: ({ signal }) => orSample(() => client.listActions({ signal }), () => LIST_ACTIONS_SAMPLE),
		retry: shouldRetryAisep,
	});
	const actions = catalog.data?.data.actions ?? [];
	// Invalid definitions last (contract §2.3).
	const valid = actions.filter((action): action is ActionDefinition => action.valid);
	const invalid = actions.filter((action): action is InvalidActionDefinition => !action.valid);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<PageTopbar
				lead={
					<PageTopbarTitle as="h1" icon={<Zap className="size-icon-md" aria-hidden="true" />}>
						{t("actions.title")}
					</PageTopbarTitle>
				}
				actions={
					catalog.data?.sample ? (
						<Badge role="status" variant="warning">
							<AlertTriangle aria-hidden="true" />
							{t("sample.badge")}
						</Badge>
					) : null
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 pt-3 pb-6">
					<p className="text-xs text-muted-foreground">{t("actions.readOnly")}</p>
					{catalog.data?.sample ? (
						<p className="text-xs text-muted-foreground">{t("actions.unconnected")}</p>
					) : null}
					{catalog.isLoading ? (
						<p role="status" className="text-xs text-muted-foreground">{t("section.loading")}</p>
					) : catalog.isError ? (
						<p role="alert" className="text-xs text-destructive">{t("gate.error", { message: aisepErrorMessage(catalog.error) })}</p>
					) : catalog.data ? (
						<>
							<p className="text-caption text-muted-foreground">{t(catalog.data.sample ? "actions.sourceSample" : "actions.source", { version: catalog.data.data.catalogVersion })}</p>
							{actions.length === 0 ? (
								<p className="text-xs text-muted-foreground">{t("actions.empty")}</p>
							) : (
								<ul className="divide-y divide-border">
									{valid.map((action) => (
										<ActionItem key={action.id} action={action} />
									))}
									{invalid.map((action, index) => (
										<InvalidItem key={action.iri ?? `invalid-${index}`} action={action} />
									))}
								</ul>
							)}
						</>
					) : null}
				</div>
			</div>
		</div>
	);
}

function ActionItem({ action }: { action: ActionDefinition }) {
	const t = useAisepT();
	const required = new Set(action.params.required ?? []);
	const iriParams = new Set(action.iriParams);
	const params = Object.entries(action.params.properties);
	return (
		<li aria-label={action.title} className="flex flex-col gap-2 py-4 text-xs">
			<div className="flex flex-wrap items-baseline gap-2">
				<h2 className="text-control font-medium text-foreground">{action.title}</h2>
				<span className="font-mono text-muted-foreground">{action.id}</span>
				<span className="text-muted-foreground">{t("actions.version", { version: action.version })}</span>
				{action.destructive ? <Badge variant="error">{t("actions.destructive")}</Badge> : null}
			</div>
			<p className="text-foreground">{action.description}</p>
			<h3 className="font-medium text-foreground">{t("actions.params")}</h3>
			{params.length ? (
				<Table className="text-xs">
					<TableHeader>
						<TableRow>
							<TableHead>{t("actions.param.name")}</TableHead>
							<TableHead>{t("actions.param.required")}</TableHead>
							<TableHead>{t("actions.param.type")}</TableHead>
							<TableHead>{t("actions.param.description")}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{params.map(([name, schema]) => (
							<TableRow key={name}>
								<TableCell className="font-mono">{name}</TableCell>
								<TableCell>{required.has(name) ? t("actions.param.requiredYes") : t("actions.param.requiredNo")}</TableCell>
								<TableCell>{iriParams.has(name) ? "IRI" : t("actions.param.text")}</TableCell>
								<TableCell className="whitespace-normal">{schema.description ?? "—"}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			) : (
				<p className="text-muted-foreground">{t("actions.none")}</p>
			)}
			<h3 className="font-medium text-foreground">{t("actions.guards")}</h3>
			{action.guards.length ? (
				<ul className="flex flex-col gap-1">
					{action.guards.map((guard) => (
						<li key={guard.id}>
							<span className="font-mono">{guard.id}</span>
							<span className="ml-2 text-muted-foreground">{guard.hint}</span>
						</li>
					))}
				</ul>
			) : (
				<p className="text-muted-foreground">{t("actions.none")}</p>
			)}
			<h3 className="font-medium text-foreground">{t("actions.steps")}</h3>
			<ol className="flex flex-col gap-1 font-mono">
				{action.steps.map((step) => (
					<li key={step.id}>
						{step.id} → {step.op}
					</li>
				))}
			</ol>
		</li>
	);
}

function InvalidItem({ action }: { action: InvalidActionDefinition }) {
	const t = useAisepT();
	return (
		<li aria-label={action.id ?? action.iri ?? t("actions.invalid")} className="flex flex-col gap-1 py-4 text-xs">
			<div className="flex flex-wrap items-baseline gap-2">
				<span className="font-mono text-foreground">{action.id ?? action.iri ?? "—"}</span>
				<Badge variant="error">{t("actions.invalid")}</Badge>
			</div>
			<ul className="flex flex-col gap-1 text-destructive">
				{action.problems.map((problem, index) => (
					<li key={`${index}:${problem}`}>{problem}</li>
				))}
			</ul>
		</li>
	);
}
