import { queryAllDeep } from "./dom-query.js";

export const LOCALE_PATTERNS = {
  published: /^已发布$/u,
  articlesHeading: /^文章$/u,
  addArticle: /^(?:添加|\+|add)$/iu,
  create: /create|创建|新建/iu,
  chooseFile: /choose file|选择文件|上传文件|browse files?/iu,
  addMedia: /add.*(?:photo|video)|添加照片或视频/iu,
  titlePlaceholder: /title/i,
  insert: /(?:^|\b)(?:insert|插入)(?:\b|$)|^insert$|^插入$/iu,
  insertAddMedia: /add\s*media\s*content|添加媒体内容/iu,
  mediaMenu: /^(?:media|媒体)$/iu,
  dividerMenu: /divider|分割线|分隔线/iu,
  codeMenu: /code|代码/iu,
  uploading: /uploading media|正在上传媒体/iu,
} as const;

const toButton = (node: Element): HTMLButtonElement | null => {
  if (node instanceof HTMLButtonElement) return node;
  const button = node.closest("button");
  return button instanceof HTMLButtonElement ? button : null;
};

const buttonLabel = (button: HTMLButtonElement): string => {
  const labelledBy = button.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const label = labelledBy
      .split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (label.length > 0) return label;
  }
  return (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? button.textContent ?? "")
    .trim();
};

export const findLeafElementsByText = (pattern: RegExp): HTMLElement[] => {
  const matches: HTMLElement[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node instanceof Text)) continue;
    const text = node.data.trim();
    if (!pattern.test(text)) continue;
    const parent = node.parentElement;
    if (parent instanceof HTMLElement) matches.push(parent);
  }
  return matches;
};

export const findLeafElementByText = (pattern: RegExp): HTMLElement | null =>
  findLeafElementsByText(pattern)[0] ?? null;

export const isAddMediaContentButton = (label: string): boolean =>
  LOCALE_PATTERNS.insertAddMedia.test(label) || /添加媒体/iu.test(label);

export const isGenericInsertButtonLabel = (label: string): boolean => {
  const trimmed = label.trim();
  if (trimmed.length === 0) return false;
  if (isAddMediaContentButton(trimmed)) return false;
  if (LOCALE_PATTERNS.addArticle.test(trimmed)) return false;
  if (/添加照片|添加视频|照片或视频|choose file|选择文件/iu.test(trimmed)) return false;
  if (/^(?:insert|插入|添加|more|更多)$/iu.test(trimmed)) return true;
  if (/(?:insert|插入)/iu.test(trimmed) && !/media|媒体|photo|video|照片|视频/iu.test(trimmed)) {
    return true;
  }
  return false;
};

const isInEditorChrome = (button: HTMLButtonElement, editor: HTMLElement): boolean => {
  const region = editor.closest("main,article,section,[role='main']") ?? editor.parentElement;
  if (region instanceof HTMLElement && region.contains(button)) return true;

  const buttonRect = button.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  if (buttonRect.width === 0 && buttonRect.height === 0) return false;
  return (
    buttonRect.bottom >= editorRect.top - 240 &&
    buttonRect.top <= editorRect.top + 40 &&
    buttonRect.left >= editorRect.left - 80 &&
    buttonRect.right <= editorRect.right + 200
  );
};

export const findButtonByName = (pattern: RegExp, root: ParentNode = document): HTMLButtonElement | null => {
  for (const node of queryAllDeep(root, "button,[role='button']")) {
    const button = toButton(node);
    if (button === null) continue;
    if (!pattern.test(buttonLabel(button))) continue;
    return button;
  }
  return null;
};

export const collectToolbarButtonLabels = (editor: HTMLElement): string[] => {
  const labels = new Set<string>();
  const root = editor.closest("main,article,section,[role='main']") ?? document.body;
  for (const node of queryAllDeep(root, "button,[role='button']")) {
    const button = toButton(node);
    if (button === null || !isVisibleButton(button)) continue;
    if (!isInEditorChrome(button, editor)) continue;
    const label = buttonLabel(button);
    labels.add(label.length > 0 ? label : `[icon:${button.getAttribute("data-testid") ?? "button"}]`);
  }
  return [...labels];
};

export const findGenericInsertButton = (): HTMLButtonElement | null => {
  const editor = articleEditors().at(-1);
  if (editor === undefined) return null;
  editor.focus();

  const sidebarAdd = findAddArticleButton();
  const root = editor.closest("main,article,section,[role='main']") ?? document.body;
  const ranked: HTMLButtonElement[] = [];

  for (const node of queryAllDeep(root, "button,[role='button']")) {
    const button = toButton(node);
    if (button === null || !isVisibleButton(button)) continue;
    if (button === sidebarAdd) continue;
    if (!isInEditorChrome(button, editor)) continue;

    const label = buttonLabel(button);
    const testId = button.getAttribute("data-testid") ?? "";
    const matchesLabel = isGenericInsertButtonLabel(label);
    const matchesTestId = /insert|插入|addcontent|toolbar/i.test(testId) && !/media/i.test(testId);

    if (matchesLabel || matchesTestId) ranked.push(button);
  }

  if (ranked.length > 0) return ranked[0]!;

  return findButtonByName(/insert|插入|添加/iu, root);
};

