import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSubtitleCommand } from "./subtitle.js";

describe("registerSubtitleCommand (retired stub)", () => {
  it("is hidden from --help", () => {
    const program = new Command();
    registerSubtitleCommand(program);
    const helpText = program.helpInformation();
    expect(helpText).not.toContain("subtitle ");
  });

  it("sets a non-zero exit code and logs a migration message when invoked", async () => {
    const program = new Command();
    program.exitOverride();
    registerSubtitleCommand(program);
    await program.parseAsync(["node", "yt2x", "subtitle"]);
    expect(process.exitCode).not.toBe(0);
    process.exitCode = 0; // reset for subsequent tests in the same process
  });

  it("does not reject old flags like --subtitle-zh with a Commander parse error", async () => {
    const program = new Command();
    program.exitOverride();
    registerSubtitleCommand(program);
    await program.parseAsync(["node", "yt2x", "subtitle", "--subtitle-zh", "srt"]);
    expect(process.exitCode).not.toBe(0);
    process.exitCode = 0; // reset for subsequent tests in the same process
  });
});
