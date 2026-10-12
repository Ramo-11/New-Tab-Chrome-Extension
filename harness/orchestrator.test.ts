import { describe, expect, test } from "bun:test";
import {
  NO_HISTORY_MESSAGE,
  NO_PAGES_MESSAGE,
  STORAGE_KEYS,
  buildHistoryDigest,
  compactPage,
  discardStaleCheckpoint,
  runHomepageBuild,
  type BuildCheckpoint,
  type CompactedPage,
  type GetHistoryResult,
  type HomepageBuildResult,
  type RunOptions,
} from "@homepage/agent-core";
import {
  ARTICLE_HTML,
  FakeLlm,
  MemoryStore,
  dailyQuotaError,
  fakeBridge,
  homepageCode,
  pickReply,
  writeFromFirstLink,
  type FakeBridge,
  type LlmCall,
} from "./fakes";
import { fixtureHistory } from "./node-bridge";
import { checkSyntax } from "./syntax";

const NOW = new Date(2026, 9, 10, 9, 30);
const HN = "https://news.ycombinator.com/";
const LOBSTERS = "https://lobste.rs/";
const KNOWN = "https://news.ycombinator.com/story-1";

class SpyStore extends MemoryStore {
  readonly checkpoints: BuildCheckpoint[] = [];

  override async set(key: string, value: unknown): Promise<void> {
    if (key === STORAGE_KEYS.buildCheckpoint) this.checkpoints.push(structuredClone(value) as BuildCheckpoint);
    await super.set(key, value);
  }
}

interface Setup {
  llm?: FakeLlm;
  bridge?: FakeBridge;
  store?: MemoryStore;
  options?: Partial<RunOptions>;
}

async function run(setup: Setup = {}) {
  const llm = setup.llm ?? new FakeLlm(pickReply(HN, LOBSTERS), writeFromFirstLink);
  const bridge = setup.bridge ?? fakeBridge();
  const store = setup.store ?? new MemoryStore();
  const phases: string[] = [];
  const details = new Map<string, string | undefined>();
  const texts: string[] = [];
  const logs: string[] = [];

  const outcome = await runHomepageBuild({
    apiKey: "test-key",
    bridge,
    store,
    llm,
    now: NOW,
    checkSyntax,
    callbacks: {
      onPhase: (phase, detail) => {
        phases.push(phase);
        details.set(phase, detail);
      },
      onText: (text) => texts.push(text),
      onLog: (line) => logs.push(line),
    },
    ...setup.options,
  }).then(
    (result) => ({ result, error: undefined as unknown }),
    (error: unknown) => ({ result: undefined as HomepageBuildResult | undefined, error }),
  );

  return { ...outcome, llm, bridge, store, phases, details, texts, logs };
}

function digestIn(message: string): GetHistoryResult {
  const marker = "Browsing history digest (JSON):\n";
  const start = message.indexOf(marker) + marker.length;
  return JSON.parse(message.slice(start).split("\n")[0]!);
}

function compacted(url: string): CompactedPage {
  return compactPage({ url, finalUrl: url, title: `Page ${url}`, html: ARTICLE_HTML });
}

function checkpoint(overrides: Partial<BuildCheckpoint> = {}): BuildCheckpoint {
  return {
    version: 1,
    startedAt: NOW.toISOString(),
    digest: buildHistoryDigest(fixtureHistory(), { daysToAnalyze: 14, maxResults: 30 }),
    urls: [HN, LOBSTERS],
    ...overrides,
  };
}

async function seeded(value: BuildCheckpoint): Promise<SpyStore> {
  const store = new SpyStore();
  await store.set(STORAGE_KEYS.buildCheckpoint, value);
  store.checkpoints.length = 0;
  return store;
}

const failingJson = () =>
  new FakeLlm(
    () => {
      throw new Error("the pick request must not run");
    },
    writeFromFirstLink,
  );

