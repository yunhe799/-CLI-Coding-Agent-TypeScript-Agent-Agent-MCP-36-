import { spawn, type ChildProcess } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface, type Interface } from "readline";

// ── 第 12 章新增：MCP 客户端 ──
// 到这一章之前，工具全写死在 tools.ts 里，想加一个就得改源码。
// MCP（Model Context Protocol）让我们**在配置里声明一个服务器**，就能把它的
// 工具动态挂进来，agent 代码一行都不用动。
//
// 我们实现的是 MCP 最核心的那条路：
//   spawn 子进程 → 在 stdio 上用 JSON-RPC 握手 → 问它有哪些工具 → 转发调用。
// 真实 MCP 还有 SSE 传输、鉴权、动态刷新，这里只留 stdio（覆盖绝大多数本地场景）。
//
// 每个工具对外暴露成三段式名字 `mcp__<服务器名>__<工具名>`——一个名字同时
// 解决了"不同服务器的工具可能重名"和"该把调用转发给谁"两个问题。

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: any;
  serverName: string;
}

// Windows 上直接 spawn("npx", ...) 会失败——npx 是 .cmd 包装脚本，不是可执行文件。
// 但 Node 24 起 `spawn(cmd, args, { shell: true })` 会报弃用警告，而且 args 不做
// 转义有注入风险。所以这里改成：Windows 下手工拼一条命令行、显式交给 cmd.exe 解析。
const isWin = process.platform === "win32";

function spawnServer(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
  if (!isWin) return spawn(command, args, { stdio, env });
  const comspec = process.env.ComSpec || "cmd.exe";
  const line = [command, ...args].map(quoteForCmd).join(" ");
  return spawn(comspec, ["/d", "/s", "/c", line], { stdio, env });
}

// 按 cmd.exe 的规则给参数加引号（只在含空格/特殊字符时才加）
function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1") + '"';
}

// 给 Promise 加超时，而且**不泄漏定时器**：裸的 Promise.race 在 promise 先胜出
// 后，setTimeout 还挂在事件循环上，会让 Node 进程迟迟不退出。
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ── 一条 MCP 连接（对应一个服务器子进程）──
class McpConnection {
  private process: ChildProcess | null = null;
  private nextId = 1;
  // pending：请求 id → 等待中的 Promise。JSON-RPC 靠自增 id 把请求和响应配对。
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private rl: Interface | null = null;

  constructor(private serverName: string, private config: McpServerConfig) {}

  /** 启动服务器子进程，并把它的 stdout 按行接成 JSON-RPC 消息流。 */
  async connect(): Promise<void> {
    const env = { ...process.env, ...(this.config.env || {}) };
    // ← Windows 适配：走 spawnServer，npx/npm 这类 .cmd 包装脚本才能启动
    this.process = spawnServer(this.config.command, this.config.args || [], env);

    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          else resolve(msg.result);
        }
      } catch {
        // 忽略非 JSON 行（服务器日志等）
      }
    });

    // 子进程退出时，把所有还在等的请求 reject 掉，避免永久挂起
    this.process.on("exit", (code) => {
      for (const [, { reject }] of this.pending) {
        reject(new Error(`MCP server '${this.serverName}' exited with code ${code}`));
      }
      this.pending.clear();
    });
    this.process.on("error", (err) => {
      console.error(`[mcp:${this.serverName}] process error: ${err.message}`);
    });
  }

  /** 发一个请求（带 id，等响应）。 */
  private sendRequest(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        return reject(new Error(`MCP server '${this.serverName}' is not connected`));
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** 发一个通知（没有 id，发后不管）。 */
  private sendNotification(method: string, params: any = {}): void {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** 握手：交换协议版本与能力。 */
  async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mini-claude", version: "1.0.0" },
    });
    // 协议要求：initialize 之后必须再补一条 initialized 通知
    this.sendNotification("notifications/initialized");
  }

  /** 问服务器有哪些工具。 */
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.sendRequest("tools/list");
    if (!result?.tools || !Array.isArray(result.tools)) return [];
    return result.tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema,
      serverName: this.serverName,
    }));
  }

  /** 调用一个工具，取回文本结果。 */
  async callTool(name: string, args: any): Promise<string> {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    // MCP 返回 { content: [{ type: "text", text: "..." }, ...] }，我们只取文本部分
    if (result?.content && Array.isArray(result.content)) {
      return result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }
    return JSON.stringify(result);
  }

  /** 关掉子进程。 */
  close(): void {
    this.rl?.close();
    this.process?.kill();
    this.process = null;
  }
}

