// 网页版（没有 window.ao 桌面桥接）记住界面语言，首次打开默认简体中文。
// 上游网页版的设置桥接不落盘、读设置永远返回 en，刷新就回英文；桌面版自己存
// ~/.ao 下的 ui-settings.json，本模块不介入。只经上游 useLocaleStore 的
// load / setLocale 改语言，不改上游文件。
import { APP_LOCALES, type AppLocale } from "../../i18n";
import { useLocaleStore } from "../../stores/locale-store";

export const WEB_LOCALE_STORAGE_KEY = "aisep.locale";
export const WEB_DEFAULT_LOCALE: AppLocale = "zh-CN";

type LocaleStorage = Pick<Storage, "getItem" | "setItem">;

export interface WebLocaleEnv {
	hasDesktopBridge: boolean;
	storage: LocaleStorage | undefined;
}

function defaultEnv(): WebLocaleEnv {
	let storage: LocaleStorage | undefined;
	try {
		storage = window.localStorage;
	} catch {
		// 隐私模式或禁用站点数据时，连读 localStorage 属性都可能抛错。
	}
	return { hasDesktopBridge: window.ao !== undefined, storage };
}

function readLocale(storage: LocaleStorage | undefined): AppLocale {
	try {
		const raw = storage?.getItem(WEB_LOCALE_STORAGE_KEY);
		if (raw && (APP_LOCALES as readonly string[]).includes(raw)) return raw as AppLocale;
	} catch {
		// 读不到就当首次打开。
	}
	return WEB_DEFAULT_LOCALE;
}

function writeLocale(storage: LocaleStorage | undefined, locale: AppLocale): void {
	try {
		storage?.setItem(WEB_LOCALE_STORAGE_KEY, locale);
	} catch {
		// 写不进去只是下次不记得，不影响当前界面。
	}
}

export async function initWebLocale(env: WebLocaleEnv = defaultEnv()): Promise<void> {
	if (env.hasDesktopBridge) return;
	// 先让上游自己的启动读取（读到的是不落盘的 en）跑完，再套用记住的语言；
	// 反过来的话上游的 load 会在之后把语言盖回 en。load 自带去重，main.tsx
	// 随后的那次调用直接复用。
	await useLocaleStore.getState().load();
	const wanted = readLocale(env.storage);
	useLocaleStore.subscribe((state, prev) => {
		if (state.locale !== prev.locale) writeLocale(env.storage, state.locale);
	});
	if (useLocaleStore.getState().locale !== wanted) await useLocaleStore.getState().setLocale(wanted);
}
