# Contributing to yt2x

感谢你愿意改进 yt2x。本项目是一个 TypeScript / pnpm monorepo，目标是把 **YouTube 采集 → 结构化笔记 → X 长文 → 发布** 做成可测试、可续跑、可替换适配器的本地 CLI 流水线。

这份文档说明如何准备环境、提交变更、运行检查、维护文档，以及维护者如何发布 npm 包。

## 当前项目状态

- 仓库根包保持 **`private: true`**。
- `@yt2x/core`、`@yt2x/adapters-node`、`@yt2x/cli` 当前也仍是 **`private: true`**，尚未公开发布到 npm。
- 推荐使用方式是 clone 仓库后运行 **`pnpm yt2x`**。
- npm 发布放在最后阶段，由维护者按本文发布流程执行。

## 开发环境

需要：

- **Node.js ≥ 22**
- **pnpm 9.x**
- **yt-dlp**
- **ffmpeg**

macOS 示例：

```bash
brew install yt-dlp ffmpeg
corepack enable
```

初始化仓库：

```bash
git clone https://github.com/yt2x/yt2x.git yt2x
cd yt2x
pnpm install
pnpm run build
pnpm yt2x --help
```

首次 clone 后必须执行 `pnpm run build`，因为 workspace 包入口指向各自的 `dist/`。如果你运行过 `pnpm run clean`，或者安装时用了 `--ignore-scripts`，也需要重新 build。

## 环境变量与本地凭证

复制模板：

```bash
cp .env.example .env
```

`.env` 已被 `.gitignore` 忽略，不要提交真实密钥。

LLM 相关：

- `YT2X_LLM_PROVIDER=openai|anthropic|deepseek|moonshot`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `DEEPSEEK_API_KEY`
- `MOONSHOT_API_KEY`

X 发布相关：

- `X_CLIENT_ID`
- `X_CLIENT_SECRET`，仅 Confidential app 需要
- `X_REDIRECT_URI`，默认 `http://127.0.0.1:8989/callback`

本地 X OAuth token 默认写入 `~/.config/yt2x/credentials.json`。不要提交 token、cookies、`.env` 或任何下载产物。

## Monorepo 分层

改代码前请先判断变更应该落在哪一层：

```text
packages/core
  领域模型、纯函数、Zod schema、端口接口。
  不允许直接依赖 Node 文件系统、子进程、真实网络或 CLI。

packages/adapters-node
  Node 实现：fs、process runner、yt-dlp / ffmpeg、LLM clients、X OAuth、X publish。

packages/cli
  Commander 命令、参数解析、流水线编排、日志和进度展示。
```

原则：

- 业务规则优先放 `core`，外部 I/O 放 `adapters-node`。
- CLI 不应重复实现领域逻辑，只做参数解析和编排。
- 不要让 `core` 引入 Node-only API。
- 不要绕过已有端口、状态存储、process runner、LLM adapter 或 X adapter。

详细架构见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 常用开发命令

```bash
# 构建全部 workspace 包
pnpm run build

# 清理 dist 和 tsbuildinfo
pnpm run clean

# 清理后重建
pnpm run rebuild

# 类型检查
pnpm run typecheck

# ESLint
pnpm run lint

# 自动修复 ESLint 可修复问题
pnpm run lint:fix

# Prettier 格式化
pnpm run format

# Prettier 检查
pnpm run format:check

# 单元测试
pnpm test

# 监听模式
pnpm run test:watch

# 覆盖率
pnpm run test:coverage

# 快速本地 CI
pnpm run ci

# 发布前 / GitHub Actions 等价检查
pnpm run ci:full
```

GitHub Actions 当前执行：

```text
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test:coverage
pnpm audit --audit-level=high
```

## 提交前检查

普通 PR 至少运行：

```bash
pnpm run ci
```

发布前或改动高风险路径时运行：

```bash
pnpm run ci:full
```

高风险路径包括：

