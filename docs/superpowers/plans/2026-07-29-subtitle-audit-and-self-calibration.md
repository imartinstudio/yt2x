# 字幕产物审计层与自校准循环

## 背景

`docs/superpowers/specs/2026-07-28-semantic-bilingual-subtitles-design.md` 已经把
BaoCut 的方法论（两阶段翻译 + 定向重对齐 + 交付质量门 + 内容/展示分级）写进设计。
实现（`packages/adapters-node/src/acquire/semantic-bilingual-subtitles.ts`）
覆盖了翻译和布局，但**校验层缺失**：设计里的质量门在代码里是空操作。

### 已确认的现状问题

| #   | 问题                                                                                                                                                        | 位置                                              | 性质     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------- |
| P0  | 质量门恒 pass：`groups` 恒为 `[]`，`evaluateSemanticBilingualDelivery` 里 `if (group === undefined) continue` 每次命中，issues 恒空，`readyForBurn` 恒 true | `semantic-bilingual-subtitles.ts:715-716`、`:962` | 系统性   |
| P0  | 测试锁死了坏行为：断言 `hard` severity 仍应 `readyForBurn: true`                                                                                            | `video-subtitles.test.ts:729-745`                 | 系统性   |
| P1  | 8 种 issue code 只有 2 种可能被产出，`coverage`/`source-sha`/`timing`/`bilingual-timing`/`cps`/`unsafe-layout` 是死代码                                     | `semantic-bilingual-subtitles.ts:22-35`           | 系统性   |
| P1  | 时长 < 0.3s 的块被静默丢弃，译文内容消失且无任何记录                                                                                                        | `semantic-bilingual-subtitles.ts:920-924`         | 内容丢失 |
| P2  | 实现从设计的"语义组"模型漂移成"逐 cue 重复中文"，设计的核心内容不变量（原始 cue 恰好覆盖一次）既不产出也无法校验                                            | `semantic-bilingual-subtitles.ts:776-794`         | 设计漂移 |

## 核心设计决策：审计只读产物，不读管线内部状态

现有质量门失效的根因不是"忘了检查"，而是**它依赖管线内存里的 `groups`**——
当实现改成逐 cue 架构、不再产出 groups 时，门就静默失效了，没有任何报错。

新的审计层必须**只从磁盘产物计算不变量**：

```
输入（只读）：
  files/downloads/<videoId>/full.en.srt        源字幕（事实来源）
  files/articles/<videoId>/video/full.en.srt   语义组英文
  files/articles/<videoId>/video/full.zh.srt   语义组中文
  files/articles/<videoId>/video/full.bilingual.srt
  files/articles/<videoId>/video/full.bilingual.semantic.json
```

这样，任何管线内部重构都无法让审计静默失效——产物不满足不变量就是不满足。
这条约束是整个方案的地基，实现时不要为了方便把 `groups` 之类的内部状态传进审计函数。

## 审计规则表

分两级，对应 BaoCut 的 content / presentation 分级。
**内容类任何模式下都阻断；展示类只在 `burned`/`all` 交付时阻断。**

### A 组：内容/结构（severity: content）

