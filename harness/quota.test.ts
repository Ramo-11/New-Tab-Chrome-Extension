import { describe, expect, test } from "bun:test";
import {
  STORAGE_KEYS,
  classifyError,
  loadExhaustedModels,
  markModelExhausted,
  nextMidnightPacific,
  parseApiError,
  parseDurationMs,
  quotaScope,
} from "@homepage/agent-core";
import {
  MemoryStore,
  apiError,
  dailyQuotaError,
  minuteQuotaError,
  overloadedError,
} from "./fakes";

describe("parseDurationMs", () => {
  test("reads protobuf style and plain durations", () => {
    expect(parseDurationMs("37s")).toBe(37_000);
    expect(parseDurationMs("37.5s")).toBe(37_500);
    expect(parseDurationMs("1m30s")).toBe(90_000);
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("2")).toBe(2_000);
    expect(parseDurationMs("37 seconds")).toBe(37_000);
    expect(parseDurationMs("2 minutes")).toBe(120_000);
    expect(parseDurationMs("soon")).toBeUndefined();
  });
});

describe("parseApiError", () => {
  test("pulls quota ids and the retry delay out of a generateContent 429", () => {
    const parsed = parseApiError(dailyQuotaError());
    expect(parsed.status).toBe(429);
    expect(parsed.apiStatus).toBe("RESOURCE_EXHAUSTED");
    expect(parsed.quotaIds).toEqual(["GenerateRequestsPerDayPerProjectPerModel-FreeTier"]);
    expect(parsed.retryDelayMs).toBe(37_000);
  });

  test("reads the Interactions API error shape", () => {
    const parsed = parseApiError(
      apiError(429, {
        error: {
          message: "Rate limit exceeded for model gemini-3.1-pro (limit: 0 input tokens per minute on Free Tier)",
          code: "too_many_requests",
        },
      }),
    );
    expect(parsed.status).toBe(429);
    expect(parsed.message).toContain("Rate limit exceeded");
  });

  test("derives the status from the error code when the status is missing", () => {
    const parsed = parseApiError(new Error(JSON.stringify({ error: { message: "busy", code: "service_unavailable" } })));
    expect(parsed.status).toBe(503);
  });

  test("reads the SDK error shape with a body string and headers", () => {
    const headers = new Headers({ "retry-after": "12" });
    const sdkError = Object.assign(new Error("429 Slow down"), {
      status: 429,
      body: JSON.stringify({ message: "Slow down", code: "too_many_requests" }),
      headers,
    });
    const parsed = parseApiError(sdkError);
    expect(parsed.status).toBe(429);
    expect(parsed.retryDelayMs).toBe(12_000);
  });

  test("falls back to text patterns when the body is not JSON", () => {
    const parsed = parseApiError(Object.assign(new Error("Quota exceeded. Please retry in 37.5s."), { status: 429 }));
    expect(parsed.retryDelayMs).toBe(37_500);
  });

  test("does not throw on garbage", () => {
    for (const value of [undefined, null, 42, "nope", {}, new Error(""), { message: 7 }]) {
      expect(() => parseApiError(value)).not.toThrow();
    }
    expect(parseApiError(undefined).status).toBeUndefined();
  });

  test("finds a quota id in a message that is only partly JSON", () => {
    const parsed = parseApiError(
      Object.assign(new Error('got status: 429. {"error":{"details":[{"violations":[{"quotaId":"X-PerMinute-FreeTier"}]}]}}'), {
        status: 429,
      }),
    );
    expect(parsed.quotaIds).toEqual(["X-PerMinute-FreeTier"]);
  });
});

