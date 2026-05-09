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
  "価格": null,
  "住所": null,
  "敷金": null,
  "礼金": null,
  "保証金": null,
  "敷引・償却": null,
  "アクセス": null,
  "間取り": null,
  "専有面積": null,
  "その他面積": null,
  "バルコニー面積": null,
  "向き": null,
  "建物種別": null,
  "築年数": null,
  "所在階": null,
  "階建": null,
  "構造・階建て": null,
  "損保": null,
  "入居時期": null,
  "引渡可能時期": null,
  "条件": null,
  "契約期間": null,
  "仲介手数料": null,
  "保証会社": null,
  "ほか初期費用": null,
  "管理費": null,
  "修繕積立金": null,
  "修繕積立基金": null,
  "諸費用": null,
  "販売スケジュール": null,
  "販売戸数": null,
  "総戸数": null,
  "敷地面積": null,
  "敷地の権利形態": null,
  "用途地域": null,
  "駐車場": null,
  "築年月": null,
  "施工": null,
  "取引態様": null,
  "取引様態": null,
  "備考": null,
  "担当者": null,
  "会社概要": null,
  "問い合わせ先": null,
  "情報提供日": null,
  "次回更新予定日": null,
  "取引条件有効期限": null,
  "部屋の特徴・設備": null,
};

const normalizeSpace = (value: string | null | undefined) =>
  value
    ?.replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim() ?? "";

const cleanLabel = (value: string | null | undefined) =>
  normalizeSpace(value).replace(/ヒント/g, "").replace(/[：:]/g, "").replace(/\s+/g, "");

const uniqJoin = (values: string[]) =>
  [...new Set(values.map((value) => normalizeSpace(value)).filter(Boolean))].join("\n");

const dedupeTextLines = (value: string) => {
  const lines = value
    .split("\n")
    .map((line) => normalizeSpace(line))
    .filter(Boolean);

  // Preserve duplicate values around a slash separator such as 敷金/礼金.
  if (lines.includes("/")) {
    return lines.join("\n");
  }

  return lines.length > 1 ? [...new Set(lines)].join("\n") : normalizeSpace(value);
};