describe("a normal build", () => {
  test("runs history, pick, scrape, write and returns the code", async () => {
    const out = await run({ options: { userSystemPrompt: "  Lead with Rust news.  " } });
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({ model: "gemini-3.8-flash", repaired: false });
    expect(out.result!.code).toContain("export default function PersonalizedHomepage");
    expect(out.result!.code).toContain('href="https://news.ycombinator.com/story-1"');

    expect(out.phases).toEqual(["setup", "history", "thinking", "scraping", "analyzing", "writing", "cleanup", "done"]);
    expect(out.details.get("thinking")).toBe("Choosing pages");
    expect(out.bridge.scrapeCalls).toEqual([[HN, LOBSTERS]]);
    expect(out.llm.jsonCalls).toHaveLength(1);
    expect(out.llm.textCalls).toHaveLength(1);
  });

  test("sends date, time of day, instructions, digest and page text to the model", async () => {
    const out = await run({ options: { userSystemPrompt: "Lead with Rust news." } });
    const pick = out.llm.jsonCalls[0]!;
    const write = out.llm.textCalls[0]!;

    expect(pick.user).toContain("Saturday, October 10, 2026");
    expect(pick.user).toContain("Time of day: morning");
    expect(pick.user).toContain("Lead with Rust news.");
    expect(digestIn(pick.user).sites[0]!.domain).toBe("news.ycombinator.com");

    expect(write.user).toContain("Saturday, October 10, 2026");
    expect(write.user).toContain("Lead with Rust news.");
    expect(write.user).toContain(`URL: ${HN}`);
    expect(write.user).toContain("[First story](https://news.ycombinator.com/story-1)");
    expect(write.user).toContain("![Lead image](https://news.ycombinator.com/lead.png)");
    expect(write.system).toContain("PersonalizedHomepage");
    expect(pick.user).toContain("Choose at most 8 URLs.");
  });

  test("tells the user what is happening in short plain lines, never code", async () => {
    const out = await run();
    expect(out.texts).toEqual(["Picked 2 pages.\n", "Read 2 pages.\n", "Writing your homepage...\n"]);
  });

  test("lists pages that failed to load for the model and the user", async () => {
    const bridge = fakeBridge({
      scrape: async (urls) => ({
        pages: [{ url: urls[0]!, finalUrl: urls[0]!, title: "HN", html: ARTICLE_HTML }],
        failed: [{ url: urls[1]!, reason: "HTTP 503" }],
      }),
    });
    const out = await run({ bridge });
    expect(out.llm.textCalls[0]!.user).toContain("Pages that could not be read:\n- https://lobste.rs/ (HTTP 503)");
    expect(out.texts).toContain("Read 1 page, 1 could not be loaded.\n");
  });

  test("a page with no readable text counts as failed", async () => {
    const bridge = fakeBridge({
      scrape: async (urls) => ({
        pages: [
          { url: urls[0]!, finalUrl: urls[0]!, title: "HN", html: ARTICLE_HTML },
          { url: urls[1]!, finalUrl: urls[1]!, title: "Empty", html: "<script>x()</script>" },
        ],
        failed: [],
      }),
    });
    const out = await run({ bridge });
    expect(out.llm.textCalls[0]!.user).toContain("- https://lobste.rs/ (no readable content)");
  });

  test("clears the checkpoint when it finishes", async () => {
    const store = new SpyStore();
    const out = await run({ store });
    expect(out.error).toBeUndefined();
    expect(store.data.has(STORAGE_KEYS.buildCheckpoint)).toBe(false);
  });

  test("a stale model id from an older version falls back to the default model", async () => {
    const out = await run({ options: { model: "claude-sonnet-5-5" as never } });
    expect(out.result!.model).toBe("gemini-3.8-flash");
  });

  test("a model the user chose is tried first", async () => {
    const out = await run({ options: { model: "gemini-3.5-flash-lite" } });
    expect(out.llm.calls.map((call) => call.model)).toEqual(["gemini-3.5-flash-lite", "gemini-3.5-flash-lite"]);
    expect(out.result!.model).toBe("gemini-3.5-flash-lite");
  });
});

