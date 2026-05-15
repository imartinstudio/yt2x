import { readFile } from "node:fs/promises";
import path from "node:path";
import { searchYouTubeDetailed, type SearchSort } from "../youtube/search.js";
import { normalizeYoutubeUrl, videoIdFromUrl } from "./video-id-from-url.js";

export type VideoSourceRow = { url: string; video_id: string; title: string };

export const extractVideoId = (url: string): string => videoIdFromUrl(url);

export type ResolveSourcesInput = {
  urls: string[];
  urlFile?: string;
  search?: string;
  searchSort?: SearchSort;
  cookiesFromBrowser?: string;
};

export const resolveVideoSources = async (input: ResolveSourcesInput): Promise<VideoSourceRow[]> => {
  const sources: VideoSourceRow[] = [];

  if (input.search !== undefined && input.search.length > 0) {
    const results = searchYouTubeDetailed(
      input.search,
      input.cookiesFromBrowser,
      input.searchSort,
    );
    for (const r of results) {
      sources.push({
        url: r.url,
        video_id: extractVideoId(r.url),
        title: r.title,
      });
    }
    return sources;
  }

  if (input.urlFile !== undefined && input.urlFile.length > 0) {
    const content = await readFile(path.resolve(input.urlFile), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("https://")) {
        sources.push({
          url: normalizeYoutubeUrl(trimmed),
          video_id: extractVideoId(trimmed),
          title: trimmed,
        });
      }
    }
    return sources;
  }

  for (const url of input.urls) {
      sources.push({
        url: normalizeYoutubeUrl(url),
        video_id: extractVideoId(url),
        title: url,
      });
  }

  if (sources.length === 0) {
    throw new Error("No video sources provided. Use --urls, --url-file, or --search.");
  }

  return sources;
};
