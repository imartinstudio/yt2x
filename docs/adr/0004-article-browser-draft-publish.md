# ADR-0004: Article 浏览器草稿发布通道

- **Status**: Accepted
- **Date**: 2026-05-23
- **Deciders**: 项目负责人
- **Tags**: publish, article, browser, safety

## Context

X Articles 长文编辑器没有 yt2x 可调用的公开发布 API。此前 `publish --target article`
已经支持 dry-run 预览，但真实发布路径和 Tweet API 发布路径共用编排，存在把
`article.md` 误压成单条 Tweet 的风险。

同时，yt2x 已生成文章 Markdown、封面和正文图片。用户需要一个比人工复制粘贴更稳定的
草稿入口，但发布按钮仍然是外部副作用，不能由自动化直接点击。

## Decision

### 1. Article 不走 Tweet API

`article` 是 X Articles 草稿目标，不是 Tweet API 目标：

- `publish --target article --dry-run` 继续生成 preview。
- `publish --target article` 在没有 browser-draft opt-in 时直接失败。
- `postTweet` 和 `postThread` 只服务 `x-short`、`x-thread` 与 `x-thread-short`。

### 2. 浏览器草稿通道显式 opt-in

新增 `--browser-draft` 后，CLI 才能启动 X Articles 浏览器自动化：

- 读取 `article.md`，生成不覆盖原稿的 `article_for_x.md`。
- 解析标题、正文 HTML、封面、正文图片与 divider block index。
- 用本地 persistent browser profile 打开 X Articles 编辑器。
- 只填入草稿内容并等待媒体上传结束，依赖 X 草稿自动保存，不点击正式发布。

### 3. 端口分层保持 API 与浏览器边界

core 定义 `XArticlesDraftPort` 与解析结果契约。Playwright、profile 目录、剪贴板和
X 页面定位逻辑只留在 adapters-node。现有 `XPublishPort` 不承担 Articles DOM
自动化。

### 4. 运行时资产不依赖外部 Skill

当前实现使用 TypeScript 解析和浏览器 Clipboard API，不依赖用户安装
`publish-x-article` Skill 或 Python 脚本目录。若后续引入 vendored 外部脚本，构建和
发布包必须显式携带这些资产并保留许可证。

## Consequences

### Positive

- article 真实发布路径不会再误发成 Tweet。
- Articles DOM 变化只影响 browser-draft adapter，不污染 OAuth API 发布端口。
- 原稿保持不变，用户能复查 `article_for_x.md` 和 draft result。
- browser-draft 仍是显式动作，满足 ADR-0003 的发布安全边界。

### Negative

- X Articles DOM、登录状态和风控挑战会让 browser-draft 比 API 发布更易受环境影响。
- 首版自动化只能保证内容写入编辑器并等待媒体上传结束，不保证所有 X locale 与页面版本都已手测。
- Premium 基础档位的复杂 Markdown 适配仍需要人工复查转换结果。

## Alternatives Considered

### 1. 继续把 article 转成单条 Premium Tweet

拒绝。Tweet 与 X Articles 是不同产物；单帖会丢失文章排版，也会把用户以为是草稿的长文
直接发到外部平台。

### 2. 默认启动浏览器并自动保存草稿

拒绝。浏览器登录态、桌面剪贴板和 X 页面风控都属于本机副作用，必须由
`--browser-draft` 显式启用。

### 3. 点击 X Articles Publish 完成正式发布

拒绝。文章需要用户在 X 编辑器里最终预览，自动化只写草稿。

## Related Documents

- [ADR-0003](./0003-publish-safety-and-process-status.md)
- [ARTICLE-DRAFT-PUBLISH-TASK.md](../ARTICLE-DRAFT-PUBLISH-TASK.md)
- [USAGE.md](../USAGE.md)
