# Progress: free Google Gemini engine

Branch: `gemini-free`. Goal: replace Claude Managed Agents with Google's free Gemini API tier, at zero cost and with no loss of features.

## Why the design changed

The free tier has small, unpublished request quotas (third-party reports go as low as ~20 requests/day per model). A chatty agent loop would burn that in one build. So the build is now a fixed pipeline of **2 model requests per build** (3 when a repair pass is needed), with no hosted sandbox:

1. **history**: `bridge.getHistory`, blocked sites removed, `buildHistoryDigest` (unchanged).
2. **pick** (request 1): history digest + user instructions -> JSON `{ urls: string[] }` (max 8) via the Interactions API (`response_format` with `mime_type: "application/json"` and a JSON `schema`). URLs are validated (absolute http/https, `isAllowedUrl` against the blocklist, host must belong to a digest domain, deduped, capped at 8). If nothing usable comes back, the top digest domains are used as `https://<domain>/`.
3. **scrape**: `bridge.getPageHtml`; pages that redirect onto a blocked host are dropped before anything is sent.
4. **compact**: each page's sanitized HTML -> compact text with absolute links and image URLs kept (pure string code, no DOM: the MV3 service worker has no `DOMParser`). Per-page and total character caps keep one request under free-tier tokens-per-minute.
5. **write** (request 2, streamed): one prompt with date, time of day, user instructions, digest and compacted pages -> the TSX component.
6. **check**: structural contract + host-supplied syntax check + every `http(s)` href/src must come from the scraped pages. Failures trigger one repair request (request 3) with the error list. Structural/syntax failure after repair is an error; leftover unverified links after repair are logged, not fatal.