- `packages/core/src/domain/pipeline`
- `packages/adapters-node/src/fs/process-status-store.ts`
- `packages/adapters-node/src/x-auth`
- `packages/adapters-node/src/x-publish`
- `packages/adapters-node/src/llm`
- `packages/cli/src/orchestrator`
- `packages/cli/src/args`

如果 `pnpm test` 在受限沙箱中因 OAuth loopback 测试报 `listen EPERM: operation not permitted 127.0.0.1`，先确认是否是环境禁止监听本地端口。业务改动仍应至少跑相关测试文件。

## 代码规范

- TypeScript 使用 ESM，源码中的相对导入保持 `*.js` 扩展。
- 保持 `strict` 类型安全，不引入 `any`；确实需要时必须解释原因并尽量限制作用域。
- 优先使用 `unknown` + runtime narrowing，而不是宽泛断言。
- 不要关闭 ESLint 规则来绕过问题。
- 不要手工和 Prettier 对抗，运行 `pnpm run format`。
- 保持函数职责清晰，避免把 CLI 参数解析、I/O 和领域逻辑写在同一层。
- 不做无关重构，不混入纯格式化大改，除非 PR 目标就是格式化。

## 测试要求

新增或修改行为时，应补对应测试。

建议位置：

| 改动类型                | 测试位置示例                                      |
| ----------------------- | ------------------------------------------------- |
| 领域纯函数              | `packages/core/src/**/*.test.ts`                  |
| 采集、文件、LLM、X 适配 | `packages/adapters-node/src/**/*.test.ts`         |
| CLI 参数解析            | `packages/cli/src/args/*.test.ts`                 |
| 命令投影 / 编排         | `packages/cli/src/commands` 或 `src/orchestrator` |

重点覆盖：

- 成功路径。
- 失败路径和退出码。
- `null` / `undefined` / 空文件 / 缺文件。
- 非法 `videoId`、路径遍历风险。
- LLM / X API 的鉴权、限流、网络失败。
- `process-status.json` 的写入和续跑语义。
- `--publish review` / `--dry-run` 不应真实调用 X API。

测试中不要访问真实外部服务；使用 fake fetcher、mock runner、临时目录和可控 fixture。

## 文档要求

用户可见行为变更必须同步文档。

常见对应关系：

- CLI 命令、参数、默认值改变：更新 [README.md](./README.md) 和 [docs/USAGE.md](./docs/USAGE.md)。
- 磁盘产物、状态文件、字段语义改变：更新 [docs/DATA-CONTRACTS.md](./docs/DATA-CONTRACTS.md)。
- 包职责、边界、数据流改变：更新 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。
- 路线图或完成状态改变：更新 [docs/REFACTOR-STATUS.md](./docs/REFACTOR-STATUS.md)。
- Agent 协作流程改变：更新 [docs/AGENT-PROMPTS.md](./docs/AGENT-PROMPTS.md) 或相关 ADR。

不要把过期 PR 验收文档当成当前实现的唯一依据。当前实现以代码、README、USAGE、DATA-CONTRACTS 和 REFACTOR-STATUS 为准。

## 安全要求

禁止提交：

- `.env`
- API key
- OAuth token
- cookies
- `x-token.json`
- `x-credentials.json`
- `llm-credentials.json`
- 下载的视频、字幕批量产物、截图产物

实现安全相关逻辑时注意：

- API key 不进入 CLI argv，不进入 URL query，不写入日志。
- X token 只通过 token store 读写，避免散落在命令层。
- `--video-id` 只能作为安全目录名，不能接受路径。
- 真实发布必须和 preview / review 区分清楚。
- 对外部输入做 runtime 校验，尤其是 JSON、URL、路径、模型返回内容。

## 发布语义

发布相关命令有明确安全边界：

- `yt2x publish --dry-run`：只预览，不调用 X API。
- `yt2x pipeline --publish review`：只生成 `publish-preview.json` 并更新状态，不调用 X API。
- `yt2x pipeline --publish auto`：真实发帖，需要有效 X OAuth 凭证。

