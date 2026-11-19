// AISEP copy lives in its own i18next namespace so the upstream catalogs
// (src/renderer/i18n/*.json) stay untouched and never conflict on upstream sync.
import type { i18n as I18n } from "i18next";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { APP_LOCALES, appI18n, type AppLocale } from "../../i18n";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import fr from "./fr.json";
import ja from "./ja.json";
import ko from "./ko.json";
import ptBR from "./pt-BR.json";
import ru from "./ru.json";
import zhCN from "./zh-CN.json";

export const AISEP_NS = "aisep";

export type AisepMessageKey = keyof typeof en;
type AisepCatalog = Record<AisepMessageKey, string>;

// Typed per locale: a catalog missing an English key fails typecheck.
export const aisepCatalogs: Record<AppLocale, AisepCatalog> = {
	en,
	"zh-CN": zhCN,
	ja,
	ko,
	es,
	fr,
	de,
	"pt-BR": ptBR,
	ru,
};

/**
 * Register every AISEP catalog up front. They are tiny, and a pre-registered
 * bundle keeps the upstream lazy backend (which ignores the namespace) from
 * ever being asked for the `aisep` namespace.
 */
export function registerAisepCatalogs(instance: I18n = appI18n): void {
	for (const locale of APP_LOCALES) {
		instance.addResourceBundle(locale, AISEP_NS, aisepCatalogs[locale], true, true);
	}
}

registerAisepCatalogs();

export type AisepT = (key: AisepMessageKey, options?: Record<string, unknown>) => string;

/**
 * Fixed `t` for the AISEP namespace. The upstream i18next typings pin the
 * namespace to `translation`, so this is the one place that owns the cast.
 */
export function aisepFixedT(instance: I18n, language: string): AisepT {
	const getFixedT = instance.getFixedT.bind(instance) as unknown as (lng: string, ns: string) => AisepT;
	const fixed = getFixedT(language, AISEP_NS);
	return (key, options) => fixed(key, options);
}

/** `t` for the AISEP namespace, with keys typed against en.json. */
export function useAisepT(): AisepT {
	// Default-namespace hook: subscribes to language changes so callers re-render.
	const { i18n } = useTranslation();
	const language = i18n.language;
	return useMemo(() => aisepFixedT(i18n, language), [i18n, language]);
}
