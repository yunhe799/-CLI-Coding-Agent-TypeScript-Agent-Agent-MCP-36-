#!/usr/bin/env node
// 本地 Web 演示台：把**真实的 CLI** 包成一层网页。
//
// 它刻意不重复实现 Agent —— 每次请求就 spawn 一次 `node dist/cli.js "<问题>"`，
// 把子进程的输出解析成事件，用 SSE 实时推给浏览器。好处：
//   · 页面里跑的就是命令行里那套代码，没有"演示版"和"真实版"之分
//   · 零依赖（只用 node 内置模块），clone 下来立刻能跑
//   · 录视频时：工具调用链、MCP 状态、回答都看得清清楚楚
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// 和 cli.ts 一样：从 .env 读配置（已存在的环境变量优先）
try {
  for (const line of readFileSync(join(root, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

const PORT = Number(process.env.WEB_PORT ?? 8787);
const html = readFileSync(join(here, "index.html"), "utf-8");

/** 跑一个问题，把 CLI 的输出按事件推给 res。 */
function runChat(message, res) {
  const send = (type, data = {}) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  send("status", { text: "启动 Agent…" });

  const child = spawn(process.execPath, ["dist/cli.js", message], { cwd: root });

  // stdout 里混着两种东西：工具调用行（`  → name(args)`，console.log 输出、带换行）
  // 和模型逐字吐出的正文（process.stdout.write，不带换行）。所以：
  // 完整行按行处理；剩下的半截缓冲，只有在"不像工具行"时才当正文实时flush。
  const handle = (line, kind) => {
    const t = line.replace(/\r$/, "");
    if (!t.trim()) return;
    if (kind === "err") return void send("status", { text: t.trim() });
    const tool = t.match(/^\s*→\s*([A-Za-z0-9_]+)\((.*)\)\s*$/);
    if (tool) return void send("tool", { name: tool[1], input: tool[2] });
    send("text", { text: t });
  };

  const watch = (stream, kind) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) handle(l, kind);
      // 半截缓冲：不像工具行/状态行的话，直接当正文推出去（保证"逐字"体验）
      if (buf && !/^\s*(→|\[mcp\])/.test(buf)) {
        send("text", { text: buf });
        buf = "";
      }
    });
    stream.on("end", () => {
      if (buf) handle(buf, kind);
    });
  };

  watch(child.stdout, "out");
  watch(child.stderr, "err");
  child.on("error", (e) => send("status", { text: `启动失败：${e.message}` }));
  child.on("close", (code) => {
    send("done", { code });
    res.end();
  });
  return child;
}

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let message = "";
      try {
        message = String(JSON.parse(body).message ?? "");
      } catch {}
      message = message.trim().slice(0, 2000);
      if (!message) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "消息是空的" }));
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const child = runChat(message, res);
      // 注意：要监听 **res** 的 close（客户端断开），不能监听 req——
      // req 的 'close' 在"请求体读完"时就触发了，会在刚 spawn 之后立刻把子进程杀掉。
      res.on("close", () => child.kill());
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`[web] 演示台已启动： http://localhost:${PORT}`);
  console.log(`[web] 工作目录 ${root}；模型 ${process.env.MINI_MODEL ?? "(未设置)"}`);
  console.log("[web] Ctrl+C 停止");
});
