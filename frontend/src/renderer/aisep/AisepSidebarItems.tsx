import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LayoutGrid, ScrollText, Workflow, Zap } from "@/components/app-icons";
import { SidebarMenuItem } from "@/components/ui/sidebar";
import { SidebarTopNavRow } from "../components/Sidebar";
import { useAisepT, type AisepMessageKey } from "./i18n";

/** Pages with their own sidebar row; every other /aisep path (home, gate pages) belongs to the AISEP row. */
const SUBPAGES = ["views", "calls", "actions"] as const;

/** AISEP's sidebar rows. Mounted by one line in the upstream Sidebar. */
export function AisepSidebarItems({ isCollapsed }: { isCollapsed: boolean }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	const inAisep = pathname === "/aisep" || pathname.startsWith("/aisep/");
	const subpage = SUBPAGES.find((page) => pathname === `/aisep/${page}`);
	return (
		<>
			<AisepRow splat="" labelKey="nav.title" icon={<Workflow aria-hidden="true" />} active={inAisep && !subpage} isCollapsed={isCollapsed} />
			<AisepRow splat="views" labelKey="nav.views" icon={<LayoutGrid aria-hidden="true" />} active={subpage === "views"} isCollapsed={isCollapsed} />
			<AisepRow splat="calls" labelKey="nav.callLog" icon={<ScrollText aria-hidden="true" />} active={subpage === "calls"} isCollapsed={isCollapsed} />
			<AisepRow splat="actions" labelKey="nav.actions" icon={<Zap aria-hidden="true" />} active={subpage === "actions"} isCollapsed={isCollapsed} />
		</>
	);
}

function AisepRow({
	splat,
	labelKey,
	icon,
	active,
	isCollapsed,
}: {
	splat: string;
	labelKey: AisepMessageKey;
	icon: ReactNode;
	active: boolean;
	isCollapsed: boolean;
}) {
	const t = useAisepT();
	const navigate = useNavigate();
	const label = t(labelKey);
	return (
		<SidebarMenuItem>
			<SidebarTopNavRow
				active={active}
				icon={icon}
				label={label}
				onClick={() => void navigate({ to: "/aisep/$", params: { _splat: splat } })}
				tooltip={isCollapsed ? label : undefined}
			/>
		</SidebarMenuItem>
	);
}
