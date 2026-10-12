# Architecture

There is no server. Two parties are involved, and you run one of them.

| | Runs where | Does what |
|---|---|---|
| **Extension** (service worker) | Your browser | Hosts the build: reads history, loads and cleans the pages, makes the Gemini requests, checks the result, persists the homepage |
| **Extension** (new-tab page(s)) | Your browser | Thin view: subscribes to the worker over a port, renders live progress and the finished homepage |
| **Gemini API** (Interactions endpoint) | Google | Answers two requests per build, three when a repair pass is needed. No tools, no sandbox, nothing kept between requests: each one is sent with `store: false` |

The build runs **in the service worker** (`apps/extension/lib/build-manager.ts` hosts
`runHomepageBuild` from `packages/agent-core`), so a build survives closing the tab, shows
up in every open tab, and can run headless on a `chrome.alarms` schedule. The history and
page-loading steps run in the extension because they need `chrome.history` and
`chrome.tabs`. The model never calls them and has no tools at all: the extension decides
what to read, and the model only ever receives text. There is no inbound connection and no
public endpoint.

## Why a fixed pipeline

Google's free tier has small request quotas, and they are not published in one place.
An agent that chats back and forth with tools would spend a whole day's allowance on a
single build. So a build is a fixed pipeline of **2 model requests, 3 when a repair pass
is needed**, and everything between the requests is plain code in the extension.

```
service worker                                   Gemini API
     |                                               |
     |  chrome.history -> ranked digest              |
     |  blocked sites removed                        |
     |                                               |
     |-- request 1: pick pages (JSON) -------------->|
     |<-- { urls: [up to 8] } -----------------------|
     |  validate the URLs, save a checkpoint         |
     |                                               |
     |  tabs + scripting: load each page             |
     |  drop redirects onto blocked hosts            |
     |  clean the HTML, compact it to text + links   |
     |  save a checkpoint                            |
     |                                               |
     |-- request 2: write the homepage (streamed) -->|
     |<-- one TSX component -------------------------|
     |  check: shape, syntax, links                  |
     |                                               |
     |-- request 3: repair, only if the check fails ->|
     |<-- fixed TSX ---------------------------------|
     |                                               |
     |  save the homepage, clear the checkpoint      |
```

1. **History.** `BrowserBridge.getHistory` returns raw per-domain history. Blocked sites are
   removed, then `buildHistoryDigest` ranks and caps it.
2. **Pick (request 1).** The digest and the user's instructions go out; Gemini answers with
   JSON `{ "urls": [...] }`, at most 8. The answer is re-validated in code: web addresses
   only, not blocked, on a site that is in the digest, deduplicated. If nothing usable
   comes back, the build falls back to the top sites in the digest.
3. **Load.** `BrowserBridge.getPageHtml` opens the URLs in a background window of the
   signed-in browser. Pages that redirected onto a blocked host are dropped.
4. **Compact.** Each page's sanitized HTML becomes compact text with absolute links and
   image URLs kept. This is pure string code because an MV3 service worker has no
   `DOMParser`. Per-page and total character caps keep a request under the free tier's
   tokens-per-minute limit.
5. **Write (request 2).** One prompt with the date, the time of day, the user's
   instructions, the digest and the compacted pages. The reply is streamed and is the
   TSX component itself.
6. **Check.** The file must default-export `PersonalizedHomepage`, import only `react`,
   compile (the extension passes a sucrase transform as `checkSyntax`), and not be cut off.
   Every `http(s)` address written into it should also appear in the loaded pages. Any
   problem triggers one repair request that lists the problems. A structural or syntax
   failure that survives the repair is an error; links that still can't be matched are
   only logged.

### Keeping the worker alive

An MV3 service worker is torn down after ~30s idle, and a build spends most of its wall
clock waiting on the model. Three things keep it alive or bring it back:

- **During a build**, the in-flight request to Google plus a 20s self-ping
  (`runtime.getPlatformInfo`) reset the idle timer.
