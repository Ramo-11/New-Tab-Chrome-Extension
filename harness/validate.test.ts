import { describe, expect, test } from "bun:test";
import {
  extractLinkLiterals,
  findUnverifiedLinks,
  foreignModules,
  normalizeUrl,
  stripCodeFence,
  stripEmoji,
  validateHomepage,
} from "@homepage/agent-core";
import { checkSyntax } from "./syntax";

const GOOD = [
  "import React from 'react';",
  "export default function PersonalizedHomepage() {",
  '  return <main><a href="https://news.example.com/story-1">Story</a><img src="https://news.example.com/lead.png" alt="" /></main>;',
  "}",
].join("\n");

const KNOWN = ["https://news.example.com/story-1", "https://news.example.com/lead.png"];

describe("structural checks", () => {
  test("a good file has no problems", () => {
    const report = validateHomepage(GOOD, { knownLinks: KNOWN, checkSyntax });
    expect(report.problems).toEqual([]);
    expect(report.blocking).toEqual([]);
  });

  test("accepts the identifier form of the default export", () => {
    const code = GOOD.replace("export default function PersonalizedHomepage", "function PersonalizedHomepage") + "\nexport default PersonalizedHomepage;";
    expect(validateHomepage(code, { knownLinks: KNOWN }).blocking).toEqual([]);
    const arrow = "import React from 'react';\nconst PersonalizedHomepage = () => <a href=\"https://news.example.com/story-1\">x</a>;\nexport default PersonalizedHomepage;";
    expect(validateHomepage(arrow, { knownLinks: KNOWN }).blocking).toEqual([]);
  });

  test("an identifier export with no definition is rejected", () => {
    const code = "import React from 'react';\nexport default PersonalizedHomepage;\n// https://news.example.com/story-1";
    expect(validateHomepage(code, { knownLinks: KNOWN }).blocking.join(" ")).toContain("PersonalizedHomepage");
  });

  test("rejects a missing or misnamed default export", () => {
    const code = GOOD.replace("export default function PersonalizedHomepage", "export default function Home");
    expect(validateHomepage(code, { knownLinks: KNOWN }).blocking).toHaveLength(1);
    expect(validateHomepage(GOOD.replace("export default ", "export "), { knownLinks: KNOWN }).blocking).toHaveLength(1);
  });

  test("requires the React import", () => {
    const report = validateHomepage(GOOD.replace("import React from 'react';\n", ""), { knownLinks: KNOWN });
    expect(report.blocking.join(" ")).toContain("import React");
    expect(validateHomepage(GOOD.replace("import React from", "import { useState } from"), { knownLinks: KNOWN }).blocking).toHaveLength(1);
    expect(validateHomepage(GOOD.replace("import React from", "import React, { useState } from"), { knownLinks: KNOWN }).blocking).toEqual([]);
    expect(validateHomepage(GOOD.replace("import React from", "import * as React from"), { knownLinks: KNOWN }).blocking).toEqual([]);
  });

  test("rejects imports other than react", () => {
    const code = `import React from 'react';\nimport styled from 'styled-components';\nimport './app.css';\n${GOOD.split("\n").slice(1).join("\n")}`;
    const report = validateHomepage(code, { knownLinks: KNOWN });
    expect(report.blocking.join(" ")).toContain("styled-components");
    expect(report.blocking.join(" ")).toContain("./app.css");
  });

  test("finds multi-line, require and dynamic imports", () => {
    const code = "import React from 'react';\nimport {\n  a,\n  b,\n} from 'lodash';\nconst x = require('left-pad');\nconst y = await import('chart.js');";
    expect(foreignModules(code).sort()).toEqual(["chart.js", "left-pad", "lodash"]);
  });

  test("prose that merely says from in quotes is not an import", () => {
    const code = `${GOOD}\n// he said from "the top" and import "nothing"`;
    expect(foreignModules(code)).toEqual([]);
    const jsx = GOOD.replace("Story", 'Quotes from "The Times"');
    expect(validateHomepage(jsx, { knownLinks: KNOWN }).blocking).toEqual([]);
  });

  test("needs at least one real http link", () => {
    const noLinks = GOOD.replace(/https:\/\/news\.example\.com\/[a-z0-9.-]+/g, "#");
    expect(validateHomepage(noLinks, { knownLinks: [] }).blocking.join(" ")).toContain("no real http");
    const svgOnly = "import React from 'react';\nexport default function PersonalizedHomepage(){ return <svg xmlns=\"http://www.w3.org/2000/svg\" />; }";
    expect(validateHomepage(svgOnly, { knownLinks: [] }).blocking.join(" ")).toContain("no real http");
  });

  test("a truncated answer is a blocking problem", () => {
    expect(validateHomepage(GOOD, { knownLinks: KNOWN, truncated: true }).blocking.join(" ")).toContain("cut off");
  });
});

