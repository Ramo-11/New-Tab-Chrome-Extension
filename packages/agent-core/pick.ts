import { MAX_PAGES } from "./schemas";
import { isAllowedUrl } from "./site-filter";
import { stripCodeFence } from "./validate";
import type { GetHistoryResult } from "./types";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function dedupeKey(url: URL): string {
  return `${url.protocol}//${bareHost(url.hostname)}${url.port}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

export function parsePickedUrls(
  raw: string,
  options: { blockedSites: string[]; digestDomains: string[]; max?: number },
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : asRecord(parsed)?.urls;
  if (!Array.isArray(list)) return [];

  const domains = options.digestDomains.map(bareHost);
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const item of list) {
    if (typeof item !== "string") continue;
    let url: URL;
    try {
      url = new URL(item.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (!isAllowedUrl(url.href, options.blockedSites)) continue;
    const host = bareHost(url.hostname);
    if (!domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
    const key = dedupeKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url.href);
    if (urls.length >= (options.max ?? MAX_PAGES)) break;
  }
  return urls;
}

export function fallbackUrls(digest: GetHistoryResult, blockedSites: string[], max: number = MAX_PAGES): string[] {
  return digest.sites
    .map((site) => `https://${site.domain}/`)
    .filter((url) => isAllowedUrl(url, blockedSites))
    .slice(0, max);
}
