import {
  DEFAULT_MODEL,
  DEFAULT_BLOCKED_SITES,
  DEFAULT_NEWS_SOURCES,
  MODEL_CHOICES,
  STORAGE_KEYS as AGENT_KEYS,
  isLikelyGeminiKey,
  parseCheckpoint,
  type HomepageModel,
  type KVStore,
} from "@homepage/agent-core";

/**
 * Everything the extension persists, in one place. All of it lives in
 * chrome.storage.local — including the API key, which anyone with access to the
 * browser profile can read. Fine for a tool you run yourself; not for one you
 * distribute (see ARCHITECTURE.md → Privacy).
 */
export const KEYS = {
  ...AGENT_KEYS,
  homepage: "homepageData",
  systemPrompt: "systemPrompt",
  blockedSites: "blockedSites",
  newsSources: "newsSources",
  model: "model",
  autoRebuild: "autoRebuild",
  openTabs: "openTabs",
  /** ISO timestamp of the last auto-build *attempted* (success or not). */
  lastAutoBuildAttempt: "lastAutoBuildAttempt",
  rebuildIntervalHours: "autoRebuildIntervalHours",
  /** Throttled mirror of the live build state, for tabs that open while the worker sleeps. */
  buildSnapshot: "buildSnapshot",
} as const;

export interface Homepage {
  /** The agent's raw TSX source. */
  code: string;
  /** ISO timestamp of when it was built. */
  timestamp: string;
}

export interface Settings {
  apiKey: string | null;
  systemPrompt: string;
  blockedSites: string[];
  newsSources: string[];
  model: HomepageModel;
  /** Unset means on — auto-rebuild is opt-out. */
  autoRebuild: boolean;
  openTabs: boolean;
  rebuildIntervalHours: number | null;
}

/** The `KVStore` agent-core persists its build checkpoint and quota state through. */
export const extensionStore: KVStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

export async function loadSettings(): Promise<Settings> {
  const s = await browser.storage.local.get([
    KEYS.apiKey,
    KEYS.systemPrompt,
    KEYS.blockedSites,
    KEYS.newsSources,
    KEYS.model,
    KEYS.autoRebuild,
    KEYS.openTabs,
    KEYS.rebuildIntervalHours,
  ]);
  const model = s[KEYS.model] as string | undefined;
  const rawKey = s[KEYS.apiKey];
  const storedKey = typeof rawKey === "string" ? rawKey.trim() : "";
  return {
    apiKey: isLikelyGeminiKey(storedKey) ? storedKey : null,
    systemPrompt: (s[KEYS.systemPrompt] as string | undefined) ?? "",
    blockedSites: (s[KEYS.blockedSites] as string[] | undefined) ?? [...DEFAULT_BLOCKED_SITES],
    newsSources: (s[KEYS.newsSources] as string[] | undefined) ?? [...DEFAULT_NEWS_SOURCES],
    // Fall back if a stored model is no longer offered.
    model: MODEL_CHOICES.find((m) => m.id === model)?.id ?? DEFAULT_MODEL,
    autoRebuild: s[KEYS.autoRebuild] !== false,
    openTabs: s[KEYS.openTabs] === true,
    rebuildIntervalHours: (s[KEYS.rebuildIntervalHours] as number | undefined) ?? null,
  };
}

export async function saveSetting<K extends "apiKey" | "systemPrompt" | "blockedSites" | "newsSources" | "model" | "autoRebuild" | "openTabs" | "rebuildIntervalHours">(
  key: K,
  value: Settings[K],
): Promise<void> {
  await browser.storage.local.set({ [KEYS[key]]: value });
}

export async function loadHomepage(): Promise<Homepage | undefined> {
  return extensionStore.get<Homepage>(KEYS.homepage);
}

export async function saveHomepage(code: string): Promise<void> {
  const homepage: Homepage = { code, timestamp: new Date().toISOString() };
  await extensionStore.set(KEYS.homepage, homepage);
}

export async function hasFreshCheckpoint(): Promise<boolean> {
  const stored = await extensionStore.get<unknown>(KEYS.buildCheckpoint);
  return parseCheckpoint(stored, new Date()) !== undefined;
}
