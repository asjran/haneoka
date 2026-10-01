/// <reference types="astro/client" />
import cnFlag from "circle-flags/flags/cn.svg?url";
import hkFlag from "circle-flags/flags/hk.svg?url";
import gbFlag from "circle-flags/flags/gb.svg?url";
import jpFlag from "circle-flags/flags/jp.svg?url";
import krFlag from "circle-flags/flags/kr.svg?url";

/** Autonyms and the same flags used by the site's locale picker. Availability comes from each stamp. */
export const STAMP_LANGUAGES: Readonly<Record<string, { label: string; flag: string }>> = {
  ja: { label: "日本語", flag: jpFlag },
  en: { label: "English", flag: gbFlag },
  "zh-Hant": { label: "繁體中文", flag: hkFlag },
  "zh-Hans": { label: "简体中文", flag: cnFlag },
  ko: { label: "한국어", flag: krFlag },
};
