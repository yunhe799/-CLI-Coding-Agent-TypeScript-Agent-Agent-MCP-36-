import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, executeTool } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { checkPermission } from "./permissions.js";
import { maybeCompact } from "./context.js";
import { recallMemories } from "./memory.js";
import { runSubAgent } from "./subagent.js";
import { McpManager } from "./mcp.js";

const MODEL = process.env.MINI_MODEL || "claude-sonnet-4-5-20250929";

// 整个 Agent 就是一个类：一个不断变长的消息数组 + 一个循环。
export class Agent {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  // ── 第 10 章新增：运行模式。"plan" 表示只读模式 ──
  mode = "default";
  // ── 第 12 章新增：外部工具（MCP）管理器 ──
  private mcp = new McpManager();
  private mcpReady = false;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // 指向 Anthropic 兼容的服务（我们用的是 DeepSeek 的兼容接口）
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
  }

  // ── 第 4 章新增：把对话历史开放给外面，好让 CLI 保存和恢复 ──
  history(): Anthropic.MessageParam[] {
    return this.messages;
  }

  loadHistory(messages: Anthropic.MessageParam[]): void {
    this.messages = messages;
  }

  clearHistory(): void {
    this.messages = [];
  }

  setMode(m: string): void {
    this.mode = m;
  }

  // 一次用户输入 = 一次 chat。
  // 调用模型 → 如果它要工具就执行 → 把结果喂回去 → 再调用，直到模型给出纯文本回答。
  async chat(userText: string): Promise<void> {
    this.messages.push({ role: "user", content: userText });
    // ── 第 12 章新增：真正用到时才连 MCP 服务器（懒加载）──
    // 只是想问句快问题的话，就不用付"启动 MCP 子进程"的代价。
    await this.ensureMcp();

    while (true) {
      // ── 第 7 章的变化：每次调用模型之前，先看历史是不是太长了 ──
      // 太长就把较早的消息压缩成一条摘要。
      this.messages = await maybeCompact(this.messages, this.client, MODEL);

      // 提示词不再是写死的一句话，而是由 prompt.ts 组装出来（静态规则 + 当前环境信息）。
      let system = buildSystemPrompt();
      // ── 第 8 章的变化：把和这次提问相关的记忆召回进提示词 ──
      system += recallMemories(userText);

      // ── 第 12 章新增：把外部 MCP 工具并进工具表 ──
      // 对模型来说它们和内置工具长得一模一样，只是名字带 mcp__ 前缀。
      const mcpTools: Anthropic.Tool[] = this.mcp.getToolDefinitions().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
      const tools = [...toolDefinitions, ...mcpTools];

      const request = {
        model: MODEL,
        max_tokens: 4096,
        system,
        tools, // 这一行让模型"知道"有哪些工具可用（内置的 + MCP 的）
        messages: this.messages,
      };

      // ── 第 5 章的变化：流式输出 ──
      // 以前是 create() 等模型把整段话都写完再一次性打印（屏幕空白好几秒）。
      // 现在改成 stream()：模型每吐出一小段文字，就立刻打印出来。
      // 最后用 finalMessage() 取回完整消息 —— 它的结构和不流式调用完全一样，
      // 所以后面的代码一行都不用改。
      const stream = this.client.messages.stream(request);
      stream.on("text", (t) => process.stdout.write(t));
      const reply = await stream.finalMessage();
      process.stdout.write("\n");

      // 把模型的完整回复（文字 + 工具调用）记进消息历史
      this.messages.push({ role: "assistant", content: reply.content });

      const toolUses = reply.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      // ★ 循环的出口：模型没有要求调用任何工具，说明这一轮的事情做完了
      if (toolUses.length === 0) return;

      // 执行所有被请求的工具，把结果作为一条 user 消息发回去
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        console.log(`  → ${tu.name}(${JSON.stringify(tu.input)})`);

        // ── 第 11 章新增：agent 工具 → 派一个只读子 Agent ──
        // 子 Agent 有自己独立的上下文，只有结论会回到主对话里，
        // 中间读了什么、翻了多少文件，主对话完全不知道。
        if (tu.name === "agent") {
          const summary = await runSubAgent(String((tu.input as any).task || ""), this.client, MODEL);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: summary });
          continue;
        }

        // ── 第 12 章新增：mcp__<服务器>__<工具> 转发给对应的 MCP 服务器 ──
        // 一行判断、一行转发——MCP 工具对主循环完全透明。
        if (this.mcp.isMcpTool(tu.name)) {
          let output: string;
          try {
            output = await this.mcp.callTool(tu.name, tu.input as Record<string, any>);
          } catch (e: any) {
            output = `MCP call failed: ${e.message}`;
          }
          results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
          continue;
        }

        // ── 第 10 章的变化：在权限闸门之上，再加一层"计划模式"约束 ──
        // plan 模式下，写文件、改文件、跑命令一律拒绝 —— 只能读和思考。
        // 被拒绝的调用根本不会被执行，模型只会收到一条"被拦下了"的结果。
        const blocked =
          checkPermission(tu.name, tu.input as Record<string, any>) === "deny" ||
          (this.mode === "plan" &&
            (tu.name === "write_file" || tu.name === "edit_file" || tu.name === "run_shell"));
        const output = blocked
          ? `Denied: ${tu.name} was blocked (${this.mode} mode).`
          : await executeTool(tu.name, tu.input as Record<string, any>);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }
      this.messages.push({ role: "user", content: results });
    }
  }

  // ── 第 12 章新增：懒连接 MCP，连不上也不影响内置工具 ──
  private async ensureMcp(): Promise<void> {
    if (this.mcpReady) return;
    this.mcpReady = true;
    try {
      await this.mcp.loadAndConnect();
    } catch (err: any) {
      console.error(`[mcp] init failed: ${err.message}`);
    }
  }

  /** 关掉 MCP 子进程。进程退出前必须调用，否则 Node 不会自己退出。 */
  async shutdown(): Promise<void> {
    await this.mcp.disconnectAll();
  }
}