describe("model fallback inside a build", () => {
  test("a model used up for the day is skipped for the rest of the build", async () => {
    const llm = new FakeLlm(
      (call) => {
        if (call.model === "gemini-3.8-flash") throw dailyQuotaError();
        return pickReply(HN);
      },
      writeFromFirstLink,
    );
    const store = new MemoryStore();
    const out = await run({ llm, store });
    expect(llm.jsonCalls.map((call) => call.model)).toEqual(["gemini-3.8-flash", "gemini-3.6-flash"]);
    expect(llm.textCalls.map((call) => call.model)).toEqual(["gemini-3.6-flash"]);
    expect(out.result!.model).toBe("gemini-3.6-flash");
    const marked = await store.get<Record<string, string>>(STORAGE_KEYS.quotaExhausted);
    expect(Object.keys(marked!)).toEqual(["gemini-3.8-flash"]);
  });

  test("every model used up ends the build with the daily limit message", async () => {
    const llm = new FakeLlm(() => {
      throw dailyQuotaError();
    }, writeFromFirstLink);
    const out = await run({ llm });
    expect((out.error as Error).message).toContain("free daily limit is used up for today");
    expect(out.bridge.scrapeCalls).toEqual([]);
  });

  test("a missing key fails before any request", async () => {
    const out = await run({ llm: undefined, options: { llm: undefined, apiKey: "  " } });
    expect((out.error as Error).message).toContain("Add your Google Gemini API key");
    expect(out.bridge.historyCalls).toBe(0);
  });
});

describe("picking pages", () => {
  test("falls back to the top sites when the answer has no usable page", async () => {
    const llm = new FakeLlm(pickReply("https://evil.example.net/", "not a url"), writeFromFirstLink);
    const out = await run({ llm });
    expect(out.bridge.scrapeCalls[0]).toEqual([
      "https://news.ycombinator.com/",
      "https://lobste.rs/",
      "https://arstechnica.com/",
      "https://github.com/",
      "https://stackoverflow.com/",
      "https://en.wikipedia.org/",
      "https://filler-0.example.com/",
      "https://filler-1.example.com/",
    ]);
    expect(out.error).toBeUndefined();
  });

  test("an unreadable answer is treated the same way", async () => {
    const llm = new FakeLlm("I would pick Hacker News", writeFromFirstLink);
    const out = await run({ llm });
    expect(out.bridge.scrapeCalls[0]![0]).toBe(HN);
    expect(out.error).toBeUndefined();
  });

  test("ignores picks outside the digest and caps at eight", async () => {
    const urls = [
      "https://evil.example.net/",
      HN,
      ...Array.from({ length: 12 }, (_, i) => `https://filler-${i}.example.com/`),
    ];
    const llm = new FakeLlm(pickReply(...urls), writeFromFirstLink);
    const out = await run({ llm });
    expect(out.bridge.scrapeCalls[0]).toHaveLength(8);
    expect(out.bridge.scrapeCalls[0]).not.toContain("https://evil.example.net/");
  });

  test("stops with a clear message when there is no history to work from", async () => {
    const bridge = fakeBridge();
    bridge.getHistory = async () => ({ sites: [], totalSitesSeen: 0 });
    const out = await run({ bridge });
    expect((out.error as Error).message).toBe(NO_HISTORY_MESSAGE);
    expect(out.llm.calls).toEqual([]);
  });
});

