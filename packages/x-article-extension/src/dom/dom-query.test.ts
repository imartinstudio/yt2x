import { describe, expect, it, afterEach } from "vitest";
import { queryAllDeep } from "./dom-query.js";

describe("queryAllDeep", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("finds file inputs inside shadow roots", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    input.type = "file";
    shadow.append(input);
    document.body.append(host);

    const found = queryAllDeep(document, 'input[type="file"]');
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(input);
  });
});
