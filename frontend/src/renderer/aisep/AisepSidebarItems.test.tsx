import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

const router = vi.hoisted(() => ({ pathname: "/", navigate: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => router.navigate,
	useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
		select({ location: { pathname: router.pathname } }),
}));

import { AisepSidebarItems } from "./AisepSidebarItems";

function renderItems() {
	return render(
		<TooltipProvider>
			<SidebarProvider>
				<SidebarMenu>
					<AisepSidebarItems isCollapsed={false} />
				</SidebarMenu>
			</SidebarProvider>
		</TooltipProvider>,
	);
}

beforeEach(() => {
	router.pathname = "/";
	router.navigate.mockReset();
});
afterEach(cleanup);

describe("AisepSidebarItems", () => {
	it("navigates to the AISEP splat route", async () => {
		renderItems();
		await userEvent.setup().click(screen.getByRole("button", { name: "AISEP" }));
		expect(router.navigate).toHaveBeenCalledWith({ to: "/aisep/$", params: { _splat: "" } });
	});

	it("is the current page on any /aisep path only", () => {
		router.pathname = "/aisep/";
		const { unmount } = renderItems();
		expect(screen.getByRole("button", { name: "AISEP" })).toHaveAttribute("aria-current", "page");
		unmount();

		router.pathname = "/aisep-other";
		renderItems();
		expect(screen.getByRole("button", { name: "AISEP" })).not.toHaveAttribute("aria-current");
	});

	it("has rows for the call log and the actions, each current only on its own page", async () => {
		router.pathname = "/aisep/calls";
		renderItems();
		expect(screen.getByRole("button", { name: "Call log" })).toHaveAttribute("aria-current", "page");
		expect(screen.getByRole("button", { name: "AISEP" })).not.toHaveAttribute("aria-current");
		expect(screen.getByRole("button", { name: "Actions" })).not.toHaveAttribute("aria-current");
		await userEvent.setup().click(screen.getByRole("button", { name: "Actions" }));
		expect(router.navigate).toHaveBeenCalledWith({ to: "/aisep/$", params: { _splat: "actions" } });
	});

	it("keeps gate pages under the AISEP row", () => {
		router.pathname = "/aisep/gate/feat/x";
		renderItems();
		expect(screen.getByRole("button", { name: "AISEP" })).toHaveAttribute("aria-current", "page");
	});

	it("has a Views row that opens /aisep/views and is the current page there, instead of the AISEP row", async () => {
		router.pathname = "/aisep/views";
		renderItems();
		expect(screen.getByRole("button", { name: "Views" })).toHaveAttribute("aria-current", "page");
		expect(screen.getByRole("button", { name: "AISEP" })).not.toHaveAttribute("aria-current");
		await userEvent.setup().click(screen.getByRole("button", { name: "Views" }));
		expect(router.navigate).toHaveBeenCalledWith({ to: "/aisep/$", params: { _splat: "views" } });
	});

	// Upstream-sync guard: the single mount line must survive merges, right after the Artifacts row.
	it("stays mounted in the upstream Sidebar after the Artifacts row", () => {
		const source = readFileSync(path.resolve(process.cwd(), "src/renderer/components/Sidebar.tsx"), "utf8");
		const artifacts = source.indexOf("onClick={selection.goArtifacts}");
		const mount = source.indexOf("<AisepSidebarItems isCollapsed={isCollapsed} />");
		expect(artifacts).toBeGreaterThan(-1);
		expect(mount).toBeGreaterThan(artifacts);
		expect(source).toContain("export function SidebarTopNavRow(");
	});
});
