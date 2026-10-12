import type { BrowserBridge, ScrapedPage } from "@homepage/agent-core";
import sanitizeHtml from "sanitize-html";

type ScrapeReport = Awaited<ReturnType<BrowserBridge["getPageHtml"]>>;

interface ScraperResult {
  url: string;
  title: string;
  html: string;
}

interface ScrapeOptions {
  loadDelay?: number;
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
  pageDeadline?: number;
  concurrentTabs?: number;
  openTabs?: boolean;
}

const DEFAULT_OPTIONS: Required<ScrapeOptions> = {
  loadDelay: 8000,
  maxRetries: 3,
  retryDelay: 1000,
  timeout: 30000,
  pageDeadline: 75000,
  concurrentTabs: 5,
  openTabs: false,
};

type PageOutcome = { page: ScrapedPage } | { reason: string };

const FETCH_TIMEOUT_MS = 15000;
const FETCH_CONCURRENCY = 6;
const MIN_FETCHED_TEXT_CHARS = 2500;
const MIN_FETCHED_LINKS = 15;

function cleanHtmlForLLM(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "a",
      "em",
      "strong",
      "b",
      "i",
      "blockquote",
      "code",
      "pre",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "img",
      "figure",
      "figcaption",
      "div",
      "span",
      "br",
      "hr",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height", "srcset", "data-src", "data-srcset", "data-lazy-src", "data-original"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    nonTextTags: ["script", "style", "textarea", "option", "noscript", "nav", "footer", "form", "button", "svg", "select"],
  });
}

function decodeTitle(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function looksReadable(cleanHtml: string): boolean {
  const text = cleanHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const links = cleanHtml.match(/<a\s[^>]*href=/gi)?.length ?? 0;
  return text.length >= MIN_FETCHED_TEXT_CHARS && links >= MIN_FETCHED_LINKS;
}

export async function fetchPage(url: string): Promise<ScrapedPage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("html")) return null;
    const source = await response.text();
    const body = source.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? source;
    const html = cleanHtmlForLLM(body);
    if (!looksReadable(html)) return null;
    return {
      url,
      finalUrl: response.url || url,
      title: decodeTitle(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
      html,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function inPool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(runners);
}

async function createScraperWindow(): Promise<number> {
  const win = await browser.windows.create({
    url: "about:blank",
    focused: false,
    state: "minimized",
  });
  if (win?.id === undefined) throw new Error("Could not open the scraper window");
  return win.id;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function closeTab(tabId: number | undefined) {
  if (tabId === undefined) return;
  try {
    await browser.tabs.remove(tabId);
  } catch {
    return;
  }
}

async function extract(tabId: number, opts: Required<ScrapeOptions>, isLive: () => boolean): Promise<ScraperResult | null> {
  let delay = opts.retryDelay;
  for (let attempt = 0; attempt <= opts.maxRetries && isLive(); attempt++) {
    try {
      const [injection] = await browser.scripting.executeScript({
        target: { tabId },
        files: ["/content-scripts/scraper.js"],
      });
      const result = injection?.result as ScraperResult | undefined;
      if (result?.html?.trim()) return result;
    } catch (error) {
      console.warn(`Extraction attempt ${attempt + 1} failed:`, error);
    }
    if (attempt < opts.maxRetries) {
      await wait(delay);
      delay *= 2;
    }
  }
  return null;
}

async function scrapeUrl(url: string, windowId: number, opts: Required<ScrapeOptions>): Promise<PageOutcome> {
  let tabId: number | undefined;
  let live = true;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const work = (async (): Promise<PageOutcome> => {
    const tab = await browser.tabs.create({ url, active: false, windowId });
    tabId = tab.id;
    if (tabId === undefined) return { reason: "could not open a tab" };

    const loaded = await waitForTabLoad(tabId, opts.timeout);
    if (!loaded) console.warn(`${url} was still loading after ${opts.timeout}ms, reading what has rendered`);
    else await wait(opts.loadDelay);
    if (!live) return { reason: "took too long to load" };

    const result = await extract(tabId, opts, () => live);
    if (!result) return { reason: "no readable content" };
    return {
      page: {
        url,
        finalUrl: result.url,
        title: result.title,
        html: cleanHtmlForLLM(result.html),
      },
    };
  })();

  const timedOut = new Promise<PageOutcome>((resolve) => {
    deadline = setTimeout(() => {
      live = false;
      resolve({ reason: "took too long to load" });
    }, opts.pageDeadline);
  });

  try {
    return await Promise.race([work, timedOut]);
  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error);
    return { reason: "failed to load" };
  } finally {
    live = false;
    clearTimeout(deadline);
    await closeTab(tabId);
  }
}

export async function scrapeUrls(urls: string[], options?: ScrapeOptions): Promise<ScrapeReport> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const pages: ScrapedPage[] = [];
  const failed: ScrapeReport["failed"] = [];
  const needTab: string[] = [];

  await inPool(urls, FETCH_CONCURRENCY, async (url) => {
    const page = await fetchPage(url);
    if (page) pages.push(page);
    else needTab.push(url);
  });

  if (needTab.length > 0 && opts.openTabs) await scrapeInTabs(needTab, opts, pages, failed);
  else for (const url of needTab) failed.push({ url, reason: "can only be read in a tab, and opening tabs is off" });

  const order = (url: string) => urls.indexOf(url);
  pages.sort((a, b) => order(a.url) - order(b.url));
  failed.sort((a, b) => order(a.url) - order(b.url));
  return { pages, failed };
}

async function scrapeInTabs(
  urls: string[],
  opts: Required<ScrapeOptions>,
  pages: ScrapedPage[],
  failed: ScrapeReport["failed"],
): Promise<void> {
  const windowId = await createScraperWindow();

  try {
    for (let i = 0; i < urls.length; i += opts.concurrentTabs) {
      const batch = urls.slice(i, i + opts.concurrentTabs);
      const outcomes = await Promise.all(batch.map(async (url) => ({ url, outcome: await scrapeUrl(url, windowId, opts) })));
      for (const { url, outcome } of outcomes) {
        if ("page" in outcome) pages.push(outcome.page);
        else failed.push({ url, reason: outcome.reason });
      }
    }
  } finally {
    try {
      await browser.windows.remove(windowId);
    } catch (error) {
      console.error("Failed to close scraper window:", error);
    }
  }
}

async function waitForTabLoad(tabId: number, timeout: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeoutId);
      resolve(value);
    };
    const listener = (changedTabId: number, changeInfo: { status?: string }) => {
      if (changedTabId === tabId && changeInfo.status === "complete") finish(true);
    };
    const timeoutId = setTimeout(() => finish(false), timeout);
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "complete" && tab.url && tab.url !== "about:blank") finish(true);
      },
      () => finish(false),
    );
  });
}
