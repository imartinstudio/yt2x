# Final Remediation A

状态：**DONE_WITH_CONCERNS**

## RED

- 首轮新增核心/adapter 定向测试在生产实现前失败 9 项，覆盖 scoped guard、occurrence 校验、SHA-256 fingerprint、active-only prompt、recognizer、持久化 cache 和冲突目录策略。
- discovery audit 投影测试先因 `technicalTermDiscoveryAuditFor` 未实现失败。
- 裸 `Graph` 测试先证明无技术语境时仍被激活；混合中文技术语境测试随后证明 `Graph 能让 agent...` 未被识别。
- deconstruct post 定向测试暴露中文“不是普通图片”被 visual context 误判；修正负向语境后恢复通过。

## GREEN

最终定向命令：

```text
pnpm test packages/core/src/domain/technical-term-catalog.test.ts packages/core/src/domain/technical-term-discovery.test.ts packages/adapters-node/src/technical-terms/discovery.test.ts packages/adapters-node/src/deconstruct/post-generator.test.ts packages/core/src/domain/deconstruct/prompts.test.ts packages/core/src/domain/deconstruct/post-prompt.test.ts
```

结果：**6 个测试文件、69 项测试通过**。

```text
pnpm typecheck
```

结果：通过。

## 验证范围

- `Graph` 只有在英文或中英混合技术语境中激活；图表、图片、diagram、visual graph 和裸 `Graph` 不激活。
- `TechnicalTermGuard.scope()` 可按 source translation unit / cue / field 派生 guard；scoped profile 按 occurrence 数量校验，forbiddenZh 恢复只作用于对应单元。
- discovery audit 将 prompt version、accepted、review、warnings 写入可序列化 profile；profile/catalog/source/cache 指纹使用稳定 SHA-256。
- deterministic recognizer 覆盖命令、flag、API/代码调用、模型名和高置信缩写；普通英文不进入 accepted。
- adapter cache 提供 schema record、冷读、校验、原子写入、single-flight；失败结果不写入持久 cache，schema 不兼容视为 miss。
- 通用文章、帖子、介绍、deconstruct prompt 不再注入完整目录，只由运行时追加 active terms。
- deconstruct 的术语筛选改用目录策略和 metadata；未修改 deconstruct 写入/原子写盘流程。
- `preserve + preferredZh` 被 catalog 拒绝；`docs/DATA-CONTRACTS.md` 统一 DubScript version 3。

## Hash

- discovery source SHA-256 断言：`sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`（输入 `hello`）。
- profile/catalog fingerprint 格式断言：`sha256-` 加 64 位十六进制摘要。
- discovery prompt version 导出常量：`TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION`。

## 约束与关注项

- 未调用真实 provider，持久化测试只使用临时目录，未写入 `files/`。
- 本批次未修改 Dashboard 或 subtitle CLI；全量测试按请求交由控制器最终运行。因此最终状态为 `DONE_WITH_CONCERNS`，关注项仅是尚未在本 agent 内执行全量回归。

---

## Final Remediation A 修复轮次 1

状态：**DONE_WITH_CONCERNS**

本轮按 reviewer 的 5 Important + 2 Minor 完成实现，范围限定为普通 SRT 翻译、article、visual prompt 的必要生产调用点；没有调用真实 provider，没有写入 `files/`。subtitle/dub 的其他链路保留给修复 C 接入。

### RED

- 首轮新增/迁移的定向测试产生 15 个失败，分别暴露了缺少显式 `scopeUnit`、scoped occurrence count 未覆盖、source identity 拼接碰撞、single-flight 后到 cache 未回写、article/visual 未接入持久 cache、审计未写入结果，以及 notes/thread/short/video-short 旧枚举断言。
- SRT 生产路径新增测试先证明完整父档案会把技术 cue 的 `Graph` 恢复规则带到自然 visual cue；31 cue batch 的旧断言也证明了原先 prompt scope 过宽。
- typecheck 首轮另暴露 exact optional property 与 SRT fallback 的类型问题，已在 GREEN 前修复。

