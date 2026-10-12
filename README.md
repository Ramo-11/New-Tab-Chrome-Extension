# AI Homepage

**A new tab that reads the internet for you.**

AI Homepage replaces Chrome's new-tab page with one that's written for you. It
looks at what you've actually been browsing, opens the pages you follow (signed
in as you), and has Google's Gemini write a fresh homepage from what it finds
there. It rebuilds itself in the background, so each new tab is up to date. It
runs on Google's free Gemini tier, so it costs nothing.

![An example homepage in a morning-newspaper style](docs/preview.png)
<sub>Illustration. Your homepage is built from your own browsing, so its stories will be different.</sub>

A morning newspaper is just one look. You can describe any look and the next build
follows it: a quiet one-column digest, a dense dashboard, a green-on-black
terminal, a zine.

> **Privacy, up front.** To build your homepage, the extension sends a summary of
> your browsing history (top domains, visit counts, a few page titles) and the
> cleaned-up text and links of up to 8 pages to Google's Gemini API (Interactions
> endpoint), using your own API key. Those pages are loaded in your signed-in
> browser, so they can include private content. The requests are marked not to be
> stored, but **on Google's free plan, Google may still use what it receives to
> improve its products.** The "Sites the agent never reads" list in Settings keeps
> sites out of every build. Your API key stays in the extension's local storage.
> More detail in [ARCHITECTURE.md](./ARCHITECTURE.md#privacy).

---

## Install

You need Chrome (or another Chromium browser), [Node.js](https://nodejs.org) 20+,
and a free Google API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
git clone https://github.com/ThariqS/ai-newtab.git
cd ai-newtab
npx pnpm@10.11.1 install
npx pnpm@10.11.1 build
```

(If you already have [pnpm](https://pnpm.io), plain `pnpm install && pnpm build` works too.)

Then load it into Chrome:

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `apps/extension/.output/chrome-mv3`.

If Chrome asks whether to keep the changed new-tab page, choose **Keep it**.

## Your first homepage

1. Open [aistudio.google.com/apikey](https://aistudio.google.com/apikey), sign in
   with your Google account, and click **Create API key**. If it asks for a
   project, let it create a new one. **Never add billing to that project.** The
   key is free only while the project has no billing, and that is also what makes
   a charge impossible.
2. Open a new tab and paste the key.
3. Click **Build today's homepage**.
4. Watch it work. The progress view walks through each step: getting ready,
   reading your history, choosing pages, opening pages in your browser, reading
   the pages, and writing your homepage.

The first build can take a few minutes, longer if Google asks it to wait out a
rate limit. You can close the tab while it runs, since the build lives in the
extension's background worker and appears in any new tab you open.

## Make it yours

Click **⚙️ Settings** on the new tab. Before your first build, the **Settings**
button next to **Build today's homepage** opens the same panel.

**Instructions.** Anything you write here goes into every build and takes priority
over the built-in defaults. This box sets both the content and the look:

| You write | You get |
| --- | --- |
| *"A morning newspaper. Serif type, a big masthead, a lead story, a column of briefs."* | A broadsheet front page |
| *"One calm column. No images. Five things worth reading, with one line on why."* | A quiet reading list |
| *"Dense dashboard: GitHub PRs and issues first, then Hacker News, then everything else."* | A work cockpit |
| *"Green-on-black terminal, monospace, like a 1980s BBS."* | Exactly that |
| *"Skip sports and politics. Always show the weather and my next three calendar events."* | Your rules, every day |

Click **Save & rebuild** to apply them right away.

**Sites the agent never reads.** Enter one host per line; subdomains are included,
and `*.example.com` is supported. The editable defaults include common webmail,
sign-in and document hosts. **Save & rebuild** saves the list and applies it to
history summaries and to the pages the build opens. A page that redirects onto a
blocked host is dropped before anything from it is sent to Google. Local-network
addresses (localhost, private IPs, `.local` and `.internal` hosts) are always blocked.

**Model.** Choose which Gemini model writes your page. All four are free:

- **Gemini 3.8 Flash** (default)
- **Gemini 3.6 Flash**
- **Gemini 3.5 Flash-Lite**
- **Gemini 3.1 Flash-Lite**

The model you pick is tried first. If it runs out of free uses for the day, the
build automatically uses the next one down this list. The new choice takes effect
from your next build.

**API key.** Paste a new Google API key in the **Replace your Google API key**
field to swap it. It's checked for the right format before it's saved.

**Rebuild automatically.** On by default. Once your homepage is older than the
interval you pick (6, 12, 24 or 48 hours), the extension rebuilds it quietly in the
background. It only starts after you've built once by hand, and it won't retry a
failed build until the next interval, so it never loops.

**↻ Rebuild** in the top-right corner rebuilds right away.

## Good to know

- **Cost.** Nothing, as long as the key comes from a Google project with no
  billing turned on. Google gives the free tier a small daily allowance for each
  model, and the numbers can change. A build uses two requests, three when the
  result needs a repair pass. If a model's allowance for the day is gone, the
  build moves on to the next free model. If every model is used up, the build
  stops with a clear message, and you can try again after the limits reset
  (midnight Pacific time). Per-minute limits are handled by waiting a few seconds
  and retrying. Automatic rebuilds draw from the same allowance, so turn them off
  if you'd rather save it for builds you start yourself.
- **What it can see.** It ranks the sites in your history and opens up to 8 of
  them per build. It skips search engines, webmail, banking and logged-out
  marketing pages. Anything it can't open is reported, not hidden.
- **Links are real.** Every web address written into the page should come from a
  page the build actually read. The result is checked, and anything that doesn't
  match is sent back for one repair pass.
- **Interrupted builds.** If Chrome closes mid-build, the extension picks up where
  it stopped, without repeating the work it already finished. The new tab also
  offers **Resume interrupted build**.
- **Updating.** After pulling new code, run `npx pnpm@10.11.1 build` again, then
  click the reload icon on the extension in `chrome://extensions`.

## How it works

A build is a short, fixed pipeline with no chat loop, which keeps it inside the
free tier:

1. **History.** The extension reads `chrome.history`, drops blocked sites, and
   boils it down to a ranked summary of your most-visited domains.
2. **Request 1: pick pages.** Gemini gets the summary and your instructions and
   returns up to 8 page URLs as JSON. Each URL is checked: web addresses only,
   not on the blocked list, no duplicates.
3. **Open the pages.** The extension loads them in a background window, in your
   signed-in browser, and cleans up the HTML.
4. **Squeeze them down.** Each page becomes compact text that keeps its links and
   image addresses, trimmed so one request fits comfortably in the free tier.
5. **Request 2: write the homepage.** Gemini gets the date, the time of day, your
   instructions, the history summary and the compacted pages, and streams back one
   React component.
6. **Check it.** The result must have the expected shape, compile, and use only
   links and images that came from the pages. If not, one repair request (the
   third) fixes it. The new tab renders the result.

The extension's background worker runs all of this, with no server in between.
Saved progress after steps 2 and 3 lets an interrupted build resume. There is no
code sandbox and no tool use: scraped pages are untrusted input, and they only
ever reach the model as text.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the flow, the layout, and the
gotchas worth knowing.

## Development

```
packages/agent-core   the build pipeline: host-agnostic, no chrome.* or node:*
apps/extension        the MV3 extension (WXT + React)
harness               Bun scripts that run agent-core outside Chrome, and test the built extension
```

```bash
pnpm dev                 # WXT with hot reload
pnpm typecheck           # all packages
pnpm test                # unit tests (no API calls; needs Bun)
pnpm extension:test      # loads the built extension into headless Chrome (no API calls)

cp .env.example .env     # add GEMINI_API_KEY, then:
pnpm agent:run           # a full build against the real API, with fixture history
pnpm agent:verify        # check the output actually renders
```

## Status

Early and experimental. It's a tool you run yourself with your own key. Don't
publish it to a store as-is: anyone with access to the browser profile can read
the stored API key.

## License

MIT
