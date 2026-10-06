import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, executeTool } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";

const MODEL = process.env.MINI_MODEL || "claude-sonnet-4-5-20250929";

// 整个 Agent 就是一个类：一个不断变长的消息数组 + 一个循环。
export class Agent {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];

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

  // 一次用户输入 = 一次 chat。
  // 调用模型 → 如果它要工具就执行 → 把结果喂回去 → 再调用，直到模型给出纯文本回答。
  async chat(userText: string): Promise<void> {
    this.messages.push({ role: "user", content: userText });

    while (true) {
      // 提示词不再是写死的一句话，而是由 prompt.ts 组装出来（静态规则 + 当前环境信息）。
      const system = buildSystemPrompt();

      const request = {
        model: MODEL,
        max_tokens: 4096,
        system,
        tools: toolDefinitions, // 这一行让模型"知道"有哪些工具可用
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
        const output = await executeTool(tu.name, tu.input as Record<string, any>);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }
      this.messages.push({ role: "user", content: results });
    }
  }
}
