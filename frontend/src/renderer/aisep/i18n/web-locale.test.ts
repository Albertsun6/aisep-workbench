import { beforeEach, describe, expect, it, vi } from "vitest";
import { appI18n } from "../../i18n";

const getUiSettings = vi.fn();
const setUiSettings = vi.fn();

// 模拟上游网页版的回退桥接：读设置永远是 en，写设置不落盘。
vi.mock("../../lib/bridge", () => ({
	aoBridge: {
		uiSettings: {
			get: (...args: unknown[]) => getUiSettings(...args),
			set: (...args: unknown[]) => setUiSettings(...args),
		},
	},
}));

import { useLocaleStore } from "../../stores/locale-store";
import { initWebLocale, WEB_LOCALE_STORAGE_KEY } from "./web-locale";

function memoryStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
	};
}

// 模拟刷新页面：上游 store 回到刚启动的样子。
async function freshStart(): Promise<void> {
	await appI18n.changeLanguage("en");
	useLocaleStore.setState({ locale: "en", loaded: false, saving: false, saveError: false });
}

describe("网页版语言记忆", () => {
	beforeEach(async () => {
		getUiSettings.mockReset();
		setUiSettings.mockReset();
		getUiSettings.mockResolvedValue({ locale: "en" });
		setUiSettings.mockImplementation(async (settings: { locale: string }) => settings);
		await freshStart();
	});

	it("首次打开（没存过）是简体中文", async () => {
		const storage = memoryStorage();
		await initWebLocale({ hasDesktopBridge: false, storage });
		expect(useLocaleStore.getState().locale).toBe("zh-CN");
		expect(appI18n.language).toBe("zh-CN");
		expect(storage.getItem(WEB_LOCALE_STORAGE_KEY)).toBe("zh-CN");
	});

	it("选过英文后刷新仍是英文", async () => {
		const storage = memoryStorage();
		await initWebLocale({ hasDesktopBridge: false, storage });
		await useLocaleStore.getState().setLocale("en");
		expect(storage.getItem(WEB_LOCALE_STORAGE_KEY)).toBe("en");

		await freshStart();
		await initWebLocale({ hasDesktopBridge: false, storage });
		expect(useLocaleStore.getState().locale).toBe("en");
		expect(appI18n.language).toBe("en");
	});

	it("上游启动读取在后面也盖不回英文", async () => {
		const storage = memoryStorage({ [WEB_LOCALE_STORAGE_KEY]: "ja" });
		// 与 main.tsx 一样：模块加载时启动本模块，紧接着上游 load 同步发起。
		const init = initWebLocale({ hasDesktopBridge: false, storage });
		const upstreamLoad = useLocaleStore.getState().load();
		await Promise.all([init, upstreamLoad]);
		expect(useLocaleStore.getState().locale).toBe("ja");
		expect(appI18n.language).toBe("ja");
	});

	it("有桌面桥接时不介入", async () => {
		const storage = memoryStorage({ [WEB_LOCALE_STORAGE_KEY]: "zh-CN" });
		await initWebLocale({ hasDesktopBridge: true, storage });
		expect(getUiSettings).not.toHaveBeenCalled();
		expect(setUiSettings).not.toHaveBeenCalled();
		expect(useLocaleStore.getState().locale).toBe("en");
		expect(appI18n.language).toBe("en");
	});

	it("localStorage 读写抛错时仍默认简体中文", async () => {
		const storage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		await expect(initWebLocale({ hasDesktopBridge: false, storage })).resolves.toBeUndefined();
		expect(useLocaleStore.getState().locale).toBe("zh-CN");
	});
});
