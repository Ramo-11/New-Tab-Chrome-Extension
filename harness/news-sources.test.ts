import { describe, expect, test } from "bun:test";
import { DEFAULT_NEWS_SOURCES, MAX_NEWS_SOURCES, parseNewsSources, sameSite } from "@homepage/agent-core";

describe("parseNewsSources", () => {
  test("accepts full addresses and bare domains, dropping blank lines and notes", () => {
    const parsed = parseNewsSources(["https://www.bbc.com/news", "  techcrunch.com  ", "", "# tech"]);
    expect(parsed.sources).toEqual(["https://www.bbc.com/news", "https://techcrunch.com/"]);
    expect(parsed.invalid).toEqual([]);
  });

  test("reports lines that are not web addresses", () => {
    const parsed = parseNewsSources(["not a site", "ftp://files.example.com", "localhost"]);
    expect(parsed.sources).toEqual([]);
    expect(parsed.invalid).toEqual(["not a site", "ftp://files.example.com", "localhost"]);
  });

  test("removes duplicates that differ only by www, a trailing slash or a fragment", () => {
    const parsed = parseNewsSources(["https://www.cnn.com/", "cnn.com", "https://cnn.com#top"]);
    expect(parsed.sources).toEqual(["https://www.cnn.com/"]);
  });

  test("keeps at most the limit and says when the list was too long", () => {
    const lines = Array.from({ length: MAX_NEWS_SOURCES + 2 }, (_, i) => `site${i}.example.com`);
    const parsed = parseNewsSources(lines);
    expect(parsed.sources).toHaveLength(MAX_NEWS_SOURCES);
    expect(parsed.overLimit).toBe(true);
  });

  test("the default list is valid and within the limit", () => {
    const parsed = parseNewsSources(DEFAULT_NEWS_SOURCES);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.sources).toHaveLength(DEFAULT_NEWS_SOURCES.length);
    expect(parsed.overLimit).toBe(false);
  });
});

describe("sameSite", () => {
  test("matches hosts with or without www and ignores paths", () => {
    expect(sameSite("https://www.reuters.com/world/", "https://reuters.com/technology/")).toBe(true);
    expect(sameSite("https://bbc.com/news", "https://cnn.com/")).toBe(false);
  });
});
