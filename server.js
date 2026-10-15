#!/usr/bin/env bun
/**
 * zen2api v2 —— 薄版直连网关（OpenCode Zen 免费池）
 *
 * 原理：把客户端请求补齐成「官方 OpenCode 客户端」的请求形状，直连
 *       https://opencode.ai/inference/openai/v1 并原样流式返回。
 *       不需要官方客户端进程、不需要侧车、不需要上游 key（免费池匿名可用）。
 *
 * 车道：
 *   POST /v1/responses          直通（muse-spark-1.3-contributor-free 等 Responses-only 模型）
 *   POST /v1/chat/completions   直通（big-pickle 等 Chat 模型）
 *   POST /v1/messages           Anthropic 协议 → 内部转成 Responses（muse 走这条）
 *   GET  /v1/models             模型清单
 *   GET  /health                健康检查
 *
 * 环境变量：
 *   PORT            监听端口（默认 18500）
 *   HOST            监听地址（默认 127.0.0.1）
 *   ZEN_UPSTREAM    上游基址（默认 https://opencode.ai/inference/openai/v1）
 *   ZEN_CLIENT_KEY  客户端鉴权 key（留空 = 不校验）
 *   ZEN_LOG         请求日志文件路径（留空 = 不落盘）
 *   ZEN_ALIASES     别名表 JSON（默认 claude-* → muse-spark-1.3-contributor-free）
 *   HTTPS_PROXY     出口代理（可选，Bun 生效，用于 resin 出口轮换）
 *   ZEN_TIMEOUT_MS  上游超时毫秒（默认 600000）
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

// 网关要能扛客户端断连/上游抖动：任何漏网异常只记日志，不退出进程。
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

// ── 配置 ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 18500);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM = (process.env.ZEN_UPSTREAM || "https://opencode.ai/inference/openai/v1").replace(/\/+$/, "");
const CLIENT_KEY = process.env.ZEN_CLIENT_KEY || "";
const LOG_PATH = process.env.ZEN_LOG || "";
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const UA = process.env.ZEN_UA || "opencode/latest/2.0.29/cli";
const TIMEOUT_MS = Number(process.env.ZEN_TIMEOUT_MS || 600000);
// 上游把加密推理块绑定到签发时的调用身份：客户端回放的旧 reasoning 项（跨身份/跨 IP）
// 会 400 "encrypted_content was not issued to this caller"。老版做法（STRIP_REASONING，默认开）：
// 入站 input 里的 reasoning 项一律剥掉，永不带旧密文上行。
const STRIP_REASONING = (process.env.ZEN_STRIP_REASONING || "1") !== "0";

let FREE_MODELS = [
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "big-pickle",
  "cat-jam-free",
  "mimo-v2.6-flash-free",
  "mimo-v2.5-free",
  "space-bunny-free",
  "nemotron-3.5-lightning-free",
];
let freeModelsAt = "";
// 免费池清单：拉上游 /zen/v1/models 目录，规则 = 名字以 -free 结尾 或 big-pickle（2026-10-15 用户钦定）。
// 启动拉一次 + 每 12h 一次（每天 2 次）；失败保留旧清单（不清空）。手动：POST /v1/models/refresh
const MODELS_URL = process.env.ZEN_MODELS_URL || "https://opencode.ai/zen/v1/models";
async function refreshFreeModels() {
  try {
    const opts = { headers: { "user-agent": UA } };
    if (PROXY) opts.proxy = PROXY;
    const r = await fetch(MODELS_URL, opts);
    const d = await r.json();
    const ids = (d.data || [])
      .map((m) => m.id)
      .filter((id) => id.endsWith("-free") || id === "big-pickle")
      .sort();
    if (ids.length >= 5) {
      FREE_MODELS = ids;
      freeModelsAt = new Date().toISOString();
      console.log(`free models refreshed: ${ids.length} @ ${freeModelsAt}`);
      return { ok: true, count: ids.length };
    }
    console.log(`free models refresh rejected (too few: ${ids.length})`);
    return { ok: false, error: `too few models: ${ids.length}` };
  } catch (e) {
    console.log(`free models refresh failed: ${e}`);
    return { ok: false, error: String(e) };
  }
}
refreshFreeModels();
setInterval(refreshFreeModels, 12 * 3600 * 1000);
const DEFAULT_ALIASES = {
  "claude-opus-5": "muse-spark-1.3-contributor-free",
  "claude-sonnet-5": "muse-spark-1.3-contributor-free",
  "claude-haiku-4-5": "muse-spark-1.3-contributor-free",
  "claude-fable-5": "muse-spark-1.3-contributor-free",
};
let ALIASES = { ...DEFAULT_ALIASES };
try { if (process.env.ZEN_ALIASES) ALIASES = { ...ALIASES, ...JSON.parse(process.env.ZEN_ALIASES) }; } catch {}

// 上游形状要求：请求体里必须有一个「名字叫 read、且 properties 非空」的工具。
// 客户端没带就注入这个；模型如果去调它，出站流里会被剥掉（客户端不知道这个工具的存在）。
const READ_TOOL = {
  name: "read",
  description: "Read the contents of a file.",
  input_schema: { type: "object", properties: { path: { type: "string", description: "File path to read" } } },
};

// ── 小工具 ────────────────────────────────────────────────────────────
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PROJECT_ID = randHex(20);

function randHex(n) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
}
// 会话 ID：与官方客户端同构 —— ses_ + 12 位 hex（毫秒时间戳编码）+ 14 位 base62
function makeSid() {
  const v = (~(BigInt(Date.now()) * 4096n + 1n)) & ((1n << 48n) - 1n);
  let r = "";
  for (const b of crypto.getRandomValues(new Uint8Array(14))) r += B62[b % 62];
  return "ses_" + v.toString(16).padStart(12, "0") + r;
}
function upstreamHeaders(sid) {
  return {
    "content-type": "application/json",
    "authorization": "Bearer public",
    "user-agent": UA,
    "x-opencode-client": "cli",
    "x-opencode-project": PROJECT_ID,
    "x-opencode-session": sid,
    "x-opencode-session-id": sid,
    "x-session-affinity": sid,
    "x-session-id": sid,
  };
}
function callUpstream(path, body, sid, signal) {
  const opts = { method: "POST", headers: upstreamHeaders(sid), body: JSON.stringify(body), signal };
  if (PROXY) opts.proxy = PROXY; // Bun 支持；Node 需自行挂 ProxyAgent
  return fetch(UPSTREAM + path, opts);
}
function logLine(obj) {
  if (!LOG_PATH) return;
  try { fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n"); } catch {}
}
function resolveModel(model) { return ALIASES[model] || model; }
function safeWrite(res, s) { if (res.destroyed || res.writableEnded) return; try { res.write(s); } catch {} }
function safeEnd(res) { if (res.destroyed || res.writableEnded) return; try { res.end(); } catch {} }
function sendJson(res, code, obj) {
  if (res.destroyed || res.writableEnded) return;
  try { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); } catch {}
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const cs = [];
    req.on("data", (c) => cs.push(c));
    req.on("end", () => resolve(Buffer.concat(cs).toString("utf8")));
    req.on("error", reject);
  });
}
async function* sseBlocks(stream) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    buf = buf.replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 2); }
  }
  if (buf.trim()) yield buf;
}
const evType = (b) => { const m = b.match(/^event:\s*(\S+)/m); return m ? m[1] : ""; };
const evData = (b) => { const m = b.match(/^data:\s*(.*)$/m); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; } };

const STUB_NAMES = new Set(["bash", "read", "glob", "grep"]);
function ensureReadResponses(tools) {
  let arr = Array.isArray(tools) ? tools.slice() : [];
  // 上游会把「bash/glob/grep + 空 properties」识别为旧版伪装签名并 403，直接丢弃这类工具
  arr = arr.filter((t) => {
    if (!t || !STUB_NAMES.has(t.name) || t.name === "read") return true;
    const props = t.parameters && t.parameters.properties;
    return !!(props && Object.keys(props).length);
  });
  const i = arr.findIndex((t) => t && t.name === "read");
  if (i < 0) {
    arr.push({ type: "function", name: READ_TOOL.name, description: READ_TOOL.description, parameters: READ_TOOL.input_schema });
    return { tools: arr, injected: true };
  }
  const props = arr[i].parameters && arr[i].parameters.properties;
  if (!props || !Object.keys(props).length) {
    arr[i] = { ...arr[i], parameters: READ_TOOL.input_schema };
    return { tools: arr, injected: false, fixed: true };
  }
  return { tools: arr, injected: false };
}
function ensureReadChat(tools) {
  let arr = Array.isArray(tools) ? tools.slice() : [];
  arr = arr.filter((t) => {
    const n = t && t.function && t.function.name;
    if (!n || !STUB_NAMES.has(n) || n === "read") return true;
    const props = t.function.parameters && t.function.parameters.properties;
    return !!(props && Object.keys(props).length);
  });
  const i = arr.findIndex((t) => t && t.function && t.function.name === "read");
  if (i < 0) {
    arr.push({ type: "function", function: { name: READ_TOOL.name, description: READ_TOOL.description, parameters: READ_TOOL.input_schema } });
    return { tools: arr, injected: true };
  }
  const f = arr[i].function;
  if (!f.parameters || !f.parameters.properties || !Object.keys(f.parameters.properties).length) {
    arr[i] = { ...arr[i], function: { ...f, parameters: READ_TOOL.input_schema } };
    return { tools: arr, injected: false, fixed: true };
  }
  return { tools: arr, injected: false };
}

// 建立上游连接；失败时返回 null（已记日志）
async function openUpstream(req, res, path, shaped, sid, lane, model) {
  const t0 = Date.now();
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  let up;
  try {
    up = await callUpstream(path, shaped, sid, AbortSignal.any([ac.signal, AbortSignal.timeout(TIMEOUT_MS)]));
  } catch (e) {
    logLine({ lane, model, status: 0, error: String(e), ms: Date.now() - t0 });
    sendJson(res, 502, { error: { message: "upstream: " + String(e) } });
    return null;
  }
  if (!up.ok) {
    let txt = "";
    try { txt = await up.text(); } catch {}
    logLine({ lane, model, status: up.status, ms: Date.now() - t0, upstream_body: txt.slice(0, 300) });
    if (res.destroyed || res.writableEnded) return null;
    try { res.writeHead(up.status, { "content-type": "application/json" }); res.end(txt); } catch {}
    return null;
  }
  return { up, t0 };
}

// ── /v1/responses：直通 ───────────────────────────────────────────────
async function handleResponses(req, res, body) {
  const sid = makeSid();
  const model = resolveModel(body.model);
  const { tools, injected } = ensureReadResponses(body.tools);
  const shaped = { ...body, model, stream: true, prompt_cache_key: sid, tools };
  if (STRIP_REASONING && Array.isArray(shaped.input)) {
    shaped.input = shaped.input.filter((it) => !(it && it.type === "reasoning"));
  }
  const conn = await openUpstream(req, res, "/responses", shaped, sid, "/responses", model);
  if (!conn) return;
  const { up, t0 } = conn;

  if (body.stream === true) {
    if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const dropped = new Set();
    try {
      for await (const blk of sseBlocks(up.body)) {
        if (res.destroyed) break;
        const t = evType(blk), d = evData(blk);
        if (injected) {
          if (t === "response.output_item.added" && d && d.item && d.item.type === "function_call" && d.item.name === "read") { dropped.add(d.item.id); continue; }
          if (d && d.item_id && dropped.has(d.item_id)) continue;
          if (t === "response.output_item.done" && d && d.item && dropped.has(d.item.id)) continue;
          if (t === "response.completed" && d && d.response && Array.isArray(d.response.output)) {
            d.response.output = d.response.output.filter((it) => !(it.type === "function_call" && it.name === "read"));
            safeWrite(res, "event: response.completed\ndata: " + JSON.stringify(d) + "\n\n");
            continue;
          }
        }
        safeWrite(res, blk + "\n\n");
      }
    } catch (e) { /* 客户端断开或上游中断，正常收尾 */ }
    logLine({ lane: "/responses", model, status: 200, ms: Date.now() - t0, stream: true, injected });
    return safeEnd(res);
  }

  let final = null, errMsg = null;
  try {
    for await (const blk of sseBlocks(up.body)) {
      const t = evType(blk), d = evData(blk);
      if (t === "error") errMsg = (d && (d.error?.message || d.message)) || "upstream error";
      if (t === "response.completed" && d) final = d.response;
    }
  } catch (e) {
    logLine({ lane: "/responses", model, status: 0, error: String(e), ms: Date.now() - t0 });
    return sendJson(res, 502, { error: { message: "upstream stream: " + String(e) } });
  }
  if (final && injected && Array.isArray(final.output)) {
    final.output = final.output.filter((it) => !(it.type === "function_call" && it.name === "read"));
  }
  if (!final) {
    const msg = errMsg || "no completed response from upstream";
    logLine({ lane: "/responses", model, status: 502, ms: Date.now() - t0, stream: false, injected, error: msg });
    return sendJson(res, 502, { error: { message: msg } });
  }
  logLine({ lane: "/responses", model, status: 200, ms: Date.now() - t0, stream: false, injected });
  sendJson(res, 200, final);
}

