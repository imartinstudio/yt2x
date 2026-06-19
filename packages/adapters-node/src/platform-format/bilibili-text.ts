import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlatformFormatInput, PlatformFormatResult, BilibiliMetadata } from "./types.js";

const METADATA_FILE = "bilibili-format/bilibili-metadata.json";
const OUTPUT_DIR = "bilibili-format";
const OUTPUT_FILE = "video-info.md";

const renderVideoInfo = (metadata: BilibiliMetadata): string => {
  const sections = [
    "# 视频信息\n",
    "## 标题",
    metadata.title,
    "",
    "## 简介",
    metadata.description,
    "",
    "## 分区",
    metadata.category,
    "",
    "## 标签",
    metadata.tags.map((t) => `- ${t}`).join("\n"),
    "",
    "## 时间线",
    ...metadata.timeline.map(
      (item: BilibiliMetadata["timeline"][number]) =>
        `- **${item.time}** ${item.title}\n  ${item.description}`,
    ),
    "",
    "## 评论引导",
    metadata.comment_prompt,
  ];
  return sections.join("\n");
};

export const formatBilibiliText = async (input: PlatformFormatInput): Promise<PlatformFormatResult> => {
  const articleDir = path.resolve(input.articleDir);
  const outputDir = path.join(articleDir, OUTPUT_DIR);

  let metadata: BilibiliMetadata | null = null;
  try {
    const raw = await readFile(path.join(articleDir, METADATA_FILE), "utf8");
    metadata = JSON.parse(raw) as BilibiliMetadata;
  } catch {
    // no metadata — generate basic info from article.md
  }

  const text = metadata !== null
    ? renderVideoInfo(metadata)
    : `# 视频信息\n\n## 简介\n\n${input.articleMd.slice(0, 2000)}\n\n> 请先运行 \`yt2x article --platform-targets bilibili\` 生成完整元数据。`;

  const outputPath = path.join(outputDir, OUTPUT_FILE);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, text, "utf8");

  // also write a plain text version for easy copy
  const plainPath = path.join(outputDir, "video-info.txt");
  const plainText = metadata !== null
    ? `${metadata.title}\n\n${metadata.description}\n\n${metadata.tags.join("，")}\n\n分区：${metadata.category}`
    : text;
  await writeFile(plainPath, plainText, "utf8");

  return {
    outputDir,
    files: [outputPath, plainPath],
    imagesGenerated: 0,
  };
};
