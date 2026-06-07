import { collectLocalMediaReferences } from "@yt2x/core";

export type MediaRegistry = {
  resolveMediaPath: (source: string) => string;
  getUploadable: (resolvedPath: string) => File | undefined;
  missingSources: string[];
};

const normalizeRef = (source: string): string =>
  source.replaceAll("\\", "/").replace(/^\/+/u, "");

const basename = (source: string): string => {
  const normalized = normalizeRef(source);
  const parts = normalized.split("/");
  return parts.at(-1) ?? normalized;
};

export const buildMediaRegistry = (input: {
  markdown: string;
  authorizedFiles: File[];
}): MediaRegistry => {
  const refs = collectLocalMediaReferences(input.markdown);
  const byRelative = new Map<string, File>();
  const byBasename = new Map<string, File[]>();

  for (const file of input.authorizedFiles) {
    const relative = normalizeRef(file.webkitRelativePath || file.name);
    if (relative.length > 0) byRelative.set(relative, file);
    const name = basename(relative);
    const bucket = byBasename.get(name) ?? [];
    bucket.push(file);
    byBasename.set(name, bucket);
  }

  const resolved = new Map<string, File>();
  const missingSources: string[] = [];

  for (const source of refs) {
    const normalized = normalizeRef(source);
    const direct = byRelative.get(normalized);
    if (direct !== undefined) {
      resolved.set(normalized, direct);
      continue;
    }
    const candidates = byBasename.get(basename(normalized)) ?? [];
    if (candidates.length === 1) {
      resolved.set(normalized, candidates[0]!);
      continue;
    }
    missingSources.push(source);
  }

  return {
    resolveMediaPath: (source) => normalizeRef(source),
    getUploadable: (resolvedPath) => resolved.get(normalizeRef(resolvedPath)),
    missingSources,
  };
};

export const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read Markdown file."));
    reader.readAsText(file);
  });

export const pickMarkdownFile = (): Promise<File | null> =>
  pickFiles({ accept: "", multiple: false }).then((files) => files[0] ?? null);

export const pickSupplementalMedia = (): Promise<File[]> =>
  pickFiles({ accept: "image/*,video/*", multiple: true });

export const pickMediaDirectory = (): Promise<File[]> =>
  pickFiles({ accept: "image/*,video/*", multiple: true, directory: true });

export const pickArticleDirectory = (): Promise<File[]> =>
  pickFiles({ accept: "", multiple: true, directory: true });

const hasUserActivation = (): boolean => {
  if (!("userActivation" in navigator)) return true;
  return navigator.userActivation.isActive;
};

const pickFiles = (input: {
  accept: string;
  multiple: boolean;
  directory?: boolean;
}): Promise<File[]> =>
  new Promise((resolve, reject) => {
    const inputEl = document.createElement("input");
    inputEl.type = "file";
    inputEl.accept = input.accept;
    inputEl.multiple = input.multiple;
    if (input.directory === true) {
      inputEl.setAttribute("webkitdirectory", "");
      inputEl.setAttribute("directory", "");
    }
    inputEl.style.display = "none";
    document.body.appendChild(inputEl);
    const finish = (files: File[]): void => {
      inputEl.remove();
      resolve(files);
    };
    inputEl.addEventListener("change", () => finish([...(inputEl.files ?? [])]), { once: true });
    inputEl.addEventListener("cancel", () => finish([]), { once: true });
    if (!hasUserActivation()) {
      inputEl.remove();
      reject(new Error("File selection must be started from a direct click. Please use the import dialog's picker button."));
      return;
    }
    inputEl.click();
  });