describe("blocked sites", () => {
  test("are removed from the digest before it is capped and from the count", async () => {
    const out = await run({ options: { blockedSites: ["news.ycombinator.com"] } });
    const pick = out.llm.jsonCalls[0]!;
    const digest = digestIn(pick.user);
    expect(digest.totalSitesSeen).toBe(fixtureHistory().length - 1);
    expect(digest.sites).toHaveLength(30);
    expect(pick.user).not.toContain("news.ycombinator.com");
    expect(out.llm.textCalls[0]!.user).not.toContain("news.ycombinator.com");
  });

  test("a list saved during the build applies to the pages that are scraped next", async () => {
    let saved: string[] = [];
    const bridge = fakeBridge({ onHistory: () => (saved = ["news.ycombinator.com"]) });
    const out = await run({ bridge, options: { blockedSites: async () => saved } });
    expect(out.bridge.scrapeCalls).toEqual([[LOBSTERS]]);
    expect(out.llm.textCalls[0]!.user).not.toContain("https://news.ycombinator.com/story-1");
  });

  const unsafe = [
    "https://bank.test",
    "https://sub.bank.test",
    "https:/bank.test",
    "https:\\bank.test",
    "file:///secret",
    "chrome://settings",
    "javascript:alert(1)",
    "not a url",
  ];

  test("blocked and non-http urls are never forwarded from a resumed build", async () => {
    const store = await seeded(checkpoint({ urls: unsafe }));
    const out = await run({ store, llm: failingJson(), options: { resume: true, blockedSites: ["bank.test"] } });
    expect(out.bridge.scrapeCalls).toEqual([]);
    expect(out.logs).toContain("blocked: 8 url(s)");
    expect((out.error as Error).message).toBe(NO_PAGES_MESSAGE);
  });

  test("blocked and non-http urls the model picks are dropped before scraping", async () => {
    const llm = new FakeLlm(pickReply(...unsafe), writeFromFirstLink);
    const out = await run({ llm, options: { blockedSites: ["bank.test"] } });
    for (const call of out.bridge.scrapeCalls) {
      expect(call.some((url) => url.includes("bank.test") || !url.startsWith("http"))).toBe(false);
    }
    expect(out.error).toBeUndefined();
  });

  test("only allowed urls are forwarded in a mixed batch", async () => {
    const store = await seeded(checkpoint({ urls: ["https://bank.test", "https://public.test"] }));
    const out = await run({ store, llm: failingJson(), options: { resume: true, blockedSites: ["bank.test"] } });
    expect(out.bridge.scrapeCalls).toEqual([["https://public.test"]]);
    expect(out.error).toBeUndefined();
  });

  test("the built in list applies when none is given, and an empty list switches it off", async () => {
    const urls = ["https://mail.google.com/"];
    const blocked = await run({ store: await seeded(checkpoint({ urls })), llm: failingJson(), options: { resume: true } });
    expect(blocked.bridge.scrapeCalls).toEqual([]);
    const open = await run({ store: await seeded(checkpoint({ urls })), llm: failingJson(), options: { resume: true, blockedSites: [] } });
    expect(open.bridge.scrapeCalls).toEqual([urls]);
  });

  test("a page that redirected onto a blocked host is dropped before anything is sent", async () => {
    const redirector = "https://www.google.com/url?q=https://mail.google.com/";
    const store = await seeded(checkpoint({ urls: [redirector, "https://public.test/"] }));
    const bridge = fakeBridge({
      scrape: async (urls) => ({
        pages: [
          { url: urls[0]!, finalUrl: "https://mail.google.com/mail/u/0/", title: "Inbox", html: "<p>secret inbox contents</p>" },
          { url: urls[1]!, finalUrl: "https://public.test/", title: "Public", html: ARTICLE_HTML },
        ],
        failed: [],
      }),
    });
    const out = await run({ store, bridge, llm: failingJson(), options: { resume: true, blockedSites: ["mail.google.com"] } });
    const sent = out.llm.textCalls[0]!.user;
    expect(sent).not.toContain("secret inbox contents");
    expect(sent).not.toContain("Inbox");
    expect(sent).toContain("URL: https://public.test/");
  });
});