const cleanupValue = (value: string | null | undefined) => {
  const normalized = normalizeSpace(value)
    .replace(/\[\s*(?:乗り換え案内|周辺環境|支払シミュレーション)\s*\]/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/□\s*支払シミュレーション/g, "");
  if (!normalized) {
    return null;
  }

  const cleaned = dedupeTextLines(
    normalizeSpace(normalized)
    .replace(/地図を見る/g, "")
    .replace(/\s*\|\s*LIFULL HOME'S.*$/g, "")
    .replace(/^\s*[:：-]+/, "")
    .trim()
  );

  return cleaned || null;
};

const cleanupSuumoTitle = (value: string | null | undefined) => {
  const normalized = cleanupValue(value);
  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/\s*-\s*.*?が提供する賃貸物件情報$/, "")
    .replace(/^【SUUMO】/, "")
    .replace(/（\d+）.*$/, "")
    .replace(/／.*$/, "")
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
    const ths = $(row).find("th");
    const tds = $(row).find("td");

    if (ths.length === 1 && tds.length === 1) {
      mergeValue(map, $(ths[0]).text(), $(tds[0]).text());
      return;
    }

    ths.each((index, th) => {
      const td = tds.get(index);
      if (td) {
        mergeValue(map, $(th).text(), $(td).text());
      }
    });
  });

  $("dt").each((_, dt) => {
    mergeValue(map, $(dt).text(), $(dt).next("dd").text());
  });

  $(".property_data").each((_, element) => {
    const label = $(element).find(".property_data-title").first().text();
    const value = $(element).find(".property_data-body").first().text();
    mergeValue(map, label, value);
  });

  $(".property_view_detail").each((_, element) => {
    const label = $(element).find(".property_view_detail-header-title").first().text();
    const values = $(element)
      .find(".property_view_detail-text")
      .map((__, textElement) => cleanupValue($(textElement).text()))
      .get()
      .filter((text): text is string => Boolean(text));

    if (label && values.length) {
      mergeValue(map, label, uniqJoin(values));
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
  const match = value.match(/(?:jnc_|bc_)(\d+)/i) ?? value.match(/(\d{6,})/);
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
    return { site: "suumo", id, url: `https://suumo.jp/chintai/bc_${id}/` };
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

const extractSuumoRent = ($: CheerioAPI) =>
  cleanupValue($(".property_view_main-emphasis").first().text());

const extractAge = (value: string | null) => {
  if (!value) {
    return null;
  }
  const match = value.match(/築[^)\n]+/);
  return match?.[0] ?? value;
};

const extractSuumoAccess = ($: CheerioAPI, labelMap: Map<string, string>) => {
  const access = getByLabels(labelMap, ["アクセス", "交通", "沿線・駅"]);
  if (access) {
    return access;
  }

  const candidates = $(".property_view_detail--train .property_view_detail-text")
    .map((_, element) => cleanupValue($(element).text()))
    .get()
    .filter((line): line is string => Boolean(line));

  return candidates.length ? uniqJoin(candidates) : null;
};

const extractSuumoFeatures = ($: CheerioAPI) => {
  const items = $("#bkdt-option .inline_list li")
    .map((_, element) => cleanupValue($(element).text()))
    .get()
    .filter((line): line is string => Boolean(line));

  if (items.length) {
    return uniqJoin(items);
  }

  const pickupHeader = $("h2, h3")
    .filter((_, element) => normalizeSpace($(element).text()).includes("特徴ピックアップ"))
    .first();
  const pickupText = cleanupValue(pickupHeader.parent().next().text());
  const pickupItems =
    pickupText
      ?.split(/\s*\/\s*|\n+/)
      .map((line) => cleanupValue(line))
      .filter((line): line is string => Boolean(line)) ?? [];

  return pickupItems.length ? uniqJoin(pickupItems) : null;
};

const inferSuumoPropertyType = ($: CheerioAPI, target: ResolvedTarget) => {
  const keywords = getMetaContent($, ["meta[name='keywords']", "meta[name='description']"]);
  if (target.url.includes("/ms/chuko/") || keywords?.includes("中古マンション")) {
    return "中古マンション";
  }
  return null;
};

const extractBalconyArea = (value: string | null) => {
  if (!value) {
    return null;
  }

  const match = value.match(/バルコニー面積[：:]?\s*([^\n]+)/);
  return cleanupValue(match?.[1]);
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

const assignDepositAndKeyMoney = (
  output: ListingFieldMap,
  combinedValue: string | null,
  shikikinValue?: string | null,
  reikinValue?: string | null
) => {
  if (combinedValue) {
    const [shikikin, reikin] = splitPair(combinedValue);
    setIfEmpty(output, "敷金", shikikin);
    setIfEmpty(output, "礼金", reikin);
    return;
  }

  setIfEmpty(output, "敷金", shikikinValue);
  setIfEmpty(output, "礼金", reikinValue);
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

  setIfEmpty(output, "物件名", getByLabels(labelMap, ["物件名"]));
  setIfEmpty(output, "物件名", cleanupSuumoTitle(getFirstText($, ["h1", ".section_h1-header-title", ".property_view_detail-header h1"])));
  setIfEmpty(output, "物件名", cleanupSuumoTitle(getMetaContent($, ["meta[property='og:title']", "title"])));
  setIfEmpty(output, "価格", getByLabels(labelMap, ["価格"]));
  setIfEmpty(output, "賃料", getByLabels(labelMap, ["賃料"]));
  setIfEmpty(output, "賃料", extractSuumoRent($));
  setIfEmpty(output, "価格", output["賃料"]);
  setIfEmpty(output, "住所", getByLabels(labelMap, ["所在地", "住所"]));
  setIfEmpty(output, "アクセス", extractSuumoAccess($, labelMap));
  setIfEmpty(output, "間取り", getByLabels(labelMap, ["間取り", "間取り詳細"]));
  setIfEmpty(output, "専有面積", getByLabels(labelMap, ["専有面積"]));
  setIfEmpty(output, "その他面積", getByLabels(labelMap, ["その他面積"]));
  setIfEmpty(output, "バルコニー面積", extractBalconyArea(output["その他面積"]));
  setIfEmpty(output, "向き", getByLabels(labelMap, ["向き"]));
  setIfEmpty(output, "建物種別", inferSuumoPropertyType($, target));
  setIfEmpty(output, "建物種別", getByLabels(labelMap, ["建物種別", "種別", "建物構造", "構造"]));
  setIfEmpty(output, "築年数", getByLabels(labelMap, ["築年数", "築年", "築年月"]));
  setIfEmpty(output, "所在階", getByLabels(labelMap, ["所在階"]));
  setIfEmpty(output, "階建", getByLabels(labelMap, ["所在階/構造・階建", "階建", "所在階", "階数"]));
  setIfEmpty(output, "構造・階建て", getByLabels(labelMap, ["構造・階建て", "構造・階建", "所在階/構造・階建"]));
  setIfEmpty(output, "損保", getByLabels(labelMap, ["損保", "保険"]));
  setIfEmpty(output, "入居時期", getByLabels(labelMap, ["入居", "入居時期"]));
  setIfEmpty(output, "引渡可能時期", getByLabels(labelMap, ["引渡可能時期", "引渡し", "引渡"]));
  setIfEmpty(output, "入居時期", output["引渡可能時期"]);
  setIfEmpty(output, "条件", getByLabels(labelMap, ["条件"]));
  setIfEmpty(output, "契約期間", getByLabels(labelMap, ["契約期間"]));
  setIfEmpty(output, "仲介手数料", getByLabels(labelMap, ["仲介手数料"]));
  setIfEmpty(output, "保証会社", getByLabels(labelMap, ["保証会社", "保証会社利用"]));
  setIfEmpty(output, "ほか初期費用", getByLabels(labelMap, ["ほか初期費用", "ほか諸費用", "その他初期費用", "その他諸費用"]));
  setIfEmpty(output, "管理費", getByLabels(labelMap, ["管理費・共益費", "管理費"]));
  setIfEmpty(output, "共益費", output["管理費"]);
  setIfEmpty(output, "修繕積立金", getByLabels(labelMap, ["修繕積立金"]));
  setIfEmpty(output, "修繕積立基金", getByLabels(labelMap, ["修繕積立基金"]));
  setIfEmpty(output, "諸費用", getByLabels(labelMap, ["諸費用"]));
  setIfEmpty(output, "販売スケジュール", getByLabels(labelMap, ["販売スケジュール"]));
  setIfEmpty(output, "販売戸数", getByLabels(labelMap, ["販売戸数"]));
  setIfEmpty(output, "総戸数", getByLabels(labelMap, ["総戸数"]));
  setIfEmpty(output, "敷地面積", getByLabels(labelMap, ["敷地面積"]));
  setIfEmpty(output, "敷地の権利形態", getByLabels(labelMap, ["敷地の権利形態"]));
  setIfEmpty(output, "用途地域", getByLabels(labelMap, ["用途地域"]));
  setIfEmpty(output, "駐車場", getByLabels(labelMap, ["駐車場"]));
  setIfEmpty(output, "築年月", getByLabels(labelMap, ["築年月"]));
  setIfEmpty(output, "施工", getByLabels(labelMap, ["施工"]));
  setIfEmpty(output, "取引態様", getByLabels(labelMap, ["取引態様"]));
  setIfEmpty(output, "備考", getByLabels(labelMap, ["備考"]));
  setIfEmpty(output, "担当者", getByLabels(labelMap, ["担当者", "担当者より"]));
  setIfEmpty(output, "会社概要", getByLabels(labelMap, ["会社概要"]));
  setIfEmpty(output, "問い合わせ先", getByLabels(labelMap, ["問い合わせ先", "お問い合せ先"]));
  setIfEmpty(output, "情報提供日", getByLabels(labelMap, ["情報提供日"]));
  setIfEmpty(output, "次回更新予定日", getByLabels(labelMap, ["次回更新予定日"]));
  setIfEmpty(output, "取引条件有効期限", getByLabels(labelMap, ["取引条件有効期限"]));
  setIfEmpty(output, "部屋の特徴・設備", extractSuumoFeatures($));

  const shikikinReikin = getByLabels(labelMap, ["敷金/礼金"]);
  const shikikin = getByLabels(labelMap, ["敷金"]);
  const reikin = getByLabels(labelMap, ["礼金"]);
  assignDepositAndKeyMoney(output, shikikinReikin, shikikin, reikin);

  setIfEmpty(output, "保証金", getByLabels(labelMap, ["保証金"]));
  setIfEmpty(output, "敷引・償却", getByLabels(labelMap, ["敷引・償却", "敷引", "償却"]));

  if (!output["住所"]) {
    const summary = $("body").text().match(/(東京都|北海道|(?:京都|大阪)府|..県).{2,80}?(?:市|区|町|村).{0,80}/);
    if (summary) {
      output["住所"] = cleanupValue(summary[0]);
    }
  }

  output["築年数"] = extractAge(output["築年数"] ?? output["築年月"]);
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
  setIfEmpty(output, "賃料", getByLabels(labelMap, ["賃料", "価格"]));
  setIfEmpty(output, "価格", output["賃料"]);
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
  setIfEmpty(output, "ほか初期費用", getByLabels(labelMap, ["その他費用", "諸費用", "初期費用", "ほか初期費用", "ほか諸費用", "その他諸費用"]));
  setIfEmpty(output, "取引態様", getByLabels(labelMap, ["取引態様"]));
  setIfEmpty(output, "備考", getByLabels(labelMap, ["備考"]));
  setIfEmpty(output, "部屋の特徴・設備", extractSuumoFeatures($));

  const shikikinReikin = getByLabels(labelMap, ["敷金/礼金"]);
  assignDepositAndKeyMoney(output, shikikinReikin);

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
