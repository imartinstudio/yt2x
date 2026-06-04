import { describe, expect, it, vi } from "vitest";
import {
  applyCheckboxChangeToSelection,
  CHECKBOX_HIT_ATTR,
  CHECKBOX_INPUT_ATTR,
  CHECKBOX_PAD_ATTR,
  CHECKBOX_VISUAL_ATTR,
  cellHasCheckbox,
  ensureUserCellCheckbox,
  getCheckedHandlesInViewport,
  listLoadedUserCells,
  removeUserCellCheckboxes,
  syncCheckboxOnCell,
} from "./user-cell-checkbox.js";

describe("ensureUserCellCheckbox", () => {
  it("prepends checkbox without wrapping row children", () => {
    const cell = document.createElement("button");
    cell.setAttribute("data-testid", "UserCell");
    cell.type = "button";
    const link = document.createElement("a");
    link.href = "/alice";
    link.textContent = "Alice";
    cell.append(link);
    document.body.append(cell);
    vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 400,
      height: 80,
      top: 0,
      left: 0,
      right: 400,
      bottom: 80,
      toJSON: () => ({}),
    } as DOMRect);

    const wrapper = document.createElement("div");
    cell.replaceWith(wrapper);
    wrapper.append(cell);

    const input = ensureUserCellCheckbox(cell);
    const hit = cell.previousElementSibling;
    const visual = hit?.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
    expect(visual).not.toBeNull();
    expect(visual!.style.background).toBe("transparent");
    expect(visual!.textContent).toBe("");

    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(visual!.style.background).toBe("var(--xfm-cb-bg-checked)");
    expect(visual!.textContent).toBe("✓");

    expect(cellHasCheckbox(cell)).toBe(true);
    expect(hit?.getAttribute(CHECKBOX_HIT_ATTR)).toBe("true");
    expect(hit?.querySelector(`[${CHECKBOX_INPUT_ATTR}]`)).toBe(input);
    expect(cell.parentElement).toBe(wrapper);
    expect(cell.textContent).toContain("Alice");
    expect(wrapper.getAttribute(CHECKBOX_PAD_ATTR)).toBe("true");
    expect(getCheckedHandlesInViewport("all")).toEqual(["alice"]);

    removeUserCellCheckboxes();
    expect(cellHasCheckbox(cell)).toBe(false);
    expect(cell.textContent).toContain("Alice");
    cell.remove();
    vi.restoreAllMocks();
  });

  it("reuses stale hit zone when virtual list recycles row handle", () => {
    const cell = document.createElement("button");
    cell.setAttribute("data-testid", "UserCell");
    cell.type = "button";
    const wrapper = document.createElement("div");
    wrapper.append(cell);
    document.body.append(wrapper);

    cell.innerHTML = '<a href="/alice">@alice</a>';
    ensureUserCellCheckbox(cell);
    const hit = cell.previousElementSibling as HTMLElement;
    const input = hit.querySelector("input") as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    input.dataset.xfmHandle = "alice";

    cell.innerHTML = '<a href="/bob">@bob</a>';
    const selected = new Set<string>(["bob"]);
    syncCheckboxOnCell(cell, selected, "all");

    expect(cell.previousElementSibling).toBe(hit);
    expect(input.dataset.xfmHandle).toBe("bob");
    expect(input.checked).toBe(true);

    const visual = hit.querySelector<HTMLSpanElement>(`[${CHECKBOX_VISUAL_ATTR}]`);
    expect(visual).not.toBeNull();
    expect(visual!.style.background).toBe("var(--xfm-cb-bg-checked)");

    input.checked = false;
    input.dispatchEvent(new Event("change"));
    expect(visual!.style.background).toBe("transparent");

    wrapper.remove();
  });

  it("restores checked state from selectedHandles when list row is re-mounted", () => {
    const selected = new Set<string>(["bob"]);
    const cell = document.createElement("button");
    cell.setAttribute("data-testid", "UserCell");
    cell.type = "button";
    const link = document.createElement("a");
    link.href = "/bob";
    cell.append(link);
    document.body.append(cell);

    const input = ensureUserCellCheckbox(cell);
    input.checked = true;
    applyCheckboxChangeToSelection(input, selected);
    expect(selected.has("bob")).toBe(true);

    input.checked = false;
    syncCheckboxOnCell(cell, selected, "all");
    expect(ensureUserCellCheckbox(cell).checked).toBe(true);

    input.checked = false;
    applyCheckboxChangeToSelection(input, selected);
    expect(selected.size).toBe(0);

    cell.remove();
  });

  it("counts loaded cells in primary column regardless of viewport", () => {
    document.body.innerHTML = `
      <div data-testid="primaryColumn">
        <button data-testid="UserCell"><a href="/a">@a</a></button>
        <button data-testid="UserCell"><a href="/b">@b</a></button>
      </div>
    `;
    const cells = listLoadedUserCells("all");
    expect(cells).toHaveLength(2);
    vi.spyOn(cells[0]!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: -500,
      width: 400,
      height: 80,
      top: -500,
      left: 0,
      right: 400,
      bottom: -420,
      toJSON: () => ({}),
    } as DOMRect);
    expect(listLoadedUserCells("all")).toHaveLength(2);
    vi.restoreAllMocks();
  });
});