const isVisibleButton = (button: HTMLButtonElement): boolean => {
  const style = window.getComputedStyle(button);
  return style.display !== "none" && style.visibility !== "hidden";
};

const nodeMatchesPattern = (node: Element, pattern: RegExp): boolean => {
  const text = node.textContent?.trim() ?? "";
  const aria = node.getAttribute("aria-label") ?? "";
  return pattern.test(text) || pattern.test(aria);
};

export const findMenuItemByName = (pattern: RegExp): HTMLElement | null => {
  const selectors = [
    "[role='menuitem']",
    "[role='option']",
    "[role='menu'] button",
    "[role='listbox'] [role='option']",
  ];
  for (const selector of selectors) {
    for (const node of queryAllDeep(document, selector)) {
      if (!nodeMatchesPattern(node, pattern)) continue;
      return node instanceof HTMLElement ? node : null;
    }
  }
  for (const leaf of findLeafElementsByText(pattern)) {
    const clickable = leaf.closest(
      "[role='menuitem'],[role='option'],button,[role='button'],a,li",
    );
    if (clickable instanceof HTMLElement) return clickable;
  }
  return null;
};

export const findToolbarActionButton = (pattern: RegExp): HTMLButtonElement | null => {
  const editor = articleEditors().at(-1);
  if (editor === undefined) return null;
  const root = editor.closest("main,article,section,[role='main']") ?? document.body;
  for (const node of queryAllDeep(root, "button,[role='button']")) {
    const button = toButton(node);
    if (button === null || !isVisibleButton(button)) continue;
    if (!isInEditorChrome(button, editor)) continue;
    if (!pattern.test(buttonLabel(button))) continue;
    return button;
  }
  return null;
};

export const menuHasInsertItems = (): boolean =>
  findMenuItemByName(LOCALE_PATTERNS.codeMenu) !== null ||
  findMenuItemByName(LOCALE_PATTERNS.dividerMenu) !== null ||
  findToolbarActionButton(LOCALE_PATTERNS.codeMenu) !== null ||
  findToolbarActionButton(LOCALE_PATTERNS.dividerMenu) !== null;

export const findAddArticleButton = (): HTMLButtonElement | null => {
  const articles = findLeafElementByText(LOCALE_PATTERNS.articlesHeading);
  if (articles !== null) {
    const row =
      articles.closest('[role="tab"],[role="tablist"] > *,li,div,section,nav') ??
      articles.parentElement;
    const scopes = [row, row?.parentElement, row?.parentElement?.parentElement].filter(
      (scope): scope is HTMLElement => scope instanceof HTMLElement,
    );
    for (const scope of scopes) {
      for (const node of scope.querySelectorAll("button,[role='button']")) {
        const button = toButton(node);
        if (button === null) continue;
        if (LOCALE_PATTERNS.addArticle.test(buttonLabel(button))) return button;
      }
    }
  }

  const published = findLeafElementByText(LOCALE_PATTERNS.published);
  if (published !== null) {
    const publishedRow =
      published.closest('[role="tab"],li,div,section,nav') ?? published.parentElement;
    const container = publishedRow?.parentElement;
    if (container instanceof HTMLElement) {
      const rows = [...container.children].filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      );
      const publishedIndex = rows.findIndex((row) => row.contains(published));
      if (publishedIndex > 0) {
        const articlesRow = rows[publishedIndex - 1]!;
        for (const node of articlesRow.querySelectorAll("button,[role='button']")) {
          const button = toButton(node);
          if (button === null) continue;
          if (LOCALE_PATTERNS.addArticle.test(buttonLabel(button))) return button;
        }
        const fallback = articlesRow.querySelector("button,[role='button']");
        const button = fallback === null ? null : toButton(fallback);
        if (button !== null) return button;
      }
    }
  }

  return (
    findButtonByName(LOCALE_PATTERNS.addArticle) ?? findButtonByName(LOCALE_PATTERNS.create)
  );
};

/** Mount import button immediately after the Articles “添加” control (row above “已发布”). */
export const findImportButtonAnchor = (): HTMLElement | null => findAddArticleButton();

export const articleEditors = (): HTMLElement[] =>
  queryAllDeep(document, '[contenteditable="true"]').filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  );

const editorArea = (element: HTMLElement): number => {
  const rect = element.getBoundingClientRect();
  return Math.max(0, rect.width) * Math.max(0, rect.height);
};

const isLikelyBioEditor = (element: HTMLElement): boolean => {
  const sample = (element.innerText ?? element.textContent ?? "").slice(0, 300);
  if (/AI Coding Workflow|探索者|前端工程师|独立开发者/u.test(sample)) return true;
  return element.closest("footer,aside,[data-testid*='profile'],[data-testid*='bio']") !== null;
};

