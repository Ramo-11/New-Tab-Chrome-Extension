import { GeminiError, MESSAGES, isAbortError, throwIfAborted } from "./errors";
import { runWithFallback, type FallbackOptions } from "./fallback";
import { createGeminiClient, type LlmClient } from "./gemini";
import { buildHistoryDigest } from "./history-digest";
import { DEFAULT_MODEL, STORAGE_KEYS, isHomepageModel, type HomepageModel } from "./models";
import { compactPages, type CompactedPage } from "./page-compact";
import { fallbackUrls, parsePickedUrls } from "./pick";
import {
  WRITE_SYSTEM_PROMPT,
  PICK_SYSTEM_PROMPT,
  buildPickMessage,
  buildRepairMessage,
  buildWriteMessage,
} from "./prompt";
import { allowedNewsSources, sameSite } from "./news-sources";
import { DEFAULTS, MAX_PAGES, MAX_PERSONAL_PAGES, PICK_JSON_SCHEMA } from "./schemas";
import { DEFAULT_BLOCKED_SITES, isAllowedUrl, isBlocked, normalizeBlockList } from "./site-filter";
import { stripCodeFence, stripEmoji, validateHomepage } from "./validate";
import type {
  BrowserBridge,
  FailedPage,
  GetHistoryResult,
  HomepageBuildResult,
  KVStore,
  RunCallbacks,
  RunPhase,
} from "./types";

export const CHECKPOINT_MAX_AGE_MS = 30 * 60 * 1000;
export const NO_PAGES_MESSAGE =
  "None of the chosen pages could be loaded, so there is nothing to build a homepage from. Check your connection and try again.";
export const NO_HISTORY_MESSAGE =
  "There isn't enough browsing history to build from yet. Browse for a little while and try again.";

export interface RunOptions {
  apiKey: string;
  bridge: BrowserBridge;
  store: KVStore;
  userSystemPrompt?: string;
  blockedSites?: string[] | (() => Promise<string[]>);
  newsSources?: string[];
  model?: HomepageModel;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  resume?: boolean;
  now?: Date;
  checkSyntax?: (code: string) => string | null;
  llm?: LlmClient;
}

export interface BuildCheckpoint {
  version: 1;
  startedAt: string;
  digest: GetHistoryResult;
  urls: string[];
  newsUrls?: string[];
  pages?: CompactedPage[];
  failed?: FailedPage[];
}

