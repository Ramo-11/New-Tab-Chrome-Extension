const MAX_SCROLL_STEPS = 15;
const SCROLL_PAUSE_MS = 400;
const TARGET_IMAGE_WIDTH = 800;
const LAZY_SRC_ATTRIBUTES = ["data-src", "data-lazy-src", "data-original", "data-url", "data-hi-res-src"];
const LAZY_SRCSET_ATTRIBUTES = ["data-srcset", "data-lazy-srcset"];

export default defineContentScript({
  registration: "runtime",
  main() {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const scrollPage = async () => {
      const step = Math.max(window.innerHeight * 0.8, 400);
      for (let i = 1; i <= MAX_SCROLL_STEPS; i++) {
        const target = step * i;
        if (target >= document.documentElement.scrollHeight) break;
        window.scrollTo(0, target);
        await pause(SCROLL_PAUSE_MS);
      }
      window.scrollTo(0, 0);
      await pause(200);
    };

    const absolute = (value: string | null | undefined): string | null => {
      const trimmed = value?.trim();
      if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return null;
      try {
        const url = new URL(trimmed, document.baseURI);
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
      } catch {
        return null;
      }
    };

    const parseSrcset = (srcset: string | null | undefined): Array<{ url: string; width: number }> => {
      if (!srcset) return [];
      return srcset.split(/,\s+(?=\S)/).flatMap((entry) => {
        const [rawUrl, descriptor = ""] = entry.trim().split(/\s+/);
        const url = absolute(rawUrl);
        if (!url) return [];
        const width = descriptor.endsWith("w")
          ? Number.parseInt(descriptor, 10)
          : descriptor.endsWith("x")
            ? Math.round(Number.parseFloat(descriptor) * 400)
            : 0;
        return [{ url, width: Number.isFinite(width) ? width : 0 }];
      });
    };

    const bestCandidate = (candidates: Array<{ url: string; width: number }>): string | null => {
      const sized = candidates.filter((candidate) => candidate.width > 0).sort((a, b) => a.width - b.width);
      if (sized.length === 0) return null;
      return (sized.find((candidate) => candidate.width >= TARGET_IMAGE_WIDTH) ?? sized[sized.length - 1]!).url;
    };

    const resolveImages = () => {
      for (const img of Array.from(document.images)) {
        const sources = img.parentElement?.tagName === "PICTURE"
          ? Array.from(img.parentElement.querySelectorAll("source")).flatMap((source) =>
              parseSrcset(source.getAttribute("srcset") ?? source.getAttribute("data-srcset")),
            )
          : [];
        const candidates = [
          ...parseSrcset(img.getAttribute("srcset")),
          ...LAZY_SRCSET_ATTRIBUTES.flatMap((name) => parseSrcset(img.getAttribute(name))),
          ...sources,
        ];
        const best =
          bestCandidate(candidates) ??
          absolute(img.currentSrc) ??
          LAZY_SRC_ATTRIBUTES.map((name) => absolute(img.getAttribute(name))).find(Boolean) ??
          absolute(img.getAttribute("src"));
        if (best) img.setAttribute("src", best);
        else img.removeAttribute("src");

        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          img.setAttribute("width", String(Math.round(rect.width)));
          img.setAttribute("height", String(Math.round(rect.height)));
        }
      }
    };

    const convertPageToHTML = async () => {
      await scrollPage();
      resolveImages();
      return {
        url: location.href,
        title: document.title,
        html: document.body.innerHTML,
      };
    };

    return convertPageToHTML();
  },
});
