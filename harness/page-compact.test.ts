import { describe, expect, test } from "bun:test";
import {
  PAGE_CHAR_CAP,
  TOTAL_CHAR_CAP,
  compactPage,
  compactPages,
  type CompactInput,
} from "@homepage/agent-core";

const BASE = "https://news.example.com/world/index.html";

function page(html: string, url = BASE, extra: Partial<CompactInput> = {}): CompactInput {
  return { url, title: "Test page", html, ...extra };
}

describe("compactPage text", () => {
  test("headings become hash lines and list items become dash lines", () => {
    const { text } = compactPage(page("<h1>Top</h1><h3>Sub</h3><p>Hello <strong>big</strong> world</p><ul><li>One</li><li>Two</li></ul>"));
    expect(text.split("\n")).toEqual(["# Top", "### Sub", "Hello big world", "- One", "- Two"]);
  });

  test("decodes entities and collapses whitespace", () => {
    const { text } = compactPage(page("<p>Fish &amp; chips&nbsp;&nbsp;are   &quot;great&quot; &#8212; &#x41; &unknown; &constructor;</p>"));
    expect(text).toBe(`Fish & chips are "great" ${String.fromCodePoint(0x2014)} A &unknown; &constructor;`);
  });

  test("removes duplicate lines", () => {
    const { text } = compactPage(page("<p>Share</p><p>Real news</p><p>Share</p><p>Share</p>"));
    expect(text).toBe("Share\nReal news");
  });

  test("drops script, style and head content even if the host did not", () => {
    const { text } = compactPage(
      page("<head><title>x</title></head><script>var secret = 1;</script><style>p{color:red}</style><p>Visible</p><!-- hidden comment -->"),
    );
    expect(text).toBe("Visible");
  });

  test("table rows stay on one line", () => {
    const { text } = compactPage(page("<table><tr><th>Team</th><th>Score</th></tr><tr><td>Reds</td><td>3</td></tr></table>"));
    expect(text.split("\n")).toEqual(["Team | Score", "Reds | 3"]);
  });

  test("survives malformed and empty input", () => {
    expect(compactPage(page("")).text).toBe("");
    expect(compactPage(page("<p>Open <b>tag")).text).toBe("Open tag");
    expect(compactPage(page("a < b and <3 hearts")).text).toContain("a < b");
  });
});

describe("compactPage links and images", () => {
  test("links are absolutized against the page URL", () => {
    const { text, links } = compactPage(
      page('<p><a href="/story/1">Relative root</a> <a href="story/2">Relative path</a> <a href="//cdn.example.org/x">Protocol relative</a> <a href="https://other.example.org/a?x=1&amp;y=2">Absolute</a></p>'),
    );
    expect(text).toBe(
      "[Relative root](https://news.example.com/story/1) [Relative path](https://news.example.com/world/story/2) [Protocol relative](https://cdn.example.org/x) [Absolute](https://other.example.org/a?x=1&y=2)",
    );
    expect(links).toEqual([
      "https://news.example.com/story/1",
      "https://news.example.com/world/story/2",
      "https://cdn.example.org/x",
      "https://other.example.org/a?x=1&y=2",
    ]);
  });

  test("resolves against the final URL after a redirect", () => {
    const { links } = compactPage(page('<a href="/a">A</a>', "https://short.example/go", { finalUrl: "https://real.example.com/start" }));
    expect(links).toEqual(["https://real.example.com/a"]);
  });

  test("images keep their alt text and absolute source", () => {
    const { text, links } = compactPage(page('<p>Look <img src="/img/a.png" alt="A [big] cat"> here</p>'));
    expect(text).toBe("Look ![A (big) cat](https://news.example.com/img/a.png) here");
    expect(links).toEqual(["https://news.example.com/img/a.png"]);
  });

  test("a linked image keeps both urls on one line", () => {
    const { text } = compactPage(page('<a href="/post"><img src="/t.jpg" alt="Thumb"></a>'));
    expect(text).toBe("[![Thumb](https://news.example.com/t.jpg)](https://news.example.com/post)");
  });

  test("a card link wraps the headline once, not every block inside it", () => {
    const { text } = compactPage(page('<a href="/card"><div><h3>Headline</h3><p>A longer summary of the story goes here.</p></div></a>'));
    expect(text.split("\n")).toEqual([
      "### [Headline](https://news.example.com/card)",
      "A longer summary of the story goes here.",
    ]);
  });

  test("without a heading the longest line of a card carries the link", () => {
    const { text } = compactPage(page('<a href="/card"><span>Tag</span><div>A longer summary of the story goes here.</div></a>'));
    expect(text).toBe("Tag\n[A longer summary of the story goes here.](https://news.example.com/card)");
  });

  test("javascript, data, mailto, tel and fragment links lose the link but keep the text", () => {
    const html = [
      '<a href="javascript:alert(1)">JS</a>',
      '<a href="  JaVaScRiPt:alert(1)">JS2</a>',
      '<a href="data:text/html;base64,AAA">Data</a>',
      '<a href="mailto:a@b.co">Mail</a>',
      '<a href="tel:+15551234">Call</a>',
      '<a href="#comments">Jump</a>',
      '<a href="ftp://files.example.com/x">Ftp</a>',
      '<a href="https://ok.example.com/">Fine</a>',
    ].join(" ");
    const { text, links } = compactPage(page(html));
    expect(text).toBe("JS JS2 Data Mail Call Jump Ftp [Fine](https://ok.example.com/)");
    expect(links).toEqual(["https://ok.example.com/"]);
  });

  test("data and blob image sources are dropped", () => {
    const { text, links } = compactPage(page('<p>x<img src="data:image/png;base64,AAAA" alt="inline"><img src="blob:https://a/b" alt="blob"></p>'));
    expect(text).toBe("x");
    expect(links).toEqual([]);
  });

  test("tiny tracking images are dropped", () => {
    const { links } = compactPage(page('<img src="/pixel.gif" width="1" height="1" alt=""><img src="/real.jpg" width="640" alt="Real">'));
    expect(links).toEqual(["https://news.example.com/real.jpg"]);
  });

  test("parentheses in urls are encoded so the markdown stays unambiguous", () => {
    const { text, links } = compactPage(page('<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a>'));
    expect(text).toBe("[Foo](https://en.wikipedia.org/wiki/Foo_%28bar%29)");
    expect(links).toEqual(["https://en.wikipedia.org/wiki/Foo_%28bar%29"]);
  });

  test("links with no visible text are dropped", () => {
    const { text, links } = compactPage(page('<a href="/empty"></a><p>Body</p>'));
    expect(text).toBe("Body");
    expect(links).toEqual([]);
  });
});

