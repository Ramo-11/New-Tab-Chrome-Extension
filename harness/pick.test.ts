import { describe, expect, test } from "bun:test";
import { buildHistoryDigest, fallbackUrls, parsePickedUrls } from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";

const DOMAINS = ["news.ycombinator.com", "lobste.rs", "github.com"];

function parse(raw: string, blockedSites: string[] = []) {
  return parsePickedUrls(raw, { blockedSites, digestDomains: DOMAINS });
}

describe("parsePickedUrls", () => {
  test("reads the urls array", () => {
    expect(parse('{"urls":["https://news.ycombinator.com/","https://lobste.rs/newest"]}')).toEqual([
      "https://news.ycombinator.com/",
      "https://lobste.rs/newest",
    ]);
  });

  test("tolerates a fenced answer and a bare array", () => {
    expect(parse('```json\n{"urls":["https://lobste.rs/"]}\n```')).toEqual(["https://lobste.rs/"]);
    expect(parse('["https://lobste.rs/"]')).toEqual(["https://lobste.rs/"]);
  });

  test("returns nothing for answers it cannot read", () => {
    for (const raw of ["", "not json", "{}", '{"urls":"https://lobste.rs/"}', "42", "null"]) {
      expect(parse(raw)).toEqual([]);
    }
  });

  test("keeps only absolute http and https urls", () => {
    const raw = JSON.stringify({
      urls: ["lobste.rs", "/relative", "ftp://lobste.rs/x", "javascript:alert(1)", "file:///etc/passwd", 7, null, "https://lobste.rs/ok"],
    });
    expect(parse(raw)).toEqual(["https://lobste.rs/ok"]);
  });

  test("only accepts hosts from the digest, including their subdomains", () => {
    const raw = JSON.stringify({
      urls: ["https://evil.example.net/", "https://old.github.com/", "https://github.com.evil.net/", "https://www.lobste.rs/"],
    });
    expect(parse(raw)).toEqual(["https://old.github.com/", "https://www.lobste.rs/"]);
  });

  test("drops blocked hosts and private addresses", () => {
    const raw = JSON.stringify({ urls: ["https://github.com/", "https://lobste.rs/", "http://localhost:3000/"] });
    expect(parse(raw, ["github.com"])).toEqual(["https://lobste.rs/"]);
    expect(parsePickedUrls(JSON.stringify({ urls: ["http://localhost:3000/", "http://192.168.1.5/"] }), {
      blockedSites: [],
      digestDomains: ["localhost", "192.168.1.5"],
    })).toEqual([]);
  });

  test("removes duplicates that differ only by www, slash or hash", () => {
    const raw = JSON.stringify({ urls: ["https://lobste.rs/", "https://www.lobste.rs", "https://lobste.rs/#top", "https://lobste.rs/x"] });
    expect(parse(raw)).toEqual(["https://lobste.rs/", "https://lobste.rs/x"]);
  });

  test("caps the list at eight", () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://lobste.rs/page-${i}`);
    expect(parse(JSON.stringify({ urls }))).toHaveLength(8);
    expect(parsePickedUrls(JSON.stringify({ urls }), { blockedSites: [], digestDomains: DOMAINS, max: 3 })).toHaveLength(3);
  });
});

describe("fallbackUrls", () => {
  const digest = buildHistoryDigest(fixtureHistory(), { daysToAnalyze: 14, maxResults: 30 });

  test("uses the top digest domains as site roots", () => {
    expect(fallbackUrls(digest, []).slice(0, 3)).toEqual([
      "https://news.ycombinator.com/",
      "https://lobste.rs/",
      "https://arstechnica.com/",
    ]);
    expect(fallbackUrls(digest, [])).toHaveLength(8);
  });

  test("leaves out blocked sites", () => {
    const urls = fallbackUrls(digest, ["lobste.rs", "mail.google.com"]);
    expect(urls).not.toContain("https://lobste.rs/");
    expect(urls).not.toContain("https://mail.google.com/");
    expect(urls).toHaveLength(8);
  });
});
