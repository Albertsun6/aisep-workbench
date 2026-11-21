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

export function defaultEnv(): WebLocaleEnv {
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

// 上一次 initWebLocale 的订阅：再次调用（测试里反复调、HMR 重载本模块）时先退掉，
// 免得写回 localStorage 的订阅越叠越多。
let unsubscribe: (() => void) | undefined;
import.meta.hot?.dispose(() => unsubscribe?.());

export async function initWebLocale(env: WebLocaleEnv = defaultEnv()): Promise<void> {
	if (env.hasDesktopBridge) return;
	// 起作用的是顺序：上游 load()（读到的是不落盘的 en）要在 setLocale 之前发起。
	// 发起时它记下 localeRevision，之后 setLocale 把版本号加一，它读完就不再套用；
	// 反过来先 setLocale、后发起 load，load 就会把语言盖回 en。这里 await 只是让
	// 顺序一目了然，不是必需的。load 自带去重，main.tsx 随后的那次调用直接复用。
	await useLocaleStore.getState().load();
	const wanted = readLocale(env.storage);
	unsubscribe?.();
	unsubscribe = useLocaleStore.subscribe((state, prev) => {
		if (state.locale !== prev.locale) writeLocale(env.storage, state.locale);
	});
	if (useLocaleStore.getState().locale !== wanted) await useLocaleStore.getState().setLocale(wanted);
}
