import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AisepApprovalProgress } from "./AisepApprovalProgress";
import { AisepToolError, type AisepModelClient, type QueryResult } from "./data/client";
import { fixtureClient } from "./data/fixture-client";
import { aisepCatalogs } from "./i18n";

const en = aisepCatalogs.en;
const EMPTY: QueryResult = { kind: "select", variables: ["record", "decision"], rows: [], truncated: false };

/** Every ref exists and holds no record (pending), until `down` makes every call fail like a lost connection. */
function flakyClient() {
	const state = { down: false };
	const client = Object.assign(Object.create(fixtureClient) as AisepModelClient, {
		query: async (): Promise<QueryResult> => {
			if (state.down) throw new AisepToolError("NETWORK", "no response from the model server", false);
			return EMPTY;
		},
	});
	return { client, state };
}

function renderProgress(client: AisepModelClient) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<AisepApprovalProgress client={client} branch="feat/approve" mainRef="refs/heads/main" />
		</QueryClientProvider>,
	);
}

afterEach(cleanup);

describe("AisepApprovalProgress", () => {
	it("keeps the last stage on screen when a later read fails, and says it failed", async () => {
		const { client, state } = flakyClient();
		renderProgress(client);
		expect(await screen.findByText(en["gate.progress.stage.pending"])).toHaveAttribute("aria-current", "step");
		state.down = true;
		await userEvent.click(screen.getByRole("button", { name: en["gate.progress.refresh"] }));
		expect(await screen.findByRole("alert")).toHaveTextContent("no response from the model server");
		expect(screen.getByText(en["gate.progress.stage.pending"])).toHaveAttribute("aria-current", "step");
		// The next good read clears the error.
		state.down = false;
		await userEvent.click(screen.getByRole("button", { name: en["gate.progress.refresh"] }));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it("shows only the error when the first read fails (no stage to keep)", async () => {
		const { client, state } = flakyClient();
		state.down = true;
		renderProgress(client);
		expect(await screen.findByRole("alert")).toHaveTextContent("no response from the model server");
		expect(screen.queryByRole("listitem")).toBeNull();
	});
});