| code                 | 规则                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source-sha`         | manifest 的 `sourceSha256` 必须等于当前下载目录源 SRT 的 SHA                                                                                              |
| `coverage-loss`      | 源 SRT 的每个词必须在文章侧 `full.en.srt` 中出现且仅出现一次（归一化后按词序做 LCS 覆盖检查）——这条直接抓 P1 的静默丢弃                                   |
| `empty-text`         | 任一 cue 的中文或英文为空/纯空白                                                                                                                          |
| `timing-invalid`     | 时长 ≤ 0、时间戳倒退、非有限值                                                                                                                            |
| `timing-overlap`     | 同一文件内相邻 cue 时间重叠                                                                                                                               |
| `bilingual-timing`   | `full.en.srt` / `full.zh.srt` / `full.bilingual.srt` 三份的 cue 数量与每条时间窗必须逐条一致                                                              |
| `adjacent-duplicate` | 相邻两条中文归一化后完全相同**且**对应英文不同——说明分配逻辑错位（注意：当前逐 cue 架构会合法地在同句内重复中文，所以必须加"英文不同"这个条件，否则误报） |
| `glossary-violation` | `PROTECTED_GLOSSARY_TERMS` / `PROTECTED_NAMES` 中的词出现在英文侧，却在对应中文侧被翻译掉                                                                 |

### B 组：展示/节奏（severity: presentation）

| code            | 规则                                                               |
| --------------- | ------------------------------------------------------------------ |
| `hard-layout`   | 实测视觉宽度超过 hard 阈值（复用现有 `measureLayout` 的 severity） |
| `line-count`    | 渲染后超过 2 行                                                    |
| `cps`           | 中文非空白字符数 ÷ 显示秒数 > 9                                    |
| `flash`         | 单条显示时长 < 1.0s                                                |
| `unsafe-layout` | hard 组找不到安全 cue 边界拆分点                                   |

阈值全部集中到一个 `SUBTITLE_AUDIT_THRESHOLDS` 常量导出，便于按场景调整。

## 实施步骤

### 阶段 1：建立审计层（不改生成逻辑）

1. 新增 `packages/adapters-node/src/acquire/audit-subtitles.ts`，导出
   `auditSubtitleArtifacts(input: { sourceSrt, enSrt, zhSrt, bilingualSrt, manifest, measurements? })`
   → `{ verdict: "pass" | "warn" | "fail", issues: AuditIssue[] }`。
   纯函数、无 I/O，便于测试。
2. 每条规则一个单元测试，**必须先写一个会红的用例**（构造违规产物，断言能被抓到），
   再实现规则——避免又写出一个恒 pass 的门。
3. 新增 CLI：`pnpm yt2x subtitle audit <videoId> [--strict]`，
   读磁盘产物、跑审计、输出 JSON 报告到
   `files/articles/<videoId>/video/full.bilingual.audit.json`。
   默认 exit 0（便于 loop 解析），`--strict` 时 fail 则 exit 2。

### 阶段 2：拆掉假门，接上真门

4. 删除 `evaluateSemanticBilingualDelivery` 对 `groups` 的依赖，改为调用
   `auditSubtitleArtifacts`；`readyForBurn` = 无 content 类 issue 且（交付模式下）无 presentation 类 issue。
5. **修正 `video-subtitles.test.ts:729-745`**——把"hard 仍 ready"的断言改成"hard 应阻断烧录"。
   这一步会让若干现有测试变红，那是对的，说明门真的生效了。
6. 修 P1：`dur < 0.3` 不再静默丢弃，改为保留并记录 `flash` issue（或按需合并进相邻块），
   决策交给审计层而不是生成层偷偷吞掉。

### 阶段 3：接入自校准 loop

7. 用下面的 loop prompt 驱动，对存量 `files/articles/*/video/` 批量跑审计，
   按"finding 聚集度"反推生成逻辑的系统性缺陷。

## 自校准 Loop Prompt

```
/loop 对 yt2x 已生成的双语字幕产物做审计，定位并修复生成逻辑的系统性问题。

范围：files/articles/*/video/（每个 videoId 一组产物）
工具：pnpm yt2x subtitle audit <videoId>（只读，输出 audit.json）

## 第一步：批量只读审计（禁止修改任何文件）
对范围内每个 videoId 跑 audit，汇总所有 issue，按 code 分组计数。
输出统计表：code | severity | 命中次数 | 涉及视频数 | 样例（videoId + 时间戳 + 文本片段）。

## 第二步：区分个例与系统性缺陷
- 同一 code 命中 ≥3 个视频，或在单个视频内命中率 ≥5% → 标记「疑似生成逻辑 bug」，
  去读 semantic-bilingual-subtitles.ts / video-subtitles.ts 对应环节，
  给出根因假设并标注 文件:行号。假设站不住就不要动代码。
- 只在 1-2 处零散出现且不成模式 → 标记「数据个例」，只记录，不改代码。

## 第三步：有限修复（每轮最多一个根因）
取排名第一的根因：
1. 只改这一个根因涉及的逻辑，不顺手重构
2. 补一个会红的回归测试（先红后绿），再改实现
3. 只对受影响的样本重跑生成 + 重跑 audit
4. 无论清零与否，本轮到此为止：
   - 清零 → 记为已修复
   - 未清零或引入新 issue → 记为待人工确认，不对同一根因自动重试第二次

## 停止条件
- 第二步没有可处理的系统性缺陷 → 结束本轮
- 单个根因修复一次后仍未清零 → 转人工，不阻塞其他根因

## 每轮输出
1. issue 统计表（与上一轮对比）
2. 本轮判定的系统性根因（含 文件:行号）
3. 已修复项 + 修复前后样例对比
4. 待人工确认项 + 原因

约束：绝不为了让审计变绿而放宽阈值或删除规则；阈值调整必须单独提出、说明理由、等人工确认。
```

最后那条约束是必须的——否则 agent 发现"改阈值比改逻辑容易"，会把门再次变成空操作，
正是本文档要修的那个问题。

## 备注：与设计文档的关系

阶段 2 完成后，实现与设计仍有 P2 的漂移（逐 cue 重复 vs 语义组）。
这是一个独立的架构决策，不在本方案范围内：要么回到设计的语义组模型，
要么更新设计文档承认逐 cue 架构。**但审计层对两种架构都适用**，
因为它只检查产物不变量，不假设内部结构——这也是先做审计层的理由。
