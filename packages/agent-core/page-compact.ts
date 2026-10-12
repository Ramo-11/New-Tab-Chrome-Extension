export const PAGE_CHAR_CAP = 25_000;
export const TOTAL_CHAR_CAP = 320_000;
const PLACEHOLDER_IMAGE = /placeholder|spacer|blank\.(?:gif|png)|transparent\.(?:gif|png)|1x1|pixel\.(?:gif|png)/i;
export const LINE_CHAR_CAP = 1_500;

export interface CompactInput {
  url: string;
  finalUrl?: string;
  title: string;
  html: string;
}

export interface CompactedPage {
  url: string;
  finalUrl?: string;
  title: string;
  text: string;
  links: string[];
}

const BLOCK_TAGS = new Set([
  "p", "div", "ul", "ol", "table", "thead", "tbody", "tfoot", "tr", "blockquote", "pre",
  "figure", "figcaption", "section", "article", "header", "footer", "main", "nav", "aside",
  "form", "dl", "dt", "dd", "details", "summary", "center", "address", "fieldset", "legend",
  "caption", "br", "hr",
]);

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "iframe", "head", "title", "canvas",
  "object", "embed", "select", "textarea",
]);

const NAMED_ENTITIES: Record<string, number> = {
  amp: 0x26,
  lt: 0x3c,
  gt: 0x3e,
  quot: 0x22,
  apos: 0x27,
  nbsp: 0x20,
  ndash: 0x2013,
  mdash: 0x2014,
  hellip: 0x2026,
  lsquo: 0x2018,
  rsquo: 0x2019,
  ldquo: 0x201c,
  rdquo: 0x201d,
  bull: 0x2022,
  middot: 0xb7,
  copy: 0xa9,
  reg: 0xae,
  trade: 0x2122,
  laquo: 0xab,
  raquo: 0xbb,
  euro: 0x20ac,
  pound: 0xa3,
  yen: 0xa5,
  cent: 0xa2,
  deg: 0xb0,
  times: 0xd7,
};

const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+)|</g;

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi,
    (whole: string, dec?: string, hex?: string, name?: string) => {
    if (name) {
      const key = name.toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, key) ? String.fromCodePoint(NAMED_ENTITIES[key]!) : whole;
    }
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
    return String.fromCodePoint(code);
    },
  );
}

const ZERO_WIDTH = new RegExp(`[${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200d)}${String.fromCharCode(0xfeff)}]`, "g");

function collapse(text: string): string {
  return text.replace(ZERO_WIDTH, "").replace(/\s+/g, " ");
}

function readAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

function absolutize(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  const value = decodeEntities(raw).trim();
  if (!value || value.startsWith("#")) return undefined;
  const scheme = value.replace(/[\x00-\x20]/g, "").match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return undefined;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return undefined;
  }
}

function tidyLabel(text: string): string {
  return collapse(decodeEntities(text)).replace(/\[/g, "(").replace(/\]/g, ")").trim();
}

interface Segment {
  line: number;
  start: number;
  end: number;
}

interface Anchor {
  href: string;
  start: number;
  segments: Segment[];
}

function wrapLink(segment: string, href: string): string {
  const match = segment.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!match || !match[2]) return segment;
  return `${match[1]}[${match[2]}](${href})${match[3]}`;
}

function textWeight(segment: string): number {
  return segment.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim().length;
}