- **A 1-minute alarm heartbeat** calls `BuildManager.tick()`. If a fresh
  `buildCheckpoint` is in storage (under 30 minutes old) and there is a valid key, the
  worker resumes: the build skips the requests and page loads that already finished. A
  stale checkpoint is deleted.
- **The same heartbeat** drives scheduled rebuilds (`lib/auto-rebuild.ts`), so the
  first new tab of the day already shows a fresh homepage.

The checkpoint is saved after request 1 (digest and chosen URLs) and after the pages are
loaded and compacted. `runHomepageBuild` clears it in a `finally`, so only a killed worker
leaves one behind. Success, an error and a cancel all remove it.

### Tabs are views

Each new tab connects on a port (`lib/protocol.ts`), receives a snapshot of the
build state, then streams phase/text/log deltas. Every open tab shows the same live
run. A throttled snapshot is also mirrored to storage so a tab opened while the
worker is asleep paints instantly.

The finished component renders inside a Sandpack iframe
(`entrypoints/newtab/components/HomepagePreview.tsx`): it is model-written code, so
it runs sandboxed, not in the extension's own page.

## Free tier and quotas

Only free-tier model IDs are offered (`MODEL_CHOICES` in `packages/agent-core/models.ts`,
first is the default), and no paid feature is used: no Search grounding, no image
generation. A key from a Google AI Studio project with **no billing account** cannot be
charged. Over-quota requests are refused with HTTP 429, never billed.

`runWithFallback` (`fallback.ts`) wraps every request:

| Response | What happens |
|---|---|
| 429, per-minute | Wait the server's `retryDelay` (clamped to 1 to 60 seconds, 15 if none) and retry, at most twice. If it still fails, move to the next model without marking this one |
| 429, per-day (or a limit of zero) | Record the model in `quotaExhausted` until the next midnight Pacific, then move to the next model. Later builds skip that model until then |
| 429, unclear after the waits | Treated as per-day |
| 5xx or overloaded | Retry after 2s and 6s, then move to the next model and try that one last for the rest of the build |
| Model not found (404) | Move to the next model |
| Network error | Retry after 1s and 3s, then stop with a connection message |
| Invalid key or unsupported region | Stop with a plain message |

The model the user picked is tried first and the rest follow in list order. When every
model is used up, the build stops with "free daily limit used up", and the existing
homepage stays. A stalled stream is cut off after 90s (JSON) or 120s (text) with no data.

## Layout

```
packages/agent-core/      host-agnostic build pipeline: imports no chrome.*, browser.*, or node:*
  orchestrator.ts         runHomepageBuild: the pipeline, checkpoints, the repair pass
  gemini.ts               Gemini client over the Interactions API: a JSON request and a streamed text request
  fallback.ts             runWithFallback: model fallback, rate-limit waits, backoff
  quota.ts                API error classification, the per-day exhaustion record
  errors.ts               user-facing error messages, abort helpers
  models.ts               MODEL_CHOICES, DEFAULT_MODEL, storage keys, key format check
  pick.ts                 validate the URLs Gemini chose, fall back to the top sites
  page-compact.ts         sanitized HTML -> compact text with absolute links, no DOM
  prompt.ts               system prompts and the messages for pick, write and repair
  validate.ts             structure, syntax and link checks; code fence stripping
  schemas.ts              defaults and the JSON schema for request 1
  history-digest.ts       narrows raw history to a ranked, capped digest
  site-filter.ts          the blocked-sites list and URL checks
  types.ts                BrowserBridge, KVStore, RunPhase, ...

apps/extension/           MV3 extension (WXT + React)
  entrypoints/
    background.ts         service worker: hosts BuildManager, alarm heartbeat
    scraper.content.ts    injected into scraped tabs: scroll, return HTML
    newtab/               the new-tab UI (thin client onto the worker)
  lib/
    build-manager.ts      single-flight build host, broadcast, keepalive, resume
    browser-bridge.ts     BrowserBridge over chrome.history / chrome.tabs
    history.ts            getHistory: group and rank chrome.history by domain
    scraper.ts            getPageHtml: load URLs in a background window, sanitize HTML
    protocol.ts           page <-> worker messages and the six UI build steps
    auto-rebuild.ts       when to rebuild on a schedule
    storage.ts            every chrome.storage key, settings, saved homepage
    transpile.ts          TSX -> JS for the preview, and the syntax check for builds

harness/                  Bun scripts: run the pipeline outside Chrome, test the extension
```

