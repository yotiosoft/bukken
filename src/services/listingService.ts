import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import type { ScrapeListingInput } from "../types/schema.js";

type ListingSite = "suumo" | "homes";
type ListingFieldMap = Record<string, string | null>;

type ResolvedTarget = {
  site: ListingSite;
  id: string | null;
  url: string;
};

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "accept-language": "ja,en-US;q=0.9,en;q=0.8",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const EMPTY_OUTPUT: ListingFieldMap = {
  "物件名": null,
  "住所": null,
  "敷金/礼金": null,
  "保証金": null,
  "敷引・償却": null,
  "アクセス": null,
  "間取り": null,
  "専有面積": null,
  "向き": null,
  "建物種別": null,
  "築年数": null,
  "階建": null,
  "損保": null,
  "入居時期": null,
  "条件": null,
  "契約期間": null,
  "仲介手数料": null,
  "保証会社": null,
  "ほか初期費用": null,
  "築年月": null,
  "取引態様": null,
  "取引様態": null,
  "備考": null,
};

const normalizeSpace = (value: string | null | undefined) =>
  value?.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim() ?? "";

const cleanLabel = (value: string | null | undefined) =>
  normalizeSpace(value).replace(/[：:]/g, "").replace(/\s+/g, "");

const uniqJoin = (values: string[]) =>
  [...new Set(values.map((value) => normalizeSpace(value)).filter(Boolean))].join("\n");

const cleanupValue = (value: string | null | undefined) => {
  const normalized = normalizeSpace(value);
  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/地図を見る/g, "")
    .replace(/\s*\|\s*LIFULL HOME'S.*$/g, "")
    .replace(/^\s*[:：-]+/, "")
    .trim();
};

const setIfEmpty = (record: ListingFieldMap, key: keyof typeof EMPTY_OUTPUT, value: string | null | undefined) => {
  const normalized = cleanupValue(value);
  if (!normalized || record[key]) {
    return;
  }
  record[key] = normalized;
};

const mergeValue = (record: Map<string, string>, key: string, value: string) => {
  const normalizedKey = cleanLabel(key);
  const normalizedValue = cleanupValue(value);
  if (!normalizedKey || !normalizedValue) {
    return;
  }

  const current = record.get(normalizedKey);
  if (!current) {
    record.set(normalizedKey, normalizedValue);
    return;
  }

  record.set(normalizedKey, uniqJoin([current, normalizedValue]));
};

const getTextLines = ($: CheerioAPI, element: AnyNode | null | undefined) => {
  if (!element) {
    return [];
  }

  const clone = $(element).clone();
  clone.find("script, style, noscript").remove();
  return clone
    .text()
    .split("\n")
    .map((line) => cleanupValue(line))
    .filter((line): line is string => Boolean(line));
};

const buildLabelMap = ($: CheerioAPI) => {
  const map = new Map<string, string>();

  $("tr").each((_, row) => {
    const label = normalizeSpace($(row).find("th").first().text());
    const value = normalizeSpace($(row).find("td").first().text());
    if (label && value) {
      mergeValue(map, label, value);
    }
  });

  $("dt").each((_, dt) => {
    const label = normalizeSpace($(dt).text());
    const value = normalizeSpace($(dt).next("dd").text());
    if (label && value) {
      mergeValue(map, label, value);
    }
  });

  return map;
};

const getByLabels = (map: Map<string, string>, labels: string[]) => {
  for (const label of labels) {
    const value = map.get(cleanLabel(label));
    if (value) {
      return value;
    }
  }

  for (const [key, value] of map.entries()) {
    if (labels.some((label) => key.includes(cleanLabel(label)))) {
      return value;
    }
  }

  return null;
};

const getMetaContent = ($: CheerioAPI, selectors: string[]) => {
  for (const selector of selectors) {
    const value = cleanupValue($(selector).attr("content") ?? $(selector).text());
    if (value) {
      return value;
    }
  }
  return null;
};

const parseSuumoId = (value: string) => {
  const match = value.match(/jnc_(\d+)/i) ?? value.match(/(\d{6,})/);
  return match?.[1] ?? null;
};

const parseHomesId = (value: string) => {
  const match = value.match(/b-(\d+)/i) ?? value.match(/(\d{6,})/);
  return match?.[1] ?? null;
};

