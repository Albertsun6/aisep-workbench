import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AisepActionsPage } from "./AisepActionsPage";
import type { AisepModelClient, ListActionsResult } from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import { McpProtocolError } from "./data/mcp-client";
import { LIST_ACTIONS_SAMPLE } from "./data/samples";
import { aisepCatalogs } from "./i18n";

const en = aisepCatalogs.en;

function renderPage(client: AisepModelClient) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<AisepActionsPage client={client} />
		</QueryClientProvider>,
	);
}

function clientWith(listActions: () => Promise<ListActionsResult>): AisepModelClient {
	return Object.assign(Object.create(fixtureClient) as AisepModelClient, { listActions });
}

afterEach(cleanup);

describe("AisepActionsPage", () => {
	it("renders the sample catalogue with an 'interface not connected' notice when there is no recording", async () => {
		renderPage(fixtureClient);
		expect(await screen.findByText(en["sample.badge"])).toHaveAttribute("role", "status");
		expect(screen.getByText(en["actions.unconnected"])).toBeInTheDocument();
		// The source line says it is sample data, not "the catalogue merged into main".
		expect(screen.getByText(en["actions.sourceSample"].replace("{{version}}", "0.2.0"))).toBeInTheDocument();
		expect(screen.queryByText(en["actions.source"].replace("{{version}}", "0.2.0"))).toBeNull();

		const register = screen.getByRole("listitem", { name: "登记验收标准并挂到需求" });
		expect(within(register).getByText("register-acceptance-criterion")).toBeInTheDocument();
		expect(within(register).queryByText(en["actions.destructive"])).toBeNull();
		// Parameter table (name, required, type, description): required from `required`, IRI from `iriParams`.
		const cells = (name: RegExp) =>
			within(within(register).getByRole("row", { name })).getAllByRole("cell").map((cell) => cell.textContent);
		expect(cells(/^requirement /).slice(0, 3)).toEqual(["requirement", en["actions.param.requiredYes"], "IRI"]);
		expect(cells(/^slug /).slice(0, 3)).toEqual(["slug", en["actions.param.requiredNo"], en["actions.param.text"]]);
		expect(within(register).getByText("parent-is-not-deprecated")).toBeInTheDocument();
		expect(within(register).getByText("aggregation → model_add_relationship")).toBeInTheDocument();

		const remove = screen.getByRole("listitem", { name: "删除元素" });
		expect(within(remove).getByText(en["actions.destructive"])).toBeInTheDocument();
	});

	it("is read-only: no button anywhere on the page", async () => {
		renderPage(fixtureClient);
		await screen.findByRole("listitem", { name: "删除元素" });
		expect(screen.queryAllByRole("button")).toHaveLength(0);
	});

	it("lists invalid definitions last with their problems, and shows live data without the sample notice", async () => {
		renderPage(
			clientWith(async () => ({
				...LIST_ACTIONS_SAMPLE,
				actions: [
					{ id: null, iri: "https://aisep.example/ont/aisep#ActionBroken", valid: false, problems: ["EA2 动作：dcterms:identifier 须恰好一个"] },
					...LIST_ACTIONS_SAMPLE.actions,
				],
			})),
		);
		const broken = await screen.findByRole("listitem", { name: "https://aisep.example/ont/aisep#ActionBroken" });
		expect(within(broken).getByText(en["actions.invalid"])).toBeInTheDocument();
		expect(within(broken).getByText("EA2 动作：dcterms:identifier 须恰好一个")).toBeInTheDocument();
		const cards = screen.getAllByRole("listitem").filter((item) => item.parentElement?.classList.contains("divide-y"));
		expect(cards.at(-1)).toBe(broken);
		expect(screen.queryByText(en["sample.badge"])).toBeNull();
		expect(screen.queryByText(en["actions.unconnected"])).toBeNull();
		expect(screen.getByText(en["actions.source"].replace("{{version}}", "0.2.0"))).toBeInTheDocument();
	});

	it("lists every problem of an invalid definition, repeated ones included, without a key clash", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			renderPage(
				clientWith(async () => ({
					...LIST_ACTIONS_SAMPLE,
					actions: [{ id: "broken", iri: null, valid: false, problems: ["同一条问题", "同一条问题"] }],
				})),
			);
			const broken = await screen.findByRole("listitem", { name: "broken" });
			expect(within(broken).getAllByText("同一条问题")).toHaveLength(2);
			expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/same key/);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("says when the catalogue is empty", async () => {
		renderPage(clientWith(async () => ({ ...LIST_ACTIONS_SAMPLE, actions: [] })));
		expect(await screen.findByText(en["actions.empty"])).toBeInTheDocument();
	});

	it("shows a real failure as an error, not as sample data", async () => {
		renderPage(
			clientWith(async () => {
				// A JSON-RPC internal error: not retried, and not an unknown tool.
				throw new McpProtocolError("model_list_actions: boom", 200, -32603);
			}),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent("boom");
		expect(screen.queryByText(en["actions.unconnected"])).toBeNull();
	});
});