function isMeaningful(line: string): boolean {
  return line.replace(/^[\s#>|*-]+/, "").trim().length > 0;
}

function toLines(html: string, base: string): string[] {
  const lines: string[] = [];
  let current = "";
  let anchor: Anchor | undefined;
  let skipTag = "";
  let skipDepth = 0;

  const flush = () => {
    const line = current;
    current = "";
    if (isMeaningful(line)) {
      lines.push(line);
      if (anchor) anchor.segments.push({ line: lines.length - 1, start: anchor.start, end: line.length });
    }
    if (anchor) anchor.start = 0;
  };

  const startBlock = (prefix: string) => {
    flush();
    current = prefix;
    if (anchor) anchor.start = prefix.length;
  };

  const closeAnchor = () => {
    if (!anchor) return;
    const closing = anchor;
    anchor = undefined;
    const candidates = [
      ...closing.segments.map((segment) => ({
        segment,
        full: lines[segment.line]!,
        pending: false,
      })),
      { segment: { line: -1, start: closing.start, end: current.length }, full: current, pending: true },
    ]
      .map((candidate) => ({
        ...candidate,
        text: candidate.full.slice(candidate.segment.start, candidate.segment.end),
      }))
      .filter((candidate) => candidate.text.trim());
    if (candidates.length === 0) return;
    const score = (candidate: (typeof candidates)[number]) =>
      textWeight(candidate.text) + (/^#{1,6} /.test(candidate.full) ? 1_000 : 0);
    const best = candidates.reduce((top, candidate) => (score(candidate) > score(top) ? candidate : top));
    const { start, end } = best.segment;
    if (best.pending) {
      current = current.slice(0, start) + wrapLink(best.text, closing.href) + current.slice(end);
    } else {
      const line = lines[best.segment.line]!;
      lines[best.segment.line] = line.slice(0, start) + wrapLink(best.text, closing.href) + line.slice(end);
    }
  };

  const appendText = (raw: string) => {
    let text = collapse(decodeEntities(raw));
    if (!text) return;
    if (!current || current.endsWith(" ")) text = text.replace(/^ /, "");
    current += text;
  };

  const appendImage = (attrs: string) => {
    const src = imageSource(attrs, base);
    if (!src) return;
    const width = Number(readAttr(attrs, "width"));
    const height = Number(readAttr(attrs, "height"));
    if ((Number.isFinite(width) && width > 0 && width <= 24) || (Number.isFinite(height) && height > 0 && height <= 24)) {
      return;
    }
    const alt = tidyLabel(readAttr(attrs, "alt") ?? "").slice(0, 150);
    if (current && !current.endsWith(" ")) current += " ";
    current += `![${alt}](${src}) `;
  };

  for (const match of html.matchAll(TOKEN)) {
    const [whole, closingSlash, rawName, attrs = "", text] = match;

    if (skipDepth > 0) {
      if (rawName?.toLowerCase() === skipTag) skipDepth += closingSlash ? -1 : 1;
      continue;
    }

    if (text !== undefined) {
      appendText(text);
      continue;
    }
    if (!rawName) {
      if (whole === "<") appendText("<");
      continue;
    }

    const name = rawName.toLowerCase();
    const closing = closingSlash === "/";

    if (SKIP_TAGS.has(name)) {
      if (!closing && !/\/\s*$/.test(attrs)) {
        skipTag = name;
        skipDepth = 1;
      }
      continue;
    }

    if (closing) {
      if (name === "a") closeAnchor();
      else if (/^h[1-6]$/.test(name) || name === "li" || BLOCK_TAGS.has(name)) flush();
      continue;
    }

    if (/^h[1-6]$/.test(name)) {
      startBlock(`${"#".repeat(Number(name[1]))} `);
    } else if (name === "li") {
      startBlock("- ");
    } else if (name === "td" || name === "th") {
      if (current.trim()) current = `${current.trimEnd()} | `;
    } else if (name === "a") {
      closeAnchor();
      const href = absolutize(readAttr(attrs, "href"), base);
      if (href) anchor = { href, start: current.length, segments: [] };
    } else if (name === "img") {
      appendImage(attrs);
    } else if (BLOCK_TAGS.has(name)) {
      flush();
    }
  }

  closeAnchor();
  flush();

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/ {2,}/g, " ").trim();
    if (!isMeaningful(line) || seen.has(line)) continue;
    seen.add(line);
    result.push(line.length > LINE_CHAR_CAP ? `${line.slice(0, LINE_CHAR_CAP)}...` : line);
  }
  return result;
}

const TARGET_IMAGE_WIDTH = 800;
const LAZY_SRC_ATTRIBUTES = ["data-src", "data-lazy-src", "data-original"];

function bestFromSrcset(srcset: string | undefined, base: string): string | undefined {
  if (!srcset) return undefined;
  const candidates = decodeEntities(srcset)
    .split(/,\s+(?=\S)/)
    .flatMap((entry) => {
      const [raw, descriptor = ""] = entry.trim().split(/\s+/);
      const url = absolutize(raw, base);
      if (!url || PLACEHOLDER_IMAGE.test(url)) return [];
      const width = descriptor.endsWith("w")
        ? Number.parseInt(descriptor, 10)
        : descriptor.endsWith("x")
          ? Math.round(Number.parseFloat(descriptor) * 400)
          : 0;
      return [{ url, width: Number.isFinite(width) ? width : 0 }];
    })
    .sort((a, b) => a.width - b.width);
  if (candidates.length === 0) return undefined;
  return (candidates.find((candidate) => candidate.width >= TARGET_IMAGE_WIDTH) ?? candidates[candidates.length - 1]!).url;
}

function imageSource(attrs: string, base: string): string | undefined {
  const usable = (value: string | undefined) => {
    const url = absolutize(value, base);
    return url && !PLACEHOLDER_IMAGE.test(url) ? url : undefined;
  };
  return (
    bestFromSrcset(readAttr(attrs, "srcset"), base) ??
    bestFromSrcset(readAttr(attrs, "data-srcset"), base) ??
    usable(readAttr(attrs, "src")) ??
    LAZY_SRC_ATTRIBUTES.map((name) => usable(readAttr(attrs, name))).find(Boolean)
  );
}

function fitLines(lines: string[], cap: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (kept.length ? 1 : 0);
    if (used + cost > cap) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0 && lines.length > 0) return lines[0]!.slice(0, cap);
  return kept.join("\n");
}

function linksIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^https?:\/\//i.test(match[1]!)) found.add(match[1]!);
  }
  return [...found];
}

function cleanTitle(title: string): string {
  return collapse(title).trim().slice(0, 200);
}

function build(input: CompactInput, lines: string[], cap: number): CompactedPage {
  const text = fitLines(lines, cap);
  return {
    url: input.url,
    ...(input.finalUrl ? { finalUrl: input.finalUrl } : {}),
    title: cleanTitle(input.title),
    text,
    links: linksIn(text),
  };
}

function shareBudget(lengths: number[], total: number): number[] {
  const budgets = lengths.map(() => 0);
  const order = lengths.map((_, index) => index).sort((a, b) => lengths[a]! - lengths[b]!);
  let remaining = total;
  order.forEach((index, position) => {
    const share = Math.floor(remaining / (order.length - position));
    budgets[index] = Math.min(lengths[index]!, share);
    remaining -= budgets[index]!;
  });
  return budgets;
}

export function compactPage(input: CompactInput, cap: number = PAGE_CHAR_CAP): CompactedPage {
  return build(input, toLines(input.html, input.finalUrl ?? input.url), cap);
}

export function compactPages(
  inputs: CompactInput[],
  options: { pageCap?: number; totalCap?: number } = {},
): CompactedPage[] {
  const pageCap = options.pageCap ?? PAGE_CHAR_CAP;
  const totalCap = options.totalCap ?? TOTAL_CHAR_CAP;
  const parsed = inputs.map((input) => ({ input, lines: toLines(input.html, input.finalUrl ?? input.url) }));
  const lengths = parsed.map(({ lines }) => Math.min(fitLines(lines, pageCap).length, pageCap));
  const budgets = shareBudget(lengths, totalCap);
  return parsed.map(({ input, lines }, index) => build(input, lines, budgets[index]!));
}
