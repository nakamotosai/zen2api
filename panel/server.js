#!/usr/bin/env bun
/**
 * zen2api panel —— 只读状态面板（配套 zen2api 网关）
 *
 * 全部配置走环境变量；未配置的可选数据源会自动隐藏对应卡片（优雅降级）：
 *   PANEL_HOST / PANEL_PORT          监听地址（默认 127.0.0.1:18505）
 *   PANEL_GW                         网关地址（默认 http://127.0.0.1:18500）
 *   PANEL_PUBLIC_URL                 面板展示给用户的网关公网地址（用于生成接入示例）
 *   PANEL_REQ_LOG                    网关请求日志 requests.jsonl（不设则不显示请求流）
 *   PANEL_CPA_CONFIG                 CPA config.yaml（不设则不显示 CPA 白名单列）
 *   PANEL_LAST_SYNC                  zen_free_sync 的 last-sync.json（不设则不显示同步卡）
 *   PANEL_SVC_ENV                    网关的 service.env（不设则不显示出网方式行）
 *   PANEL_RESIN_ENV / PANEL_RESIN_API / PANEL_RESIN_PLATFORM_ID / PANEL_RESIN_SUB_ID
 *                                    出口池（resin 类管理 API，全部设了才显示出池卡片）
 *
 * 只读：不写任何被观测对象。
 */
const fs = require("fs");

const HOST = process.env.PANEL_HOST || "127.0.0.1";
const PORT = Number(process.env.PANEL_PORT || 18505);
const GW = (process.env.PANEL_GW || "http://127.0.0.1:18500").replace(/\/+$/, "");
const PUBLIC_URL = process.env.PANEL_PUBLIC_URL || "http://<gateway-host>:18500";
const REQ_LOG = process.env.PANEL_REQ_LOG || "";
const CPA_CFG = process.env.PANEL_CPA_CONFIG || "";
const LAST_SYNC = process.env.PANEL_LAST_SYNC || "";
const SVC_ENV = process.env.PANEL_SVC_ENV || "";
const RESIN_ENV = process.env.PANEL_RESIN_ENV || "";
const RESIN_API = (process.env.PANEL_RESIN_API || "").replace(/\/+$/, "");
const RESIN_PLATFORM_ID = process.env.PANEL_RESIN_PLATFORM_ID || "";
const RESIN_SUB_ID = process.env.PANEL_RESIN_SUB_ID || "";

function readFile(p, d = "") { try { return p ? fs.readFileSync(p, "utf8") : d; } catch { return d; } }

async function jget(url, headers) {
  try {
    const r = await fetch(url, { headers });
    return { code: r.status, data: await r.json() };
  } catch (e) { return { code: 0, error: String(e) }; }
}

async function jpost(url) {
  try { const r = await fetch(url, { method: "POST" }); return { code: r.status, data: await r.json() }; }
  catch (e) { return { code: 0, error: String(e) }; }
}

function cpaWhitelist() {
  if (!CPA_CFG) return { enabled: false, models: [] };
  const txt = readFile(CPA_CFG);
  const start = txt.indexOf("  - name: zen2api");
  if (start < 0) return { enabled: true, found: false, models: [] };
  let end = txt.indexOf("\n  - name:", start + 10);
  if (end < 0) end = txt.length;
  const models = [...new Set([...txt.slice(start, end).matchAll(/^ {6}- name: *(\S+) *$/gm)].map((m) => m[1]))];
  return { enabled: true, found: true, models };
}

