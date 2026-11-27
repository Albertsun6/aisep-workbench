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

	const screenshot = process.env.AISEP_VIEWS_SCREENSHOT;
	if (screenshot) await page.screenshot({ path: screenshot });
});