describe("writing and repair", () => {
  test("strips a markdown fence the model added", async () => {
    const llm = new FakeLlm(pickReply(HN), (call) => `\`\`\`tsx\n${writeFromFirstLink(call)}\n\`\`\``);
    const out = await run({ llm });
    expect(out.result!.code.startsWith("import React")).toBe(true);
    expect(out.result!.code).not.toContain("```");
    expect(llm.textCalls).toHaveLength(1);
  });

  test("asks once for a corrected file when a link was not on the pages", async () => {
    const llm = new FakeLlm(pickReply(HN), (_call, index) =>
      index === 0 ? homepageCode("https://made-up.example.org/story") : homepageCode(KNOWN),
    );
    const out = await run({ llm });
    expect(out.error).toBeUndefined();
    expect(out.result!.repaired).toBe(true);
    expect(out.result!.code).toContain("https://news.ycombinator.com/story-1");
    expect(llm.textCalls).toHaveLength(2);
    const repair: LlmCall = llm.textCalls[1]!;
    expect(repair.user).toContain("This link does not appear in the provided pages: https://made-up.example.org/story");
    expect(repair.user).toContain(homepageCode("https://made-up.example.org/story"));
    expect(out.phases.filter((phase) => phase === "writing")).toHaveLength(2);
  });

  test("a syntax error from the host's checker also triggers the repair", async () => {
    const llm = new FakeLlm(pickReply(HN), (call, index) =>
      index === 0 ? `${writeFromFirstLink(call)}\nconst = ;` : homepageCode(KNOWN),
    );
    const out = await run({ llm });
    expect(out.result!.repaired).toBe(true);
    expect(llm.textCalls[1]!.user).toContain("Syntax error:");
  });

  test("an answer that was cut off is repaired", async () => {
    const llm = new FakeLlm(pickReply(HN), (call, index) =>
      index === 0 ? { text: writeFromFirstLink(call), truncated: true } : homepageCode(KNOWN),
    );
    const out = await run({ llm });
    expect(out.result!.repaired).toBe(true);
    expect(llm.textCalls[1]!.user).toContain("cut off");
  });

  test("links that stay unverified after the repair are logged and accepted", async () => {
    const fake = homepageCode("https://made-up.example.org/story");
    const llm = new FakeLlm(pickReply(HN), () => fake);
    const out = await run({ llm });
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({ code: fake, repaired: true });
    expect(out.logs.some((line) => line.includes("could not be matched"))).toBe(true);
    expect(llm.textCalls).toHaveLength(2);
  });

  test("keeps a draft that only had link problems when the repair request itself fails", async () => {
    const fake = homepageCode("https://made-up.example.org/story");
    const llm = new FakeLlm(pickReply(HN), (_call, index) => {
      if (index === 0) return fake;
      throw dailyQuotaError();
    });
    const out = await run({ llm });
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({ code: fake, repaired: false });
  });

  test("a structural problem that survives the repair ends the build", async () => {
    const llm = new FakeLlm(pickReply(HN), () => "const nothing = 1;");
    const out = await run({ llm });
    expect((out.error as Error).message).toContain("not usable");
    expect(llm.textCalls).toHaveLength(2);
    expect(out.result).toBeUndefined();
  });

  test("a structural problem with a failed repair request surfaces that failure", async () => {
    const llm = new FakeLlm(pickReply(HN), (_call, index) => {
      if (index === 0) return "const nothing = 1;";
      throw dailyQuotaError();
    });
    const out = await run({ llm });
    expect((out.error as Error).message).toContain("free daily limit is used up");
  });

  test("never sends the model's code back as progress text", async () => {
    const out = await run();
    expect(out.texts.join("")).not.toContain("PersonalizedHomepage");
    expect(out.texts.every((line) => line.length < 80 && line.endsWith("\n"))).toBe(true);
  });
});