## Verification

| Command | Proves |
|---|---|
| `pnpm test` | The history digest and the site filter behave, plus the pipeline's own unit tests with a fake model (no network) |
| `pnpm agent:run` | A full build against the real Gemini API with fixture history |
| `pnpm agent:verify` | The deliverable transforms, evaluates and server-renders |
| `pnpm extension:test` | In headless Chrome: worker registers, new tab renders the key screen and rejects a bad key inline, port protocol answers, `chrome.history` reads |

`agent:run` needs `GEMINI_API_KEY` in `.env` (from a project with no billing) and uses
some of the free daily allowance. The harness's bridge uses fixture history and a plain
`fetch`, so it can't see logged-in pages. That is the whole reason page loading runs in
your browser.

## Gotchas worth knowing

**Send `store: false` on every request.** The Interactions API stores requests by
default. The client sets it so Google does not keep them as saved interactions.

**Read only `model_output` steps.** The reply can contain other step types (thinking,
for example). Only text from `model_output` steps is the answer.

**A 429 doesn't say which limit you hit.** The engine reads the `quotaId` in the error
details: `PerDay` means the day's allowance is gone, `PerMinute` means wait. A limit of
zero counts as daily.

**The daily reset is midnight Pacific time, not local midnight.** The next reset is worked
out with `Intl` so daylight saving time is handled.

**The schema can't enforce "from the digest".** Request 1 asks for JSON with a schema, but
the schema only says "up to 8 strings". Every URL is still checked in code afterwards.

**A stream that ends early is not an error.** If the final status isn't `completed`, the
text is marked truncated and goes straight to the repair request.

**No `DOMParser` in a service worker.** Anything that touches page HTML before the
request has to be string processing, which is why `page-compact.ts` exists.

**Model fallback is per request.** A daily limit hit during request 2 does not redo
request 1. The write request just moves to the next model.

## Privacy

Each build sends Google:

- **Request 1:** your standing instructions, today's date and the time of day, and the
  history digest: domains, visit counts, last-visit dates and a few page titles.
- **Requests 2 and 3:** the same, plus the compacted text and links of up to 8 pages. Those
  pages are loaded in your signed-in browser, so they can include private content such as
  a logged-in feed or dashboard.

The extension sends `store: false` so Google does not keep the requests as stored
interactions. **On the free plan, Google may still use what it receives to improve its
products.** Confirm Google's current terms for the Gemini API's free tier before relying on
any other assumption. Turning on billing for the project would change those terms, but it
also removes the guarantee that a key can't be charged, so this project is meant to be
used without it.

The editable blocked-sites list is enforced in code, not just the prompt. Blocked domains
are left out of the history digest and its counts. The URLs Gemini picks are checked
(web addresses only, not blocked, on a site in the digest) before the browser bridge ever
sees them. Each loaded page's final URL is checked again before anything is compacted or
sent, so a redirect onto a blocked host is dropped: the browser still loads it, but
nothing it read is sent. Loopback, private-IP and local-network hosts are always blocked,
whatever the list says. Subresource loads are not intercepted.

The API key lives in `chrome.storage.local`, readable by anyone with access to the
browser profile, and is sent only to Google. Fine for a tool you run yourself; **do not
ship this to the Web Store** without moving the key behind a proxy.
