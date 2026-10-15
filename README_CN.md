# zen2api

**OpenCode Zen 免费池网关** —— 把 OpenCode Zen 的免费模型池暴露成标准 OpenAI / Anthropic 兼容 API。
单文件 [Bun](https://bun.sh) 服务、**不需要任何上游 key**、自带只读状态面板。

> 社区项目，与 OpenCode / SST 无关。免费池是第三方服务，随时可能变更或限流（见「注意事项」）。

---

## 为什么有这个项目

OpenCode 的免费层只接受「看起来来自官方 OpenCode 客户端」的请求（客户端指纹闸：形状不对会被
`403 FreeTierError: OpenCode's free tier can only be used from within OpenCode` 拒掉）。

本网关把请求补齐成官方客户端的形状（客户端头、工具 schema、协议车道），直连
`https://opencode.ai/inference/openai/v1` 并原样流式返回 —— 于是**任何** OpenAI / Anthropic
兼容客户端都能用上免费模型。

## 特性

- **三条车道**：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`
- **无需上游 key**：免费池本来就不要；客户端鉴权可选（`ZEN_CLIENT_KEY`）
- **模型清单动态更新**：`GET /v1/models` 返回实时免费集（规则：名字以 `-free` 结尾 + `big-pickle`）；
  启动时拉一次、每 12 小时一次、也可 `POST /v1/models/refresh` 手动拉
- **内置别名**：`claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5 / claude-fable-5`
  → `muse-spark-1.3-contributor-free`
- **默认支持出口代理**：可挂在任意 HTTP 代理池后面（resin / clash / warp / squid…）。
  免费池按**出口 IP** 限流，轮换的 IP 池是最有效的缓解手段
- **只读面板**：网关健康、模型清单对比上游目录、出口池状态、实时请求日志（全部可选，env 驱动）

## 快速开始

需要 [Bun](https://bun.sh)（≥ 1.1）。

```bash
git clone https://github.com/nakamotosai/zen2api.git
cd zen2api

# 1)（可选）配置
cp .env.example .env      # 按需修改；默认值开箱即用

# 2) 跑网关
bun server.js
# → zen2api v2 listening on http://127.0.0.1:18500 -> https://opencode.ai/inference/openai/v1

# 3) 冒烟
curl -s http://127.0.0.1:18500/v1/chat/completions \
  -H "Authorization: Bearer any" -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}]}'
```

### 作为系统服务（systemd）

```bash
sudo mkdir -p /opt/zen2api && sudo cp -r . /opt/zen2api/
sudo cp /opt/zen2api/.env.example /opt/zen2api/service.env   # 然后编辑
sudo cp /opt/zen2api/deploy/zen2api.service /etc/systemd/system/
sudo systemctl enable --now zen2api
```

（按需调整 unit 里的 `User=` / 路径。面板同理，用 `deploy/zen2api-panel.service`。）

## 接入客户端

**Claude Code**（Anthropic 车道）：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18500
export ANTHROPIC_AUTH_TOKEN=any
claude        # 模型填 claude-sonnet-5（自动映射），或任意 *-free 模型 id
```

**Codex CLI**（`~/.codex/config.toml`）：

```toml
[model_providers.zen]
name = "zen2api"
base_url = "http://127.0.0.1:18500/v1"
env_key = "ZEN_KEY"
wire_api = "responses"

# ZEN_KEY=any codex -m muse-spark-1.3-contributor-free -c model_provider=zen
```

**OpenAI SDK / 任何 OpenAI 兼容客户端**：base URL 填 `http://127.0.0.1:18500/v1`，key 随便填。

**查免费模型清单：**

```bash
curl -s http://127.0.0.1:18500/v1/models
```

## 出口代理（resin 类代理池）

网关原生读 `HTTPS_PROXY` / `HTTP_PROXY`（Bun 内置支持），**全部**上游流量走它，无需其它配置：

```bash
HTTPS_PROXY=http://<池用户名>:<池令牌>@127.0.0.1:2260 \
HTTP_PROXY=http://<池用户名>:<池令牌>@127.0.0.1:2260 \
bun server.js
```

验证是否生效 —— 启动行会显示 `... via http://***@host:port`。

> 原因：免费层的 `429 FreeUsageLimitError` 按**出口 IP** 计数（数量 + 新鲜度）。
> 一个会轮换的新鲜 IP 池是最有效的缓解手段。

## 面板

网关的只读状态页（不写任何东西、无鉴权 —— 请绑在内网/私有网络上）：

```bash
PANEL_GW=http://127.0.0.1:18500 PANEL_REQ_LOG=./requests.jsonl bun panel/server.js
# → http://127.0.0.1:18505
```

显示哪些卡片取决于你配了什么（详见 `.env.example`）：

| 卡片 | 需要配置 |
|---|---|
| 网关健康 + 模型清单对比上游目录 | 什么都不用（有 `PANEL_GW` 即可） |
| 实时请求日志 | `PANEL_REQ_LOG` |
| CPA 白名单列 | `PANEL_CPA_CONFIG` |
| 同步回执 | `PANEL_LAST_SYNC` |
| 出口池（resin 类管理 API） | `PANEL_RESIN_*`（四项全设） |

## 注意事项

- **免费层有额度**：高负载下 `429 FreeUsageLimitError` 是常态 —— 它按账号与请求形状计数，
  换新鲜出口 IP 有帮助。别猛打。
- **请求形状是命根子**：网关的职责就是"像官方客户端"。改了指纹头 / 工具 schema / 车道，
  上游就会 `403`。
- **可用性无保证**：依赖未公开的上游端点，随时可能变（v1 就是这么退役的）。
- **与 OpenCode/SST 无关**，自担风险使用。

## 目录结构

```
server.js               网关（单文件，零依赖）
panel/server.js         只读状态面板
deploy/*.service        systemd 单元模板
scripts/sanitize-gate.sh  仓库卫生门禁（CI 用）
.env.example            全部环境变量，带说明
SPEC.md / PLAN.md / TRACK_TREE.md / progress.md / HANDOFF.md   项目状态（长项目规范）
```

## 许可

MIT —— 见 [LICENSE](LICENSE)。