const resolveTarget = (input: ScrapeListingInput): ResolvedTarget => {
  if (input.url) {
    const url = new URL(input.url);
    const hostname = url.hostname.toLowerCase();

    if (hostname.includes("suumo.jp")) {
      return { site: "suumo", id: parseSuumoId(url.pathname), url: url.toString() };
    }

    if (hostname.includes("homes.co.jp")) {
      return { site: "homes", id: parseHomesId(url.pathname), url: url.toString() };
    }

    throw new Error("対応しているURLは suumo.jp または homes.co.jp のみです。");
  }

  if (input.site === "suumo" && input.id) {
    const id = parseSuumoId(input.id) ?? input.id;
    return { site: "suumo", id, url: `https://suumo.jp/chintai/jnc_${id}/` };
  }

  if (input.site === "homes" && input.id) {
    const id = parseHomesId(input.id) ?? input.id;
    return { site: "homes", id, url: `https://www.homes.co.jp/chintai/b-${id}/` };
  }

  throw new Error("url または site と id の両方を指定してください。");
};

const fetchHtml = async (url: string) => {
  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`スクレイピングに失敗しました: ${response.status} ${response.statusText}`);
  }
  return response.text();
};

const getFirstText = ($: CheerioAPI, selectors: string[]) => {
  for (const selector of selectors) {
    const text = cleanupValue($(selector).first().text());
    if (text) {
      return text;
    }
  }
  return null;
};

const extractAge = (value: string | null) => {
  if (!value) {
    return null;
  }
  const match = value.match(/築[^)\n]+/);
  return match?.[0] ?? value;
};

const extractSuumoAccess = ($: CheerioAPI, labelMap: Map<string, string>) => {
  const access = getByLabels(labelMap, ["交通", "沿線・駅"]);
  if (access) {
    return access;
  }

  const candidates: string[] = [];
  $(".property_view_note-emphasis, .property_view_note-info, .property_view_detail-header li").each((_, element) => {
    const lines = getTextLines($, element).filter((line) => /歩|バス|線|駅/.test(line));
    candidates.push(...lines);
  });

  return candidates.length ? uniqJoin(candidates) : null;
};

const extractHomesAccess = ($: CheerioAPI, labelMap: Map<string, string>) => {
  const access = getByLabels(labelMap, ["交通", "アクセス"]);
  if (access) {
    return access;
  }

  const candidates: string[] = [];
  $("section, div, li").each((_, element) => {
    const lines = getTextLines($, element);
    if (lines.some((line) => cleanLabel(line) === "交通")) {
      candidates.push(...lines.filter((line) => line !== "交通"));
    }
  });

  return candidates.length ? uniqJoin(candidates) : null;
};

const splitPair = (value: string | null) => {
  if (!value) {
    return [null, null] as const;
  }
  const parts = value.split("/").map((part) => cleanupValue(part));
  return [parts[0] || null, parts[1] || null] as const;
};

const extractCostItem = (value: string | null, label: string) => {
  if (!value) {
    return null;
  }

  const match = value.match(new RegExp(`${label}[：:]([^、\n]+)`));
  return cleanupValue(match?.[1]);
};

const parseSuumo = (html: string, target: ResolvedTarget) => {
  const $ = cheerio.load(html);
  const labelMap = buildLabelMap($);
  const output: ListingFieldMap = { ...EMPTY_OUTPUT };

  setIfEmpty(output, "物件名", getFirstText($, ["h1", ".section_h1-header-title", ".property_view_detail-header h1"]));
  setIfEmpty(output, "物件名", getMetaContent($, ["meta[property='og:title']", "title"]));
  setIfEmpty(output, "住所", getByLabels(labelMap, ["住所", "所在地"]));
  setIfEmpty(output, "アクセス", extractSuumoAccess($, labelMap));
  setIfEmpty(output, "間取り", getByLabels(labelMap, ["間取り", "間取り詳細"]));
  setIfEmpty(output, "専有面積", getByLabels(labelMap, ["専有面積"]));
  setIfEmpty(output, "向き", getByLabels(labelMap, ["向き"]));
  setIfEmpty(output, "建物種別", getByLabels(labelMap, ["建物種別", "種別", "建物構造", "構造"]));
  setIfEmpty(output, "築年数", getByLabels(labelMap, ["築年数", "築年", "築年月"]));
  setIfEmpty(output, "階建", getByLabels(labelMap, ["階建", "所在階", "階数"]));
  setIfEmpty(output, "損保", getByLabels(labelMap, ["損保", "保険"]));
  setIfEmpty(output, "入居時期", getByLabels(labelMap, ["入居", "入居時期"]));
  setIfEmpty(output, "条件", getByLabels(labelMap, ["条件"]));
  setIfEmpty(output, "契約期間", getByLabels(labelMap, ["契約期間"]));
  setIfEmpty(output, "仲介手数料", getByLabels(labelMap, ["仲介手数料"]));
  setIfEmpty(output, "保証会社", getByLabels(labelMap, ["保証会社", "保証会社利用"]));
  setIfEmpty(output, "ほか初期費用", getByLabels(labelMap, ["ほか初期費用", "その他初期費用"]));
  setIfEmpty(output, "築年月", getByLabels(labelMap, ["築年月"]));
  setIfEmpty(output, "取引態様", getByLabels(labelMap, ["取引態様"]));
  setIfEmpty(output, "備考", getByLabels(labelMap, ["備考"]));

  const shikikin = getByLabels(labelMap, ["敷金"]);
  const reikin = getByLabels(labelMap, ["礼金"]);
  if (shikikin || reikin) {
    setIfEmpty(output, "敷金/礼金", `${shikikin ?? "-"} / ${reikin ?? "-"}`);
  }

  setIfEmpty(output, "保証金", getByLabels(labelMap, ["保証金"]));
  setIfEmpty(output, "敷引・償却", getByLabels(labelMap, ["敷引・償却", "敷引", "償却"]));

  if (!output["住所"]) {
    const summary = $("body").text().match(/(東京都|北海道|(?:京都|大阪)府|..県).{2,80}?(?:市|区|町|村).{0,80}/);
    if (summary) {
      output["住所"] = cleanupValue(summary[0]);
    }
  }

  output["築年数"] = extractAge(output["築年数"]);
  output["取引様態"] = output["取引態様"];

  return {
    sourceSite: target.site,
    sourceUrl: target.url,
    listingId: target.id,
    fields: output,
  };
};

