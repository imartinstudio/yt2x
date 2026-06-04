/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Runs in the page MAIN world. Communicates with the yt2x content script via postMessage.
 * Inspired by Draft.js integration patterns used in X Articles import extensions.
 */
(() => {
  const WRITER_INSTANCE_KEY = "__YT2X_DRAFT_WRITER_V2__";
  if ((window as unknown as Record<string, boolean | undefined>)[WRITER_INSTANCE_KEY] === true) {
    return;
  }
  (window as unknown as Record<string, boolean | undefined>)[WRITER_INSTANCE_KEY] = true;

  const LOG = "[yt2x MAIN]";
  const CHANNEL_TO_MAIN = "yt2x-content-v2";
  const CHANNEL_FROM_MAIN = "yt2x-main-v2";
  const EDITOR_SELECTOR =
    "[data-contents='true'] [contenteditable='true'], [contenteditable='true'][role='textbox'], [contenteditable='true'].public-DraftEditor-content, [contenteditable='true']";
  const MEDIA_UPLOAD_BASE_TIMEOUT_MS = 90_000;
  const MEDIA_UPLOAD_PER_ITEM_TIMEOUT_MS = 2_500;
  const MEDIA_UPLOAD_MAX_TIMEOUT_MS = 150_000;
  const MEDIA_UPLOAD_PROGRESS_HEARTBEAT_MS = 15_000;
  const MEDIA_UPLOAD_PENDING_READY_MS = 20_000;
  const MEDIA_UPLOAD_PENDING_STABLE_MS = 5_000;
  const MEDIA_UPLOAD_TIMEOUT_ERROR =
    "X media upload took too long. Wait a moment, then import again or split the article.";

  type ImageFilePayload = {
    token: string;
    base64: string;
    mime: string;
    fileName: string;
  };

  type PlanOperation = {
    marker: string;
    op: {
      type: "atomic" | "image";
      entityType?: string;
      data?: Record<string, unknown>;
      mutability?: string;
      file?: { token: string };
      source?: string;
      fallbackText?: string;
    };
  };

  type WritePayload = {
    title?: string;
    blocks: Array<{
      type: string;
      text: string;
      inlineStyleRanges?: Array<{ offset: number; length: number; style: string }>;
      links?: Array<{ offset: number; length: number; url: string }>;
    }>;
    plan: PlanOperation[];
    html: string;
    plain: string;
    markerPrefix: string;
    imageFiles?: ImageFilePayload[];
  };

  const imageFileStore = new Map<string, ImageFilePayload>();
  let cancelRequested = false;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });

  const post = (kind: string, payload: Record<string, unknown> = {}): void => {
    window.postMessage({ source: CHANNEL_FROM_MAIN, kind, ...payload }, "*");
  };

  const progress = (text: string, level = "work"): void => {
    post("progress", { text, level });
  };

  const throwIfCancelled = (): void => {
    if (!cancelRequested) return;
    const error = new Error("Import stopped by user.");
    (error as Error & { cancelled?: boolean }).cancelled = true;
    throw error;
  };

  const requestPreparedFile = (operation: PlanOperation, timeoutMs = 30_000): Promise<ImageFilePayload> => {
    const token = operation.op.file?.token ?? "";
    const cached = imageFileStore.get(token);
    if (cached !== undefined) return Promise.resolve(cached);
    const requestId = `file_${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", listener);
        reject(new Error("Prepared image data did not arrive"));
      }, timeoutMs);
      const listener = (event: MessageEvent): void => {
        if (event.source !== window) return;
        const message = event.data as { source?: string; kind?: string; requestId?: string; file?: ImageFilePayload; error?: string };
        if (message?.source !== CHANNEL_TO_MAIN || message.kind !== "file-response" || message.requestId !== requestId) {
          return;
        }
        window.clearTimeout(timeout);
        window.removeEventListener("message", listener);
        if (message.file?.base64) resolve(message.file);
        else reject(new Error(message.error || "Prepared image data was not available"));
      };
      window.addEventListener("message", listener);
      post("file-request", { requestId, token, marker: operation.marker });
    });
  };

  const findEditorElement = (): HTMLElement | null => {
    for (const element of document.querySelectorAll(EDITOR_SELECTOR)) {
      if (!(element instanceof HTMLElement)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 80) return element;
    }
    return null;
  };

  const reactFiberFromElement = (element: HTMLElement): any | null => {
    const fiberKey = Object.keys(element).find(
      (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"),
    );
    return fiberKey === undefined ? null : (element as unknown as Record<string, unknown>)[fiberKey];
  };

  const draftNodeFromFiber = (startFiber: any): any | null => {
    let fiber = startFiber;
    for (let depth = 0; depth < 80 && fiber; depth += 1) {
      const stateNode = fiber.stateNode;
      if (stateNode?.props?.editorState && typeof stateNode.props.onChange === "function") {
        return stateNode;
      }
      const memoizedProps = fiber.memoizedProps;
      if (memoizedProps?.editorState && typeof memoizedProps.onChange === "function") {
        return { props: memoizedProps };
      }
      const pendingProps = fiber.pendingProps;
      if (pendingProps?.editorState && typeof pendingProps.onChange === "function") {
        return { props: pendingProps };
      }
      fiber = fiber.return;
    }
    return null;
  };

  const findDraftStateNodeForElement = (editor: HTMLElement | null): any | null => {
    let current: HTMLElement | null = editor;
    for (let hops = 0; hops < 8 && current !== null; hops += 1) {
      const direct = draftNodeFromFiber(reactFiberFromElement(current));
      if (direct !== null) return direct;
      current = current.parentElement;
    }
    return null;
  };

  const findDraftStateNode = (): any | null => findDraftStateNodeForElement(findEditorElement());

  const findOnFilesAdded = (): ((files: File[]) => void) | null => {
    const editor = findEditorElement();
    if (editor === null) return null;
    const fiberKey = Object.keys(editor).find(
      (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"),
    );
    if (fiberKey === undefined) return null;
    let fiber = (editor as unknown as Record<string, unknown>)[fiberKey] as any;
    for (let depth = 0; depth < 160 && fiber; depth += 1) {
      const props = fiber.memoizedProps || fiber.stateNode?.props;
      if (typeof props?.onFilesAdded === "function") return props.onFilesAdded;
      fiber = fiber.return;
    }
    return null;
  };

  const pasteHtml = (html: string, plain: string): boolean => {
    const editor = findEditorElement();
    if (editor === null) return false;
    editor.focus();
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", plain || html.replace(/<[^>]*>/g, ""));
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    if (event.clipboardData !== data) {
      Object.defineProperty(event, "clipboardData", { value: data });
    }
    return editor.dispatchEvent(event);
  };

  const isDraftCharacterMetadata = (character: any, requireStyle = true): boolean =>
    Boolean(character?.set && (!requireStyle || character.getStyle));

  const firstCharacterMetadata = (block: any, requireStyle = true): any | null => {
    const characterList = block?.getCharacterList?.();
    if (!characterList) return null;
    const size =
      typeof characterList.size === "number"
        ? characterList.size
        : typeof characterList.count === "function"
          ? characterList.count()
          : 0;
    for (let index = 0; index < size; index += 1) {
      const character = characterList.get?.(index);
      if (isDraftCharacterMetadata(character, requireStyle)) return character;
    }
    const first = characterList.first?.() || characterList.get?.(0);
    return isDraftCharacterMetadata(first, requireStyle) ? first : null;
  };

  const findDraftCharacterSample = (draftNode: any): { block: any; character: any } | null => {
    const blockMap = draftNode?.props?.editorState?.getCurrentContent?.()?.getBlockMap?.();
    if (!blockMap?.find) return null;
    const block =
      blockMap.find((candidate: any) => Boolean(firstCharacterMetadata(candidate))) || null;
    return block ? { block, character: firstCharacterMetadata(block) } : null;
  };

  const findDraftSampleBlock = (draftNode: any): any | null => findDraftCharacterSample(draftNode)?.block || null;

  const ensureDraftCharacterSample = async (draftNode: any): Promise<any> => {
    if (findDraftSampleBlock(draftNode)) return draftNode;
    const editor = findEditorElement();
    if (editor === null) return draftNode;
    editor.focus();
    document.execCommand("insertText", false, "x");
    const deadline = Date.now() + 1_600;
    while (Date.now() < deadline) {
      await sleep(80);
      const latestNode = findDraftStateNode() || draftNode;
      if (findDraftSampleBlock(latestNode)) return latestNode;
    }
    return findDraftStateNode() || draftNode;
  };

  const draftInlineStyleName = (style: string): string =>
    ({ Bold: "BOLD", Italic: "ITALIC", Strikethrough: "STRIKETHROUGH", Code: "CODE" })[style] || style;

  const writeDraftBlocks = (draftNode: any, blocks: WritePayload["blocks"]): { ok: boolean; error?: string } => {
    if (!Array.isArray(blocks) || blocks.length === 0) return { ok: false, error: "No structured blocks" };

    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    const blockMap = contentState.getBlockMap();
    const sample = findDraftCharacterSample(draftNode);
    const sampleBlock = sample?.block || null;
    const sampleCharacter = sample?.character || null;
    if (!sampleBlock || !sampleCharacter) {
      return { ok: false, error: "No Draft.js character sample for structured write" };
    }

    const BlockMap = blockMap.constructor;
    const CharacterList = sampleBlock.getCharacterList().constructor;
    let nextContent = contentState;
    let nextBlockMap = BlockMap();
    const createdKeys: string[] = [];

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      const text = String(block.text || "");
      const key = `${Math.random().toString(36).slice(2, 7)}${index.toString(36)}`;
      let characterList = CharacterList();
      const entityRanges = new Map<string, string>();

      for (const link of block.links || []) {
        const offset = Number(link.offset) || 0;
        const length = Math.max(0, Number(link.length) || 0);
        if (length === 0 || !link.url) continue;
        nextContent = nextContent.createEntity("LINK", "MUTABLE", { url: String(link.url) });
        entityRanges.set(`${offset}:${offset + length}`, nextContent.getLastCreatedEntityKey());
      }

      for (let charIndex = 0; charIndex < text.length; charIndex += 1) {
        const styleNames = (block.inlineStyleRanges || [])
          .filter((range) => charIndex >= range.offset && charIndex < range.offset + range.length)
          .map((range) => draftInlineStyleName(range.style))
          .filter(Boolean);
        let entity: string | null = null;
        for (const [range, entityKey] of entityRanges.entries()) {
          const [startText, endText] = range.split(":");
          const start = Number(startText);
          const end = Number(endText);
          if (Number.isFinite(start) && Number.isFinite(end) && charIndex >= start && charIndex < end) {
            entity = entityKey;
            break;
          }
        }
        let style = sampleCharacter.getStyle().clear();
        for (const styleName of styleNames) style = style.add(styleName);
        characterList = characterList.push(sampleCharacter.set("style", style).set("entity", entity));
      }

      const nextBlock = sampleBlock.merge({
        key,
        type: block.type || "unstyled",
        text,
        characterList,
        depth: 0,
        data: sampleBlock.getData?.()?.clear?.() || sampleBlock.getData?.(),
      });
      nextBlockMap = nextBlockMap.set(key, nextBlock);
      createdKeys.push(key);
    }

    if (createdKeys.length === 0) return { ok: false, error: "No Draft.js blocks created" };
    const lastKey = createdKeys[createdKeys.length - 1]!;
    const selection = SelectionState.createEmpty(lastKey);
    const nextState = nextContent
      .set("blockMap", nextBlockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextState, "insert-fragment");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    draftNode.props.onChange(nextEditorState);
    return { ok: true };
  };

  const markerTokenPattern = (prefix: string): RegExp =>
    new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Z]+_\\d+__`, "g");

  const findMarkerLocation = (contentState: any, marker: string, exactOnly = false): any | null => {
    const needle = String(marker || "");
    if (needle.length === 0) return null;
    let exact: any | null = null;
    let partial: any | null = null;
    contentState.getBlockMap().forEach((block: any, key: string) => {
      if (block.getType() === "atomic") return;
      const text = block.getText() || "";
      const offset = text.indexOf(needle);
      if (offset < 0) return;
      const candidate = { blockKey: key, offset, length: needle.length, exact: text.trim() === needle };
      if (candidate.exact && !exact) exact = candidate;
      else if (!partial) partial = candidate;
    });
    if (exact) return exact;
    return exactOnly ? null : partial;
  };

  const countMarkerTokens = (draftNode: any, prefix: string): number => {
    if (!draftNode || !prefix) return 0;
    let count = 0;
    const markerPattern = markerTokenPattern(prefix);
    draftNode.props.editorState
      .getCurrentContent()
      .getBlockMap()
      .forEach((block: any) => {
        const matches = (block.getText() || "").match(markerPattern);
        if (matches?.length) count += matches.length;
      });
    return count;
  };

  const waitForDraftMarkers = async (markerPrefix: string, expectedCount: number, timeoutMs = 4_000): Promise<any | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const latestNode = findDraftStateNode();
      if (latestNode && countMarkerTokens(latestNode, markerPrefix) >= expectedCount) return latestNode;
      await sleep(100);
    }
    return findDraftStateNode();
  };

  const replaceMarkerWithAtomic = (
    contentState: any,
    marker: string,
    entityType: string,
    data: Record<string, unknown>,
    mutability: string,
    sampleBlock: any,
  ): { ok: boolean; error?: string; contentState?: any } => {
    const blockKey = findMarkerLocation(contentState, marker, true)?.blockKey;
    if (!blockKey) return { ok: false, error: `Marker not found: ${marker}` };

    const markerBlock = contentState.getBlockMap().get(blockKey);
    const blockTemplate = markerBlock || sampleBlock;
    const characterList = markerBlock.getCharacterList();
    const markerCharacter = firstCharacterMetadata(markerBlock, false);
    const fallbackCharacter = firstCharacterMetadata(sampleBlock, false);
    const sampleCharacter = markerCharacter?.set ? markerCharacter : fallbackCharacter;
    if (!sampleCharacter?.set) {
      return { ok: false, error: `No Draft.js character sample for marker: ${marker}` };
    }
    const CharacterList = characterList.constructor;
    const withEntity = contentState.createEntity(entityType, mutability || "IMMUTABLE", data || {});
    const entityKey = withEntity.getLastCreatedEntityKey();
    const character = sampleCharacter.set("entity", entityKey);
    const atomicBlock = blockTemplate.merge({
      key: blockKey,
      type: "atomic",
      text: " ",
      characterList: CharacterList([character]),
      depth: 0,
    });
    const blockMap = withEntity.getBlockMap().set(blockKey, atomicBlock);
    return { ok: true, contentState: withEntity.set("blockMap", blockMap) };
  };

  const insertAtomicBatch = (draftNode: any, operations: PlanOperation[]): { okCount: number; failCount: number; errors: string[] } => {
    if (operations.length === 0) return { okCount: 0, failCount: 0, errors: [] };
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    let contentState = editorState.getCurrentContent();
    const sampleBlock = findDraftSampleBlock(draftNode);
    let okCount = 0;
    const errors: string[] = [];

    for (const item of operations) {
      const result = replaceMarkerWithAtomic(
        contentState,
        item.marker,
        item.op.entityType || "DIVIDER",
        item.op.data || {},
        item.op.mutability || "IMMUTABLE",
        sampleBlock,
      );
      if (result.ok && result.contentState) {
        contentState = result.contentState;
        okCount += 1;
      } else {
        errors.push(result.error || "Atomic insert failed");
      }
    }

    if (okCount > 0) {
      const lastKey = contentState.getBlockMap().last().getKey();
      const selection = SelectionState.createEmpty(lastKey);
      const nextState = contentState.merge({ selectionBefore: selection, selectionAfter: selection });
      let nextEditorState = EditorState.push(editorState, nextState, "insert-characters");
      nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
      draftNode.props.onChange(nextEditorState);
    }

    return { okCount, failCount: errors.length, errors };
  };

  const base64ToFile = (base64: string, fileName: string, mime: string): File => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], fileName, { type: mime });
  };

  const normalizeMediaIdValue = (value: unknown): string | null => {
    if (value == null || value === "") return null;
    const text = String(value).trim();
    if (text.length === 0) return null;
    if (/^\d+$/u.test(text)) return text;
    const mediaKey = text.match(/^\d+_(\d+)$/u);
    if (mediaKey) return mediaKey[1]!;
    const trailingDigits = text.match(/(?:^|[_:])(\d{8,})$/u);
    return trailingDigits ? trailingDigits[1]! : null;
  };

  const mediaIdFromEntityData = (data: unknown, depth = 0): string | null => {
    if (data == null || depth > 5) return null;
    const primitive = normalizeMediaIdValue(data);
    if (primitive) return primitive;
    if (typeof data !== "object") return null;
    if (Array.isArray(data)) {
      for (const item of data) {
        const mediaId = mediaIdFromEntityData(item, depth + 1);
        if (mediaId) return mediaId;
      }
      return null;
    }
    const record = data as Record<string, unknown>;
    for (const key of ["mediaId", "media_id", "media_id_string", "id_str", "id", "rest_id"]) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const mediaId = normalizeMediaIdValue(record[key]);
      if (mediaId) return mediaId;
    }
    for (const key of ["mediaItems", "mediaItem", "media", "data"]) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const mediaId = mediaIdFromEntityData(record[key], depth + 1);
      if (mediaId) return mediaId;
    }
    return null;
  };

  const existingMediaEntities = (contentState: any): Set<string> => {
    const entities = new Set<string>();
    contentState.getBlockMap().forEach((block: any) => {
      if (block.getType() !== "atomic") return;
      block.findEntityRanges(
        (character: any) => Boolean(character.getEntity()),
        (start: number) => {
          const entityKey = block.getCharacterList().get(start)?.getEntity?.();
          if (!entityKey) return;
          try {
            if (contentState.getEntity(entityKey).getType() === "MEDIA") entities.add(entityKey);
          } catch {
            // Ignore stale entity references while X is updating the draft.
          }
        },
      );
    });
    return entities;
  };

  const findNewMediaUpload = (contentState: any, before: Set<string>): any | null => {
    let complete: any | null = null;
    let pending: any | null = null;
    contentState.getBlockMap().forEach((block: any, blockKey: string) => {
      if (block.getType() !== "atomic") return;
      block.findEntityRanges(
        (character: any) => Boolean(character.getEntity()),
        (start: number) => {
          const entityKey = block.getCharacterList().get(start)?.getEntity?.();
          if (!entityKey || before.has(entityKey)) return;
          try {
            const entity = contentState.getEntity(entityKey);
            if (entity.getType() !== "MEDIA") return;
            const candidate = { entityKey, blockKey, mediaId: mediaIdFromEntityData(entity.getData()) };
            if (candidate.mediaId) complete = candidate;
            else pending ||= candidate;
          } catch {
            // Ignore stale entity references while X is updating the draft.
          }
        },
      );
    });
    return complete || pending;
  };

  const placeSelectionAtMarker = (draftNode: any, marker: string): any | null => {
    const editorState = draftNode.props.editorState;
    const SelectionState = editorState.getSelection().constructor;
    const EditorState = editorState.constructor;
    const contentState = editorState.getCurrentContent();
    const location = findMarkerLocation(contentState, marker);
    if (!location) return null;
    const selection = SelectionState.createEmpty(location.blockKey).merge({
      anchorOffset: location.offset,
      focusOffset: location.offset,
    });
    draftNode.props.onChange(EditorState.forceSelection(editorState, selection));
    return location;
  };

  const replaceMarkerText = (draftNode: any, marker: string, text: string): boolean => {
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const contentState = editorState.getCurrentContent();
    const location = findMarkerLocation(contentState, marker, true);
    if (!location) return false;
    const block = contentState.getBlockForKey(location.blockKey);
    const nextText = (block.getText() || "").replace(marker, text);
    const nextBlock = block.merge({ text: nextText });
    const nextContent = contentState.merge({
      blockMap: contentState.getBlockMap().set(location.blockKey, nextBlock),
    });
    draftNode.props.onChange(EditorState.push(editorState, nextContent, "change-block-data"));
    return true;
  };

  const uploadImageAtMarker = async (
    draftNode: any,
    imageOperation: PlanOperation,
    existingAtomicBlocks: Set<string>,
    context: { index?: number; total?: number } = {},
  ): Promise<{
    ok: boolean;
    error?: string;
    blockKey?: string;
    entityKey?: string;
    mediaPending?: boolean;
    markerBlock?: string;
    markerOffset?: number;
    markerLength?: number;
    markerExact?: boolean;
  }> => {
    throwIfCancelled();
    const onFilesAdded = findOnFilesAdded();
    if (!onFilesAdded) return { ok: false, error: "X upload handler was not reachable" };

    const markerLocation = placeSelectionAtMarker(draftNode, imageOperation.marker);
    if (!markerLocation) return { ok: false, error: "Image placeholder was not found in the X editor" };
    await sleep(80);

    const before = existingMediaEntities(draftNode.props.editorState.getCurrentContent());
    const preparedFile = await requestPreparedFile(imageOperation);
    throwIfCancelled();
    const file = base64ToFile(preparedFile.base64, preparedFile.fileName, preparedFile.mime);
    onFilesAdded([file]);

    const timeoutMs = Math.min(
      MEDIA_UPLOAD_MAX_TIMEOUT_MS,
      MEDIA_UPLOAD_BASE_TIMEOUT_MS + Math.max(0, Number(context.total || 0) - 1) * MEDIA_UPLOAD_PER_ITEM_TIMEOUT_MS,
    );
    const deadline = Date.now() + timeoutMs;
    let nextProgressAt = Date.now() + MEDIA_UPLOAD_PROGRESS_HEARTBEAT_MS;
    let pendingUpload: any | null = null;
    let pendingSignature = "";
    let pendingFirstSeenAt = 0;
    let pendingStableSince = 0;

    while (Date.now() < deadline) {
      throwIfCancelled();
      await sleep(350);
      const now = Date.now();
      if (now >= nextProgressAt) {
        const index = Number(context.index || 0);
        const total = Number(context.total || 0);
        if (index && total) {
          progress(
            pendingUpload
              ? `Uploading image ${index}/${total}... waiting for X to finish.`
              : `Uploading image ${index}/${total}...`,
          );
        }
        nextProgressAt = Date.now() + MEDIA_UPLOAD_PROGRESS_HEARTBEAT_MS;
      }
      draftNode = findDraftStateNode() || draftNode;
      const contentState = draftNode.props.editorState.getCurrentContent();
      const found = findNewMediaUpload(contentState, before);
      if (found?.mediaId) {
        existingAtomicBlocks.add(found.blockKey);
        return {
          ok: true,
          blockKey: found.blockKey,
          entityKey: found.entityKey,
          markerBlock: markerLocation.blockKey,
          markerOffset: markerLocation.offset,
          markerLength: markerLocation.length,
          markerExact: markerLocation.exact,
        };
      }
      if (found) {
        const signature = `${found.entityKey}:${found.blockKey}`;
        if (signature !== pendingSignature) {
          pendingSignature = signature;
          pendingFirstSeenAt = now;
          pendingStableSince = now;
        }
        pendingUpload = found;
        const pendingReady =
          now - pendingFirstSeenAt >= MEDIA_UPLOAD_PENDING_READY_MS &&
          now - pendingStableSince >= MEDIA_UPLOAD_PENDING_STABLE_MS;
        if (pendingReady) {
          existingAtomicBlocks.add(found.blockKey);
          return {
            ok: true,
            blockKey: found.blockKey,
            entityKey: found.entityKey,
            mediaPending: true,
            markerBlock: markerLocation.blockKey,
            markerOffset: markerLocation.offset,
            markerLength: markerLocation.length,
            markerExact: markerLocation.exact,
          };
        }
      }
    }

    return { ok: false, error: MEDIA_UPLOAD_TIMEOUT_ERROR };
  };

  type ImageUploadRecord = {
    marker: string;
    blockKey?: string | undefined;
    entityKey?: string | undefined;
    markerBlock?: string | undefined;
    markerOffset?: number | undefined;
    markerLength?: number | undefined;
    markerExact?: boolean | undefined;
    source?: string | null | undefined;
  };

  const relocateImages = (
    draftNode: any,
    uploads: ImageUploadRecord[],
    protectedAtomicBlocks: Set<string>,
  ): { moved: number; missing: number } => {
    if (uploads.length === 0) return { moved: 0, missing: 0 };

    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    const blockMap = contentState.getBlockMap();
    const entityToBlock = new Map<string, string>();
    const mediaBlocks: Array<{ blockKey: string; entityKey: string }> = [];

    for (const upload of uploads) {
      if (upload.markerBlock && blockMap.has(upload.markerBlock)) continue;
      const location = findMarkerLocation(contentState, upload.marker);
      if (!location) continue;
      upload.markerBlock = location.blockKey;
      upload.markerOffset = location.offset;
      upload.markerLength = location.length;
      upload.markerExact = location.exact;
    }

    blockMap.forEach((block: any, blockKey: string) => {
      if (block.getType() !== "atomic") return;
      let firstEntity: string | null = null;
      block.findEntityRanges(
        (character: any) => Boolean(character.getEntity()),
        (start: number) => {
          const entityKey = block.getCharacterList().get(start)?.getEntity?.();
          if (entityKey) {
            firstEntity ||= entityKey;
            entityToBlock.set(entityKey, blockKey);
          }
        },
      );
      if (!protectedAtomicBlocks.has(blockKey) && firstEntity) {
        try {
          if (contentState.getEntity(firstEntity).getType() === "MEDIA") {
            mediaBlocks.push({ blockKey, entityKey: firstEntity });
          }
        } catch {
          // Ignore stale entity references while X updates the draft.
        }
      }
    });

    const moves = new Map<string, { imageBlock: string; markerExact: boolean }>();
    let missing = 0;
    let fallbackIndex = 0;

    for (const upload of uploads) {
      if (!upload.markerBlock || !blockMap.has(upload.markerBlock)) {
        missing += 1;
        continue;
      }
      let imageBlock = upload.entityKey ? entityToBlock.get(upload.entityKey) : undefined;
      if (!imageBlock) {
        while (fallbackIndex < mediaBlocks.length && moves.has(mediaBlocks[fallbackIndex]!.blockKey)) {
          fallbackIndex += 1;
        }
        imageBlock = mediaBlocks[fallbackIndex]?.blockKey;
        fallbackIndex += 1;
      }
      if (!imageBlock) {
        missing += 1;
        continue;
      }
      if (imageBlock !== upload.markerBlock) {
        moves.set(upload.markerBlock, {
          imageBlock,
          markerExact: upload.markerExact !== false,
        });
      }
    }

    if (moves.size === 0) return { moved: 0, missing };

    const destinationBlocks = new Set(Array.from(moves.values()).map((move) => move.imageBlock));
    const orderedKeys: string[] = [];
    blockMap.forEach((_block: any, key: string) => {
      if (moves.has(key)) {
        const move = moves.get(key)!;
        orderedKeys.push(move.imageBlock);
        if (!move.markerExact) orderedKeys.push(key);
      } else if (!destinationBlocks.has(key)) {
        orderedKeys.push(key);
      }
    });

    const BlockMap = blockMap.constructor;
    let nextBlockMap = BlockMap();
    for (const key of orderedKeys) {
      nextBlockMap = nextBlockMap.set(key, blockMap.get(key));
    }
    const lastKey = orderedKeys[orderedKeys.length - 1]!;
    const selection = SelectionState.createEmpty(lastKey);
    const nextContent = contentState
      .set("blockMap", nextBlockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextContent, "remove-range");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    draftNode.props.onChange(nextEditorState);
    return { moved: moves.size, missing };
  };

  const cleanupMarkers = (draftNode: any, markerPrefix: string): number => {
    const editorState = draftNode.props.editorState;
    const EditorState = editorState.constructor;
    const SelectionState = editorState.getSelection().constructor;
    const contentState = editorState.getCurrentContent();
    let blockMap = contentState.getBlockMap();
    const markerPattern = markerTokenPattern(markerPrefix);
    const toDelete: string[] = [];
    const replacements: Array<{ key: string; text: string }> = [];

    blockMap.forEach((block: any, key: string) => {
      if (block.getType() === "atomic") return;
      const text = block.getText() || "";
      if (!text.includes(markerPrefix)) return;
      const cleaned = text.replace(markerPattern, "").replace(/\s{2,}/gu, " ").trim();
      if (cleaned.length === 0) {
        toDelete.push(key);
        return;
      }
      if (cleaned !== text) replacements.push({ key, text: cleaned });
    });

    if (toDelete.length === 0 && replacements.length === 0) return 0;

    for (const replacement of replacements) {
      const block = blockMap.get(replacement.key);
      if (!block) continue;
      const characterFactory = block.getCharacterList().get(0)?.constructor;
      const character = characterFactory ? characterFactory.create({}) : null;
      const characterList = block
        .getCharacterList()
        .clear()
        .concat(Array.from({ length: replacement.text.length }, () => character));
      blockMap = blockMap.set(
        replacement.key,
        block.merge({ text: replacement.text, characterList }),
      );
    }
    for (const key of toDelete) blockMap = blockMap.delete(key);

    const lastKey = blockMap.last()?.getKey?.();
    const selection = lastKey
      ? SelectionState.createEmpty(lastKey)
      : editorState.getSelection();
    const nextContent = contentState
      .set("blockMap", blockMap)
      .set("selectionBefore", selection)
      .set("selectionAfter", selection);
    let nextEditorState = EditorState.push(editorState, nextContent, "remove-range");
    nextEditorState = EditorState.moveSelectionToEnd(nextEditorState);
    draftNode.props.onChange(nextEditorState);
    return toDelete.length + replacements.length;
  };

  const kickRender = (draftNode: any): void => {
    const EditorState = draftNode.props.editorState.constructor;
    draftNode.props.onChange(EditorState.moveSelectionToEnd(draftNode.props.editorState));
  };

  const runFlow = async (payload: WritePayload): Promise<void> => {
    cancelRequested = false;
    imageFileStore.clear();
    for (const file of payload.imageFiles || []) {
      imageFileStore.set(file.token, file);
    }

    let draftNode = findDraftStateNode();
    if (!draftNode) throw new Error("X Draft.js editor was not reachable");

    const summary = {
      atomicOk: 0,
      atomicFail: 0,
      imgOk: 0,
      imgFail: 0,
      imageErrors: [] as Array<{ index: number; marker: string; source: string | null; error: string }>,
      markersCleaned: 0,
      relocatedImages: 0,
    };

    throwIfCancelled();
    progress("Writing structured Markdown into the X Articles editor...");
    draftNode = await ensureDraftCharacterSample(draftNode);
    throwIfCancelled();

    const writeResult = writeDraftBlocks(draftNode, payload.blocks);
    if (!writeResult.ok) {
      console.warn(LOG, "structured block write failed; falling back to paste", writeResult.error);
      pasteHtml(payload.html, payload.plain);
    }

    draftNode = (await waitForDraftMarkers(payload.markerPrefix, payload.plan.length)) || draftNode;
    if (!draftNode) throw new Error("X Draft.js editor was not reachable after writing Markdown");
    await sleep(150);

    const atomicOps = payload.plan.filter((item) => item.op.type === "atomic");
    const imageOps = payload.plan.filter((item) => item.op.type === "image");

    if (atomicOps.length > 0) {
      throwIfCancelled();
      progress(`Inserting ${atomicOps.length} special block(s)...`);
      draftNode = findDraftStateNode() || draftNode;
      const result = insertAtomicBatch(draftNode, atomicOps);
      summary.atomicOk = result.okCount;
      summary.atomicFail = result.failCount;
      if (result.errors.length > 0) console.warn(LOG, "atomic failures", result.errors);
      await sleep(350);
    }

    draftNode = findDraftStateNode() || draftNode;
    const protectedAtomicBlocks = new Set<string>();
    draftNode.props.editorState
      .getCurrentContent()
      .getBlockMap()
      .forEach((block: any, key: string) => {
        if (block.getType() === "atomic") protectedAtomicBlocks.add(key);
      });

    const uploads: ImageUploadRecord[] = [];

    for (let index = 0; index < imageOps.length; index += 1) {
      throwIfCancelled();
      draftNode = findDraftStateNode() || draftNode;
      const op = imageOps[index]!;
      progress(`Uploading image ${index + 1}/${imageOps.length}...`);
      const result = await uploadImageAtMarker(draftNode, op, protectedAtomicBlocks, {
        index: index + 1,
        total: imageOps.length,
      });
      if (result.ok) {
        summary.imgOk += 1;
        uploads.push({
          marker: op.marker,
          blockKey: result.blockKey,
          entityKey: result.entityKey,
          markerBlock: result.markerBlock,
          markerOffset: result.markerOffset,
          markerLength: result.markerLength,
          markerExact: result.markerExact,
          source: op.op.source ?? null,
        });
      } else {
        summary.imgFail += 1;
        summary.imageErrors.push({
          index: index + 1,
          marker: op.marker,
          source: op.op.source || null,
          error: result.error || "Image upload failed",
        });
        replaceMarkerText(draftNode, op.marker, op.op.fallbackText || "[image upload failed]");
      }
      draftNode = findDraftStateNode() || draftNode;
    }

    if (uploads.length > 0) {
      throwIfCancelled();
      progress("Reordering uploaded images into document positions...");
      await sleep(900);
      draftNode = findDraftStateNode() || draftNode;
      const relocateResult = relocateImages(draftNode, uploads, protectedAtomicBlocks);
      summary.relocatedImages = relocateResult.moved;
      if (relocateResult.missing > 0) {
        console.warn(LOG, "some images could not be relocated", relocateResult);
      }
      await sleep(400);
    }

    progress("Cleaning up import markers...");
    draftNode = findDraftStateNode() || draftNode;
    summary.markersCleaned = cleanupMarkers(draftNode, payload.markerPrefix);
    kickRender(draftNode);
    await sleep(250);
    throwIfCancelled();
    post("done", { summary });
  };

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const message = event.data as { source?: string; kind?: string; payload?: WritePayload };
    if (message?.source !== CHANNEL_TO_MAIN) return;

    if (message.kind === "ready?") {
      post("ready");
      return;
    }

    if (message.kind === "run") {
      if (!message.payload) {
        post("error", { error: "Missing MAIN world import payload." });
        return;
      }
      void runFlow(message.payload).catch((error: Error & { cancelled?: boolean }) => {
        console.error(LOG, error);
        if (error?.cancelled) {
          post("cancelled", { reason: error.message || "Import stopped by user." });
          return;
        }
        post("error", { error: error?.message || String(error), stack: error?.stack || null });
      });
      return;
    }

    if (message.kind === "cancel") {
      cancelRequested = true;
      progress("Import stopped by user.", "warn");
    }
  });

  console.log(LOG, "ready");
  post("ready");
})();

export {};
