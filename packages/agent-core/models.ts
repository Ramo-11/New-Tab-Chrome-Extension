export const MODEL_CHOICES = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
] as const;

export type HomepageModel = (typeof MODEL_CHOICES)[number]["id"];

export const DEFAULT_MODEL: HomepageModel = "gemini-3.8-flash";

export const STORAGE_KEYS = {
  apiKey: "apiKey",
  buildCheckpoint: "buildCheckpoint",
  quotaExhausted: "quotaExhausted",
} as const;

export function isHomepageModel(id: unknown): id is HomepageModel {
  return MODEL_CHOICES.some((choice) => choice.id === id);
}

export function modelOrder(preferred: unknown): HomepageModel[] {
  const first = isHomepageModel(preferred) ? preferred : DEFAULT_MODEL;
  return [first, ...MODEL_CHOICES.map((choice) => choice.id).filter((id) => id !== first)];
}

const CLASSIC_KEY = /^AIza[0-9A-Za-z_-]{30,50}$/;
const AQ_KEY = /^AQ\.[0-9A-Za-z._-]{20,120}$/;

export function isLikelyGeminiKey(key: string): boolean {
  const value = key.trim();
  return CLASSIC_KEY.test(value) || AQ_KEY.test(value);
}
