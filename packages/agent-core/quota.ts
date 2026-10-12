import { isAbortError } from "./errors";
import { STORAGE_KEYS } from "./models";
import type { KVStore } from "./types";

export interface ParsedApiError {
  status: number | undefined;
  apiStatus: string | undefined;
  message: string;
  text: string;
  quotaIds: string[];
  quotaValues: string[];
  reasons: string[];
  retryDelayMs: number | undefined;
}

export type QuotaScope = "day" | "minute" | "unknown";

export type ErrorInfo =
  | { kind: "aborted" }
  | { kind: "invalid-key" }
  | { kind: "region" }
  | { kind: "quota"; scope: QuotaScope; retryAfterMs: number | undefined }
  | { kind: "server" }
  | { kind: "slow" }
  | { kind: "network" }
  | { kind: "model-missing" }
  | { kind: "unexpected"; message: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

const DURATION_UNIT = "ms|seconds?|secs?|s|minutes?|mins?|m|hours?|h";

function unitMs(unit: string): number {
  const name = unit.toLowerCase();
  if (name === "ms") return 1;
  if (name.startsWith("s")) return 1000;
  if (name.startsWith("m")) return 60_000;
  return 3_600_000;
}

export function parseDurationMs(text: string): number | undefined {
  const trimmed = text.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  let total = 0;
  let matched = false;
  for (const match of trimmed.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNIT})(?![a-z])`, "gi"))) {
    matched = true;
    total += Number(match[1]) * unitMs(match[2]!);
  }
  return matched ? Math.round(total) : undefined;
}

const CODE_STATUS: Array<[RegExp, number]> = [
  [/too_many_requests|resource_exhausted|rate_limit/i, 429],
  [/unavailable|overloaded/i, 503],
  [/deadline|timeout/i, 504],
  [/internal/i, 500],
  [/unauthenticated/i, 401],
  [/permission_denied|forbidden/i, 403],
  [/not_found/i, 404],
];

export function statusFromCode(code: string): number | undefined {
  return CODE_STATUS.find(([pattern]) => pattern.test(code))?.[1];
}

function readRetryAfterHeader(headers: unknown): number | undefined {
  const getter = asRecord(headers)?.get;
  if (typeof getter !== "function") return undefined;
  const value = getter.call(headers, "retry-after");
  return typeof value === "string" ? parseDurationMs(value) : undefined;
}

export function parseApiError(error: unknown): ParsedApiError {
  const record = asRecord(error);
  const errorMessage =
    typeof record?.message === "string" ? record.message : typeof error === "string" ? error : "";
  const bodyText = typeof record?.body === "string" ? record.body : "";

  const payload =
    asRecord(record?.error) ?? asRecord(parseJsonLoose(bodyText)) ?? asRecord(parseJsonLoose(errorMessage));
  const inner = asRecord(payload?.error) ?? payload;

  const codeValue = inner?.code;
  const codeText = typeof codeValue === "string" ? codeValue : "";
  const numeric = [record?.status, record?.statusCode, codeValue].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  const status = numeric ?? (codeText ? statusFromCode(codeText) : undefined);
  const apiStatus =
    typeof inner?.status === "string" ? inner.status : codeText || undefined;
  const innerMessage = typeof inner?.message === "string" ? inner.message : "";
  const message = innerMessage || errorMessage;
  const text = [innerMessage, errorMessage, bodyText].filter(Boolean).join(" ");

  const quotaIds: string[] = [];
  const quotaValues: string[] = [];
  const reasons: string[] = [];
  let retryDelayMs: number | undefined;

  const details = Array.isArray(inner?.details) ? inner.details : [];
  for (const detail of details) {
    const entry = asRecord(detail);
    if (!entry) continue;
    if (Array.isArray(entry.violations)) {
      for (const violation of entry.violations) {
        const item = asRecord(violation);
        if (typeof item?.quotaId === "string") quotaIds.push(item.quotaId);
        if (item?.quotaValue !== undefined) quotaValues.push(String(item.quotaValue));
      }
    }
    if (typeof entry.retryDelay === "string") {
      retryDelayMs = parseDurationMs(entry.retryDelay) ?? retryDelayMs;
    }
    if (typeof entry.reason === "string") reasons.push(entry.reason);
  }

  if (quotaIds.length === 0) {
    for (const match of text.matchAll(/"quotaId"\s*:\s*"([^"]+)"/g)) quotaIds.push(match[1]!);
  }
  if (retryDelayMs === undefined) {
    const delay =
      text.match(/"retryDelay"\s*:\s*"([^"]+)"/) ??
      text.match(new RegExp(`retry (?:in|after)\\s*([\\d.]+\\s*(?:${DURATION_UNIT})?)`, "i"));
    if (delay) retryDelayMs = parseDurationMs(delay[1]!.trim());
  }
  retryDelayMs ??= readRetryAfterHeader(record?.headers);

  return { status, apiStatus, message, text, quotaIds, quotaValues, reasons, retryDelayMs };
}

export function quotaScope(parsed: ParsedApiError): QuotaScope {
  const haystack = `${parsed.quotaIds.join(" ")} ${parsed.text}`;
  if (/PerDay|per day|daily/i.test(haystack)) return "day";
  if (parsed.quotaValues.some((value) => value === "0") || /limit:\s*0\b/i.test(parsed.text)) return "day";
  if (/PerMinute|per minute/i.test(haystack)) return "minute";
  return "unknown";
}

const KEY_PROBLEM = /API key not valid|API_KEY_INVALID|API key expired|API_KEY_EXPIRED|valid API key/i;
const REGION_PROBLEM = /location is not supported|free tier is not available/i;
const NETWORK_PROBLEM = /fetch failed|failed to fetch|network|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket|terminated|load failed|connection error|timed out/i;

export function classifyError(error: unknown, signal?: AbortSignal): ErrorInfo {
  if (signal?.aborted || isAbortError(error)) return { kind: "aborted" };
  if (asRecord(error)?.timedOut === true) return { kind: "slow" };

  const parsed = parseApiError(error);
  const { status } = parsed;

  if (status === undefined) {
    if (NETWORK_PROBLEM.test(parsed.message)) return { kind: "network" };
    return { kind: "unexpected", message: parsed.message || "Unknown error" };
  }

  const text = `${parsed.text} ${parsed.reasons.join(" ")}`;
  if (status === 401) return { kind: "invalid-key" };
  if (REGION_PROBLEM.test(text) || parsed.apiStatus === "FAILED_PRECONDITION") return { kind: "region" };
  if (status === 403) return { kind: "invalid-key" };
  if (status === 400) {
    return KEY_PROBLEM.test(text) ? { kind: "invalid-key" } : { kind: "unexpected", message: parsed.message };
  }
  if (status === 404) return { kind: "model-missing" };
  if (status === 429) {
    return { kind: "quota", scope: quotaScope(parsed), retryAfterMs: parsed.retryDelayMs };
  }
  if (status === 408 || status >= 500) return { kind: "server" };
  return { kind: "unexpected", message: parsed.message };
}

function pacificParts(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const parts = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

export function nextMidnightPacific(from: Date): Date {
  const local = pacificParts(from);
  for (const utcHour of [8, 7]) {
    const candidate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1, utcHour));
    const check = pacificParts(candidate);
    if (check.hour === 0 && check.minute === 0) return candidate;
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

type ExhaustedRecord = Record<string, string>;

async function readExhausted(store: KVStore, now: Date): Promise<ExhaustedRecord> {
  const stored = asRecord(await store.get<unknown>(STORAGE_KEYS.quotaExhausted));
  const live: ExhaustedRecord = {};
  if (!stored) return live;
  for (const [model, until] of Object.entries(stored)) {
    if (typeof until === "string" && Date.parse(until) > now.getTime()) live[model] = until;
  }
  return live;
}

export async function loadExhaustedModels(store: KVStore, now: Date): Promise<Set<string>> {
  return new Set(Object.keys(await readExhausted(store, now)));
}

export async function markModelExhausted(store: KVStore, model: string, now: Date): Promise<void> {
  const live = await readExhausted(store, now);
  live[model] = nextMidnightPacific(now).toISOString();
  await store.set(STORAGE_KEYS.quotaExhausted, live);
}
