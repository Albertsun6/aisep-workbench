import { useParams, useRouterState } from "@tanstack/react-router";
import { AisepActionsPage } from "./AisepActionsPage";
import { AisepCallLogPage } from "./AisepCallLogPage";
import { AisepGatePage } from "./AisepGatePage";
import { AisepViewComparePage } from "./AisepViewComparePage";
import { AisepViewsPage } from "./AisepViewsPage";
import { AisepWorkbenchPage } from "./AisepWorkbenchPage";
import { useAisepT } from "./i18n";

/**
 * Entry for the `/aisep/*` splat route. New AISEP pages are dispatched here,
 * so the upstream `routes/` directory never needs another file.
 */
export function AisepRoot() {
	const { _splat: splat = "" } = useParams({ strict: false });
	// The raw query string: the router's parsed search would turn an all-digit commit into a number.
	const searchStr = useRouterState({ select: (state) => state.location.searchStr });
	if (splat === "") return <AisepWorkbenchPage />;
	if (splat === "calls") return <AisepCallLogPage />;
	if (splat === "actions") return <AisepActionsPage />;
	if (splat === "views") return <AisepViewsPage />;
	if (splat === "views/compare") {
		const search = new URLSearchParams(searchStr);
		return (
			<AisepViewComparePage
				view={search.get("view") ?? ""}
				base={search.get("base") ?? ""}
				head={search.get("head") ?? ""}
				branch={search.get("branch") ?? undefined}
			/>
		);
	}
	// gate/<branch>: branch names contain "/", so the rest of the splat is the branch (§8 step 5).
	if (splat.startsWith("gate/") && splat.length > "gate/".length) return <AisepGatePage branch={splat.slice("gate/".length)} />;
	return <AisepNotFound />;
}

function AisepNotFound() {
	const t = useAisepT();
	return <p className="px-6 pt-6 text-xs text-muted-foreground">{t("page.notFound")}</p>;
}
