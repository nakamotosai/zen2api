# AGENTS.md — 给 AI 协作者的项目约定

本项目接受 AI agent 提交的改动，但有硬约束：

## 架构红线

- **指纹逻辑集中且不可动**：网关（`server.js`）的职责是把请求补齐成官方 OpenCode 客户端形状。
  UA / `x-opencode-*` 头 / 工具 schema / 车道选择这些「自报家门」的部分，只能集中在这里，
  **不许散到别处、不许删改** —— 改坏等于对上游自报家门失败（`403 FreeTierError`）。
- **零上游 key 依赖**：免费池不需要 key；不要引入任何要求用户填上游 key 的设计。
- **面板保持只读**：`panel/server.js` 不写任何被观测对象（只读数据源 + 内存缓存）。

## 提交前必跑

```bash
bash scripts/sanitize-gate.sh                     # 脱敏门禁（CI 同款）
bun build server.js --target=bun --outfile=/dev/null
bun build panel/server.js --target=bun --outfile=/dev/null
# 冒烟：起网关，curl /health 与 /v1/models（见 .github/workflows/ci.yml）
```

## 风格

- 单文件优先、零依赖优先（网关与面板只用 Bun 内建 API）。
- 注释写「为什么」，不写「是什么」。
- 中文注释可接受（维护者是中文使用者），代码与文档面向英文社区时用英文。
- 改动网关/面板的行为时，同步更新 `.env.example` 与 README。
