import { expect, test } from "@playwright/test";

// AISEP: the web build (no window.ao) opens in Simplified Chinese the first time
// and remembers the choice (src/renderer/aisep/i18n/web-locale.ts).
// playwright.config.ts pre-seeds aisep.locale=en for every other spec; clear it
// here so this is a true first visit.
test.use({ storageState: { cookies: [], origins: [] } });

test("aisep: first web visit defaults to Simplified Chinese @T0 @AISEP", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
	await expect.poll(() => page.evaluate(() => window.localStorage.getItem("aisep.locale"))).toBe("zh-CN");
});
