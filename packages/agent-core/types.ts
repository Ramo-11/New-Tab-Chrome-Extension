export interface SiteDigest {
  domain: string;
  visits: number;
  pages: number;
  lastVisit: string;
  score: number;
  sampleTitles: string[];
}

export interface GetHistoryResult {
  windowDays: number;
  totalSitesSeen: number;
  sites: SiteDigest[];
}

export interface RawSiteMetadata {
  domain: string;
  totalVisits: number;
  uniquePages: number;
  lastVisitTime: number;
  averageVisitsPerDay: number;
  titles: string[];
  urls: string[];
  relevanceScore: number;
}

export interface ScrapedPage {
  url: string;
  finalUrl?: string;
  title: string;
  html: string;
}

export interface FailedPage {
  url: string;
  reason: string;
}

export interface BrowserBridge {
  getHistory(args: {
    daysToAnalyze: number;
    maxResults: number;
  }): Promise<{ sites: RawSiteMetadata[]; totalSitesSeen: number }>;

  getPageHtml(args: {
    urls: string[];
    loadDelayMs?: number;
  }): Promise<{ pages: ScrapedPage[]; failed: FailedPage[] }>;
}

export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export type RunPhase =
  | "setup"
  | "history"
  | "thinking"
  | "scraping"
  | "analyzing"
  | "writing"
  | "cleanup"
  | "done"
  | "error";

export interface RunCallbacks {
  onPhase?(phase: RunPhase, detail?: string): void;
  onText?(text: string): void;
  onLog?(line: string): void;
}

export interface HomepageBuildResult {
  code: string;
  model: string;
  repaired: boolean;
}
