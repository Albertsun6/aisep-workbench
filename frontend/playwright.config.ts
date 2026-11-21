import { defineConfig } from "@playwright/test";

// Overridable because 5173 is not ours alone: another worktree's
// `electron-forge start` also listens there, and with reuseExistingServer the
// suite silently runs against ITS renderer — which is built for Electron and
// fails in confusing, unrelated ways. Set AO_E2E_PORT to run alongside one.
const port = Number(process.env.AO_E2E_PORT ?? 5173);

export default defineConfig({
	testDir: "e2e",
	retries: process.env.CI ? 1 : 0,
	// AISEP: CI runners are presumed slower than dev machines; first-render
	// assertions on a busy runner can exceed the 5 s default without anything
	// being wrong. That premise rests only on local load data so far (see wb PR
	// #6), not on runner measurements. Cost: this is the default for every
	// expect assertion without an explicit timeout, in every spec this config
	// runs in CI (not just first render), so any such wait that regresses into
	// the 5–15 s range no longer fails in CI.
	expect: { timeout: process.env.CI ? 15_000 : 5_000 },
	reporter: process.env.CI ? [["list"], ["github"]] : "list",
	use: {
		baseURL: `http://127.0.0.1:${port}`,
	},
	webServer: {
		// dev:web serves the renderer alone (VITE_NO_ELECTRON=1) — no Electron child to
		// launch, which is all the browser-based e2e suite needs.
		command: process.env.AO_PERF_PRODUCTION === "1"
			? "node scripts/performance-web.mjs"
			: `npm run dev:web -- --port ${port} --host 127.0.0.1`,
		port,
		reuseExistingServer: !process.env.CI,
	},
});
