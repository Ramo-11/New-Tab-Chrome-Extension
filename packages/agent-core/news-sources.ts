import { isAllowedUrl } from "./site-filter";

export const MAX_NEWS_SOURCES = 24;

export const DEFAULT_NEWS_SOURCES = [
  "https://www.reuters.com/technology/",
  "https://www.theguardian.com/technology",
  "https://www.theverge.com/",
  "https://techcrunch.com/",
  "https://www.politico.com/",
  "https://www.reuters.com/world/",
  "https://www.cnn.com/",
  "https://www.bbc.com/news",
  "https://english.ahram.org.eg/",
  "https://www.arabnews.com/",
  "https://english.wafa.ps/",
  "https://www.fcbarcelona.com/en/news",
  "https://www.espn.com/soccer/team/_/id/83/barcelona",
  "https://www.bbc.com/sport/football/teams/barcelona",
  "https://aboutislam.net/",
  "https://www.aljazeera.com/",
  "https://muslimmatters.org/",
];

export interface NewsSourceList {
  sources: string[];
  invalid: string[];
  overLimit: boolean;
}

function toSourceUrl(line: string): string | null {
  const value = line.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname.includes(".") || url.username || url.password) return null;
  url.hash = "";
  return url.href;
}

function sourceKey(href: string): string {
  const url = new URL(href);
  return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

export function parseNewsSources(lines: string[]): NewsSourceList {
  const sources: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const href = toSourceUrl(line);
    if (!href) {
      invalid.push(line.trim());
      continue;
    }
    const key = sourceKey(href);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(href);
  }
  return {
    sources: sources.slice(0, MAX_NEWS_SOURCES),
    invalid,
    overLimit: sources.length > MAX_NEWS_SOURCES,
  };
}

export function allowedNewsSources(sources: string[], blockedSites: string[]): string[] {
  return parseNewsSources(sources).sources.filter((url) => isAllowedUrl(url, blockedSites));
}

export function sameSite(a: string, b: string): boolean {
  try {
    const host = (value: string) => new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host(a) === host(b);
  } catch {
    return false;
  }
}