Transport: the Interactions API (`ai.interactions.create`, POST `/v1beta/interactions`), not `generateContent`, which returns 404 NOT_FOUND for new users. Every request sends `store: false` (nothing is kept on Google's side), `system_instruction`, `input`, `generation_config.max_output_tokens`, and for the pick step `response_format`; the write step uses `stream: true`. The SDK's own retries are switched off (`retries: { strategy: "none" }`) so quota is spent only by our own, counted retries. Output text is the concatenated `text` parts of the `model_output` steps (thought steps are skipped). A stream is cut off after 120 s without a chunk and a JSON request after 90 s.

Free-only guarantees: only free-tier model IDs are offered (`gemini-3.8-flash` default, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`); no paid features (no Search grounding, no image generation). A key from a Google AI Studio project with **no billing account** cannot be charged; over-quota requests are refused (HTTP 429), never billed.

Quota handling: errors are classified by HTTP status first, then by message text and `google.rpc` details (`QuotaFailure.quotaId`, `RetryInfo.retryDelay`, `Retry-After`). 429 per-minute -> wait the server's retry delay (capped at 60 s, at most 2 waits) and retry the same model, then move to the next model without marking it; 429 per-day, or `limit: 0` (model not on the free tier) -> mark that model exhausted until next midnight Pacific and fall through to the next free model; an unclassifiable 429 that keeps failing is treated as per-day. 500/503/504 and network drops -> two short backoff retries, then next model, never marked exhausted (503 "high demand" is common on `gemini-3.8-flash`). 404 for a model -> skip to the next model, not marked. All exhausted -> clear "free daily limit used up" error. 400 "API key not valid", 401, 403 -> "Google didn't accept this key" message. A model that was unavailable earlier in a build is tried last for the rest of that build.

Resume: a checkpoint (`STORAGE_KEYS.buildCheckpoint`) is saved after pick and after scrape, so a worker killed mid-build resumes without repeating finished requests or page loads. It is cleared in `finally` (success, error or cancel).

## Contract between engine and extension

`@homepage/agent-core` exports (in addition to the unchanged `types` bridge/KV types, `history-digest`, `site-filter`, `DEFAULTS`):

```ts
export const MODEL_CHOICES: readonly { id: string; label: string }[]; // gemini-3.8-flash (default), gemini-3.6-flash, gemini-3.5-flash-lite, gemini-3.1-flash-lite
export type HomepageModel = (typeof MODEL_CHOICES)[number]["id"];
export const DEFAULT_MODEL: HomepageModel;
export const STORAGE_KEYS: { apiKey: "apiKey"; buildCheckpoint: "buildCheckpoint"; quotaExhausted: "quotaExhausted" };
export function isLikelyGeminiKey(key: string): boolean; // trims, then accepts "AIza" + 30-50 key chars, or "AQ." + 20-120 chars of [A-Za-z0-9._-]

export type RunPhase = "setup" | "history" | "thinking" | "scraping" | "analyzing" | "writing" | "cleanup" | "done" | "error";

export interface RunOptions {
  apiKey: string;
  bridge: BrowserBridge;
  store: KVStore;
  userSystemPrompt?: string;
  blockedSites?: string[] | (() => Promise<string[]>);
  model?: HomepageModel;
  callbacks?: RunCallbacks;        // onPhase, onText (short human progress lines), onLog
  signal?: AbortSignal;
  resume?: boolean;                // continue from STORAGE_KEYS.buildCheckpoint if present
  now?: Date;
  /** Host syntax check; returns an error message or null. Extension and harness pass a sucrase transform. */
  checkSyntax?: (code: string) => string | null;
  /** Test seam; defaults to the real Gemini client built from apiKey. */
  llm?: LlmClient;
}
export interface HomepageBuildResult { code: string; model: string; repaired: boolean; }
export function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult>;
```

### Additions beyond the contract (all additive)

- `GeminiError` (`.code`: `invalid-key | region | daily-limit | rate-limit | unavailable | network | unexpected`) carries a plain-English `.message` that is safe to show as is. Other failures are plain `Error`s with readable messages (for example `NO_PAGES_MESSAGE`, `NO_HISTORY_MESSAGE`).
- Cancelling rejects with an `Error` whose `name` is `"AbortError"` and message `"Build cancelled."` (`isAbortError(err)` helper). The old engine threw `"aborted"`.
- `onText` lines are short sentences that each end with `"\n"` ("Picked 7 pages.", "Read 6 pages, 1 could not be loaded.", "Writing your homepage...", "Checking the result and fixing a few details...").
- `isHomepageModel(id)` and `modelOrder(preferred)` helpers; an unknown stored model id (for example an old Claude id) falls back to `DEFAULT_MODEL`.
- `discardStaleCheckpoint(store, now?)`: removes a leftover checkpoint that is older than 30 minutes or damaged. The checkpoint holds page text, so the extension should call it on startup. `parseCheckpoint`, `BuildCheckpoint`, `CHECKPOINT_MAX_AGE_MS` are exported too.
- Removed: `setup.ts` (agent/environment code), `OUTPUT_PATH`, the custom tool schemas, `PageRef`, `GetPageHtmlResult`, `HomepageBuildResult.sessionId/source`, the `"session-create"` phase, `RunOptions.client` and `resumeSessionId`. `ScrapedPage`, `BrowserBridge`, `KVStore`, `DEFAULTS` are unchanged (`DEFAULTS` is not extended; `MAX_PAGES = 8` is a separate export).
- `LlmClient` (`generateJson`, `generateText`), `createGeminiClient`, `runWithFallback`, `classifyError`, `parseApiError`, `nextMidnightPacific`, `compactPage(s)`, `validateHomepage`, `parsePickedUrls` are exported for tests and hosts.

## Ownership

- Engine (agent-core, harness except `test-extension.ts`, root scripts, `.env.example`): subagent A.
- Extension (apps/extension, `harness/test-extension.ts`, README, ARCHITECTURE): subagent B.
- Integration, typecheck, tests, build, review: orchestrator.

## Status

- [x] Branch, dependencies swapped (`@google/genai@2.24.0` in agent-core; Anthropic SDK removed everywhere)
- [x] Engine (agent-core, harness scripts and tests, root scripts, `.env.example`, `.gitignore`). Typecheck clean; 186 unit tests green under a Node shim of `bun:test` because Bun is not installed on this machine. Request shape and stream parsing were checked against the real SDK with a stubbed `fetch`; no real Gemini call was made.
- [x] Extension
- [x] Integration: workspace typecheck clean, 186 unit tests green (Node shim, Bun not installed), build clean, headless extension test passes. Page loader hardened: a per-page deadline (75 s), extraction after a load timeout, bounded scrolling, so a stuck page fails instead of hanging the build.
- [x] Live engine check with a real free key (2026-10-10): pick + write on gemini-3.8-flash, 74 s, output renders with 37 real links. Paid-only probe answered `limit: 0 on Free Tier`, so the key's project has no billing.
- [x] Page reading in real Chrome (2026-10-10): the user's first build read LinkedIn, Instagram and X and produced a homepage.
- [x] Slow models: a request that times out skips straight to the next model instead of being retried on the same one; the JSON request's idle limit is 60 s; the log names each model as it is asked.
- [x] Design pass (2026-10-10): calm light design rules in the write prompt (no emoji, one accent, at most five sections, no widgets), emoji stripped from generated code before validation, extension controls moved into a slim toolbar above the page, Sandpack's own buttons hidden.
- [x] Design rules confirmed on the user's real build (2026-10-10).
- [x] Links open in the browser tab instead of inside the preview frame (sites like x.com refuse to be framed): the preview posts the clicked URL to the extension page, which navigates; Cmd, Ctrl, Shift or middle click opens a background tab. Verified headlessly.
- [x] Picture-rich layout rules: the lead story carries the largest picture, other items show thumbnails or picture cards, every item shows its source.
- [x] Picture layout confirmed on the user's real build.
- [x] News sources (2026-10-10): a "News sites it reads on every build" list in Settings (17 defaults across tech, politics, Barcelona and religion, max 24) is always read; history picks are capped at 5 and form a short personal section. The writer is told which pages are news and which are personal, picks the lead story from the news by real-world importance, and merges duplicate stories. Five tabs load at once; the total text budget is 320k characters.
- [x] Lead story from the news confirmed on the user's real build.
- [x] Pictures (2026-10-10): the page cleaner was deleting every link or box that held only a picture (sanitize-html exclusiveFilter), so news pages kept 0 to 1 images; now 36 to 40 on Guardian and BBC. Menus, footers and forms are dropped instead. The page reader resolves srcset, picture sources and lazy data-src into the sharpest image around 800px wide, records rendered size so tracking pixels are dropped, and placeholders are filtered. The writer may only use a picture next to its own story.
- [ ] Confirm pictures on the user's next real build.
- [x] Quiet reading (2026-10-10): pages are first fetched by the service worker with the user's cookies, six at a time, and kept when they hold at least 2,500 characters of text and 15 links; only the rest open in tabs. In a Node probe 12 of the 17 default news sites qualified (Reuters, Politico, Ahram and WAFA did not, likely bot checks against the Node user agent). The tab window now opens minimized on about:blank instead of a normal window on the new tab page, which in macOS full screen came to the front. Compaction also resolves srcset, data-srcset and data-src for fetched HTML.
- [x] "Open tabs for sites that can't be read quietly" switch in Settings, off by default (2026-10-11): with it off, pages that fail the quiet fetch are listed as failed and no window or tab ever opens.
- [ ] With the switch on, confirm in real Chrome that the minimized window stays out of the way and its tabs still load and read.
