export const DEFAULTS = {
  daysToAnalyze: 14,
  maxResults: 30,
  loadDelayMs: 8000,
  sampleTitles: 5,
} as const;

export const MAX_PAGES = 8;
export const MAX_PERSONAL_PAGES = 5;

export const PICK_JSON_SCHEMA = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_PAGES,
    },
  },
  required: ["urls"],
} as const;
