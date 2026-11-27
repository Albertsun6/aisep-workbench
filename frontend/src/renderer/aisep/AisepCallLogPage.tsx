// 调用日志: the server's call log (ADR-031, aisep PR #171), read through the proposed model_call_log
// (coordination/workbench-readonly-contract-20261127.md §1). Modelled on CloudTrail Event history: newest first,
// filters, "older" by cursor, a row expands to the whole event. Diagnostic only: the log is not tamper-proof.
import { useInfiniteQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, ScrollText } from "@/components/app-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageTopbar, PageTopbarTitle } from "../components/PageTopbar";
import { aisepErrorMessage } from "./AisepApprovalProgress";
import { modelClient } from "./AisepWorkbenchPage";
import { AUDITED_TOOLS, type AisepModelClient, type CallLogEntry, type CallLogInput } from "./data/client";
import { shouldRetryAisep } from "./data/mcp-client";
import { callLogSample, orSample } from "./data/samples";
import { useAisepT } from "./i18n";

const ALL = "all";

export function AisepCallLogPage({ client = modelClient }: { client?: AisepModelClient }) {
	const t = useAisepT();
	const [tool, setTool] = useState(ALL);
	const [outcome, setOutcome] = useState(ALL);
	const [modelDraft, setModelDraft] = useState("");
	const [model, setModel] = useState("");
	const filter: CallLogInput = {
		tools: tool === ALL ? undefined : [tool],
		outcome: outcome === ALL ? undefined : outcome,
		model: model || undefined,
	};
	const log = useInfiniteQuery({
		queryKey: ["aisep", "call-log", filter],
		queryFn: ({ pageParam, signal }) =>
			orSample(
				() => client.callLog({ ...filter, cursor: pageParam }, { signal }),
				() => callLogSample(filter),
			),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.data.nextCursor ?? undefined,
		retry: shouldRetryAisep,
	});
	const first = log.data?.pages[0];
	const items = log.data?.pages.flatMap((page) => page.data.items) ?? [];
	// Every page reports the lines it skipped, so the count is the sum over the pages loaded so far.
	const skipped = (log.data?.pages ?? []).reduce(
		(sum, page) => ({
			malformed: sum.malformed + page.data.skipped.malformed,
			unknownVersion: sum.unknownVersion + page.data.skipped.unknownVersion,
		}),
		{ malformed: 0, unknownVersion: 0 },
	);
	const commitModel = () => setModel(modelDraft.trim());

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<PageTopbar
				lead={
					<PageTopbarTitle as="h1" icon={<ScrollText className="size-icon-md" aria-hidden="true" />}>
						{t("callLog.title")}
					</PageTopbarTitle>
				}
				actions={
					first?.sample ? (
						<Badge role="status" variant="warning">
							<AlertTriangle aria-hidden="true" />
							{t("sample.badge")}
						</Badge>
					) : null
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 pt-3 pb-6">
					<p role="note" className="text-xs text-warning">
						<strong className="font-medium">{t("callLog.notice.lead")}</strong>
						{t("callLog.notice.body")}
					</p>
					{first?.sample ? (
						<p className="text-xs text-muted-foreground">{t("callLog.unconnected")}</p>
					) : null}
					<div className="flex flex-wrap items-end gap-3 text-xs">
						<FilterSelect
							label={t("callLog.filter.tool")}
							value={tool}
							onValueChange={setTool}
							options={[{ value: ALL, label: t("callLog.filter.all") }, ...AUDITED_TOOLS.map((name) => ({ value: name, label: name }))]}
						/>
						<FilterSelect
							label={t("callLog.filter.outcome")}
							value={outcome}
							onValueChange={setOutcome}
							options={[
								{ value: ALL, label: t("callLog.filter.all") },
								{ value: "ok", label: t("callLog.filter.ok") },
								{ value: "rejected", label: t("callLog.filter.rejected") },
							]}
						/>
						<ModelFilter
							value={modelDraft}
							onChange={setModelDraft}
							onCommit={commitModel}
						/>
					</div>
					{log.isLoading ? (
						<p role="status" className="text-xs text-muted-foreground">{t("section.loading")}</p>
					) : log.isError ? (
						<p role="alert" className="text-xs text-destructive">{t("gate.error", { message: aisepErrorMessage(log.error) })}</p>
					) : first?.data.log.path === null ? (
						<p className="text-xs text-muted-foreground">{t("callLog.empty.noPath")}</p>
					) : first && !first.data.log.present ? (
						<p className="text-xs text-muted-foreground">{t("callLog.empty.noLog")}</p>
					) : items.length === 0 ? (
						<p className="text-xs text-muted-foreground">{t("callLog.empty.filtered")}</p>
					) : (
						<CallLogTable items={items} />
					)}
					{skipped.malformed > 0 || skipped.unknownVersion > 0 ? (
						<p role="note" className="text-caption text-warning">
							{t("callLog.skipped", skipped)}
						</p>
					) : null}
					{log.hasNextPage ? (
						<Button variant="secondary" size="sm" className="self-start" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
							{t("callLog.older")}
						</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}

function CallLogTable({ items }: { items: CallLogEntry[] }) {
	const t = useAisepT();
	const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
	const toggle = (offset: number) =>
		setOpen((current) => {
			const next = new Set(current);
			if (!next.delete(offset)) next.add(offset);
			return next;
		});
	return (
		<Table className="text-xs">
			<TableHeader>
				<TableRow>
					<TableHead>{t("callLog.column.time")}</TableHead>
					<TableHead>{t("callLog.column.tool")}</TableHead>
					<TableHead>{t("callLog.column.outcome")}</TableHead>
					<TableHead>{t("callLog.column.model")}</TableHead>
					<TableHead>{t("callLog.column.branch")}</TableHead>
					<TableHead>{t("callLog.column.files")}</TableHead>
					<TableHead>{t("callLog.detail.duration")}</TableHead>
					<TableHead>{t("callLog.column.client")}</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{items.map((entry) => {
					const { measured, declared } = entry;
					const expanded = open.has(entry.offset);
					const client = declared.clientInfo;
					return (
						<Fragment key={entry.offset}>
							<TableRow>
								<TableCell title={measured.time}>
									<Pressable
										aria-expanded={expanded}
										onClick={() => toggle(entry.offset)}
										className="flex items-center gap-1 rounded-sm tabular-nums focus-visible:ring-2 focus-visible:ring-ring/60"
									>
										{expanded ? (
											<ChevronDown className="size-icon-sm" aria-hidden="true" />
										) : (
											<ChevronRight className="size-icon-sm" aria-hidden="true" />
										)}
										{new Date(measured.time).toLocaleString()}
									</Pressable>
								</TableCell>
								<TableCell>
									<span className="font-mono">{measured.tool}</span>
									{measured.request.actionId ? (
										<span className="ml-2 text-muted-foreground">
											{measured.request.actionId}@{measured.request.actionVersion}
											{measured.request.dryRun ? ` ${t("callLog.dryRun")}` : ""}
										</span>
									) : null}
								</TableCell>
								<TableCell>
									<Badge variant={measured.outcome === "ok" ? "success" : "error"}>{measured.outcome}</Badge>
								</TableCell>
								<TableCell>{measured.request.model ?? "—"}</TableCell>
								<TableCell className="font-mono">{measured.target?.branch ?? "—"}</TableCell>
								<TableCell className="tabular-nums">{measured.files.length}</TableCell>
								<TableCell className="tabular-nums">{`${measured.durationMs} ms`}</TableCell>
								<TableCell className="text-muted-foreground">
									{client ? `${client.name} ${client.version}` : "—"}
									<span className="ml-1 text-caption">{t("callLog.selfReported")}</span>
								</TableCell>
							</TableRow>
							{expanded ? (
								<TableRow>
									<TableCell colSpan={8} className="whitespace-normal">
										<CallLogDetail entry={entry} />
									</TableCell>
								</TableRow>
							) : null}
						</Fragment>
					);
				})}
			</TableBody>
		</Table>
	);
}

function CallLogDetail({ entry }: { entry: CallLogEntry }) {
	const t = useAisepT();
	const { measured, declared } = entry;
	const request = Object.entries(measured.request).filter(([, value]) => value !== null && !(Array.isArray(value) && value.length === 0));
	return (
		<div className="grid gap-4 py-1 md:grid-cols-2">
			<section className="flex flex-col gap-2">
				<h3 className="font-medium text-foreground">{t("callLog.detail.measured")}</h3>
				<Fields
					rows={[
						[t("callLog.detail.duration"), `${measured.durationMs} ms`],
						[t("callLog.detail.server"), `${measured.server.profile} · ${measured.server.transport} · pid ${measured.server.pid}`],
						[
							t("callLog.detail.target"),
							measured.target ? `${measured.target.branch} @ ${measured.target.head.slice(0, 12)}` : t("callLog.detail.noTarget"),
						],
						...(measured.target ? [[t("callLog.detail.worktree"), measured.target.worktree] as [string, string]] : []),
						...request.map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : String(value)] as [string, string]),
						...(measured.approval ? [[t("callLog.detail.approval"), measured.approval.commit] as [string, string]] : []),
					]}
				/>
				{measured.files.length ? (
					<Table className="text-xs">
						<TableHeader>
							<TableRow>
								<TableHead>{t("callLog.file.path")}</TableHead>
								<TableHead>{t("callLog.file.before")}</TableHead>
								<TableHead>{t("callLog.file.after")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{measured.files.map((file) => (
								<TableRow key={file.path}>
									<TableCell className="font-mono">{file.path}</TableCell>
									<TableCell className="font-mono" title={file.before ?? undefined}>{file.before ? shortHash(file.before) : t("callLog.file.new")}</TableCell>
									<TableCell className="font-mono" title={file.after}>{shortHash(file.after)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				) : (
					<p className="text-muted-foreground">{t("callLog.detail.noFiles")}</p>
				)}
			</section>
			<section className="flex flex-col gap-2">
				<h3 className="font-medium text-foreground">{t("callLog.detail.declared")}</h3>
				<Fields
					rows={[
						[t("callLog.detail.clientInfo"), declared.clientInfo ? `${declared.clientInfo.name} ${declared.clientInfo.version}` : "—"],
						...(declared.activity
							? [
									["activity.agent", declared.activity.agent] as [string, string],
									["activity.sessionRef", declared.activity.sessionRef] as [string, string],
								]
							: []),
					]}
				/>
			</section>
		</div>
	);
}

function Fields({ rows }: { rows: [string, string][] }) {
	return (
		<dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
			{rows.map(([label, value]) => (
				<Fragment key={label}>
					<dt className="text-muted-foreground">{label}</dt>
					<dd className="break-all whitespace-pre-line">{value}</dd>
				</Fragment>
			))}
		</dl>
	);
}

/** "sha256:5d1e…" stays as it is; a full digest shows its first 12 hex digits (hover for all of it). */
function shortHash(hash: string): string {
	const hex = hash.replace(/^sha256:/, "");
	return hex.length > 12 ? `${hex.slice(0, 12)}…` : hex;
}

function FilterSelect({
	label,
	value,
	onValueChange,
	options,
}: {
	label: string;
	value: string;
	onValueChange: (value: string) => void;
	options: { value: string; label: string }[];
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1">
			<span id={id} className="text-muted-foreground">{label}</span>
			<Select value={value} onValueChange={onValueChange}>
				<SelectTrigger size="sm" aria-labelledby={id} className="min-w-40">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/** Applied on Enter or leaving the field, not per keystroke (each change is a server call). */
function ModelFilter({ value, onChange, onCommit }: { value: string; onChange: (value: string) => void; onCommit: () => void }) {
	const t = useAisepT();
	const id = useId();
	return (
		<form
			className="flex flex-col gap-1"
			onSubmit={(event) => {
				event.preventDefault();
				onCommit();
			}}
		>
			<label htmlFor={id} className="text-muted-foreground">{t("callLog.filter.model")}</label>
			<Input
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onBlur={onCommit}
				className="h-control-form w-40 text-xs"
			/>
		</form>
	);
}
