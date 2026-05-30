# Plan: Improve X Thread Generation Quality

**Branch**: `feature/improve-x-thread-generation`  
**Goal**: General improvements to existing thread logic (no content-type branching)

## Tasks (执行顺序)

- [x] **Task 1**: 读取当前 thread 逻辑文件
  - 读取 `packages/core/src/domain/thread/prompts.ts`
  - 读取 `packages/adapters-node/src/thread/generator.ts`
  - 读取 `packages/core/src/domain/thread/types.ts`

- [x] **Task 2**: 分析现有 prompt 的 5 个改进点
  - 第一条 hook 强度
  - 单条只讲一个信息点
  - 列表类内容自然拆分
  - 结尾帖结构（风险 + 行动 + 问题）
  - 视觉分配规则

- [x] **Task 3**: 起草改进后的 `THREAD_X_SYSTEM_PROMPT`
  - 加强第一条要求
  - 增加「每条只讲一个清晰观点」规则
  - 优化最后一条结构
  - 最大 tweet 数量改为 12

- [x] **Task 4**: 修改 Schema（最小改动）
  - `generator.ts` 中 `tweets` max 从 10 改为 12
  - 新增可选 `thread_style` 字段

- [ ] **Task 5**: 使用 SNAlFLV9MBE 文章测试生成效果
  - 运行 thread 生成
  - 对比修改前后质量
  - 验证 JSON 合法性

- [x] **Task 6**: 提交代码
  - 使用规范 commit message
  - 包含 Included 列表

- [ ] **Task 7**: 推送分支并创建 PR（可选）

## 约束
- 不做内容类型分支
- 保持向后兼容
- 所有改动为通用性优化

## 完成标准
- Hook 更强
- 信息点拆分更清晰
- 结尾帖结构更完整
- 列表类内容能自然生成较好线程