describe("failures", () => {
  test("zero scraped pages is a clear error and nothing is written", async () => {
    const bridge = fakeBridge({
      scrape: async (urls) => ({ pages: [], failed: urls.map((url) => ({ url, reason: "timed out" })) }),
    });
    const out = await run({ bridge });
    expect((out.error as Error).message).toBe(NO_PAGES_MESSAGE);
    expect(out.llm.textCalls).toEqual([]);
    expect(out.phases.slice(-1)).toEqual(["cleanup"]);
  });

  test("the checkpoint is cleared after an error too", async () => {
    const store = new SpyStore();
    const bridge = fakeBridge({ scrape: async () => ({ pages: [], failed: [] }) });
    const out = await run({ bridge, store });
    expect(out.error).toBeDefined();
    expect(store.checkpoints).toHaveLength(1);
    expect(store.data.has(STORAGE_KEYS.buildCheckpoint)).toBe(false);
  });

  test("a build cancelled before it starts makes no request", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await run({ options: { signal: controller.signal } });
    expect((out.error as Error).name).toBe("AbortError");
    expect(out.bridge.historyCalls).toBe(0);
    expect(out.llm.calls).toEqual([]);
  });

  test("a build cancelled during scraping never reaches the writer", async () => {
    const controller = new AbortController();
    const bridge = fakeBridge({
      scrape: async (urls) => {
        controller.abort();
        return { pages: urls.map((url) => ({ url, title: "x", html: ARTICLE_HTML })), failed: [] };
      },
    });
    const store = new SpyStore();
    const out = await run({ bridge, store, options: { signal: controller.signal } });
    expect((out.error as Error).name).toBe("AbortError");
    expect(out.llm.textCalls).toEqual([]);
    expect(store.data.has(STORAGE_KEYS.buildCheckpoint)).toBe(false);
  });
});

describe("checkpoint and resume", () => {
  test("is saved after the pick and again after the scrape", async () => {
    const store = new SpyStore();
    await run({ store });
    expect(store.checkpoints).toHaveLength(2);

    const [afterPick, afterScrape] = store.checkpoints as [BuildCheckpoint, BuildCheckpoint];
    expect(afterPick).toMatchObject({ version: 1, urls: [HN, LOBSTERS] });
    expect(afterPick.startedAt).toBe(NOW.toISOString());
    expect(afterPick.pages).toBeUndefined();

    expect(afterScrape.urls).toEqual([HN, LOBSTERS]);
    expect(afterScrape.pages!.map((page) => page.url)).toEqual([HN, LOBSTERS]);
    expect(afterScrape.pages![0]!.text).toContain("[First story](https://news.ycombinator.com/story-1)");
    expect(afterScrape.failed).toEqual([]);
  });

  test("a build resumed after the scrape only writes", async () => {
    const store = await seeded(checkpoint({ pages: [compacted(HN), compacted(LOBSTERS)], failed: [] }));
    const bridge = fakeBridge({
      scrape: async () => {
        throw new Error("the pages must not be loaded again");
      },
    });
    bridge.getHistory = async () => {
      throw new Error("history must not be read again");
    };
    const out = await run({ store, bridge, llm: failingJson(), options: { resume: true } });
    expect(out.error).toBeUndefined();
    expect(out.llm.jsonCalls).toEqual([]);
    expect(out.llm.textCalls).toHaveLength(1);
    expect(bridge.scrapeCalls).toEqual([]);
    expect(out.phases).toEqual(["setup", "writing", "cleanup", "done"]);
    expect(out.llm.textCalls[0]!.user).toContain("[First story](https://lobste.rs/story-1)");
    expect(store.data.has(STORAGE_KEYS.buildCheckpoint)).toBe(false);
  });

  test("a build resumed after the pick skips history and the pick but still loads the pages", async () => {
    const store = await seeded(checkpoint());
    const bridge = fakeBridge();
    bridge.getHistory = async () => {
      throw new Error("history must not be read again");
    };
    const out = await run({ store, bridge, llm: failingJson(), options: { resume: true } });
    expect(out.error).toBeUndefined();
    expect(out.llm.jsonCalls).toEqual([]);
    expect(bridge.scrapeCalls).toEqual([[HN, LOBSTERS]]);
    expect(out.phases).toEqual(["setup", "scraping", "analyzing", "writing", "cleanup", "done"]);
    expect(out.llm.textCalls).toHaveLength(1);
  });

  test("pages blocked since the checkpoint was saved are dropped on resume", async () => {
    const store = await seeded(checkpoint({ pages: [compacted(HN), compacted(LOBSTERS)], failed: [] }));
    const out = await run({ store, llm: failingJson(), options: { resume: true, blockedSites: ["lobste.rs"] } });
    const sent = out.llm.textCalls[0]!.user;
    expect(sent).toContain(`URL: ${HN}`);
    expect(sent).not.toContain("lobste.rs");
  });

  test("starts over when the checkpoint is too old", async () => {
    const old = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const store = await seeded(checkpoint({ startedAt: old, pages: [compacted(HN)], failed: [] }));
    const out = await run({ store, options: { resume: true } });
    expect(out.bridge.historyCalls).toBe(1);
    expect(out.llm.jsonCalls).toHaveLength(1);
    expect(out.logs).toContain("no usable checkpoint, starting fresh");
  });

  test("starts over when the checkpoint is damaged or missing", async () => {
    for (const value of [undefined, "junk", { version: 2 }, { version: 1, startedAt: NOW.toISOString(), urls: "x" }]) {
      const store = new MemoryStore();
      if (value !== undefined) await store.set(STORAGE_KEYS.buildCheckpoint, value);
      const out = await run({ store, options: { resume: true } });
      expect(out.error).toBeUndefined();
      expect(out.bridge.historyCalls).toBe(1);
    }
  });

  test("a checkpoint is ignored unless the caller asks to resume", async () => {
    const store = await seeded(checkpoint({ pages: [compacted(HN)], failed: [] }));
    const out = await run({ store });
    expect(out.bridge.historyCalls).toBe(1);
    expect(out.llm.jsonCalls).toHaveLength(1);
  });

  test("a leftover checkpoint is discarded once it is too old or damaged, and kept while fresh", async () => {
    const fresh = await seeded(checkpoint());
    await discardStaleCheckpoint(fresh, NOW);
    expect(fresh.data.has(STORAGE_KEYS.buildCheckpoint)).toBe(true);

    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    await discardStaleCheckpoint(fresh, later);
    expect(fresh.data.has(STORAGE_KEYS.buildCheckpoint)).toBe(false);

    const damaged = new MemoryStore();
    await damaged.set(STORAGE_KEYS.buildCheckpoint, "junk");
    await discardStaleCheckpoint(damaged, NOW);
    expect(damaged.data.has(STORAGE_KEYS.buildCheckpoint)).toBe(false);

    await discardStaleCheckpoint(new MemoryStore(), NOW);
  });
});

