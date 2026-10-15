#!/usr/bin/env python3
"""zen2api v2 验收冒烟：python3 smoke.py [base_url]

默认 http://127.0.0.1:18500。退出码 0 = 全过。
"""
import json, re, sys, time, urllib.request, urllib.error

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18500").rstrip("/")
MUSE = "muse-spark-1.3-contributor-free"
PASS, FAIL = [], []


def call(path, body, timeout=150):
    data = json.dumps(body).encode()
    rq = urllib.request.Request(BASE + path, data=data, headers={"content-type": "application/json"}, method="POST")
    t0 = time.time()
    try:
        r = urllib.request.urlopen(rq, timeout=timeout)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), round(time.time() - t0, 1)
    ct = r.headers.get("content-type", "")
    if "event-stream" in ct:
        buf = b""
        while True:
            try:
                chunk = r.read(2048)
            except Exception:
                break
            if not chunk:
                break
            buf += chunk
            if len(buf) > 20000:
                break
            s = buf.decode("utf-8", "replace")
            if "response.completed" in s or "message_stop" in s or "[DONE]" in s:
                break
        return r.status, buf.decode("utf-8", "replace"), round(time.time() - t0, 1)
    return r.status, r.read().decode("utf-8", "replace"), round(time.time() - t0, 1)


def stream_text(txt, kind):
    out = ""
    for m in re.finditer(r"^data: (.+)$", txt, re.M):
        try:
            d = json.loads(m.group(1))
        except Exception:
            continue
        if kind == "responses" and d.get("type") == "response.output_text.delta":
            out += d.get("delta", "")
        elif kind == "anthropic" and d.get("type") == "content_block_delta" and d.get("delta", {}).get("type") == "text_delta":
            out += d["delta"].get("text", "")
        elif kind == "chat":
            ch = (d.get("choices") or [{}])[0]
            out += (ch.get("delta") or {}).get("content") or ""
    return out


def fc_names(txt):
    names = []
    for m in re.finditer(r"^data: (.+)$", txt, re.M):
        try:
            d = json.loads(m.group(1))
        except Exception:
            continue
        it = d.get("item")
        if isinstance(it, dict) and it.get("type") == "function_call":
            names.append(it.get("name"))
        r = d.get("response")
        if isinstance(r, dict):
            for o in r.get("output") or []:
                if isinstance(o, dict) and o.get("type") == "function_call":
                    names.append(o.get("name"))
    return names


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(("PASS " if ok else "FAIL ") + name + ((" | " + detail) if detail else ""))


print("== zen2api v2 smoke @", BASE)
try:
    r = urllib.request.urlopen(BASE + "/health", timeout=10)
    h = json.loads(r.read())
    check("health", r.status == 200 and h.get("ok") is True, json.dumps(h, ensure_ascii=False)[:140])
except Exception as e:
    check("health", False, str(e))
    print("\n== server unreachable, abort")
    sys.exit(1)

code, txt, dt = call("/v1/responses", {"model": MUSE, "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "reply with exactly: OK"}]}], "stream": True})
check("responses stream", code == 200 and "OK" in stream_text(txt, "responses"), f"{code} {dt}s")

code, txt, dt = call("/v1/responses", {"model": MUSE, "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "reply with exactly: OK"}]}], "stream": False})
ok = False
try:
    d = json.loads(txt)
    ok = code == 200 and d.get("status") == "completed"
except Exception:
    pass
check("responses non-stream", ok, f"{code} {dt}s")

code, txt, dt = call("/v1/messages", {"model": "claude-sonnet-5", "max_tokens": 2000, "messages": [{"role": "user", "content": "reply with exactly: OK"}], "stream": True})
check("messages stream (alias->muse)", code == 200 and "OK" in stream_text(txt, "anthropic"), f"{code} {dt}s")

code, txt, dt = call("/v1/messages", {"model": "claude-sonnet-5", "max_tokens": 2000, "messages": [{"role": "user", "content": "reply with exactly: OK"}]})
ok = False
try:
    d = json.loads(txt)
    ok = code == 200 and any(b.get("text") == "OK" for b in d.get("content") or [])
except Exception:
    pass
check("messages non-stream", ok, f"{code} {dt}s")

code, txt, dt = call("/v1/chat/completions", {"model": "big-pickle", "messages": [{"role": "user", "content": "reply with exactly: OK"}], "stream": True})
check("chat stream (big-pickle)", code == 200 and "OK" in stream_text(txt, "chat"), f"{code} {dt}s")

gt = {"type": "function", "name": "get_time", "description": "Get the current time", "parameters": {"type": "object", "properties": {"tz": {"type": "string"}}}}
code, txt, dt = call("/v1/responses", {"model": MUSE, "input": [
    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "What exact time did the get_time tool return? Report it verbatim."}]},
    {"type": "function_call", "call_id": "call_smoke_1", "name": "get_time", "arguments": "{\"tz\":\"UTC\"}"},
    {"type": "function_call_output", "call_id": "call_smoke_1", "output": "2026-10-15T12:34:56Z"},
], "tools": [gt], "stream": True})
check("tool round-trip", code == 200 and "12:34" in stream_text(txt, "responses"), f"{code} {dt}s")

code, txt, dt = call("/v1/responses", {"model": MUSE, "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Use the read tool to read C:\\Windows\\win.ini and show me its first line."}]}], "stream": True})
leaked = "read" in fc_names(txt)
check("injected read filtered", code == 200 and not leaked, f"{code} {dt}s leaked={leaked}")

print(f"\n== {len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