function tailJsonl(n) {
  if (!REQ_LOG) return [];
  return readFile(REQ_LOG).trim().split("\n").slice(-n)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function lastSync() { if (!LAST_SYNC) return null; try { return JSON.parse(readFile(LAST_SYNC, "{}")) || null; } catch { return null; } }

function egressInfo() {
  if (!SVC_ENV) return null;
  const m = readFile(SVC_ENV).match(/^HTTPS_PROXY=(.*)$/m);
  if (!m) return { mode: "直连（未配 HTTPS_PROXY）", proxy: "" };
  const raw = m[1].trim();
  const pool = (raw.match(/:\/\/([^:@/]+):/) || [])[1] || "?";
  return { mode: "经出口代理（池 " + pool + "）", proxy: raw.replace(/:\/\/[^:@/]+:[^@]+@/, "://***@") };
}

function resinToken() {
  const m = readFile(RESIN_ENV).match(/^RESIN_ADMIN_TOKEN=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

async function resinState() {
  if (!RESIN_ENV || !RESIN_API || !RESIN_PLATFORM_ID || !RESIN_SUB_ID) return { enabled: false };
  const tok = resinToken();
  if (!tok) return { enabled: true, ok: false, error: "读不到 RESIN_ADMIN_TOKEN" };
  const h = { authorization: "Bearer " + tok };
  const [plat, nodesR, logsR] = await Promise.all([
    jget(`${RESIN_API}/platforms/${RESIN_PLATFORM_ID}`, h),
    jget(`${RESIN_API}/nodes?subscription_id=${RESIN_SUB_ID}&limit=300`, h),
    jget(`${RESIN_API}/request-logs?limit=8`, h),
  ]);
  const nodes = nodesR.data ? (Array.isArray(nodesR.data) ? nodesR.data : nodesR.data.items || []) : [];
  const logs = logsR.data ? (Array.isArray(logsR.data) ? logsR.data : logsR.data.items || []) : [];
  const cnt = (arr, re) => arr.filter((n) => re.test(n.display_tag || "") && !n.circuit_open_since).length;
  return {
    enabled: true,
    ok: nodesR.code === 200,
    routable: plat.data && plat.data.routable_node_count,
    total: nodes.length,
    jp_ok: cnt(nodes, /-jp-/),
    us_ok: cnt(nodes, /-us-/),
    open: nodes.filter((n) => n.circuit_open_since).map((n) => ({
      tag: n.display_tag, fails: n.failure_count, err: String(n.last_error || "").slice(0, 80),
    })),
    logs: logs.map((l) => ({
      ts: l.ts, tag: l.node_tag, ip: l.egress_ip, ok: l.net_ok,
      status: l.http_status, ms: l.duration_ms, host: l.target_host,
    })),
  };
}

const UPSTREAM_MODELS = process.env.PANEL_UPSTREAM_MODELS || "https://opencode.ai/zen/v1/models";
let upstreamCache = { at: 0, free: [], error: "" };
async function upstreamFree() {
  if (Date.now() - upstreamCache.at < 10 * 60 * 1000) return upstreamCache;
  try {
    const r = await fetch(UPSTREAM_MODELS, { headers: { "user-agent": "zen2api-panel" } });
    const d = await r.json();
    const free = (d.data || []).map((m) => m.id).filter((id) => id.endsWith("-free") || id === "big-pickle").sort();
    upstreamCache = { at: Date.now(), free, error: "" };
  } catch (e) {
    upstreamCache = { ...upstreamCache, at: Date.now(), error: String(e) };
  }
  return upstreamCache;
}

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>zen2api · 面板</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--card2:#1c2129;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--acc:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}
header{display:flex;align-items:center;gap:12px;padding:14px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:9;flex-wrap:wrap}
h1{font-size:16px;margin:0;font-weight:600}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;flex:none}
.dot.ok{background:var(--ok);box-shadow:0 0 8px var(--ok)}.dot.bad{background:var(--bad);box-shadow:0 0 8px var(--bad)}
.dim{color:var(--dim)}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
main{padding:16px 22px;display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:1360px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card.wide{grid-column:1/-1}
.card h2{font-size:13px;margin:0 0 10px;color:var(--dim);font-weight:600;letter-spacing:.03em}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px 18px}
.kv b{display:block;color:var(--dim);font-weight:500;font-size:12px;margin-bottom:2px}
.cpy{cursor:pointer;border-radius:6px;padding:2px 6px;margin:-2px -6px}
.cpy:hover{background:var(--card2)}
.cpy.copied{outline:1px solid var(--ok)}
table{width:100%;border-collapse:collapse}.mono td,.mono th{padding:3px 6px;text-align:left;border-bottom:1px solid #21262d;white-space:nowrap}
th{color:var(--dim);font-weight:500}tr:last-child td{border-bottom:0}
.s200{color:var(--ok)}.s0{color:var(--bad)}.s429{color:var(--warn)}
.pill{display:inline-block;padding:1px 7px;border-radius:99px;border:1px solid var(--line);font-size:12px;margin:2px 4px 2px 0}
.pill.ok{border-color:#238636;color:var(--ok)}.pill.bad{border-color:#f85149;color:var(--bad)}
pre{background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:6px 0 12px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre}
pre .hd{display:flex;justify-content:space-between;align-items:center;color:var(--dim);font-size:11.5px;margin-bottom:6px}
pre button{font-size:11px}
button{background:var(--card2);border:1px solid var(--line);color:var(--fg);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px}
button:hover{border-color:var(--acc)}
.snip{margin-bottom:4px}
.snip h3{font-size:12.5px;color:var(--fg);margin:10px 0 4px;font-weight:600}
footer{padding:10px 22px 26px;color:var(--dim);font-size:12px}
.flex{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
</style></head><body>
<header>
  <span class="dot" id="dot"></span><h1>zen2api · 面板</h1>
  <span class="pill" id="pool-pill" style="display:none"></span>
  <span class="dim mono" id="up"></span>
  <span class="dim" style="margin-left:auto" id="ts"></span>
</header>
<main>

<div class="card wide"><h2>接入信息（点任意值可复制）</h2>
  <div class="kv">
    <div><b>OpenAI Base URL（带 /v1）</b><span class="cpy mono" id="u-oai" data-copy=""></span></div>
    <div><b>Anthropic Base URL（不带 /v1）</b><span class="cpy mono" id="u-anth" data-copy=""></span></div>
    <div><b>API Key</b><span class="mono">任意值（网关默认不校验）</span></div>
    <div><b>车道</b><span class="mono">/v1/chat/completions · /v1/responses · /v1/messages</span></div>
    <div><b>模型别名</b><span class="mono">claude-* → muse-spark-1.3（内置映射）</span></div>
    <div id="egress-box" style="display:none"><b>出网方式</b><span class="mono" id="egress-mode"></span></div>
  </div>
  <div class="snip"><h3>Claude Code</h3><pre id="snip-claude"></pre></div>
  <div class="snip"><h3>Codex CLI（~/.codex/config.toml）</h3><pre id="snip-codex"></pre></div>
  <div class="snip"><h3>curl 直测</h3><pre id="snip-curl"></pre></div>
</div>

<div class="card wide"><h2>免费模型清单（上游规则：名字以 -free 结尾 + big-pickle）<span class="flex" style="float:right"><span class="dim mono" id="models-at"></span><button id="btn-refresh">拉取最新模型列表</button></span></h2>
  <div id="free-tbl"></div>
  <div class="dim" id="free-note" style="margin-top:8px;font-size:12px"></div></div>

<div class="card wide" id="resin-card" style="display:none"><h2>出口池（resin）</h2>
  <div class="kv" id="resin-kv"></div>
  <div id="resin-open" style="margin-top:10px"></div>
  <h2 style="margin-top:14px">最近出口请求</h2>
  <div id="resin-logs"></div>
</div>

<div class="card wide" id="reqs-card" style="display:none"><h2>实时请求日志（网关侧 · 尾部 30 条，新在上）<span class="flex" style="float:right"><button id="f-all">全部</button><button id="f-bad">仅非 200</button></span></h2>
  <div id="reqs"></div></div>

<div class="card wide" id="sync-card" style="display:none"><h2>最近一次白名单同步</h2><div class="kv" id="sync"></div></div>

</main>
<footer>只读面板 · 数据源：网关 /health+/v1/models · 上游目录 · 可选：请求日志 / CPA 白名单 / 同步回执 / 出口池 · 5s 刷新</footer>
<script>
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
var cls = function (c) { return c === 200 ? "s200" : c === 429 ? "s429" : "s0"; };
var reqFilter = "all";

function snips(base) {
  var b = base.replace(/\/v1$/, "");
  return {
    "snip-claude": "export ANTHROPIC_BASE_URL=" + b + "\\nexport ANTHROPIC_AUTH_TOKEN=<任意>\\nclaude   # 模型名可用 claude-sonnet-5 / claude-haiku-4-5（网关映射到 muse-spark-1.3）",
    "snip-codex": "[model_providers.zen]\\nname = \\"zen2api\\"\\nbase_url = \\"" + base + "\\"\\nenv_key = \\"ZEN_KEY\\"\\nwire_api = \\"responses\\"\\n\\n# 启动：ZEN_KEY=any codex -m muse-spark-1.3-contributor-free -c model_provider=zen",
    "snip-curl": "curl " + base + "/chat/completions \\\\\\n  -H \\"Authorization: Bearer any\\" -H \\"Content-Type: application/json\\" \\\\\\n  -d '{\\"model\\":\\"big-pickle\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}'"
  };
}
function renderSnips(base) {
  var S = snips(base);
  Object.keys(S).forEach(function (id) {
    $(id).innerHTML = '<div class="hd"><span>' + (id === "snip-claude" ? "环境变量" : id === "snip-codex" ? "config.toml" : "bash") + '</span><button data-snip="' + id + '">复制</button></div><code>' + esc(S[id]) + "</code>";
  });
}

function copyText(t, el) {
  var done = function () { el.classList.add("copied"); setTimeout(function () { el.classList.remove("copied"); }, 700); };
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t).then(done, function () { fallback(); }); }
  else fallback();
  function fallback() {
    var ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) {}
    document.body.removeChild(ta);
  }
}
document.addEventListener("click", function (ev) {
  var t = ev.target;
  var c = t.closest ? t.closest("[data-copy]") : null;
  if (c && c.getAttribute("data-copy")) { copyText(c.getAttribute("data-copy"), c); return; }
  if (t.dataset && t.dataset.snip) {
    var pre = $(t.dataset.snip);
    var code = pre.querySelector("code");
    copyText(code ? code.textContent : pre.textContent, pre);
  }
});
$("f-all").onclick = function () { reqFilter = "all"; tick(); };
$("f-bad").onclick = function () { reqFilter = "bad"; tick(); };
$("btn-refresh").onclick = async function () {
  var b = $("btn-refresh");
  b.disabled = true; b.textContent = "拉取中…";
  try {
    var r = await (await fetch("/api/refresh", { method: "POST" })).json();
    var n = (r.gw && r.gw.count) || "?";
    b.textContent = "已拉取 " + n + " 个 ✓";
    setTimeout(function () { b.textContent = "拉取最新模型列表"; b.disabled = false; }, 3000);
    tick();
  } catch (e) { b.textContent = "拉取失败"; b.disabled = false; }
};

function renderFree(st) {
  var gwIds = ((st.models && st.models.data && st.models.data.data) || []).map(function (m) { return m.id; });
  var upIds = (st.upstream && st.upstream.free) || [];
  var cpa = st.cpa || {};
  var cpaIds = cpa.models || [];
  var all = {};
  [gwIds, upIds, cpaIds].forEach(function (arr) { arr.forEach(function (id) { all[id] = 1; }); });
  var ids = Object.keys(all).sort();
  var at = st.models && st.models.data && st.models.data.updated_at;
  $("models-at").textContent = at ? "网关清单更新于 " + new Date(at).toLocaleString("sv-SE", { hour12: false }).slice(5, 16) : "";
  var f = function (b) { return b ? '<span class="s200">✓</span>' : '<span class="dim">—</span>'; };
  var head = "<tr><th>模型</th><th>上游目录</th><th>网关清单</th>" + (cpa.enabled ? "<th>CPA 白名单</th>" : "") + "</tr>";
  $("free-tbl").innerHTML = '<table class="mono">' + head + ids.map(function (id) {
    return "<tr><td>" + esc(id) + "</td><td>" + f(upIds.indexOf(id) >= 0) + "</td><td>" + f(gwIds.indexOf(id) >= 0) + "</td>" + (cpa.enabled ? "<td>" + f(cpaIds.indexOf(id) >= 0) + "</td>" : "") + "</tr>";
  }).join("") + "</table>";
  var missing = gwIds.filter(function (id) { return cpaIds.indexOf(id) < 0; });
  $("free-note").textContent = "上游目录 " + upIds.length + " 个 · 网关清单 " + gwIds.length + " 个" + (cpa.enabled ? " · CPA 白名单 " + cpaIds.length + " 个" + (missing.length ? " · 网关有、CPA 没有：" + missing.join(", ") : " · 网关清单已全部在 CPA 白名单内") : "");
}

async function tick() {
  var st;
  try { st = await (await fetch("/api/state")).json(); }
  catch (e) { $("dot").className = "dot bad"; return; }
  var h = st.health || {};
  var ok = h.code === 200 && h.data && h.data.ok === true;
  $("dot").className = "dot " + (ok ? "ok" : "bad");
  $("up").textContent = ok ? "up " + Math.floor((h.data.uptime_s || 0) / 60) + " min" : "网关不可达";
  $("ts").textContent = "刷新 " + new Date(st.ts).toLocaleTimeString();
  $("u-oai").textContent = st.publicUrl + "/v1";
  $("u-oai").setAttribute("data-copy", st.publicUrl + "/v1");
  $("u-anth").textContent = st.publicUrl;
  $("u-anth").setAttribute("data-copy", st.publicUrl);
  if (st.egress) { $("egress-box").style.display = ""; $("egress-mode").textContent = st.egress.mode; $("egress-mode").title = st.egress.proxy || ""; }

  var rs = st.resin || {};
  if (rs.enabled) {
    $("resin-card").style.display = "";
    $("pool-pill").style.display = "";
    $("pool-pill").textContent = rs.ok ? "池 " + rs.routable + " 可路由" : "池 ?";
    $("pool-pill").className = "pill " + (rs.ok ? (rs.open && rs.open.length ? "bad" : "ok") : "");
    $("resin-kv").innerHTML = rs.ok ? [
      ["可路由节点", '<span class="mono">' + rs.routable + "</span>"],
      ["订阅节点总数", '<span class="mono">' + rs.total + "</span>"],
      ["JP 健康", '<span class="mono s200">' + rs.jp_ok + "</span>"],
      ["US 健康", '<span class="mono s200">' + rs.us_ok + "</span>"],
      ["熔断中", '<span class="mono ' + (rs.open.length ? "s0" : "s200") + '">' + rs.open.length + "</span>"],
    ].map(function (r) { return "<div><b>" + r[0] + "</b>" + r[1] + "</div>"; }).join("") : '<span class="dim">' + esc(rs.error || "取数失败") + "</span>";
    $("resin-open").innerHTML = rs.ok && rs.open.length
      ? '<div class="dim" style="margin-bottom:4px">熔断节点：</div><table class="mono"><tr><th>节点</th><th>失败</th><th>错误</th></tr>' + rs.open.map(function (o) { return "<tr><td>" + esc(o.tag) + "</td><td>" + esc(o.fails) + "</td><td>" + esc(o.err) + "</td></tr>"; }).join("") + "</table>" : "";
    $("resin-logs").innerHTML = rs.ok && rs.logs.length
      ? '<table class="mono"><tr><th>时间</th><th>节点</th><th>出口 IP</th><th>目标</th><th>status</th><th>ms</th></tr>' + rs.logs.map(function (l) {
        return "<tr><td>" + esc(new Date(l.ts).toLocaleString("sv-SE", { hour12: false }).slice(5, 16)) + "</td><td>" + esc(l.tag) + "</td><td>" + esc(l.ip) + "</td><td>" + esc(l.host) + '</td><td class="' + (l.ok ? "s200" : "s0") + '">' + esc(l.status) + "</td><td>" + esc(l.ms) + "</td></tr>";
      }).join("") + "</table>" : '<span class="dim">无出口日志</span>';
  }

  renderFree(st);

  if (st.reqsEnabled) {
    $("reqs-card").style.display = "";
    var rows = (st.reqs || []).slice().reverse();
    if (reqFilter === "bad") rows = rows.filter(function (r) { return r.status !== 200; });
    $("reqs").innerHTML = '<table class="mono"><tr><th>时间</th><th>lane</th><th>model</th><th>status</th><th>ms</th><th>stream</th></tr>' + rows.map(function (r) {
      return "<tr><td>" + esc(r.ts ? new Date(r.ts).toLocaleString("sv-SE", { hour12: false }).slice(5, 16) : "-") + "</td><td>" + esc(r.lane) + "</td><td>" + esc(r.model) + '</td><td class="' + cls(r.status) + '">' + esc(r.status) + "</td><td>" + esc(r.ms) + "</td><td>" + (r.stream ? "是" : "否") + "</td></tr>";
    }).join("") + "</table>";
  }

  var s = st.sync;
  if (s) {
    $("sync-card").style.display = "";
    $("sync").innerHTML = [
      ["时间", esc(s.ts)], ["新增", (s.added || []).join(", ") || "—"],
      ["剔除", (s.removed || []).join(", ") || "—"], ["白名单", (s.desired || []).length + " 个"],
    ].map(function (r) { return "<div><b>" + r[0] + "</b><span class='mono'>" + r[1] + "</span></div>"; }).join("");
  }
}

renderSnips(PUBLIC_URL);
tick(); setInterval(tick, 5000);
</script></body></html>`;

Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/api/state") {
      const [health, models, resin, upstream] = await Promise.all([jget(GW + "/health"), jget(GW + "/v1/models"), resinState(), upstreamFree()]);
      return Response.json({
        ts: new Date().toISOString(),
        publicUrl: PUBLIC_URL,
        health, models, resin, upstream,
        egress: egressInfo(),
        cpa: cpaWhitelist(),
        sync: lastSync(),
        reqsEnabled: !!REQ_LOG,
        reqs: tailJsonl(30),
      });
    }
    if (u.pathname === "/api/refresh" && req.method === "POST") {
      const gw = await jpost(GW + "/v1/models/refresh");
      upstreamCache = { at: 0, free: [], error: "" };
      const [upstream, models] = await Promise.all([upstreamFree(), jget(GW + "/v1/models")]);
      return Response.json({ ts: new Date().toISOString(), gw, upstream, models, cpa: cpaWhitelist() });
    }
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`zen2api panel listening on http://${HOST}:${PORT} (read-only) -> ${GW}`);