// ── /v1/chat/completions：直通 ────────────────────────────────────────
async function handleChat(req, res, body) {
  const sid = makeSid();
  const model = resolveModel(body.model);
  const { tools, injected } = ensureReadChat(body.tools);
  const shaped = { ...body, model, stream: true, tools };
  const conn = await openUpstream(req, res, "/chat/completions", shaped, sid, "/chat/completions", model);
  if (!conn) return;
  const { up, t0 } = conn;
  const badIdx = new Set();

  if (body.stream === true) {
    if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    try {
      for await (const blk of sseBlocks(up.body)) {
        if (res.destroyed) break;
        const d = evData(blk);
        if (injected && d && Array.isArray(d.choices)) {
          for (const ch of d.choices) {
            const tcs = ch.delta && ch.delta.tool_calls;
            if (!Array.isArray(tcs)) continue;
            const kept = tcs.filter((tc) => {
              if (tc.function && tc.function.name === "read") { badIdx.add(tc.index); return false; }
              return !badIdx.has(tc.index);
            });
            if (kept.length) ch.delta.tool_calls = kept;
            else delete ch.delta.tool_calls;
          }
        }
        safeWrite(res, blk + "\n\n");
      }
    } catch (e) { /* 客户端断开或上游中断 */ }
    logLine({ lane: "/chat/completions", model, status: 200, ms: Date.now() - t0, stream: true, injected });
    return safeEnd(res);
  }

  // 非流式：把上游 SSE 聚合成一条 chat.completion
  let id = "chatcmpl-" + randHex(12), created = Math.floor(Date.now() / 1000), content = "";
  const toolCalls = new Map();
  let finish = null, usage = null, upstreamModel = model, errMsg = null;
  try {
    for await (const blk of sseBlocks(up.body)) {
      const d = evData(blk);
      if (!d) continue;
      if (d.error) { errMsg = d.error.message || "upstream error"; continue; }
      if (d.id) id = d.id;
      if (d.model) upstreamModel = d.model;
      if (d.usage) usage = d.usage;
      const ch = Array.isArray(d.choices) ? d.choices[0] : null;
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const delta = ch.delta || {};
      if (typeof delta.content === "string") content += delta.content;
      for (const tc of delta.tool_calls || []) {
        if (injected && tc.function && tc.function.name === "read") { badIdx.add(tc.index); continue; }
        if (badIdx.has(tc.index)) continue;
        const cur = toolCalls.get(tc.index) || { id: tc.id, type: "function", function: { name: "", arguments: "" } };
        if (tc.id) cur.id = tc.id;
        if (tc.function && tc.function.name) cur.function.name = tc.function.name;
        if (tc.function && tc.function.arguments) cur.function.arguments += tc.function.arguments;
        toolCalls.set(tc.index, cur);
      }
    }
  } catch (e) {
    logLine({ lane: "/chat/completions", model, status: 0, error: String(e), ms: Date.now() - t0 });
    return sendJson(res, 502, { error: { message: "upstream stream: " + String(e) } });
  }
  if (errMsg && !content && !toolCalls.size) {
    logLine({ lane: "/chat/completions", model, status: 502, ms: Date.now() - t0, stream: false, injected, error: errMsg });
    return sendJson(res, 502, { error: { message: errMsg } });
  }
  const msg = { role: "assistant", content: content || null };
  if (toolCalls.size) msg.tool_calls = [...toolCalls.values()];
  logLine({ lane: "/chat/completions", model, status: 200, ms: Date.now() - t0, stream: false, injected });
  sendJson(res, 200, { id, object: "chat.completion", created, model: upstreamModel, choices: [{ index: 0, message: msg, finish_reason: toolCalls.size ? "tool_calls" : (finish || "stop") }], usage: usage || undefined });
}