describe("news sources", () => {
  const REUTERS = "https://www.reuters.com/world/";
  const HN_FRONT = "https://news.ycombinator.com/front";

  test("are read first, then personal picks that are not on a news site", async () => {
    const out = await run({ options: { newsSources: [REUTERS, HN_FRONT] } });
    expect(out.error).toBeUndefined();
    expect(out.bridge.scrapeCalls).toEqual([[REUTERS, HN_FRONT, LOBSTERS]]);
    const pickMessage = out.llm.jsonCalls[0]!.user;
    expect(pickMessage).toContain("Choose at most 5 URLs.");
    expect(pickMessage).toContain(`- ${REUTERS}`);
  });

  test("each page is marked as a news source or a personal feed for the writer", async () => {
    const out = await run({ options: { newsSources: [REUTERS] } });
    const write = out.llm.textCalls[0]!.user;
    expect(write).toContain(`URL: ${REUTERS}\nKind: News source`);
    expect(write).toContain(`URL: ${HN}\nKind: Personal feed`);
  });

  test("build from news alone when there is no history, without a pick request", async () => {
    const bridge = fakeBridge();
    bridge.getHistory = async () => ({ sites: [], totalSitesSeen: 0 });
    const out = await run({ bridge, options: { newsSources: [REUTERS] } });
    expect(out.error).toBeUndefined();
    expect(out.llm.jsonCalls).toHaveLength(0);
    expect(out.bridge.scrapeCalls).toEqual([[REUTERS]]);
  });

  test("a blocked news site is never read", async () => {
    const out = await run({ options: { newsSources: [REUTERS], blockedSites: ["reuters.com"] } });
    expect(out.bridge.scrapeCalls.flat()).not.toContain(REUTERS);
  });
});
