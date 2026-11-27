import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// AISEP views page (src/renderer/aisep/AisepViewsPage.tsx) on the web build, which has no model server URL and so
// shows the recorded example views. In a real browser the SVG must load as an image (it is never inlined), zoom and
// pan must move it. AISEP_VIEWS_SCREENSHOT=<path> also saves a screenshot there.
// First visit (no stored locale): the page opens in Simplified Chinese, the copy Albert reads.
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 } });

test("aisep: views page lists the example views and shows one as an image @T0 @AISEP", async ({ page }) => {
	await page.goto("/#/aisep/views");
	await expect(page.getByRole("note")).toContainText("使用示例数据");
	await page.getByRole("region", { name: "采购" }).getByRole("button", { name: /Layered Viewpoint/ }).click();

	const image = page.getByRole("img", { name: "Layered Viewpoint" });
	await expect(image).toBeVisible();
	// The data: URL decoded and drew: an <img> that failed to load has naturalWidth 0.
	await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(814);
	expect(await page.locator('svg[viewBox="0 0 814 726"]').count()).toBe(0);
	await expect(page.getByText("元素 7 · 关系 8").first()).toBeVisible();

	const level = page.getByRole("status", { name: "缩放比例" });
	const fitted = await level.textContent();
	await page.getByRole("button", { name: "放大" }).click();
	await expect(level).not.toHaveText(fitted ?? "");

	const viewport = page.getByTestId("aisep-view-viewport");
	const before = await image.evaluate((img: HTMLImageElement) => img.style.transform);
	const box = await viewport.boundingBox();
	if (!box) throw new Error("no viewport box");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 4 });
	await page.mouse.up();
	await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.style.transform)).not.toBe(before);

	await page.getByRole("button", { name: "适应窗口" }).click();
	await expect(level).toHaveText(fitted ?? "");

	// Still fitted after a window resize (no manual zoom since "fit"); the zoom level follows the new size.
	await page.setViewportSize({ width: 1000, height: 700 });
	await expect(level).not.toHaveText(fitted ?? "");
	const refitted = await level.textContent();
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(level).toHaveText(fitted ?? "");
	// After a manual zoom a resize leaves the zoom alone.
	await page.getByRole("button", { name: "放大" }).click();
	const zoomed = await level.textContent();
	await page.setViewportSize({ width: 1000, height: 700 });
	await expect(level).toHaveText(zoomed ?? "");
	expect(zoomed).not.toBe(refitted);
	await page.setViewportSize({ width: 1440, height: 900 });

	// The web build saves through a blob download (the desktop app shows a save dialog); the file is the server's SVG.
	const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "下载 SVG" }).click()]);
	expect(download.suggestedFilename()).toBe("Layered Viewpoint.svg");
	const saved = await download.path();
	const layered = JSON.parse(readFileSync("src/renderer/aisep/data/fixtures/view-procurement-layered.json", "utf8")) as { svg: string };
	expect(readFileSync(saved, "utf8")).toBe(layered.svg);

	const screenshot = process.env.AISEP_VIEWS_SCREENSHOT;
	if (screenshot) await page.screenshot({ path: screenshot });
});
