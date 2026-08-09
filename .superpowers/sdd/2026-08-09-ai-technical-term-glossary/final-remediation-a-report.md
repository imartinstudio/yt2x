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
