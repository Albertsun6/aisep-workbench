import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const location = vi.hoisted(() => ({ splat: "", searchStr: "" }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useParams: () => ({ _splat: location.splat }),
	useRouterState: ({ select }: { select: (state: { location: { searchStr: string } }) => unknown }) =>
		select({ location: { searchStr: location.searchStr } }),
}));

vi.mock("./AisepViewComparePage", () => ({
	AisepViewComparePage: (props: Record<string, unknown>) => <pre data-testid="compare">{JSON.stringify(props)}</pre>,
}));

import { AisepRoot } from "./AisepRoot";

afterEach(cleanup);

function compareProps(searchStr: string) {
	location.splat = "views/compare";
	location.searchStr = searchStr;
	render(<AisepRoot />);
	return JSON.parse(screen.getByTestId("compare").textContent ?? "") as Record<string, unknown>;
}

describe("AisepRoot views/compare", () => {
	it("passes view, base, head and branch from the raw query string, an all-digit commit stays a string", () => {
		const view = "https://aisep.example/model/procurement/view-quote-approval-app-usage";
		const search = new URLSearchParams({ view, base: "1234567", head: "78068baa7461362e81850970fd6d4aee799e4462", branch: "feat/a b" });
		expect(compareProps(`?${search.toString()}`)).toEqual({
			view,
			base: "1234567",
			head: "78068baa7461362e81850970fd6d4aee799e4462",
			branch: "feat/a b",
		});
	});

	it("passes empty strings and no branch when the parameters are missing", () => {
		expect(compareProps("")).toEqual({ view: "", base: "", head: "" });
	});
});
