import type {
  BrowserBridge,
  JsonRequest,
  KVStore,
  LlmClient,
  ScrapedPage,
  TextRequest,
  TextResult,
} from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";

export class MemoryStore implements KVStore {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export function apiError(status: number, body: unknown): Error {
  return Object.assign(new Error(typeof body === "string" ? body : JSON.stringify(body)), { status });
}

export function dailyQuotaError(): Error {
  return apiError(429, {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "You exceeded your current quota.",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" },
      ],
    },
  });
}

export function minuteQuotaError(retryDelay = "37s"): Error {
  return apiError(429, {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "You exceeded your current quota.",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "5" }],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
      ],
    },
  });
}

export function overloadedError(): Error {
  return apiError(503, {
    error: { code: "service_unavailable", message: "This model is currently experiencing high demand." },
  });
}

export interface LlmCall {
  kind: "json" | "text";
  model: string;
  user: string;
  system: string;
}

type Reply<T> = T | Error | ((call: LlmCall, index: number) => T | Promise<T>);

export class FakeLlm implements LlmClient {
  readonly calls: LlmCall[] = [];
  private jsonCount = 0;
  private textCount = 0;

  constructor(
    private readonly json: Reply<string>,
    private readonly text: Reply<string | TextResult>,
  ) {}

  async generateJson(request: JsonRequest): Promise<string> {
    const call: LlmCall = { kind: "json", model: request.model, user: request.user, system: request.system };
    this.calls.push(call);
    return resolve(this.json, call, this.jsonCount++);
  }

  async generateText(request: TextRequest): Promise<TextResult> {
    const call: LlmCall = { kind: "text", model: request.model, user: request.user, system: request.system };
    this.calls.push(call);
    const value = await resolve(this.text, call, this.textCount++);
    request.onProgress?.(typeof value === "string" ? value.length : value.text.length);
    return typeof value === "string" ? { text: value, truncated: false } : value;
  }

  get jsonCalls(): LlmCall[] {
    return this.calls.filter((call) => call.kind === "json");
  }

  get textCalls(): LlmCall[] {
    return this.calls.filter((call) => call.kind === "text");
  }
}

async function resolve<T>(reply: Reply<T>, call: LlmCall, index: number): Promise<T> {
  if (reply instanceof Error) throw reply;
  if (typeof reply === "function") return (reply as (call: LlmCall, index: number) => T | Promise<T>)(call, index);
  return reply;
}

export function homepageCode(href: string): string {
  return [
    "import React from 'react';",
    "export default function PersonalizedHomepage() {",
    `  return <main><a href="${href}">Top story</a></main>;`,
    "}",
  ].join("\n");
}

export function firstLinkIn(message: string): string {
  const match = message.match(/\]\((https?:\/\/[^)\s]+)\)/);
  if (!match) throw new Error("no link in the message");
  return match[1]!;
}

export function writeFromFirstLink(call: LlmCall): string {
  return homepageCode(firstLinkIn(call.user));
}

export function pickReply(...urls: string[]): string {
  return JSON.stringify({ urls });
}

export const ARTICLE_HTML =
  '<h1>Front page</h1><ul><li><a href="/story-1">First story</a></li><li><a href="/story-2">Second story</a></li></ul><p>Some body text for the page.</p><img src="/lead.png" alt="Lead image">';

export interface FakeBridge extends BrowserBridge {
  readonly scrapeCalls: string[][];
  historyCalls: number;
}

export function fakeBridge(
  options: {
    scrape?: (urls: string[]) => Promise<{ pages: ScrapedPage[]; failed: Array<{ url: string; reason: string }> }>;
    onHistory?: () => void;
  } = {},
): FakeBridge {
  const bridge: FakeBridge = {
    scrapeCalls: [],
    historyCalls: 0,
    async getHistory() {
      bridge.historyCalls += 1;
      options.onHistory?.();
      const sites = fixtureHistory();
      return { sites, totalSitesSeen: sites.length };
    },
    async getPageHtml({ urls }) {
      bridge.scrapeCalls.push(urls);
      if (options.scrape) return options.scrape(urls);
      return {
        pages: urls.map((url) => ({ url, finalUrl: url, title: `Page ${url}`, html: ARTICLE_HTML })),
        failed: [],
      };
    },
  };
  return bridge;
}