interface Emit {
  phase(phase: RunPhase, detail?: string): void;
  text(line: string): void;
  log(line: string): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCompactedPage(value: unknown): value is CompactedPage {
  const page = asRecord(value);
  return (
    page !== undefined &&
    typeof page.url === "string" &&
    typeof page.title === "string" &&
    typeof page.text === "string" &&
    isStringArray(page.links)
  );
}

function isFailedPage(value: unknown): value is FailedPage {
  const item = asRecord(value);
  return item !== undefined && typeof item.url === "string" && typeof item.reason === "string";
}

export function parseCheckpoint(value: unknown, now: Date): BuildCheckpoint | undefined {
  const checkpoint = asRecord(value);
  if (!checkpoint || checkpoint.version !== 1 || typeof checkpoint.startedAt !== "string") return undefined;
  const started = Date.parse(checkpoint.startedAt);
  if (!Number.isFinite(started) || now.getTime() - started > CHECKPOINT_MAX_AGE_MS) return undefined;
  const digest = asRecord(checkpoint.digest);
  if (!digest || !Array.isArray(digest.sites) || typeof digest.totalSitesSeen !== "number") return undefined;
  if (!isStringArray(checkpoint.urls)) return undefined;
  if (checkpoint.newsUrls !== undefined && !isStringArray(checkpoint.newsUrls)) return undefined;
  if (checkpoint.pages !== undefined) {
    if (!Array.isArray(checkpoint.pages) || !checkpoint.pages.every(isCompactedPage)) return undefined;
    if (checkpoint.failed !== undefined && !(Array.isArray(checkpoint.failed) && checkpoint.failed.every(isFailedPage))) {
      return undefined;
    }
  }
  return value as BuildCheckpoint;
}

export async function discardStaleCheckpoint(store: KVStore, now: Date = new Date()): Promise<void> {
  const stored = await store.get<unknown>(STORAGE_KEYS.buildCheckpoint);
  if (stored !== undefined && !parseCheckpoint(stored, now)) await store.remove(STORAGE_KEYS.buildCheckpoint);
}

function filterDigest(digest: GetHistoryResult, blockedSites: string[]): GetHistoryResult {
  const sites = digest.sites.filter((site) => !isBlocked(site.domain, blockedSites));
  return {
    ...digest,
    totalSitesSeen: Math.max(sites.length, digest.totalSitesSeen - (digest.sites.length - sites.length)),
    sites,
  };
}

function requireKey(apiKey: string | undefined): string {
  const key = apiKey?.trim();
  if (!key) throw new GeminiError("invalid-key", MESSAGES.noKey);
  return key;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export async function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult> {
  const { bridge, store, callbacks, signal } = opts;
  const emit: Emit = {
    phase: (phase, detail) => callbacks?.onPhase?.(phase, detail),
    text: (line) => callbacks?.onText?.(line),
    log: (line) => callbacks?.onLog?.(line),
  };
  const clock = () => opts.now ?? new Date();
  const preferred = isHomepageModel(opts.model) ? opts.model : DEFAULT_MODEL;
  const userSystemPrompt = opts.userSystemPrompt?.trim() || undefined;

  const readBlocked = async (): Promise<string[]> =>
    normalizeBlockList(
      (typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites) ??
        DEFAULT_BLOCKED_SITES,
    );

  const saveCheckpoint = async (checkpoint: BuildCheckpoint) => {
    await store.set(STORAGE_KEYS.buildCheckpoint, checkpoint);
  };

  const fallback: FallbackOptions = {
    store,
    preferred,
    signal,
    now: clock,
    log: emit.log,
    demoted: new Set<string>(),
  };

  const build = async (): Promise<HomepageBuildResult> => {
    emit.phase("setup");
    throwIfAborted(signal);

    const llm = opts.llm ?? createGeminiClient(requireKey(opts.apiKey));

    const startedAt = clock().toISOString();
    let checkpoint = opts.resume ? parseCheckpoint(await store.get<unknown>(STORAGE_KEYS.buildCheckpoint), clock()) : undefined;
    if (opts.resume) {
      emit.log(checkpoint ? `resuming from checkpoint (${checkpoint.pages ? "pages loaded" : "pages chosen"})` : "no usable checkpoint, starting fresh");
    }

    let blocked = await readBlocked();
    let digest: GetHistoryResult;
    let urls: string[];
    let newsUrls: string[];

    if (checkpoint) {
      digest = filterDigest(checkpoint.digest, blocked);
      urls = checkpoint.urls;
      newsUrls = checkpoint.newsUrls ?? [];
    } else {
      newsUrls = allowedNewsSources(opts.newsSources ?? [], blocked);
      emit.phase("history", `${DEFAULTS.daysToAnalyze}d`);
      const { sites, totalSitesSeen } = await bridge.getHistory({
        daysToAnalyze: DEFAULTS.daysToAnalyze,
        maxResults: DEFAULTS.maxResults,
      });
      throwIfAborted(signal);
      const allowed = sites.filter((site) => !isBlocked(site.domain, blocked));
      digest = buildHistoryDigest(allowed, {
        daysToAnalyze: DEFAULTS.daysToAnalyze,
        maxResults: DEFAULTS.maxResults,
        totalSitesSeen: totalSitesSeen - (sites.length - allowed.length),
      });
      emit.log(`history: ${digest.sites.length} of ${digest.totalSitesSeen} domains`);
      if (digest.sites.length === 0 && newsUrls.length === 0) throw new Error(NO_HISTORY_MESSAGE);

      emit.phase("thinking", "Choosing pages");
      const maxPersonal = newsUrls.length > 0 ? MAX_PERSONAL_PAGES : MAX_PAGES;
      let personal: string[] = [];
      if (digest.sites.length > 0) {
        const pick = await runWithFallback(fallback, (model) =>
          llm.generateJson({
            model,
            system: PICK_SYSTEM_PROMPT,
            user: buildPickMessage({ now: clock(), userSystemPrompt, digest, newsUrls, maxPages: maxPersonal }),
            schema: PICK_JSON_SCHEMA,
            signal,
          }),
        );
        const notNews = (url: string) => !newsUrls.some((news) => sameSite(news, url));
        personal = parsePickedUrls(pick.value, {
          blockedSites: blocked,
          digestDomains: digest.sites.map((site) => site.domain),
          max: MAX_PAGES,
        })
          .filter(notNews)
          .slice(0, maxPersonal);
        if (personal.length === 0 && newsUrls.length === 0) {
          personal = fallbackUrls(digest, blocked);
          emit.log("no usable pages in the answer, using your top sites");
        }
      }
      urls = [...newsUrls, ...personal];
      if (urls.length === 0) throw new Error(NO_HISTORY_MESSAGE);

      checkpoint = { version: 1, startedAt, digest, urls, newsUrls };
      await saveCheckpoint(checkpoint);
      emit.log(`picked: ${urls.join(", ")}`);
      emit.text(`Picked ${plural(urls.length, "page")}.\n`);
    }

    let pages: CompactedPage[];
    let failed: FailedPage[];

    if (checkpoint.pages) {
      pages = checkpoint.pages.filter(
        (page) => isAllowedUrl(page.url, blocked) && (!page.finalUrl || isAllowedUrl(page.finalUrl, blocked)),
      );
      failed = checkpoint.failed ?? [];
      if (pages.length === 0) throw new Error(NO_PAGES_MESSAGE);
    } else {
      throwIfAborted(signal);
      blocked = await readBlocked();
      emit.phase("scraping", plural(urls.length, "page"));

      const allowedUrls = urls.filter((url) => isAllowedUrl(url, blocked));
      const blockedCount = urls.length - allowedUrls.length;
      const loaded = allowedUrls.length
        ? await bridge.getPageHtml({ urls: allowedUrls, loadDelayMs: DEFAULTS.loadDelayMs })
        : { pages: [], failed: [] };
      throwIfAborted(signal);

      const readable = loaded.pages.filter(
        (page) => !page.finalUrl || isAllowedUrl(page.finalUrl, blocked),
      );
      const droppedByRedirect = loaded.pages.length - readable.length;
      if (blockedCount + droppedByRedirect > 0) {
        emit.log(`blocked: ${blockedCount + droppedByRedirect} url(s)`);
      }

      emit.phase("analyzing", plural(readable.length, "page"));
      const compacted = compactPages(
        readable.map((page) => ({ url: page.url, finalUrl: page.finalUrl, title: page.title, html: page.html })),
      );
      pages = compacted.filter((page) => page.text.trim().length > 0);
      failed = [
        ...loaded.failed,
        ...compacted
          .filter((page) => page.text.trim().length === 0)
          .map((page) => ({ url: page.url, reason: "no readable content" })),
      ];
      if (pages.length === 0) throw new Error(NO_PAGES_MESSAGE);

      checkpoint = { ...checkpoint, pages, failed };
      await saveCheckpoint(checkpoint);
      emit.log(`read ${pages.length} of ${urls.length} pages`);
      emit.text(
        failed.length > 0
          ? `Read ${plural(pages.length, "page")}, ${failed.length} could not be loaded.\n`
          : `Read ${plural(pages.length, "page")}.\n`,
      );
    }

    const knownLinks = new Set<string>();
    for (const page of pages) {
      knownLinks.add(page.url);
      if (page.finalUrl) knownLinks.add(page.finalUrl);
      for (const link of page.links) knownLinks.add(link);
    }
    const sourceUrls = pages.map((page) => page.finalUrl ?? page.url);

    emit.phase("writing");
    emit.text("Writing your homepage...\n");
    throwIfAborted(signal);

    let logged = 0;
    const draft = await runWithFallback(fallback, (model) => {
      logged = 0;
      return llm.generateText({
        model,
        system: WRITE_SYSTEM_PROMPT,
        user: buildWriteMessage({
          now: clock(),
          userSystemPrompt,
          digest,
          pages,
          failed,
          newsUrls,
        }),
        signal,
        onProgress: (chars) => {
          if (chars - logged >= 4000) {
            logged = chars;
            emit.log(`writing: ${chars} characters`);
          }
        },
      });
    });

    let code = stripEmoji(stripCodeFence(draft.value.text));
    let model = draft.model;
    let repaired = false;
    let report = validateHomepage(code, {
      knownLinks,
      checkSyntax: opts.checkSyntax,
      truncated: draft.value.truncated,
    });

    if (report.problems.length > 0) {
      for (const problem of report.problems) emit.log(`check: ${problem}`);
      emit.phase("writing", "Checking the result");
      emit.text("Checking the result and fixing a few details...\n");
      try {
        const fix = await runWithFallback(fallback, (candidate) =>
          llm.generateText({
            model: candidate,
            system: WRITE_SYSTEM_PROMPT,
            user: buildRepairMessage({ code, problems: report.problems, sourceUrls }),
            signal,
          }),
        );
        const fixedCode = stripEmoji(stripCodeFence(fix.value.text));
        const fixedReport = validateHomepage(fixedCode, {
          knownLinks,
          checkSyntax: opts.checkSyntax,
          truncated: fix.value.truncated,
        });
        if (fixedReport.blocking.length === 0) {
          code = fixedCode;
          report = fixedReport;
          model = fix.model;
          repaired = true;
        } else if (report.blocking.length > 0) {
          throw new Error(
            `The homepage that came back was not usable: ${fixedReport.blocking[0]} Try building again.`,
          );
        } else {
          emit.log("the fixed version was worse, keeping the first draft");
        }
      } catch (error) {
        if (isAbortError(error) || report.blocking.length > 0) throw error;
        emit.log(`could not fix the draft, keeping it as it is: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (report.unverifiedLinks.length > 0) {
      emit.log(`${plural(report.unverifiedLinks.length, "link")} could not be matched to the loaded pages`);
    }

    return { code, model, repaired };
  };

  let result: HomepageBuildResult;
  try {
    result = await build();
  } finally {
    emit.phase("cleanup");
    await store.remove(STORAGE_KEYS.buildCheckpoint).catch((error: unknown) => {
      emit.log(`could not clear the checkpoint: ${String(error)}`);
    });
  }
  emit.phase("done");
  return result;
}
