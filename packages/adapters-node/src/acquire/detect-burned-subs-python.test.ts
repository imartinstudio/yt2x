import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const scriptPath = path.join(
  process.cwd(),
  "packages",
  "adapters-node",
  "src",
  "acquire",
  "detect-burned-subs.py",
);

const runPython = async (body: string): Promise<string> => {
  const source = [
    "import importlib.util",
    `spec = importlib.util.spec_from_file_location("detect_burned_subs", ${JSON.stringify(scriptPath)})`,
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    body,
  ].join("\n");
  const { stdout } = await execFileAsync("python3", ["-c", source]);
  return stdout.trim();
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const fixtureDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "yt2x-burned-subs-fix-"));
  tempDirs.push(dir);
  return dir;
};

describe("detect-burned-subs.py", () => {
  it("treats Simplified and Traditional Chinese text as Chinese subtitles", async () => {
    await expect(runPython("print(mod.looks_like_chinese_subtitle('这是简体中文字幕'))")).resolves.toBe(
      "True",
    );
    await expect(runPython("print(mod.looks_like_chinese_subtitle('這是繁體中文字幕'))")).resolves.toBe(
      "True",
    );
  });

  it("rejects OCR text that looks like screencast UI or source code", async () => {
    await expect(
      runPython("print(mod.looks_like_chinese_subtitle('const config = { enabled: true }; // 配置'))"),
    ).resolves.toBe("False");
    await expect(
      runPython("print(mod.looks_like_chinese_subtitle('npm install && pnpm test\\n运行测试'))"),
    ).resolves.toBe("False");
  });

  it("does not treat a screencast bottom region as hard subtitles", async () => {
    // Dense full-width lines mimic IDE/terminal chrome — the false-positive mode
    // that fired on real programming screencasts before layout scoring.
    const dir = await fixtureDir();
    const imagePath = path.join(dir, "screencast.png");
    const result = await runPython(`
from PIL import Image, ImageDraw
img = Image.new("L", (1280, 720), 35)
draw = ImageDraw.Draw(img)
for i in range(10):
    y = 540 + i * 16
    draw.rectangle([16, y, 1264, y + 11], fill=210)
img.save(${JSON.stringify(imagePath)})
print(mod.frame_looks_like_hard_subtitle(${JSON.stringify(imagePath)}))
`);
    expect(result).toBe("False");
  });

  it("detects centered bilingual hard subtitles in the safe zone", async () => {
    const dir = await fixtureDir();
    const imagePath = path.join(dir, "bilingual-subs.png");
    const result = await runPython(`
from PIL import Image, ImageDraw
img = Image.new("L", (1280, 720), 45)
draw = ImageDraw.Draw(img)
draw.rectangle([80, 80, 1200, 480], fill=90)
draw.rectangle([320, 590, 960, 612], fill=255)
draw.rectangle([380, 622, 900, 640], fill=230)
img.save(${JSON.stringify(imagePath)})
print(mod.frame_looks_like_hard_subtitle(${JSON.stringify(imagePath)}))
`);
    expect(result).toBe("True");
  });
});
