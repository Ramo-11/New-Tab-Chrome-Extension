import { describe, expect, test } from "bun:test";
import {
  GeminiError,
  MODEL_CHOICES,
  STORAGE_KEYS,
  runWithFallback,
  type FallbackOptions,
} from "@homepage/agent-core";
import { MemoryStore, apiError, dailyQuotaError, minuteQuotaError, overloadedError } from "./fakes";

const NOW = new Date("2026-10-10T18:00:00Z");
const [FIRST, SECOND, THIRD, FOURTH] = MODEL_CHOICES.map((choice) => choice.id);

type Outcome = string | Error;

function harness(script: Record<string, Outcome[]>, overrides: Partial<FallbackOptions> = {}) {
  const store = new MemoryStore();
  const sleeps: number[] = [];
  const logs: string[] = [];
  const calls: string[] = [];
  const options: FallbackOptions = {
    store,
    preferred: FIRST,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => logs.push(line),
    ...overrides,
  };
  const call = async (model: string): Promise<string> => {
    calls.push(model);
    const outcome = script[model]?.shift() ?? "ok";
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  const run = () => runWithFallback(options, call);
  return { store, sleeps, logs, calls, run, options };
}

async function exhausted(store: MemoryStore): Promise<string[]> {
  const record = await store.get<Record<string, string>>(STORAGE_KEYS.quotaExhausted);
  return Object.keys(record ?? {});
}

describe("model order", () => {
  test("uses the chosen model first and reports it", async () => {
    const h = harness({}, { preferred: THIRD });
    const result = await h.run();
    expect(result).toEqual({ value: "ok", model: THIRD });
    expect(h.calls).toEqual([THIRD]);
  });

  test("falls through the rest in list order when each is out for the day", async () => {
    const h = harness(
      { [THIRD!]: [dailyQuotaError()], [FIRST!]: [dailyQuotaError()], [SECOND!]: [dailyQuotaError()] },
      { preferred: THIRD },
    );
    const result = await h.run();
    expect(h.calls).toEqual([THIRD, FIRST, SECOND, FOURTH]);
    expect(result.model).toBe(FOURTH);
    expect((await exhausted(h.store)).sort()).toEqual([FIRST, SECOND, THIRD].sort());
  });

  test("skips models already marked exhausted without calling them", async () => {
    const h = harness({});
    await h.store.set(STORAGE_KEYS.quotaExhausted, { [FIRST!]: "2026-10-11T07:00:00.000Z" });
    const result = await h.run();
    expect(h.calls).toEqual([SECOND]);
    expect(result.model).toBe(SECOND);
  });

  test("tries a model again once its exhausted mark has expired", async () => {
    const h = harness({});
    await h.store.set(STORAGE_KEYS.quotaExhausted, { [FIRST!]: "2026-10-10T07:00:00.000Z" });
    const result = await h.run();
    expect(result.model).toBe(FIRST);
  });

  test("tries models that were unavailable earlier in the build last", async () => {
    const h = harness({}, { demoted: new Set([FIRST!]) });
    const result = await h.run();
    expect(result.model).toBe(SECOND);
  });

  test("an unknown preferred model falls back to the default", async () => {
    const h = harness({}, { preferred: "claude-sonnet-5-5" });
    expect((await h.run()).model).toBe(FIRST);
  });
});

describe("per-minute limits", () => {
  test("waits the server's retry delay and retries the same model", async () => {
    const h = harness({ [FIRST!]: [minuteQuotaError("37s")] });
    const result = await h.run();
    expect(h.sleeps).toEqual([37_000]);
    expect(h.calls).toEqual([FIRST, FIRST]);
    expect(result.model).toBe(FIRST);
    expect(await exhausted(h.store)).toEqual([]);
  });

  test("caps a long wait at 60 seconds", async () => {
    const h = harness({ [FIRST!]: [minuteQuotaError("300s")] });
    await h.run();
    expect(h.sleeps).toEqual([60_000]);
  });

  test("waits at most twice, then moves on without marking the model exhausted", async () => {
    const h = harness({ [FIRST!]: [minuteQuotaError("5s"), minuteQuotaError("6s"), minuteQuotaError("7s")] });
    const result = await h.run();
    expect(h.sleeps).toEqual([5_000, 6_000]);
    expect(h.calls).toEqual([FIRST, FIRST, FIRST, SECOND]);
    expect(result.model).toBe(SECOND);
    expect(await exhausted(h.store)).toEqual([]);
  });

  test("an unknown 429 that keeps failing marks the model exhausted", async () => {
    const unknown = () => apiError(429, { error: { message: "Slow down", code: "too_many_requests" } });
    const h = harness({ [FIRST!]: [unknown(), unknown(), unknown()] });
    const result = await h.run();
    expect(h.sleeps).toEqual([15_000, 15_000]);
    expect(result.model).toBe(SECOND);
    expect(await exhausted(h.store)).toEqual([FIRST]);
  });

  test("reports a rate limit, not a daily one, when every model is rate limited", async () => {
    const limited = () => [minuteQuotaError("1s"), minuteQuotaError("1s"), minuteQuotaError("1s")];
    const h = harness({ [FIRST!]: limited(), [SECOND!]: limited(), [THIRD!]: limited(), [FOURTH!]: limited() });
    const error = await h.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiError);
    expect((error as GeminiError).code).toBe("rate-limit");
    expect(await exhausted(h.store)).toEqual([]);
  });

  test("a wait is cut short when the build is cancelled", async () => {
    const controller = new AbortController();
    const h = harness({ [FIRST!]: [minuteQuotaError("30s")] }, { signal: controller.signal, sleep: undefined });
    const pending = h.run().catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const error = (await pending) as Error;
    expect(error.name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("per-day limits", () => {
  test("records the model as exhausted until the next Pacific midnight and moves on at once", async () => {
    const h = harness({ [FIRST!]: [dailyQuotaError()] });
    const result = await h.run();
    expect(h.sleeps).toEqual([]);
    expect(result.model).toBe(SECOND);
    expect(await h.store.get<Record<string, string>>(STORAGE_KEYS.quotaExhausted)).toEqual({ [FIRST!]: "2026-10-11T07:00:00.000Z" });
  });

  test("the plain-English daily message when every model is used up", async () => {
    const h = harness({
      [FIRST!]: [dailyQuotaError()],
      [SECOND!]: [dailyQuotaError()],
      [THIRD!]: [dailyQuotaError()],
      [FOURTH!]: [dailyQuotaError()],
    });
    const error = (await h.run().catch((e: unknown) => e)) as GeminiError;
    expect(error).toBeInstanceOf(GeminiError);
    expect(error.code).toBe("daily-limit");
    expect(error.message).toBe(
      "Google's free daily limit is used up for today. It resets at midnight Pacific time, and your current homepage stays until then.",
    );
    expect(await exhausted(h.store)).toHaveLength(4);
  });

  test("makes no request at all when every model is already marked", async () => {
    const h = harness({});
    const until = "2026-10-11T07:00:00.000Z";
    await h.store.set(
      STORAGE_KEYS.quotaExhausted,
      Object.fromEntries(MODEL_CHOICES.map((choice) => [choice.id, until])),
    );
    const error = (await h.run().catch((e: unknown) => e)) as GeminiError;
    expect(error.code).toBe("daily-limit");
    expect(h.calls).toEqual([]);
  });
});

describe("server trouble", () => {
  test("retries a busy model with backoff and stays on it when it recovers", async () => {
    const h = harness({ [FIRST!]: [overloadedError()] });
    const result = await h.run();
    expect(h.sleeps).toEqual([2_000]);
    expect(result.model).toBe(FIRST);
  });

  test("after two backoffs moves to the next model without marking the busy one exhausted", async () => {
    const h = harness({ [FIRST!]: [overloadedError(), overloadedError(), overloadedError()] });
    const result = await h.run();
    expect(h.sleeps).toEqual([2_000, 6_000]);
    expect(h.calls).toEqual([FIRST, FIRST, FIRST, SECOND]);
    expect(result.model).toBe(SECOND);
    expect(await exhausted(h.store)).toEqual([]);
  });

  test("a model that times out is skipped at once without retrying it", async () => {
    const slow = Object.assign(new Error("Google took too long to answer."), { status: 504, timedOut: true });
    const h = harness({ [FIRST!]: [slow] });
    const result = await h.run();
    expect(h.calls).toEqual([FIRST, SECOND]);
    expect(h.sleeps).toEqual([]);
    expect(result.model).toBe(SECOND);
    expect(await exhausted(h.store)).toEqual([]);
  });

  test("a 500 is treated the same way", async () => {
    const h = harness({ [FIRST!]: [apiError(500, "boom"), apiError(500, "boom"), apiError(500, "boom")] });
    expect((await h.run()).model).toBe(SECOND);
  });

  test("a model that is gone (404) is skipped and not marked exhausted", async () => {
    const gone = apiError(404, { error: { message: "no longer available to new users", code: "not_found" } });
    const h = harness({ [FIRST!]: [gone] });
    const result = await h.run();
    expect(h.calls).toEqual([FIRST, SECOND]);
    expect(h.sleeps).toEqual([]);
    expect(result.model).toBe(SECOND);
    expect(await exhausted(h.store)).toEqual([]);
  });

  test("reports busy servers when nothing answered", async () => {
    const busy = () => [overloadedError(), overloadedError(), overloadedError()];
    const h = harness({ [FIRST!]: busy(), [SECOND!]: busy(), [THIRD!]: busy(), [FOURTH!]: busy() });
    const error = (await h.run().catch((e: unknown) => e)) as GeminiError;
    expect(error.code).toBe("unavailable");
  });

  test("a network failure retries twice, then stops with a clear message", async () => {
    const down = () => new TypeError("fetch failed");
    const h = harness({ [FIRST!]: [down(), down(), down()] });
    const error = (await h.run().catch((e: unknown) => e)) as GeminiError;
    expect(error.code).toBe("network");
    expect(error.message).toBe("Couldn't reach Google. Check your internet connection and try again.");
    expect(h.calls).toEqual([FIRST, FIRST, FIRST]);
  });
});

describe("fatal errors", () => {
  test("a rejected key stops everything with the plain-English message", async () => {
    const invalid = apiError(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key." } });
    const h = harness({ [FIRST!]: [invalid] });
    const error = (await h.run().catch((e: unknown) => e)) as GeminiError;
    expect(error).toBeInstanceOf(GeminiError);
    expect(error.code).toBe("invalid-key");
    expect(error.message).toBe(
      "Google didn't accept this key. Create a new one at aistudio.google.com/apikey and paste it in Settings.",
    );
    expect(h.calls).toEqual([FIRST]);
  });

  test("401 and 403 mean the same thing", async () => {
    for (const status of [401, 403]) {
      const h = harness({ [FIRST!]: [apiError(status, { error: { message: "denied" } })] });
      const error = (await h.run().catch((e: unknown) => e)) as GeminiError;
      expect(error.code).toBe("invalid-key");
    }
  });

  test("an unexpected 400 surfaces Google's message", async () => {
    const h = harness({ [FIRST!]: [apiError(400, { error: { message: "Invalid JSON schema" } })] });
    const error = (await h.run().catch((e: unknown) => e)) as GeminiError;
    expect(error.code).toBe("unexpected");
    expect(error.message).toContain("Invalid JSON schema");
  });

  test("a cancelled build never calls the model", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({}, { signal: controller.signal });
    const error = (await h.run().catch((e: unknown) => e)) as Error;
    expect(error.name).toBe("AbortError");
    expect(h.calls).toEqual([]);
  });
});
