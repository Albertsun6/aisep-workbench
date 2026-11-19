import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { appI18n } from "../i18n";
import { AisepWorkbenchPage } from "./AisepWorkbenchPage";
import type { AisepModelClient } from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import { aisepCatalogs } from "./i18n";

function renderPage(client: AisepModelClient = fixtureClient) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<AisepWorkbenchPage client={client} />
		</QueryClientProvider>,
	);
}

afterEach(async () => {
	cleanup();
	await act(() => appI18n.changeLanguage("en"));
});

describe("AisepWorkbenchPage", () => {
	it("shows the three placeholder regions with counts and titles from the client", async () => {
		renderPage();
		const en = aisepCatalogs.en;
		expect(screen.getByRole("heading", { level: 1, name: en["page.title"] })).toBeInTheDocument();

		const architecture = screen.getByRole("region", { name: en["section.architecture.title"] });
		expect(await within(architecture).findByText("Total: 8")).toBeInTheDocument();
		expect(within(architecture).getAllByRole("listitem")).toHaveLength(8);

		const gates = screen.getByRole("region", { name: en["section.gates.title"] });
		expect(within(gates).getByText("Total: 2")).toBeInTheDocument();
		expect(within(gates).getByText("报价审批")).toBeInTheDocument();
		expect(within(gates).getByText("单笔超过10万需二级审批")).toBeInTheDocument();

		const ai = screen.getByRole("region", { name: en["section.aiActivity.title"] });
		expect(within(ai).getByText(en["section.aiActivity.unsourced"])).toBeInTheDocument();
	});

	it("re-renders in the selected app language", async () => {
		renderPage();
		await act(() => appI18n.changeLanguage("zh-CN"));
		expect(screen.getByRole("heading", { level: 1, name: "AISEP 工作台" })).toBeInTheDocument();
		expect(await screen.findByText("共 8 项")).toBeInTheDocument();
	});

	it("shows an error state when the client fails", async () => {
		renderPage({ ...fixtureClient, query: () => Promise.reject(new Error("down")) } as AisepModelClient);
		expect(await screen.findAllByText(aisepCatalogs.en["section.error"])).toHaveLength(2);
	});
});
