export type ImportButtonVariant = "icon" | "text";

export const IMPORT_BUTTON_PAIR_ATTR = "data-yt2x-import-pair";

export const importIconMarkup = `
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M12 13v8"/>
  <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
  <path d="m8 17 4-4 4 4"/>
</svg>`;

const applyInteractivePolish = (button: HTMLButtonElement, hoverBackground: string): void => {
  button.addEventListener("mouseenter", () => {
    if (button.disabled) return;
    button.style.backgroundColor = hoverBackground;
  });
  button.addEventListener("mouseleave", () => {
    if (button.disabled) return;
    button.style.backgroundColor = button.dataset.yt2xBaseBackground ?? "";
  });
  button.addEventListener("focus", () => {
    button.style.outline = "";
    button.style.outlineOffset = "";
  });
  button.addEventListener("blur", () => {
    button.style.outline = "";
    button.style.outlineOffset = "";
  });
};

export const styleImportButton = (
  button: HTMLButtonElement,
  anchor: HTMLElement,
  variant: ImportButtonVariant,
): void => {
  if (variant === "icon") {
    if (anchor instanceof HTMLButtonElement) button.className = anchor.className;
    button.dataset.yt2xBaseBackground = "transparent";
    button.style.cssText =
      "box-sizing:border-box;margin:0;width:36px;height:36px;min-width:36px;min-height:36px;padding:0;border:0;border-radius:999px;background:transparent;color:rgb(231,233,234);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;line-height:1;outline:none;box-shadow:none;transition:background-color 120ms ease,transform 120ms ease";
    button.style.setProperty("-webkit-tap-highlight-color", "transparent");
    applyInteractivePolish(button, "rgba(239,243,244,0.12)");
    return;
  }

  if (anchor instanceof HTMLButtonElement) button.className = anchor.className;
  button.dataset.yt2xBaseBackground = "rgb(255,255,255)";
  button.style.cssText =
    "box-sizing:border-box;margin:0;min-height:52px;height:52px;padding:0 28px;border:0;border-radius:9999px;background:rgb(255,255,255);color:rgb(15,20,25);font:800 17px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;vertical-align:middle;outline:none;box-shadow:none;line-height:20px;transition:background-color 120ms ease,transform 120ms ease";
  applyInteractivePolish(button, "rgb(230,230,230)");
};

export const isImportButtonPlaced = (
  existing: HTMLElement,
  anchor: HTMLElement,
  placement: InsertPosition,
): boolean =>
  placement === "beforebegin"
    ? existing.nextElementSibling === anchor
    : existing.previousElementSibling === anchor;

export const alignImportIconPair = (anchor: HTMLElement, button: HTMLButtonElement): void => {
  const parent = anchor.parentElement;
  if (parent === null) return;
  parent.style.display = "flex";
  parent.style.flexDirection = "row";
  parent.style.alignItems = "center";
  parent.style.justifyContent = "flex-end";
  parent.style.gap = "6px";
  button.style.marginInline = "0";
};

export const ensureImportTextPair = (anchor: HTMLElement, button: HTMLButtonElement): void => {
  const existingPair = anchor.closest(`[${IMPORT_BUTTON_PAIR_ATTR}]`);
  const pair =
    existingPair instanceof HTMLElement ? existingPair : document.createElement("div");

  if (!(existingPair instanceof HTMLElement)) {
    pair.setAttribute(IMPORT_BUTTON_PAIR_ATTR, "text");
    anchor.insertAdjacentElement("beforebegin", pair);
    pair.appendChild(anchor);
  }

  pair.style.display = "flex";
  pair.style.flexDirection = "row";
  pair.style.alignItems = "center";
  pair.style.justifyContent = "center";
  pair.style.gap = "12px";
  pair.style.flexWrap = "nowrap";
  pair.style.width = "max-content";
  pair.style.maxWidth = "calc(100vw - 32px)";
  pair.style.marginTop = "0";

  if (button.parentElement !== pair) pair.appendChild(button);
  button.style.marginInlineStart = "0";
};