describe("caps", () => {
  const paragraphs = (count: number, size: number) =>
    Array.from({ length: count }, (_, i) => `<p>${`${i}:`.padEnd(size, "x")}</p>`).join("");

  test("exports the documented caps", () => {
    expect(PAGE_CHAR_CAP).toBe(25_000);
    expect(TOTAL_CHAR_CAP).toBe(320_000);
  });

  test("one page is cut at the per-page cap on a line boundary", () => {
    const result = compactPage(page(paragraphs(200, 400)));
    expect(result.text.length).toBeLessThanOrEqual(PAGE_CHAR_CAP);
    expect(result.text.length).toBeGreaterThan(PAGE_CHAR_CAP - 500);
    expect(result.text.split("\n").every((line) => line.length === 400)).toBe(true);
  });

  test("an explicit cap is honoured", () => {
    expect(compactPage(page(paragraphs(50, 100)), 1_000).text.length).toBeLessThanOrEqual(1_000);
  });

  test("links are only reported for text that survived the cap", () => {
    const html = `<p><a href="/first">first link</a></p>${paragraphs(300, 300)}<p><a href="/last">last link</a></p>`;
    const result = compactPage(page(html), 2_000);
    expect(result.links).toEqual(["https://news.example.com/first"]);
  });

  test("the total cap is shared across pages, with small pages keeping everything", () => {
    const small = page("<p>tiny page</p>", "https://small.example.com/");
    const bigs = Array.from({ length: 10 }, (_, i) => page(paragraphs(120, 400), `https://big${i}.example.com/`));
    const result = compactPages([small, ...bigs]);
    const total = result.reduce((sum, p) => sum + p.text.length, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_CHAR_CAP);
    expect(result[0]!.text).toBe("tiny page");
    for (const big of result.slice(1)) {
      expect(big.text.length).toBeGreaterThan(15_000);
      expect(big.text.length).toBeLessThanOrEqual(PAGE_CHAR_CAP);
    }
  });

  test("keeps url, final url and a clean title on every page", () => {
    const [first] = compactPages([page("<p>x</p>", "https://a.example/", { finalUrl: "https://b.example/", title: "  Spaced \n title  " })]);
    expect(first).toMatchObject({ url: "https://a.example/", finalUrl: "https://b.example/", title: "Spaced title" });
  });
});

describe("placeholder images", () => {
  test("lazy-load placeholders and spacer pixels are dropped, real pictures stay", () => {
    const page = compactPage({
      url: "https://news.example.com/",
      title: "News",
      html: '<p><img src="https://static.example.com/grey-placeholder.png" alt=""><img src="https://img.example.com/story.jpg" alt="Story"> Headline</p>',
    });
    expect(page.text).not.toContain("placeholder");
    expect(page.text).toContain("![Story](https://img.example.com/story.jpg)");
  });
});

describe("responsive and lazy images", () => {
  const read = (img: string) =>
    compactPage({ url: "https://news.example.com/", title: "News", html: `<p>${img} Headline</p>` }).text;

  test("takes the srcset candidate closest above 800 pixels wide", () => {
    const text = read('<img src="/s.jpg" srcset="/a-320.jpg 320w, /a-960.jpg 960w, /a-2000.jpg 2000w" alt="A">');
    expect(text).toContain("![A](https://news.example.com/a-960.jpg)");
  });

  test("falls back to the largest candidate when none is that wide", () => {
    const text = read('<img srcset="/b-200.jpg 200w, /b-480.jpg 480w" alt="B">');
    expect(text).toContain("![B](https://news.example.com/b-480.jpg)");
  });

  test("uses data-src when the src is a lazy-load placeholder", () => {
    const text = read('<img src="/img/placeholder.gif" data-src="/real.jpg" alt="C">');
    expect(text).toContain("![C](https://news.example.com/real.jpg)");
  });
});
