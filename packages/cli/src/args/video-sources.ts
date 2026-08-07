import { z } from "zod";

export const SearchSortSchema = z.enum(["views"]);

export const VideoSourcesFieldsSchema = z
  .object({
    urls: z.array(z.string().url()).default([]),
    urlFile: z.string().min(1).optional(),
    search: z.string().min(1).optional(),
    searchSort: SearchSortSchema.optional(),
  })
  .refine((data) => data.searchSort === undefined || data.search !== undefined, {
    message: "--search-sort 需要同时提供 --search",
    path: ["searchSort"],
  });

export type VideoSourcesFields = z.infer<typeof VideoSourcesFieldsSchema>;

export const hasVideoSources = (sources: VideoSourcesFields): boolean =>
  sources.urls.length > 0 || sources.urlFile !== undefined || sources.search !== undefined;