const parseHomes = (html: string, target: ResolvedTarget) => {
  const $ = cheerio.load(html);
  const labelMap = buildLabelMap($);
  const output: ListingFieldMap = { ...EMPTY_OUTPUT };

  setIfEmpty(output, "物件名", getFirstText($, ["h1", "[class*='PropertyName']", "[class*='Title'] h1"]));
  setIfEmpty(output, "物件名", getMetaContent($, ["meta[property='og:title']", "meta[name='twitter:title']", "title"]));
  setIfEmpty(output, "住所", getByLabels(labelMap, ["所在地", "住所"]));
  setIfEmpty(output, "アクセス", extractHomesAccess($, labelMap));
  setIfEmpty(output, "間取り", getByLabels(labelMap, ["間取り"]));
  setIfEmpty(output, "専有面積", getByLabels(labelMap, ["専有面積"]));
  setIfEmpty(output, "向き", getByLabels(labelMap, ["主要採光面", "向き"]));
  setIfEmpty(output, "建物種別", getByLabels(labelMap, ["建物種別", "建物構造", "物件種別"]));
  setIfEmpty(output, "築年月", getByLabels(labelMap, ["築年月"]));
  setIfEmpty(output, "階建", getByLabels(labelMap, ["所在階/階数", "階建", "総階数"]));
  setIfEmpty(output, "損保", getByLabels(labelMap, ["住宅保険", "損保"]));
  setIfEmpty(output, "入居時期", getByLabels(labelMap, ["入居可能時期", "入居時期"]));
  setIfEmpty(output, "条件", getByLabels(labelMap, ["条件", "契約条件"]));
  setIfEmpty(output, "契約期間", getByLabels(labelMap, ["契約期間"]));
  setIfEmpty(output, "仲介手数料", getByLabels(labelMap, ["仲介手数料"]));
  setIfEmpty(output, "保証会社", getByLabels(labelMap, ["保証会社", "保証会社利用料"]));
  setIfEmpty(output, "ほか初期費用", getByLabels(labelMap, ["その他費用", "初期費用", "ほか初期費用"]));
  setIfEmpty(output, "取引態様", getByLabels(labelMap, ["取引態様"]));
  setIfEmpty(output, "備考", getByLabels(labelMap, ["備考"]));

  const shikikinReikin = getByLabels(labelMap, ["敷金/礼金"]);
  if (shikikinReikin) {
    setIfEmpty(output, "敷金/礼金", shikikinReikin);
  }

  const hoshokinShikibiki = getByLabels(labelMap, ["保証金/敷引・償却金", "保証金/敷引・償却"]);
  if (hoshokinShikibiki) {
    const [hoshokin, shikibiki] = splitPair(hoshokinShikibiki);
    setIfEmpty(output, "保証金", hoshokin);
    setIfEmpty(output, "敷引・償却", shikibiki);
  }

  if (!output["仲介手数料"]) {
    setIfEmpty(output, "仲介手数料", extractCostItem(output["ほか初期費用"], "仲介手数料"));
  }

  if (output["保証会社"]) {
    output["保証会社"] = uniqJoin(output["保証会社"].split("\n"));
  }

  output["築年数"] = extractAge(output["築年月"]);
  output["取引様態"] = output["取引態様"];

  return {
    sourceSite: target.site,
    sourceUrl: target.url,
    listingId: target.id,
    fields: output,
  };
};

export const scrapeListing = async (input: ScrapeListingInput) => {
  const target = resolveTarget(input);
  const html = await fetchHtml(target.url);
  const result = target.site === "suumo" ? parseSuumo(html, target) : parseHomes(html, target);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
};