describe("syntax check", () => {
  test("reports the host's syntax error", () => {
    const broken = `${GOOD}\nconst = ;`;
    const report = validateHomepage(broken, { knownLinks: KNOWN, checkSyntax });
    expect(report.blocking.some((problem) => problem.startsWith("Syntax error:"))).toBe(true);
  });

  test("is skipped when the host does not provide one", () => {
    const broken = `${GOOD}\nconst = ;`;
    expect(validateHomepage(broken, { knownLinks: KNOWN }).blocking).toEqual([]);
  });

  test("passes through a custom checker", () => {
    expect(validateHomepage(GOOD, { knownLinks: KNOWN, checkSyntax: () => "bad token" }).blocking).toEqual(["Syntax error: bad token"]);
  });
});

describe("link verification", () => {
  test("flags links that were never in the scraped pages", () => {
    const code = GOOD.replace("story-1", "story-999");
    const report = validateHomepage(code, { knownLinks: KNOWN });
    expect(report.blocking).toEqual([]);
    expect(report.unverifiedLinks).toEqual(["https://news.example.com/story-999"]);
    expect(report.problems).toEqual(["This link does not appear in the provided pages: https://news.example.com/story-999"]);
  });

  test("ignores trailing slashes and hashes when comparing", () => {
    const code = GOOD.replace('"https://news.example.com/story-1"', '"https://news.example.com/story-1/#comments"');
    expect(validateHomepage(code, { knownLinks: KNOWN }).unverifiedLinks).toEqual([]);
    expect(normalizeUrl("https://a.com/x/")).toBe(normalizeUrl("https://a.com/x#top"));
    expect(normalizeUrl("https://a.com/")).toBe(normalizeUrl("https://a.com"));
    expect(normalizeUrl("https://a.com/x?y=1")).not.toBe(normalizeUrl("https://a.com/x"));
  });

  test("a known link with a trailing slash matches an unslashed one", () => {
    expect(findUnverifiedLinks('const a = "https://news.example.com/story-1";', ["https://news.example.com/story-1/"])).toEqual([]);
  });

  test("checks urls wherever they appear in string literals, not only href and src", () => {
    const code = `import React from 'react';\nconst items = [{ url: "https://fake.example.org/a", image: 'https://fake.example.org/b.png' }];\nexport default function PersonalizedHomepage(){ return <a href={items[0].url}>x</a>; }`;
    expect(extractLinkLiterals(code)).toEqual(["https://fake.example.org/a", "https://fake.example.org/b.png"]);
    expect(validateHomepage(code, { knownLinks: [] }).unverifiedLinks).toHaveLength(2);
  });

  test("ignores xmlns urls, template urls and non-http values", () => {
    const code = [
      "import React from 'react';",
      'const ns = "http://www.w3.org/2000/svg";',
      "const dynamic = `https://news.example.com/${id}`;",
      'const mail = "mailto:a@b.co";',
      'const rel = "/relative/path";',
      "export default function PersonalizedHomepage(){ return <a href=\"https://news.example.com/story-1\">x</a>; }",
    ].join("\n");
    expect(validateHomepage(code, { knownLinks: KNOWN }).unverifiedLinks).toEqual([]);
  });

  test("lists at most a handful of links in the problems", () => {
    const many = Array.from({ length: 12 }, (_, i) => `"https://fake.example.org/${i}"`).join(", ");
    const code = `import React from 'react';\nconst all = [${many}];\nexport default function PersonalizedHomepage(){ return null; }`;
    const report = validateHomepage(code, { knownLinks: [] });
    expect(report.unverifiedLinks).toHaveLength(12);
    expect(report.problems).toHaveLength(9);
    expect(report.problems.at(-1)).toBe("4 more links do not appear in the provided pages.");
  });
});

describe("stripCodeFence", () => {
  test("leaves plain code alone", () => {
    expect(stripCodeFence(`\n${GOOD}\n`)).toBe(GOOD);
  });

  test("unwraps a tsx fence", () => {
    expect(stripCodeFence("```tsx\n" + GOOD + "\n```")).toBe(GOOD);
  });

  test("takes the fenced block out of surrounding prose", () => {
    expect(stripCodeFence("Here is the page:\n```tsx\n" + GOOD + "\n```\nHope that helps!")).toBe(GOOD);
  });

  test("handles a fence that was never closed", () => {
    expect(stripCodeFence("```tsx\n" + GOOD)).toBe(GOOD);
  });

  test("drops prose that comes before the import line", () => {
    expect(stripCodeFence("Sure, here you go.\n\n" + GOOD)).toBe(GOOD);
  });
});

describe("stripEmoji", () => {
  test("removes emoji, skin tones, joined sequences and flags with the space after them", () => {
    expect(stripEmoji("<h2>⚡ AI Radar</h2>")).toBe("<h2>AI Radar</h2>");
    expect(stripEmoji("Welcome back, Omar 👋🏽")).toBe("Welcome back, Omar ");
    expect(stripEmoji("<span>👨‍💻 Dev</span>")).toBe("<span>Dev</span>");
    expect(stripEmoji("⚙️ Settings")).toBe("Settings");
    expect(stripEmoji("🇺🇸 News")).toBe("News");
  });

  test("keeps code, ordinary punctuation and legal marks intact", () => {
    expect(stripEmoji(GOOD)).toBe(GOOD);
    expect(stripEmoji("© 2026 Acme™ · ® – “quoted” → next")).toBe("© 2026 Acme™ · ® – “quoted” → next");
  });
});
