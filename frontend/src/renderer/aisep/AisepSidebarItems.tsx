import { useNavigate, useRouterState } from "@tanstack/react-router";
import { LayoutGrid, Workflow } from "@/components/app-icons";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { SidebarTopNavRow } from "../components/Sidebar";
import { useAisepT } from "./i18n";

/** AISEP's sidebar rows. Mounted by one line in the upstream Sidebar. */
export function AisepSidebarItems({ isCollapsed }: { isCollapsed: boolean }) {
	const t = useAisepT();
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const onViews = pathname === "/aisep/views";
	const active = !onViews && (pathname === "/aisep" || pathname.startsWith("/aisep/"));
	const label = t("nav.title");
	const viewsLabel = t("nav.views");
	return (
		<>
			<SidebarMenuItem>
				<SidebarTopNavRow
					active={active}
					icon={<Workflow aria-hidden="true" />}
					label={label}
					onClick={() => void navigate({ to: "/aisep/$", params: { _splat: "" } })}
					tooltip={isCollapsed ? label : undefined}
				/>
			</SidebarMenuItem>
			<SidebarMenuItem>
				<SidebarTopNavRow
					active={onViews}
					icon={<LayoutGrid aria-hidden="true" />}
					label={viewsLabel}
					onClick={() => void navigate({ to: "/aisep/$", params: { _splat: "views" } })}
					tooltip={isCollapsed ? viewsLabel : undefined}
				/>
			</SidebarMenuItem>
		</>
	);
}
