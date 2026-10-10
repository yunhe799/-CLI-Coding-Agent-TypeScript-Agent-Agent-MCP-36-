#!/usr/bin/env node
// 一个极小的 MCP 服务器（第 12 章用来演示/测试的"外部工具服务器"）。
// 它和我们的客户端一样，只是在 stdin/stdout 上说按行分隔的 JSON-RPC。
// 真实世界里的 filesystem / github / 你自己写的业务服务器，说的是同一套协议——
// 所以客户端一行都不用改。
//
// 提供的工具：add（两数相加）、echo（回显）、timestamp（当前时间戳）。
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const TOOLS = [
  {
    name: "add",
    description: "Add two numbers and return the sum.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "echo",
    description: "Echo back the given text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "timestamp",
    description: "Return the current Unix timestamp (ms).",
    inputSchema: { type: "object", properties: {} },
  },
];

function handle(req) {
  const { id, method, params } = req;
  switch (method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "demo", version: "1.0.0" },
      } };
    case "notifications/initialized":
      return null; // 通知，不需要响应
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const args = params?.arguments || {};
      switch (params?.name) {
        case "add":
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String((args.a ?? 0) + (args.b ?? 0)) }] } };
        case "echo":
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(args.text ?? "") }] } };
        case "timestamp":
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(Date.now()) }] } };
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${params?.name}` } };
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  try {
    const resp = handle(JSON.parse(text));
    if (resp) send(resp);
  } catch {
    // 忽略解析不了的行
  }
});
