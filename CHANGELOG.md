# Changelog

## v2.0.1 (2026-10-15)

**修复**：面板页内联脚本存在模板转义错误——`panel/server.js` 模板字符串内 `\/` 被折叠为 `/`，
页面实际收到 `base.replace(//v1$/, ...)`（`//` 变行注释），整个 `<script>` 解析失败、面板打开后全空白。另有第二个叠加问题：页面脚本 `renderSnips(PUBLIC_URL)` 引用的客户端变量从未被注入（语法修复后立即触发 ReferenceError），已一并补齐。
仅影响面板页面展示，不影响网关转发。CI 新增「页面内联脚本语法检查」门禁，防同类回归。

## v2.0.0 (2026-10-15)

**重写**。v1（客户端头伪造 + 完整工程：密钥管理 / 池热切换 / Docker / CI / 发版流水线）在
2026-10-14 上游改版后失效（免费层改走 `opencode.ai/inference/openai/v1` 并加了客户端指纹闸），
项目一度下线。本版按「薄网关」思路重写：

- **单文件 Bun 网关**：把请求补齐成官方 OpenCode 客户端形状（指纹头 / 工具 schema / 协议车道），
  直连新上游端点并原样流式返回；不需要任何上游 key
- **三条车道**：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`；内置
  `claude-*` → `muse-spark-1.3-contributor-free` 别名映射
- **模型清单动态更新**：`GET /v1/models` 实时反映免费集（规则：名字以 `-free` 结尾 + `big-pickle`），
  启动拉取 + 每 12 小时 + `POST /v1/models/refresh` 手动刷新
- **原生出口代理支持**：`HTTPS_PROXY` / `HTTP_PROXY` 全量走代理（resin 类代理池），
  缓解免费层按出口 IP 的 429
- **只读状态面板**（`panel/server.js`）：网关健康 / 模型清单对比上游目录 / 出口池 / 实时请求日志；
  全部 env 配置，未配置的卡片自动隐藏
- 仓库治理件（CONTRIBUTING / SECURITY / PR 模板 / Issue 表单 / CI 门禁）沿用 v1 体系并适配

> v1 的历史版本（v0.3.x ~ v0.4.0）见 `zen2api-legacy`（私有存档）。
