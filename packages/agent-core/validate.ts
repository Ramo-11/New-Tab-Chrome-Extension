export interface ValidationOptions {
  knownLinks: Iterable<string>;
  checkSyntax?: (code: string) => string | null;
  truncated?: boolean;
}

export interface ValidationReport {
  blocking: string[];
  unverifiedLinks: string[];
  problems: string[];
}

const DEFAULT_FUNCTION = /export\s+default\s+(?:async\s+)?function\s+PersonalizedHomepage\b/;
const DEFAULT_IDENTIFIER = /export\s+default\s+PersonalizedHomepage\b/;
const DEFAULT_ALIAS = /export\s*\{[^}]*\bPersonalizedHomepage\s+as\s+default\b[^}]*\}/;
const DECLARATION = /\b(?:function|const|let|var|class)\s+PersonalizedHomepage\b/;
const REACT_IMPORT = /import\s+(?:\*\s+as\s+)?React\b[^;'"]*from\s*['"]react['"]/;
const REAL_LINK = /https?:\/\/(?!www\.w3\.org)[^\s"'`<>]+/i;
const URL_LITERAL = /(["'`])(https?:\/\/[^"'`\s]+)\1/g;
const IGNORED_HOSTS = new Set(["www.w3.org"]);
const MAX_LISTED_LINKS = 8;

const MODULE_PATTERNS = [
  /(?:^|;)\s*import\s+(?:type\s+)?[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /(?:^|;)\s*import\s*['"]([^'"]+)['"]/gm,
  /(?:^|;)\s*export\s+(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\s*['"]([^'"]+)['"]/gm,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/&amp;/g, "&");
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return trimmed.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

export function foreignModules(code: string): string[] {
  const found = new Set<string>();
  for (const pattern of MODULE_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const name = match[1]!;
      if (name !== "react") found.add(name);
    }
  }
  return [...found];
}

export function extractLinkLiterals(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(URL_LITERAL)) {
    const url = match[2]!;
    if (url.includes("${")) continue;
    try {
      if (IGNORED_HOSTS.has(new URL(url).hostname)) continue;
    } catch {
      continue;
    }
    found.add(url);
  }
  return [...found];
}

export function findUnverifiedLinks(code: string, knownLinks: Iterable<string>): string[] {
  const known = new Set<string>();
  for (const link of knownLinks) known.add(normalizeUrl(link));
  return extractLinkLiterals(code).filter((url) => !known.has(normalizeUrl(url)));
}

export function validateHomepage(code: string, options: ValidationOptions): ValidationReport {
  const blocking: string[] = [];

  const exportsComponent =
    DEFAULT_FUNCTION.test(code) ||
    ((DEFAULT_IDENTIFIER.test(code) || DEFAULT_ALIAS.test(code)) && DECLARATION.test(code));
  if (!exportsComponent) {
    blocking.push("The file must default-export a component named PersonalizedHomepage.");
  }
  if (!REACT_IMPORT.test(code)) {
    blocking.push("The file must start with: import React from 'react'.");
  }
  const foreign = foreignModules(code);
  if (foreign.length > 0) {
    blocking.push(`Only 'react' may be imported, but the file also imports: ${foreign.join(", ")}.`);
  }
  if (!REAL_LINK.test(code)) {
    blocking.push("The page has no real http or https links.");
  }
  if (options.truncated) {
    blocking.push("The file was cut off before the end. Make it shorter so it fits.");
  }
  if (options.checkSyntax) {
    const syntaxError = options.checkSyntax(code);
    if (syntaxError) blocking.push(`Syntax error: ${syntaxError}`);
  }

  const unverifiedLinks = findUnverifiedLinks(code, options.knownLinks);
  const linkProblems = unverifiedLinks.slice(0, MAX_LISTED_LINKS).map(
    (url) => `This link does not appear in the provided pages: ${url}`,
  );
  if (unverifiedLinks.length > MAX_LISTED_LINKS) {
    linkProblems.push(`${unverifiedLinks.length - MAX_LISTED_LINKS} more links do not appear in the provided pages.`);
  }

  return { blocking, unverifiedLinks, problems: [...blocking, ...linkProblems] };
}

const EMOJI = /(?![\u00A9\u00AE\u2122])[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}][\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\p{Extended_Pictographic}]*[ \t]?/gu;

export function stripEmoji(code: string): string {
  return code.replace(EMOJI, "");
}

const FENCE = /```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/g;

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const blocks = [...trimmed.matchAll(FENCE)].map((match) => match[1]!.trim());
  let code = blocks.find((block) => block.includes("PersonalizedHomepage")) ?? blocks[0];
  if (code === undefined) {
    code = trimmed.replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, "").replace(/\r?\n?```\s*$/, "").trim();
  }
  if (!/^(?:import|export|["']use )/.test(code)) {
    const index = code.search(/^[ \t]*import\s+React\b/m);
    if (index > 0) code = code.slice(index).trim();
  }
  return code;
}
