export const IMPORT_BUTTON_IDS = {
  icon: "yt2x-import-markdown-icon-btn",
  text: "yt2x-import-markdown-text-btn",
} as const;
export const IMPORT_BUTTON_ID = IMPORT_BUTTON_IDS.text;
const LOADING_HOST_ATTR = "data-yt2x-import-loading";
const BUSY_ATTR = "data-yt2x-import-busy";

export type ImportLoadingHandle = {
  update: (message: string) => void;
  close: () => void;
};

export const formatIndexedStep = (label: string, index: number, total: number): string =>
  total <= 1 ? label : `${label}（${index}/${total}）`;

export const setImportButtonDisabled = (disabled: boolean): void => {
  for (const id of Object.values(IMPORT_BUTTON_IDS)) {
    const button = document.getElementById(id);
    if (!(button instanceof HTMLButtonElement)) continue;
    button.disabled = disabled;
    button.setAttribute("aria-busy", disabled ? "true" : "false");
    button.style.opacity = disabled ? "0.55" : "";
    button.style.pointerEvents = disabled ? "none" : "";
    button.style.cursor = disabled ? "not-allowed" : "pointer";
  }
};

export const showImportLoading = (message: string): ImportLoadingHandle => {
  document.querySelector(`[${LOADING_HOST_ATTR}]`)?.remove();
  document.documentElement.setAttribute(BUSY_ATTR, "true");
  setImportButtonDisabled(true);

  const host = document.createElement("div");
  host.setAttribute(LOADING_HOST_ATTR, "true");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
<style>
  :host { all: initial; }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.42);
    font: 14px/1.5 system-ui, -apple-system, sans-serif;
    color: #111;
    pointer-events: auto;
    user-select: none;
  }
  .panel {
    min-width: min(360px, calc(100vw - 48px));
    max-width: calc(100vw - 48px);
    padding: 20px 22px;
    border-radius: 12px;
    background: #fff;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);
    text-align: center;
  }
  .spinner {
    width: 28px;
    height: 28px;
    margin: 0 auto 14px;
    border: 3px solid #e5e7eb;
    border-top-color: #111;
    border-radius: 50%;
    animation: yt2x-spin 0.8s linear infinite;
  }
  @keyframes yt2x-spin {
    to { transform: rotate(360deg); }
  }
  .message {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: #0f1419;
  }
  .hint {
    margin: 10px 0 0;
    font-size: 13px;
    color: #536471;
  }
</style>
<div class="backdrop" role="alertdialog" aria-modal="true" aria-busy="true" aria-live="polite">
  <div class="panel">
    <div class="spinner" aria-hidden="true"></div>
    <p class="message" data-role="message"></p>
    <p class="hint">导入进行中，请勿操作页面或关闭标签页</p>
  </div>
</div>`;

  const messageEl = shadow.querySelector("[data-role='message']");
  const update = (text: string): void => {
    if (messageEl !== null) messageEl.textContent = text;
  };
  update(message);
  document.body.appendChild(host);

  const close = (): void => {
    host.remove();
    document.documentElement.removeAttribute(BUSY_ATTR);
    setImportButtonDisabled(false);
  };

  return { update, close };
};
