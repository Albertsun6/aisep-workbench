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

// BPMN (aisep PR #193): the process's BPMN 2.0 XML is drawn by the real bpmn-js NavigatedViewer, read-only, with the
// bpmn.io watermark visible (license). AISEP_VIEWS_BPMN_SCREENSHOT=<path> also saves a screenshot there.
test("aisep: views page draws a BPMN process with bpmn-js, read-only, watermark visible @T0 @AISEP", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/#/aisep/views");
	const procurement = page.getByRole("region", { name: "采购" });
	await expect(procurement.getByRole("heading", { level: 3 })).toHaveText(["ArchiMate 视点", "BPMN 流程", "UML", "DDD"]);
	await procurement.getByRole("button", { name: /BPMN 流程：报价审批流程/ }).click();

	const canvas = page.getByTestId("aisep-bpmn-viewer");
	await expect(canvas).toHaveAccessibleName("BPMN 流程图（只读）: 报价审批流程");
	// Every flow node and sequence flow of the recorded XML is on the canvas: 6 + 6, plus the process root.
	const fixture = JSON.parse(readFileSync("src/renderer/aisep/data/fixtures/view-procurement-bpmn-quote-approval.json", "utf8")) as {
		content: string;
	};
	const ids = [...fixture.content.matchAll(/<bpmndi:BPMN(?:Shape|Edge) id="[^"]*" bpmnElement="([^"]*)"/g)].map((m) => m[1]);
	expect(ids).toHaveLength(12);
	for (const id of ids) await expect(canvas.locator(`[data-element-id="${id}"]`)).toHaveCount(1);
	await expect(canvas.getByText("审核报价单")).toBeVisible();
	// Read-only: no palette, no context pad, no direct editing.
	await expect(canvas.locator(".djs-palette, .djs-context-pad")).toHaveCount(0);
	await canvas.locator('[data-element-id="bpmnReview"]').dblclick();
	await expect(canvas.locator(".djs-direct-editing-parent")).toHaveCount(0);
	// The bpmn.io watermark (bpmn-js license) is there and not covered.
	const watermark = canvas.locator(".bjs-powered-by");
	await expect(watermark).toBeVisible();
	const box = await watermark.boundingBox();
	if (!box) throw new Error("no watermark box");
	const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".bjs-powered-by") !== null, {
		x: box.x + box.width / 2,
		y: box.y + box.height / 2,
	});
	expect(top).toBe(true);
	// Zoom buttons drive the bpmn-js canvas.
	const level = page.getByRole("status", { name: "缩放比例" });
	const fitted = await level.textContent();
	await page.getByRole("button", { name: "放大" }).click();
	await expect(level).not.toHaveText(fitted ?? "");
	await page.getByRole("button", { name: "适应窗口" }).click();
	await expect(level).toHaveText(fitted ?? "");
	expect(errors).toEqual([]);

	const screenshot = process.env.AISEP_VIEWS_BPMN_SCREENSHOT;
	if (screenshot) await page.screenshot({ path: screenshot });
});

// DDD (and UML) views are SVG: shown as an <img>, the server's SVG never inlined. AISEP_VIEWS_DDD_SCREENSHOT=<path>.
test("aisep: views page shows a DDD context map as an image, never inline SVG @T0 @AISEP", async ({ page }) => {
	await page.goto("/#/aisep/views");
	const procurement = page.getByRole("region", { name: "采购" });
	await procurement.getByRole("button", { name: /上下文映射图/ }).click();
	const image = page.getByRole("img", { name: "上下文映射图：采购" });
	await expect(image).toBeVisible();
	await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
	expect(await image.evaluate((img) => img.tagName)).toBe("IMG");
	// No SVG from the server in the DOM: its root carries role="img" and an aria-label, the app's icons do not.
	expect(await page.locator("svg[aria-label]").count()).toBe(0);
	expect(await page.locator("svg [data-kind]").count()).toBe(0);
	await expect(page.getByText("元素 2 · 关系 1").first()).toBeVisible();

	await procurement.getByRole("button", { name: /UML 类图/ }).click();
	await expect(page.getByRole("img", { name: "UML 类图：procurement" })).toBeVisible();
	expect(await page.locator("svg [data-kind]").count()).toBe(0);

	await procurement.getByRole("button", { name: /上下文映射图/ }).click();
	await expect(image).toBeVisible();
	const screenshot = process.env.AISEP_VIEWS_DDD_SCREENSHOT;
	if (screenshot) await page.screenshot({ path: screenshot });
});