改动发布路径时，必须补测试证明 review / dry-run 不会真实发帖。

## 分支与提交

建议：

- 从最新 `main` 创建短分支。
- 分支名使用标准语义前缀和小写 kebab-case，格式为 `<type>/<short-topic>`。
- 常用类型：
  - `feature/`：新功能、实验性能力、用户可见增强。
  - `fix/`：普通缺陷修复。
  - `hotfix/`：需要快速处理的生产或发布阻断修复。
  - `docs/`：仅文档改动。
  - `chore/`：维护性工作，例如依赖、配置、脚本、仓库 housekeeping。
  - `refactor/`：不改变行为的结构调整。
  - `test/`：测试补充或测试基础设施改动。
- 分支主题必须描述问题或目标，例如 `feature/x-target-output-test`、`fix/publish-review-dry-run`。
- 不使用带有个人、Agent、模型、工具或供应商色彩的分支前缀，例如 `codex/`、`agent/`。
- 一个 PR 解决一个清晰问题。
- 提交信息使用简洁祈使句，例如 `Fix publish review dry-run semantics`。
- 不把大规模格式化、重命名、行为变更混在同一个提交里。
- 不提交生成的大文件、下载产物、临时调试文件。

如果 PR 影响用户命令或数据契约，请在 PR 描述里写清楚：

- 改了什么行为。
- 如何验证。
- 是否需要迁移已有产物。
- 是否影响真实发布安全。

## Pull Request 清单

提交 PR 前检查：

- [ ] 变更范围聚焦，没有无关重构。
- [ ] 相关测试已新增或更新。
- [ ] `pnpm run ci` 通过。
- [ ] 用户可见变更已更新文档。
- [ ] 没有提交密钥、token、cookies、本地下载产物。
- [ ] 发布路径改动已验证 dry-run / review 不会真实发帖。
- [ ] 如改动数据契约，已更新 `docs/DATA-CONTRACTS.md`。

## 排障

`dist` 为空或 CLI 找不到包入口：

```bash
pnpm run rebuild
```

类型缓存异常：

```bash
pnpm run clean
pnpm run build
```

本地测试因 loopback 监听失败：

```text
listen EPERM: operation not permitted 127.0.0.1
```

这通常是沙箱限制。请在允许本地端口监听的环境重跑，或只跑与当前改动相关且不需要 loopback 的测试。

`yt-dlp` / `ffmpeg` 失败：

- 确认命令在 shell 中可直接运行。
- 对需要登录或地区限制的视频，使用 `--cookies-from-browser` 或 `--proxy`。
- 查看 `<outDir>/<videoId>/prepare-result.json` 和 `process-status.json`。

## 维护者发布流程

发布前提：

- GitHub Actions 绿。
- `pnpm run ci:full` 本地通过。
- 三个 workspace 包的版本号、repository、homepage、bugs 字段正确。
- 确认真的要公开 npm 包。

发布顺序：

```text
@yt2x/core
@yt2x/adapters-node
@yt2x/cli
```

发布步骤：

1. 确认根包 `package.json` 继续保持 `"private": true`。
2. 只把要发布的 workspace 包从 `"private": true` 改为 `"private": false`。
3. 运行：

```bash
pnpm run ci:full
pnpm run build
pnpm run pack:cli
```

4. 检查 tarball 内容，确认 CLI 包只包含预期的 `dist/`、声明文件和必要 metadata。
5. 确认 `workspace:*` 在发布产物中会被替换为具体版本范围。
6. 依次发布：

```bash
pnpm publish --filter @yt2x/core
pnpm publish --filter @yt2x/adapters-node
pnpm publish --filter @yt2x/cli
```

7. 发布后在干净环境验证：

```bash
npm i -g @yt2x/cli
yt2x --version
yt2x --help
```

如果发布过程中发现 tarball、版本、依赖范围或入口文件异常，停止发布并修复，不要继续发布后续包。

## License

提交贡献即表示你同意贡献内容以 **Apache License 2.0** 授权。详见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
