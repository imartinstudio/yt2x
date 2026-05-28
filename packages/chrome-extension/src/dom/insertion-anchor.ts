const BLOCK_SELECTOR =
  "div[data-block='true'],div[data-block],p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,table,pre,div[dir='ltr']";

type TextMatch = {
  node: Text;
  offset: number;
};

export const normalizeAnchorText = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/[：:]/gu, ":")
    .replace(/\s+/gu, " ")
    .trim();

const listEditorBlocks = (editor: HTMLElement): HTMLElement[] => {
  const nodes = [...editor.querySelectorAll(BLOCK_SELECTOR)].filter(
    (node): node is HTMLElement => node instanceof HTMLElement && editor.contains(node),
  );
  if (nodes.length > 0) return nodes;
  return editor.innerHTML.trim().length > 0 ? [editor] : [];
};

const setRangeAtEnd = (element: HTMLElement): void => {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

const syncEditorSelection = (editor: HTMLElement): void => {
  document.dispatchEvent(new Event("selectionchange"));
  editor.dispatchEvent(new Event("select", { bubbles: true }));
};

const setRangeAtMatch = (match: TextMatch): void => {
  const range = document.createRange();
  const endOffset = Math.min(match.offset, match.node.data.length);
  range.setStart(match.node, endOffset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

export const focusByBlockIndex = (editor: HTMLElement, blockIndex: number): boolean => {
  const blocks = listEditorBlocks(editor);
  if (blocks.length === 0) return false;
  const index = Math.max(0, Math.min(blockIndex, blocks.length - 1));
  editor.focus({ preventScroll: true });
  setRangeAtEnd(blocks[index]!);
  syncEditorSelection(editor);
  return true;
};

export const focusEditorEnd = (editor: HTMLElement): void => {
  const blocks = listEditorBlocks(editor);
  editor.focus({ preventScroll: true });
  if (blocks.length > 0) {
    setRangeAtEnd(blocks.at(-1)!);
    syncEditorSelection(editor);
    return;
  }
  setRangeAtEnd(editor);
  syncEditorSelection(editor);
};

const anchorNeedles = (afterText: string): string[] => {
  const normalized = normalizeAnchorText(afterText);
  if (normalized.length === 0) return [];
  const needles = new Set<string>([normalized]);
  if (normalized.length > 40) needles.add(normalized.slice(-40));
  if (normalized.length > 20) needles.add(normalized.slice(-20));
  const colonIdx = normalized.lastIndexOf(":");
  if (colonIdx > 0) needles.add(normalized.slice(0, colonIdx + 1));
  return [...needles].sort((a, b) => b.length - a.length);
};

const needleVariants = (needle: string): string[] => {
  const variants = new Set<string>([needle]);
  if (needle.includes(":")) variants.add(needle.replaceAll(":", "："));
  if (needle.includes("：")) variants.add(needle.replaceAll("：", ":"));
  return [...variants];
};

const findAllTextMatches = (editor: HTMLElement, needle: string): TextMatch[] => {
  const matches: TextMatch[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node instanceof Text)) continue;
    for (const variant of needleVariants(needle)) {
      let from = 0;
      while (from < node.data.length) {
        const index = node.data.indexOf(variant, from);
        if (index < 0) break;
        matches.push({ node, offset: index + variant.length });
        from = index + variant.length;
      }
    }
  }
  return matches;
};

const editorBlockIndexForMatch = (editor: HTMLElement, match: TextMatch): number => {
  const blocks = listEditorBlocks(editor);
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index]!.contains(match.node)) return index;
  }
  return 0;
};

const pickMatchForBlockIndex = (
  editor: HTMLElement,
  matches: TextMatch[],
  blockIndex: number,
  totalBlocks: number,
): TextMatch => {
  if (matches.length === 1) return matches[0]!;
  const blocks = listEditorBlocks(editor);
  const target =
    totalBlocks <= 0
      ? 0
      : Math.round((blockIndex / totalBlocks) * Math.max(blocks.length - 1, 0));
  let best = matches[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const match of matches) {
    const distance = Math.abs(editorBlockIndexForMatch(editor, match) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = match;
    }
  }
  return best;
};

export const focusInsertionAnchor = (
  editor: HTMLElement,
  afterText: string,
  blockIndex: number,
  totalBlocks = 0,
): void => {
  for (const needle of anchorNeedles(afterText)) {
    const matches = findAllTextMatches(editor, needle);
    if (matches.length > 0) {
      const match =
        matches.length === 1
          ? matches[0]!
          : pickMatchForBlockIndex(editor, matches, blockIndex, totalBlocks);
      editor.focus({ preventScroll: true });
      setRangeAtMatch(match);
      syncEditorSelection(editor);
      return;
    }
  }

  if (focusByBlockIndex(editor, blockIndex)) return;

  throw new Error(
    `X Article insertion anchor was not found after block ${blockIndex}: "${afterText}"`,
  );
};

const blockElementFromRange = (range: Range): HTMLElement | null => {
  let node: Node | null = range.endContainer;
  if (node instanceof Text) node = node.parentElement;
  if (!(node instanceof HTMLElement)) return null;
  const block = node.closest(
    "div[data-block='true'],div[data-block],p,h1,h2,h3,h4,h5,h6,blockquote,li",
  );
  return block instanceof HTMLElement ? block : node;
};

/** Activate the target Draft.js block, then move the native caret to its end. */
export const activateInsertionAnchor = (
  editor: HTMLElement,
  afterText: string,
  blockIndex: number,
  totalBlocks = 0,
): void => {
  focusInsertionAnchor(editor, afterText, blockIndex, totalBlocks);
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  const block = blockElementFromRange(range);
  if (block instanceof HTMLElement) {
    block.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const endRange = document.createRange();
    endRange.selectNodeContents(block);
    endRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(endRange);
    syncEditorSelection(editor);
    return;
  }

  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  syncEditorSelection(editor);
};

export type SavedEditorSelection = {
  editor: HTMLElement;
  range: Range;
};

export const saveEditorSelection = (editor: HTMLElement): SavedEditorSelection | null => {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;
  return { editor, range: range.cloneRange() };
};

export const restoreEditorSelection = (saved: SavedEditorSelection | null): void => {
  if (saved === null) return;
  saved.editor.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(saved.range);
  syncEditorSelection(saved.editor);
};