### GREEN

最终全量命令：

```text
pnpm test -- --reporter=dot
```

结果：**128 个测试文件、1599 项测试全部通过**。

定向命令：

```text
pnpm exec vitest run packages/core/src/domain/technical-term-catalog.test.ts packages/core/src/domain/notes/prompts.test.ts packages/core/src/domain/thread/prompts.test.ts packages/core/src/domain/short/prompts.test.ts packages/core/src/domain/video-short/prompts.test.ts packages/adapters-node/src/technical-terms/discovery.test.ts packages/adapters-node/src/acquire/srt-translator.test.ts packages/adapters-node/src/article/generator.test.ts packages/adapters-node/src/platform-format/prompt-orchestrator.test.ts packages/adapters-node/src/article/file-store.test.ts --reporter=dot
```

结果：**10 个测试文件、173 项测试通过**。

```text
pnpm typecheck
```

结果：通过。

### 验证范围

- SRT 翻译每个 cue、repair batch 和最终校验 range 都从完整父档案派生 `scopeUnit({ sourceText, unitId })`；每个 cue 使用自己的 guard 做 prepare/finalize，跨 cue 术语仍由对应 range guard 修复。技术 `Graph` cue 可恢复，visual graph cue 不会被恢复成 `Graph`。
- `scopeUnit` 类型要求显式 `unitId`；scoped profile 按该 unit 内的 source occurrence count 验证，同一术语出现两次而输出一次会报告 missing。未 scope 的生成性 guard 仍保持 presence 语义。
- discovery cache 使用目标侧稳定路径 `<target>/.cache/technical-terms` 与 schema record；article 和 visual 编排已真实传入 cache，清空进程内 cache 后可冷读。single-flight 的后到 cache caller 会写回成功结果；unavailable/malformed 结果不会持久化。
- article `GenerateXArticleResult`、native article `run.json` 与平台 `prompts.json` 写入 `promptVersion`、结构化 `sourceIdentity`、`acceptedCandidates`、`reviewCandidates`、`warnings`；旧 run/prompts 缺少审计字段时保持兼容读取。
- notes 静态 prompt 只注入通用专业术语规则和 runtime active-terms 说明，不再发出“没有 active terms”的静态结论；thread、short、video-short 测试已迁移为 active-only 语义。
- profile fingerprint 仅包含 source/profile、实际 active entries、accepted candidates、source/discovery version 与 artifact 等相关输入；不再包含无关完整 catalog fingerprint。全局 catalog SHA-256 仍单独用于 cache record 兼容检查。
- `docs/DATA-CONTRACTS.md` 已补充审计字段和 profile/cache fingerprint 边界；未修改 subtitle/dub 的后续生产链路，待修复 C 接入。

### Hash

- 稳定 discovery source identity 与 profile fingerprint 均为 `sha256-` 加 64 位十六进制摘要；title/text 结构化序列化碰撞测试通过。
- 已保留的 SHA-256 断言：`fingerprintTechnicalTermDiscoverySource("hello")` → `sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`。
- discovery prompt version 导出常量：`TECHNICAL_TERM_DISCOVERY_PROMPT_VERSION = technical-term-discovery-v1`。
- 本轮基线提交：`3b91d524532aca71061dee548ff4c0ad0b843132`；本轮实现提交已包含本报告。

### 关注项

- 改动文件的 ESLint、Prettier 和 `git diff --check` 通过；全仓 `pnpm lint` 仍被仓库中被忽略的 `.claude/worktrees/video-delivery-foundations` 既有 28 个 unused-vars 报错阻断，未修改该目录。
- 最终状态为 `DONE_WITH_CONCERNS`：功能定向与全量测试、typecheck 均通过，唯一关注项是上述非本轮目录的全仓 lint 基线问题，以及 subtitle/dub 链路按计划留给修复 C。
