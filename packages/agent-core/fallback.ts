import { GeminiError, MESSAGES, sleep, throwIfAborted } from "./errors";
import { modelOrder } from "./models";
import { classifyError, loadExhaustedModels, markModelExhausted } from "./quota";
import type { KVStore } from "./types";

export const MAX_RATE_WAITS = 2;
export const MAX_RATE_WAIT_MS = 60_000;
export const MIN_RATE_WAIT_MS = 1_000;
export const DEFAULT_RATE_WAIT_MS = 15_000;
export const SERVER_BACKOFF_MS = [2_000, 6_000] as const;
export const NETWORK_BACKOFF_MS = [1_000, 3_000] as const;

type SkipReason = "daily" | "rate" | "unavailable";

export interface FallbackOptions {
  store: KVStore;
  preferred: unknown;
  signal?: AbortSignal;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
  demoted?: Set<string>;
}

class ModelSkipped extends Error {
  readonly reason: SkipReason;

  constructor(reason: SkipReason) {
    super(`model skipped: ${reason}`);
    this.reason = reason;
  }
}

function exhaustedError(reasons: SkipReason[]): GeminiError {
  if (reasons.includes("rate")) return new GeminiError("rate-limit", MESSAGES.rateLimit);
  if (reasons.includes("unavailable")) return new GeminiError("unavailable", MESSAGES.unavailable);
  return new GeminiError("daily-limit", MESSAGES.dailyLimit);
}

function orderedCandidates(options: FallbackOptions): string[] {
  const order: string[] = modelOrder(options.preferred);
  const demoted = options.demoted;
  if (!demoted?.size) return order;
  return [...order.filter((id) => !demoted.has(id)), ...order.filter((id) => demoted.has(id))];
}

export async function runWithFallback<T>(
  options: FallbackOptions,
  call: (model: string) => Promise<T>,
): Promise<{ value: T; model: string }> {
  const now = options.now ?? (() => new Date());
  const wait = options.sleep ?? sleep;
  const log = options.log ?? (() => undefined);
  const { signal } = options;

  const exhausted = await loadExhaustedModels(options.store, now());
  const reasons: SkipReason[] = [];
  const candidates = orderedCandidates(options).filter((model) => {
    if (!exhausted.has(model)) return true;
    reasons.push("daily");
    log(`${model} skipped: free daily limit already used`);
    return false;
  });

  async function attempt(model: string): Promise<T> {
    let rateWaits = 0;
    let serverRetries = 0;
    let networkRetries = 0;
    log(`asking ${model}`);

    for (;;) {
      throwIfAborted(signal);
      try {
        return await call(model);
      } catch (error) {
        const info = classifyError(error, signal);
        switch (info.kind) {
          case "aborted":
            throwIfAborted(signal);
            throw error;
          case "invalid-key":
            throw new GeminiError("invalid-key", MESSAGES.invalidKey);
          case "region":
            throw new GeminiError("region", MESSAGES.region);
          case "quota": {
            if (info.scope === "day") {
              await markModelExhausted(options.store, model, now());
              throw new ModelSkipped("daily");
            }
            if (rateWaits < MAX_RATE_WAITS) {
              rateWaits += 1;
              const delay = Math.max(
                MIN_RATE_WAIT_MS,
                Math.min(info.retryAfterMs ?? DEFAULT_RATE_WAIT_MS, MAX_RATE_WAIT_MS),
              );
              log(`${model} rate limited, waiting ${Math.round(delay / 1000)}s`);
              await wait(delay, signal);
              continue;
            }
            if (info.scope === "unknown") {
              await markModelExhausted(options.store, model, now());
              throw new ModelSkipped("daily");
            }
            throw new ModelSkipped("rate");
          }
          case "server": {
            if (serverRetries < SERVER_BACKOFF_MS.length) {
              const delay = SERVER_BACKOFF_MS[serverRetries]!;
              serverRetries += 1;
              log(`${model} unavailable, retrying in ${Math.round(delay / 1000)}s`);
              await wait(delay, signal);
              continue;
            }
            throw new ModelSkipped("unavailable");
          }
          case "slow":
            log(`${model} is too slow right now, trying the next model`);
            throw new ModelSkipped("unavailable");
          case "model-missing":
            throw new ModelSkipped("unavailable");
          case "network": {
            if (networkRetries < NETWORK_BACKOFF_MS.length) {
              const delay = NETWORK_BACKOFF_MS[networkRetries]!;
              networkRetries += 1;
              await wait(delay, signal);
              continue;
            }
            throw new GeminiError("network", MESSAGES.network);
          }
          case "unexpected":
            throw new GeminiError("unexpected", `Google returned an error: ${info.message.slice(0, 300)}`);
        }
      }
    }
  }

  for (const model of candidates) {
    throwIfAborted(signal);
    try {
      const value = await attempt(model);
      return { value, model };
    } catch (error) {
      if (!(error instanceof ModelSkipped)) throw error;
      reasons.push(error.reason);
      if (error.reason === "unavailable") options.demoted?.add(model);
      log(`${model} skipped: ${error.reason}`);
    }
  }

  throw exhaustedError(reasons);
}
