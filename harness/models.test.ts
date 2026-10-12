import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL,
  MODEL_CHOICES,
  STORAGE_KEYS,
  isHomepageModel,
  isLikelyGeminiKey,
  modelOrder,
} from "@homepage/agent-core";

describe("model choices", () => {
  test("offers only the free Gemini models, default first", () => {
    expect(MODEL_CHOICES.map((choice) => choice.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
    ]);
    expect(MODEL_CHOICES.map((choice) => choice.label)).toEqual([
      "Gemini 3.8 Flash",
      "Gemini 3.6 Flash",
      "Gemini 3.5 Flash-Lite",
      "Gemini 3.1 Flash-Lite",
    ]);
    expect(DEFAULT_MODEL).toBe(MODEL_CHOICES[0].id);
  });

  test("exposes the storage keys the extension shares", () => {
    expect(STORAGE_KEYS).toEqual({
      apiKey: "apiKey",
      buildCheckpoint: "buildCheckpoint",
      quotaExhausted: "quotaExhausted",
    });
  });

  test("puts the chosen model first and keeps the rest in list order", () => {
    expect(modelOrder("gemini-3.5-flash-lite")).toEqual([
      "gemini-3.5-flash-lite",
      "gemini-3.8-flash",
      "gemini-3.6-flash",
      "gemini-3.1-flash-lite",
    ]);
  });

  test("falls back to the default for an unknown or stale model id", () => {
    expect(modelOrder("claude-sonnet-5-5")[0]).toBe(DEFAULT_MODEL);
    expect(modelOrder(undefined)[0]).toBe(DEFAULT_MODEL);
    expect(isHomepageModel("claude-sonnet-5-5")).toBe(false);
    expect(isHomepageModel("gemini-3.6-flash")).toBe(true);
  });
});

describe("isLikelyGeminiKey", () => {
  const classic = `AIza${"Sy".repeat(17)}x`;
  const aq = "AQ.Ab8RN6K3dJ1xP0qLm2Zr5Tt9WvUe7Yc4HgFs_Bn-XyA1";

  test("accepts the classic AIza key", () => {
    expect(classic).toHaveLength(39);
    expect(isLikelyGeminiKey(classic)).toBe(true);
  });

  test("accepts the newer AQ. key", () => {
    expect(isLikelyGeminiKey(aq)).toBe(true);
    expect(isLikelyGeminiKey("AQ.Ab8RN6K3dJ1xP0qLm2Zr5Tt9WvUe7Yc4HgFs_Bn-XyA1.part-2")).toBe(true);
  });

  test("trims surrounding whitespace", () => {
    expect(isLikelyGeminiKey(`  ${classic}\n`)).toBe(true);
    expect(isLikelyGeminiKey(`\t${aq} `)).toBe(true);
  });

  test("rejects other providers and malformed values", () => {
    expect(isLikelyGeminiKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(isLikelyGeminiKey("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(isLikelyGeminiKey("")).toBe(false);
    expect(isLikelyGeminiKey("AIza")).toBe(false);
    expect(isLikelyGeminiKey("AIzaShort")).toBe(false);
    expect(isLikelyGeminiKey("AQ.short")).toBe(false);
    expect(isLikelyGeminiKey(`${classic} ${classic}`)).toBe(false);
    expect(isLikelyGeminiKey(`aiza${classic.slice(4)}`)).toBe(false);
    expect(isLikelyGeminiKey(`AIza${"!".repeat(35)}`)).toBe(false);
  });
});
