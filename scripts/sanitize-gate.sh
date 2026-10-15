#!/usr/bin/env bash
# 脱敏门禁：仓库里不允许出现私有标识（tailnet 域名 / 私网 IP / 私有 UUID / 本机路径 / 密钥前缀）
# CI 与本地都可跑：bash scripts/sanitize-gate.sh
set -u

PATTERNS='tail4b5213|100\.86\.60\.|100\.113\.241\.|/home/ubuntu/|/Users/sai/|e5202c56-|9c8ccb0e-|nvapi-|gsk_|oc_sk_|resin-[A-Za-z0-9]{8,}'

HITS=$(grep -rEn "$PATTERNS" \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude='sanitize-gate.sh' \
  --exclude='*.example' \
  . || true)

if [ -n "$HITS" ]; then
  echo "❌ 发现私有标识，禁止入库："
  echo "$HITS"
  exit 1
fi
echo "✅ 脱敏门禁通过（无私有标识）"