const isTitleFieldHint = (hint: string): boolean =>
  /添加标题|add\s*a\s*title|article\s*title/iu.test(hint);

export const isTitleComposerElement = (element: HTMLElement): boolean => {
  try {
    const title = findTitleField();
    return element === title || title.contains(element) || element.contains(title);
  } catch {
    return false;
  }
};

export const findTitleField = (): HTMLElement => {
  const candidates: HTMLElement[] = [];

  for (const node of queryAllDeep(
    document,
    '[data-placeholder],[placeholder],[aria-label],[contenteditable="true"],[role="textbox"]',
  )) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.closest('[role="dialog"]') !== null) continue;
    const hint =
      node.getAttribute("data-placeholder") ??
      node.getAttribute("placeholder") ??
      node.getAttribute("aria-label") ??
      "";
    if (!isTitleFieldHint(hint)) continue;
    const editable = node.closest('[contenteditable="true"],[role="textbox"]') ?? node;
    if (editable instanceof HTMLElement) candidates.push(editable);
  }

  for (const leaf of findLeafElementsByText(/^添加标题$/u)) {
    const editable = leaf.closest('[contenteditable="true"],[role="textbox"]');
    if (editable instanceof HTMLElement && editable.closest('[role="dialog"]') === null) {
      candidates.push(editable);
    }
  }

  if (candidates.length > 0) {
    return [...candidates].sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
    )[0]!;
  }

  const textboxes = queryAllDeep(document, '[role="textbox"]').filter(
    (node): node is HTMLElement =>
      node instanceof HTMLElement && node.closest('[role="dialog"]') === null,
  );
  if (textboxes.length > 0) {
    return [...textboxes].sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
    )[0]!;
  }

  throw new Error("X Articles title field was not found.");
};

export const pickArticleBodyEditor = (): HTMLElement => {
  for (const node of queryAllDeep(document, ".public-DraftEditor-content[contenteditable='true']")) {
    if (!(node instanceof HTMLElement)) continue;
    if (isLikelyBioEditor(node)) continue;
    if (editorArea(node) < 2_000) continue;
    return node;
  }

  const editors = articleEditors();
  if (editors.length === 0) {
    throw new Error("X Articles editor was not found on this page.");
  }
  if (editors.length === 1) return editors[0]!;

  let titleElement: HTMLElement | null = null;
  try {
    titleElement = findTitleField();
  } catch {
    titleElement = null;
  }

  const candidates = editors.filter((editor) => {
    if (editor === titleElement) return false;
    if (isLikelyBioEditor(editor)) return false;
    return true;
  });

  const pool = candidates.length > 0 ? candidates : editors;
  return [...pool].sort((a, b) => editorArea(b) - editorArea(a))[0]!;
};

export const articleEditor = (): HTMLElement => pickArticleBodyEditor();

export const readTitleFieldText = (field: HTMLElement): string => {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.value.replace(/\u200b/gu, "").trim();
  }
  return (field.innerText ?? field.textContent ?? "").replace(/\u200b/gu, "").trim();
};

export const titleFieldShowsPlaceholder = (field: HTMLElement): boolean => {
  const text = readTitleFieldText(field);
  return text.length === 0 || /^添加标题$/u.test(text);
};

const editorLooksReady = (editor: HTMLElement): boolean => {
  const rect = editor.getBoundingClientRect();
  return rect.height >= 48 && rect.width >= 120;
};

export type ArticleDraftShell = {
  titleField: HTMLElement;
  editor: HTMLElement;
};

export const waitForArticleDraftReady = (timeoutMs = 20_000): Promise<ArticleDraftShell> =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tryResolve = (): void => {
      try {
        const titleField = findTitleField();
        const editor = pickArticleBodyEditor();
        if (editorLooksReady(editor)) {
          observer.disconnect();
          resolve({ titleField, editor });
          return;
        }
      } catch {
        // Draft shell not ready yet.
      }
      if (Date.now() - started > timeoutMs) {
        observer.disconnect();
        reject(
          new Error(
            "Timed out waiting for X Articles draft shell (title field and body editor) to finish loading.",
          ),
        );
      }
    };
    const observer = new MutationObserver(tryResolve);
    observer.observe(document.body, { childList: true, subtree: true });
    tryResolve();
  });

export const waitForArticleEditor = (timeoutMs = 20_000): Promise<HTMLElement> =>
  waitForArticleDraftReady(timeoutMs).then((shell) => shell.editor);

export const createNewArticleDraft = async (): Promise<HTMLElement> => {
  const add = findAddArticleButton();
  if (add === null) {
    throw new Error(
      'X Articles "添加" button was not found beside "文章" (expected on the row above "已发布").',
    );
  }
  add.click();
  const shell = await waitForArticleDraftReady();
  return shell.editor;
};

/** @deprecated Use findTitleField */
export const titleField = (): HTMLElement => findTitleField();

export const editorHasContent = (editor: HTMLElement): boolean => {
  const raw = editor.innerText ?? editor.textContent ?? "";
  const text = raw.replace(/\u200b/gu, "").trim();
  return text.length > 0;
};
