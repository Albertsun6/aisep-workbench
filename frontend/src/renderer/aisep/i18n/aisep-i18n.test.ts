import { describe, expect, it } from "vitest";
import { APP_LOCALES, appI18n } from "../../i18n";
import { createLazyAppI18n } from "../../i18n/instance";
import jaMessages from "../../i18n/ja.json";
import zhMessages from "../../i18n/zh-CN.json";
import { AISEP_NS, aisepCatalogs, aisepFixedT, registerAisepCatalogs } from "./index";

const englishKeys = Object.keys(aisepCatalogs.en).sort();
const variables = (value: string) => [...value.matchAll(/{{\s*(\w+)\s*}}/g)].map((match) => match[1]).sort();

describe("AISEP i18n namespace", () => {
	it("has every English key, non-empty, with matching interpolation variables, in every app locale", () => {
		for (const locale of APP_LOCALES) {
			const catalog = aisepCatalogs[locale];
			expect(Object.keys(catalog).sort(), locale).toEqual(englishKeys);
			for (const key of englishKeys) {
				const value = catalog[key as keyof typeof catalog];
				expect(value.trim(), `${locale} ${key}`).not.toBe("");
				expect(variables(value), `${locale} ${key}`).toEqual(variables(aisepCatalogs.en[key as keyof typeof catalog]));
			}
		}
	});

	it("registers on the app instance without touching the upstream translation namespace", () => {
		expect(appI18n.getResource("zh-CN", AISEP_NS, "section.gates.title")).toBe("待批准关口");
		expect(appI18n.getResource("en", "translation", "section.gates.title")).toBeUndefined();
	});

	it("falls back to English within the aisep namespace", () => {
		const t = aisepFixedT(appI18n, "zh-CN");
		appI18n.removeResourceBundle("zh-CN", AISEP_NS);
		appI18n.addResourceBundle("zh-CN", AISEP_NS, { "nav.title": "AISEP" });
		expect(t("page.title")).toBe(aisepCatalogs.en["page.title"]);
		registerAisepCatalogs();
		expect(t("page.title")).toBe(aisepCatalogs["zh-CN"]["page.title"]);
	});

	it("does not stop the lazy backend from loading the upstream catalog on language change", async () => {
		const instance = createLazyAppI18n();
		registerAisepCatalogs(instance);
		await instance.changeLanguage("ja");
		expect(instance.t("settings.general")).toBe(jaMessages["settings.general"]);
		expect(aisepFixedT(instance, "ja")("nav.title")).toBe(aisepCatalogs.ja["nav.title"]);
		// The backend ignores the namespace; the pre-registered bundle must not be overwritten by the full catalog.
		expect(instance.getResource("ja", AISEP_NS, "settings.general")).toBeUndefined();
		await instance.changeLanguage("zh-CN");
		expect(instance.t("settings.general")).toBe(zhMessages["settings.general"]);
	});
});
