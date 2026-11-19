import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Workflow } from "@/components/app-icons";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { SidebarTopNavRow } from "../components/Sidebar";
import { useAisepT } from "./i18n";

/** AISEP's sidebar rows. Mounted by one line in the upstream Sidebar. */
export function AisepSidebarItems({ isCollapsed }: { isCollapsed: boolean }) {
	const t = useAisepT();
	const navigate = useNavigate();
	const active = useRouterState({
		select: (state) => state.location.pathname === "/aisep" || state.location.pathname.startsWith("/aisep/"),
	});
	const label = t("nav.title");
	return (
		<SidebarMenuItem>
			<SidebarTopNavRow
				active={active}
				icon={<Workflow aria-hidden="true" />}
				label={label}
				onClick={() => void navigate({ to: "/aisep/$", params: { _splat: "" } })}
				tooltip={isCollapsed ? label : undefined}
			/>
		</SidebarMenuItem>
	);
}
