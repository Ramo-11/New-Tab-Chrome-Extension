export type GeminiErrorCode =
  | "invalid-key"
  | "region"
  | "daily-limit"
  | "rate-limit"
  | "unavailable"
  | "network"
  | "unexpected";

export class GeminiError extends Error {
  readonly code: GeminiErrorCode;

  constructor(code: GeminiErrorCode, message: string) {
    super(message);
    this.name = "GeminiError";
    this.code = code;
  }
}

export const MESSAGES = {
  invalidKey:
    "Google didn't accept this key. Create a new one at aistudio.google.com/apikey and paste it in Settings.",
  region:
    "Google's free tier isn't available where this key's project is located. Try a key from a different Google AI Studio project.",
  dailyLimit:
    "Google's free daily limit is used up for today. It resets at midnight Pacific time, and your current homepage stays until then.",
  rateLimit:
    "Google is limiting free requests right now. Wait a minute or two and try again. Your current homepage stays until then.",
  unavailable:
    "Google's servers are busy right now. Try again in a few minutes. Your current homepage stays until then.",
  network: "Couldn't reach Google. Check your internet connection and try again.",
  noKey: "Add your Google Gemini API key in Settings, then try again.",
  cancelled: "Build cancelled.",
} as const;

export function abortError(): Error {
  return Object.assign(new Error(MESSAGES.cancelled), { name: "AbortError" });
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
