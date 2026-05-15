/** YouTube search via yt-dlp `ytsearch` 前缀（`yt2x acquire` / pipeline 共用）。 */

import { execFileSync } from "node:child_process";

export type SearchResult = {
  url: string;
  title: string;
  channel: string;
  duration: number | null;
  viewCount: number | null;
};

/** 搜索结果的排序方式（在取前 N 条之前应用）。 */
export type SearchSort = "views";

const SEARCH_TAKE_MAX = 10;
const SEARCH_POOL_MIN = 20;
const SEARCH_POOL_MAX = 50;

export const parseSearchQuery = (input: string): { keywords: string; count: number } => {
  const match = /^(.+):(\d+)$/.exec(input.trim());
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { keywords: match[1].trim(), count: Math.min(parseInt(match[2], 10), SEARCH_TAKE_MAX) };
  }
  return { keywords: input.trim(), count: 3 };
};

/** `--search-sort views` 时向 yt-dlp 请求的候选条数（多于最终 N，便于按播放量重排）。 */
export const resolveSearchFetchCount = (takeCount: number, sort?: SearchSort): number => {
  if (sort === "views") {
    return Math.min(Math.max(takeCount * 5, SEARCH_POOL_MIN), SEARCH_POOL_MAX);
  }
  return takeCount;
};

export const sortSearchResults = (
  results: SearchResult[],
  sort: SearchSort | undefined,
  take: number,
): SearchResult[] => {
  if (sort === "views") {
    return [...results]
      .sort((a, b) => (b.viewCount ?? -1) - (a.viewCount ?? -1))
      .slice(0, take);
  }
  return results.slice(0, take);
};

const runYtSearch = (fetchCount: number, keywords: string, cookiesFromBrowser?: string): string => {
  const searchArg = `ytsearch${fetchCount}:${keywords}`;
  const args = [
    searchArg,
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
    "--no-progress",
  ];
  if (cookiesFromBrowser !== undefined && cookiesFromBrowser.length > 0) {
    args.push("--cookies-from-browser", cookiesFromBrowser);
  }
  return execFileSync("yt-dlp", args, {
    encoding: "utf-8",
    timeout: 30_000,
  });
};

const parseSearchStdout = (stdout: string): SearchResult[] =>
  stdout
    .trim()
    .split("\n")
    .map((line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const url = (entry.url ?? entry.webpage_url ?? "") as string;
        return {
          url,
          title: (entry.title ?? entry.fulltitle ?? "") as string,
          channel: (entry.channel ?? entry.uploader ?? "") as string,
          duration: (entry.duration as number | null | undefined) ?? null,
          viewCount: (entry.view_count as number | null | undefined) ?? null,
        };
      } catch {
        return null;
      }
    })
    .filter((r): r is SearchResult => r !== null && r.url.startsWith("https://"));

export const searchYouTubeDetailed = (
  query: string,
  cookiesFromBrowser?: string,
  sort?: SearchSort,
): SearchResult[] => {
  const { count, keywords } = parseSearchQuery(query);
  const fetchCount = resolveSearchFetchCount(count, sort);
  const stdout = runYtSearch(fetchCount, keywords, cookiesFromBrowser);
  const results = parseSearchStdout(stdout);

  if (results.length === 0) {
    throw new Error(`No YouTube results found for: "${keywords}"`);
  }

  return sortSearchResults(results, sort, count);
};

export const searchYouTube = (
  query: string,
  cookiesFromBrowser?: string,
  sort?: SearchSort,
): string[] => searchYouTubeDetailed(query, cookiesFromBrowser, sort).map((r) => r.url);