// ── Anthropic ⇄ Responses 转换（/v1/messages 用）──────────────────────
function anthropicToResponses(body) {
  const input = [];
  let instructions = "";
  const sys = body.system;
  if (typeof sys === "string") instructions = sys;
  else if (Array.isArray(sys)) instructions = sys.map((s) => (typeof s === "string" ? s : s.text || "")).join("\n");
  for (const m of body.messages || []) {
    if (typeof m.content === "string") {
      input.push({ type: "message", role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    if (m.role === "assistant") {
      let textParts = [];
      const flush = () => { if (textParts.length) { input.push({ type: "message", role: "assistant", content: textParts }); textParts = []; } };
      for (const b of m.content) {
        if (b.type === "text") textParts.push({ type: "output_text", text: b.text });
        else if (b.type === "tool_use") {
          flush();
          input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
        }
      }
      flush();
    } else {
      for (const b of m.content) {
        if (b.type === "text") input.push({ type: "message", role: "user", content: [{ type: "input_text", text: b.text }] });
        else if (b.type === "tool_result") {
          let out = b.content;
          if (Array.isArray(out)) out = out.map((x) => (typeof x === "string" ? x : x.text || "")).join("\n");
          input.push({ type: "function_call_output", call_id: b.tool_use_id, output: typeof out === "string" ? out : JSON.stringify(out ?? "") });
        }
      }
    }
  }
  const tools = (body.tools || []).map((t) => ({ type: "function", name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } }));
  const out = { model: body.model, input, stream: true };
  if (instructions) out.instructions = instructions;
  if (tools.length) out.tools = tools;
  if (body.max_tokens) out.max_output_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  const tc = body.tool_choice;
  if (tc && tc.type === "auto") out.tool_choice = "auto";
  else if (tc && tc.type === "any") out.tool_choice = "required";
  else if (tc && tc.type === "tool" && tc.name) out.tool_choice = { type: "function", name: tc.name };
  return out;
}

async function pipeResponsesToAnthropic(res, up, model, injected) {
  if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const w = (event, data) => safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const msgId = "msg_" + randHex(12);
  let started = false, nextIdx = 0, textIdx = -1, toolIdx = -1;
  const dropped = new Set();
  let outputTokens = 0, sawTool = false;
  const ensureStart = () => {
    if (started) return;
    started = true;
    w("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  };
  const closeText = () => { if (textIdx >= 0) { w("content_block_stop", { type: "content_block_stop", index: textIdx }); textIdx = -1; } };
  const closeTool = () => { if (toolIdx >= 0) { w("content_block_stop", { type: "content_block_stop", index: toolIdx }); toolIdx = -1; } };

  try {
    for await (const blk of sseBlocks(up.body)) {
      if (res.destroyed) break;
      const t = evType(blk), d = evData(blk);
      if (t === "response.created") { ensureStart(); continue; }
      if (t === "error" || t === "response.failed") {
        const r = d && d.response;
        const msg = (d && d.error && d.error.message) || (r && r.error && r.error.message) || (d && d.message) || "upstream error";
        ensureStart();
        w("error", { type: "error", error: { type: "api_error", message: msg } });
        continue;
      }
      if (t === "response.output_item.added") {
        const it = d && d.item;
        if (it && it.type === "function_call") {
          if (injected && it.name === "read") { dropped.add(it.id); continue; }
          ensureStart();
          closeText();
          toolIdx = nextIdx++;
          sawTool = true;
          w("content_block_start", { type: "content_block_start", index: toolIdx, content_block: { type: "tool_use", id: it.call_id || it.id, name: it.name, input: {} } });
        }
        continue;
      }
      if (d && d.item_id && dropped.has(d.item_id)) continue;
      if (t === "response.output_text.delta" && d && d.delta) {
        ensureStart();
        if (textIdx < 0) {
          closeTool();
          textIdx = nextIdx++;
          w("content_block_start", { type: "content_block_start", index: textIdx, content_block: { type: "text", text: "" } });
        }
        w("content_block_delta", { type: "content_block_delta", index: textIdx, delta: { type: "text_delta", text: d.delta } });
        continue;
      }
      if (t === "response.function_call_arguments.delta" && d && d.delta && toolIdx >= 0) {
        w("content_block_delta", { type: "content_block_delta", index: toolIdx, delta: { type: "input_json_delta", partial_json: d.delta } });
        continue;
      }
      if (t === "response.output_item.done") {
        const it = d && d.item;
        if (it && it.type === "function_call") closeTool();
        continue;
      }
      if (t === "response.completed") {
        const r = d && d.response;
        if (r && r.usage) outputTokens = r.usage.output_tokens || outputTokens;
        ensureStart();
        closeText();
        closeTool();
        w("message_delta", { type: "message_delta", delta: { stop_reason: sawTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } });
        w("message_stop", { type: "message_stop" });
        continue;
      }
    }
  } catch (e) { /* 客户端断开或上游中断 */ }
  safeEnd(res);
}

async function handleMessages(req, res, body) {
  const sid = makeSid();
  const model = resolveModel(body.model);
  const shaped = anthropicToResponses({ ...body, model });
  const { tools, injected } = ensureReadResponses(shaped.tools);
  shaped.tools = tools;
  const conn = await openUpstream(req, res, "/responses", shaped, sid, "/messages", model);
  if (!conn) return;
  const { up, t0 } = conn;

  if (body.stream === true) {
    logLine({ lane: "/messages", model, status: 200, ms: Date.now() - t0, stream: true, injected });
    return pipeResponsesToAnthropic(res, up, model, injected);
  }

  // 非流式：聚合为 Anthropic Message
  const msgId = "msg_" + randHex(12);
  const content = [];
  let textBuf = "", usage = { input_tokens: 0, output_tokens: 0 }, stopReason = "end_turn";
  const dropped = new Set();
  let curTool = null, sawCompleted = false, errMsg = null;
  const flushText = () => { if (textBuf) { content.push({ type: "text", text: textBuf }); textBuf = ""; } };
  try {
    for await (const blk of sseBlocks(up.body)) {
      const t = evType(blk), d = evData(blk);
      if (t === "error") { errMsg = (d && (d.error?.message || d.message)) || "upstream error"; continue; }
      if (t === "response.output_text.delta" && d && d.delta) { textBuf += d.delta; continue; }
      if (t === "response.output_item.added" && d && d.item && d.item.type === "function_call") {
        if (injected && d.item.name === "read") { dropped.add(d.item.id); continue; }
        flushText();
        curTool = { type: "tool_use", id: d.item.call_id || d.item.id, name: d.item.name, input: {} };
        continue;
      }
      if (d && d.item_id && dropped.has(d.item_id)) continue;
      if (t === "response.function_call_arguments.delta" && d && d.delta && curTool) { curTool._args = (curTool._args || "") + d.delta; continue; }
      if (t === "response.output_item.done" && d && d.item && d.item.type === "function_call") {
        if (curTool) {
          try { curTool.input = JSON.parse(curTool._args || "{}"); } catch { curTool.input = {}; }
          delete curTool._args;
          content.push(curTool);
          curTool = null;
          stopReason = "tool_use";
        }
        continue;
      }
      if (t === "response.completed" && d && d.response) {
        sawCompleted = true;
        if (d.response.usage) usage = { input_tokens: d.response.usage.input_tokens || 0, output_tokens: d.response.usage.output_tokens || 0 };
        continue;
      }
    }
  } catch (e) {
    logLine({ lane: "/messages", model, status: 0, error: String(e), ms: Date.now() - t0 });
    return sendJson(res, 502, { type: "error", error: { type: "api_error", message: "upstream stream: " + String(e) } });
  }
  if (!sawCompleted) {
    const msg = errMsg || "no completed response from upstream";
    logLine({ lane: "/messages", model, status: 502, ms: Date.now() - t0, stream: false, injected, error: msg });
    return sendJson(res, 502, { type: "error", error: { type: "api_error", message: msg } });
  }
  flushText();
  if (curTool) { try { curTool.input = JSON.parse(curTool._args || "{}"); } catch {} delete curTool._args; content.push(curTool); stopReason = "tool_use"; }
  logLine({ lane: "/messages", model, status: 200, ms: Date.now() - t0, stream: false, injected });
  sendJson(res, 200, { id: msgId, type: "message", role: "assistant", model, content, stop_reason: stopReason, stop_sequence: null, usage });
}

// ── HTTP 入口 ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (CLIENT_KEY) {
      const auth = req.headers["authorization"] || "";
      const k = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-api-key"] || "";
      if (k !== CLIENT_KEY) return sendJson(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid api key" } });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return sendJson(res, 200, { object: "list", updated_at: freeModelsAt, data: FREE_MODELS.map((id) => ({ id, object: "model", owned_by: "zen2api-v2" })) });
    }
    if (req.method === "POST" && url.pathname === "/v1/models/refresh") {
      const r = await refreshFreeModels();
      return sendJson(res, r.ok ? 200 : 502, { ...r, updated_at: freeModelsAt, models: FREE_MODELS });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, uptime_s: Math.round(process.uptime()), upstream: UPSTREAM });
    }
    if (req.method !== "POST") return sendJson(res, 404, { error: { message: "not found" } });
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { return sendJson(res, 400, { error: { message: "invalid json" } }); }
    if (url.pathname === "/v1/responses") return await handleResponses(req, res, body);
    if (url.pathname === "/v1/chat/completions") return await handleChat(req, res, body);
    if (url.pathname === "/v1/messages") return await handleMessages(req, res, body);
    return sendJson(res, 404, { error: { message: "not found" } });
  } catch (e) {
    console.error("request error:", e);
    sendJson(res, 500, { error: { message: String(e) } });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`zen2api v2 listening on http://${HOST}:${PORT} -> ${UPSTREAM}${PROXY ? " via " + PROXY.replace(/\/\/.*@/, "//***@") : ""}`);
});