// ── MCP 管理器：管所有连接的生命周期，对外只暴露"工具表 + 路由"──
export class McpManager {
  private connections = new Map<string, McpConnection>();
  private tools: McpToolInfo[] = [];
  private connected = false;

  /** 读配置、连上所有服务器、发现工具。多次调用只会执行一次（幂等）。 */
  async loadAndConnect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;

    const configs = this.loadConfigs();
    if (Object.keys(configs).length === 0) return;

    const TIMEOUT_MS = 15_000; // 用 npx 起的服务器首次要下包，但也不能无限等

    for (const [name, config] of Object.entries(configs)) {
      const conn = new McpConnection(name, config);
      try {
        await conn.connect();
        await withTimeout(conn.initialize(), TIMEOUT_MS);
        const serverTools = await withTimeout(conn.listTools(), TIMEOUT_MS);
        this.connections.set(name, conn);
        this.tools.push(...serverTools);
        console.error(`[mcp] Connected to '${name}' — ${serverTools.length} tools`);
      } catch (err: any) {
        // 一个服务器连不上，只打日志——不影响其他服务器，也不影响内置工具
        console.error(`[mcp] Failed to connect to '${name}': ${err.message}`);
        conn.close();
      }
    }
  }

  /** 把发现的工具转成 Anthropic API 的工具定义，名字加 `mcp__<服务器>__` 前缀。 */
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: any }> {
    return this.tools.map((t) => ({
      name: `mcp__${t.serverName}__${t.name}`,
      description: t.description || `MCP tool ${t.name} from ${t.serverName}`,
      input_schema: t.inputSchema || { type: "object", properties: {} },
    }));
  }

  /** 这个工具名是不是 MCP 工具？ */
  isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  /** 把 `mcp__服务器__工具` 路由到对应服务器。 */
  async callTool(prefixedName: string, args: any): Promise<string> {
    const parts = prefixedName.split("__");
    if (parts.length < 3) throw new Error(`Invalid MCP tool name: ${prefixedName}`);
    const serverName = parts[1];
    const toolName = parts.slice(2).join("__"); // 工具名本身可能含 __
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP server '${serverName}' not connected`);
    return conn.callTool(toolName, args);
  }

  /** 断开全部连接（进程退出前必须调用，否则子进程会让 Node 一直不退出）。 */
  async disconnectAll(): Promise<void> {
    for (const [, conn] of this.connections) conn.close();
    this.connections.clear();
    this.tools = [];
    this.connected = false;
  }

  // ── 私有：读配置 ──
  private loadConfigs(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};
    // 三处依次读，同名服务器后读覆盖先读
    this.mergeConfigFile(join(homedir(), ".claude", "settings.json"), merged); // 用户级
    this.mergeConfigFile(join(process.cwd(), ".claude", "settings.json"), merged); // 项目级
    this.mergeConfigFile(join(process.cwd(), ".mcp.json"), merged); // MCP 专用
    return merged;
  }

  private mergeConfigFile(filePath: string, target: Record<string, McpServerConfig>): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const servers = raw.mcpServers || raw; // .mcp.json 也可能是扁平的服务器映射
      for (const [name, config] of Object.entries(servers)) {
        if (this.isValidConfig(config)) target[name] = config as McpServerConfig;
      }
    } catch {
      // 配置文件格式错误就静默跳过
    }
  }

  private isValidConfig(config: any): boolean {
    return config && typeof config === "object" && typeof config.command === "string";
  }
}
