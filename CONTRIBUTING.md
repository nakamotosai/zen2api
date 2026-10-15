# 贡献指南

欢迎 PR。这个项目很小，改动不大，但有几条硬规则。

## 环境

只需要 [Bun](https://bun.sh) 1.1+（跑测试与本地起服务用）。没有别的依赖。

```bash
git clone https://github.com/nakamotosai/zen2api.git
cd zen2api
cp .env.example .env          # 可选；所有变量都有内置默认值
cp data/config.example.json data/config.json
bun server.js                 # http://127.0.0.1:18400
```

## 提交前必须跑

```bash
bun run test
```

这一条会依次跑：

| 用例 | 管什么 |
|---|---|
| `tests/gate-test.mjs` | 协议桥接的收尾闸门（续打判据、桩拦截） |
| `tests/aggregate-test.mjs` | 非流式聚合（把上游 SSE 折叠成单条 JSON） |
| `tests/install-unit-merge-test` | 升级时不得丢掉 unit 里手写的 `Environment=` 行 |

另外 CI 还会跑：**脱敏门禁**（全仓扫密钥/个人标识）、**启动冒烟**（真起一次服务打接口）、
**shell 语法检查**、**Docker 构建**。

## 硬规则

1. **不要提交任何真实密钥、域名、内网 IP、个人标识。**
   仓库里出现过的具体形态包括：上游 Zen key、客户端 key、管理密钥、代理地址与密码、
   tailnet 域名。脱敏门禁会拦，但它是最后一道，不是第一道。写测试要造密钥请用
   `sk-test-…` 这类一眼假的字符串。

2. **不要写死出口 IP 或代理凭据。** 出口走 `ZEN_PROXY_URL` / `ZEN_RESIN_*` 环境变量。

3. **改了文案/配置就要同步文档。** 新增环境变量 → `.env.example` + README 配置表；
   改了用户可见行为 → `CHANGELOG.md`。

4. **不要为了一个功能引入依赖。** 这个项目刻意保持零依赖（只用 Bun 内置能力）。
   真需要的话，在 PR 里说明为什么标准库解决不了。

5. **不要提交格式化/重排产生的大 diff。** 一个 PR 只做一件事，审起来才快。

## 提交信息

用 Conventional Commits 风格，一句话说清「改了什么」：

```
fix(install): 升级时不再丢掉 unit 里手写的 Environment= 行
feat(egress): 支持任意 HTTP(S) 代理
docs: 修正升级命令
```

## PR 流程

1. 开 PR（模板会提示你填验证方式）。
2. CI 自动跑门禁，并**自动打标签**（按改动路径）。
3. 首次贡献者会收到一条欢迎说明。
4. 维护者会**立刻收到一条 Telegram 通知**（所以不必担心 PR 石沉大海，不用催）。
5. 满足以下**全部**条件的 PR 会自动合并：
   - 改动只落在安全区（`docs/**`、`**/*.md`、`.github/dependabot.yml`）
   - 所有门禁通过
   - 由维护者打过 `automerge` 标签，或来自 Dependabot
6. 其余 PR 需要人工过一眼。**涉及 `server.js`、`lib/**`、`deploy/**`、
   `.github/workflows/**` 的改动永远不会自动合并。**

## 安全

发现漏洞（尤其是密钥处理、鉴权绕过、密钥外泄）请走
[私密报告](https://github.com/nakamotosai/zen2api/security/advisories/new)，
详见 [SECURITY.md](SECURITY.md)。不要开公开 issue。
