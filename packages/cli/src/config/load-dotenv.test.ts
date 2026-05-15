import { describe, expect, it } from "vitest";
import { parseDotEnvContent } from "./load-dotenv.js";

describe("parseDotEnvContent", () => {
  it("parses KEY=value and ignores comments", () => {
    const raw = `
# c
FOO=bar
export BAZ="x y"
`;
    expect(parseDotEnvContent(raw)).toEqual({ FOO: "bar", BAZ: "x y" });
  });

  it("supports single-quoted values", () => {
    expect(parseDotEnvContent("A='b'")).toEqual({ A: "b" });
  });
});
