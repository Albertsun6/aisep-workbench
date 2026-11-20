import { useParams } from "@tanstack/react-router";
import { AisepGatePage } from "./AisepGatePage";
import { AisepWorkbenchPage } from "./AisepWorkbenchPage";
import { useAisepT } from "./i18n";

/**
 * Entry for the `/aisep/*` splat route. New AISEP pages are dispatched here,
 * so the upstream `routes/` directory never needs another file.
 */
export function AisepRoot() {
	const { _splat: splat = "" } = useParams({ strict: false });
	if (splat === "") return <AisepWorkbenchPage />;
	// gate/<branch>: branch names contain "/", so the rest of the splat is the branch (§8 step 5).
	if (splat.startsWith("gate/") && splat.length > "gate/".length) return <AisepGatePage branch={splat.slice("gate/".length)} />;
	return <AisepNotFound />;
}

function AisepNotFound() {
	const t = useAisepT();
	return <p className="px-6 pt-6 text-xs text-muted-foreground">{t("page.notFound")}</p>;
}