describe("quotaScope", () => {
  test("separates per-day from per-minute limits", () => {
    expect(quotaScope(parseApiError(dailyQuotaError()))).toBe("day");
    expect(quotaScope(parseApiError(minuteQuotaError()))).toBe("minute");
  });

  test("a day limit wins when both appear", () => {
    const both = apiError(429, {
      error: {
        details: [
          {
            violations: [
              { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" },
              { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" },
            ],
          },
        ],
      },
    });
    expect(quotaScope(parseApiError(both))).toBe("day");
  });

  test("reads the Interactions API wording", () => {
    const day = apiError(429, { error: { message: "You have exceeded the requests per day limit", code: "too_many_requests" } });
    const minute = apiError(429, { error: { message: "Too many requests per minute", code: "too_many_requests" } });
    const zero = apiError(429, {
      error: { message: "Rate limit exceeded (limit: 0 input tokens per minute on Free Tier)", code: "too_many_requests" },
    });
    expect(quotaScope(parseApiError(day))).toBe("day");
    expect(quotaScope(parseApiError(minute))).toBe("minute");
    expect(quotaScope(parseApiError(zero))).toBe("day");
  });

  test("is unknown without any hint", () => {
    expect(quotaScope(parseApiError(apiError(429, { error: { message: "Slow down" } })))).toBe("unknown");
  });
});

describe("classifyError", () => {
  test("429 carries scope and retry delay", () => {
    expect(classifyError(minuteQuotaError("12s"))).toEqual({ kind: "quota", scope: "minute", retryAfterMs: 12_000 });
    expect(classifyError(dailyQuotaError())).toMatchObject({ kind: "quota", scope: "day" });
  });

  test("500 and 503 are server problems", () => {
    expect(classifyError(overloadedError()).kind).toBe("server");
    expect(classifyError(apiError(500, "boom")).kind).toBe("server");
    expect(classifyError(apiError(504, { error: { message: "timeout" } })).kind).toBe("server");
  });

  test("an invalid key is recognised from 400, 401 and 403", () => {
    const invalid = apiError(400, {
      error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." },
    });
    expect(classifyError(invalid).kind).toBe("invalid-key");
    expect(classifyError(apiError(401, { error: { message: "nope" } })).kind).toBe("invalid-key");
    expect(classifyError(apiError(403, { error: { message: "denied" } })).kind).toBe("invalid-key");
  });

  test("other 400s stay unexpected and keep their message", () => {
    const info = classifyError(apiError(400, { error: { message: "Invalid JSON schema" } }));
    expect(info).toEqual({ kind: "unexpected", message: "Invalid JSON schema" });
  });

  test("a missing model is its own kind", () => {
    const gone = apiError(404, {
      error: { message: "This model is no longer available to new users.", code: "not_found" },
    });
    expect(classifyError(gone).kind).toBe("model-missing");
  });

  test("an unsupported region is recognised", () => {
    const region = apiError(400, {
      error: { code: 400, status: "FAILED_PRECONDITION", message: "User location is not supported for the API use." },
    });
    expect(classifyError(region).kind).toBe("region");
  });

  test("network failures and aborts", () => {
    expect(classifyError(new TypeError("fetch failed")).kind).toBe("network");
    expect(classifyError(new Error("Failed to fetch")).kind).toBe("network");
    expect(classifyError(Object.assign(new Error("x"), { name: "AbortError" })).kind).toBe("aborted");
    const controller = new AbortController();
    controller.abort();
    expect(classifyError(new Error("whatever"), controller.signal).kind).toBe("aborted");
  });

  test("a plain bug is not mistaken for a network problem", () => {
    expect(classifyError(new TypeError("Cannot read properties of undefined")).kind).toBe("unexpected");
  });
});

describe("nextMidnightPacific", () => {
  test("summer evening rolls to 07:00 UTC the next day", () => {
    expect(nextMidnightPacific(new Date("2026-07-15T20:30:00Z")).toISOString()).toBe("2026-07-16T07:00:00.000Z");
  });

  test("winter morning rolls to 08:00 UTC the next day", () => {
    expect(nextMidnightPacific(new Date("2026-01-15T10:00:00Z")).toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  test("the last second before midnight Pacific", () => {
    expect(nextMidnightPacific(new Date("2026-10-10T06:59:59Z")).toISOString()).toBe("2026-10-10T07:00:00.000Z");
  });

  test("exactly midnight Pacific moves to the following midnight", () => {
    expect(nextMidnightPacific(new Date("2026-10-10T07:00:00Z")).toISOString()).toBe("2026-10-11T07:00:00.000Z");
  });

  test("handles the end of daylight saving time", () => {
    expect(nextMidnightPacific(new Date("2026-10-31T20:00:00Z")).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(nextMidnightPacific(new Date("2026-11-01T12:00:00Z")).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  test("handles the start of daylight saving time and a year end", () => {
    expect(nextMidnightPacific(new Date("2026-03-08T12:00:00Z")).toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(nextMidnightPacific(new Date("2026-12-31T23:00:00Z")).toISOString()).toBe("2027-01-01T08:00:00.000Z");
  });
});

describe("exhausted model store", () => {
  const now = new Date("2026-10-10T18:00:00Z");

  test("remembers a model until the next Pacific midnight", async () => {
    const store = new MemoryStore();
    await markModelExhausted(store, "gemini-3.8-flash", now);
    expect(await store.get<Record<string, string>>(STORAGE_KEYS.quotaExhausted)).toEqual({ "gemini-3.8-flash": "2026-10-11T07:00:00.000Z" });
    expect([...(await loadExhaustedModels(store, now))]).toEqual(["gemini-3.8-flash"]);
    expect((await loadExhaustedModels(store, new Date("2026-10-11T06:59:00Z"))).size).toBe(1);
    expect((await loadExhaustedModels(store, new Date("2026-10-11T07:00:01Z"))).size).toBe(0);
  });

  test("drops expired entries when it writes", async () => {
    const store = new MemoryStore();
    await store.set(STORAGE_KEYS.quotaExhausted, { "gemini-3.6-flash": "2026-10-09T07:00:00.000Z" });
    await markModelExhausted(store, "gemini-3.8-flash", now);
    expect(Object.keys((await store.get<Record<string, string>>(STORAGE_KEYS.quotaExhausted))!)).toEqual(["gemini-3.8-flash"]);
  });

  test("ignores a corrupted record", async () => {
    const store = new MemoryStore();
    await store.set(STORAGE_KEYS.quotaExhausted, "garbage");
    expect((await loadExhaustedModels(store, now)).size).toBe(0);
    await store.set(STORAGE_KEYS.quotaExhausted, { a: 5, b: "not a date" });
    expect((await loadExhaustedModels(store, now)).size).toBe(0);
  });
});
