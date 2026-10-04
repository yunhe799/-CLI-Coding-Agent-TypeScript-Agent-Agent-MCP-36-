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

  // 一次用户输入 = 一次 chat。
  // 调用模型 → 如果它要工具就执行 → 把结果喂回去 → 再调用，直到模型给出纯文本回答。
  async chat(userText: string): Promise<void> {
    this.messages.push({ role: "user", content: userText });

    while (true) {
      // 第 3 章的变化：提示词不再是写死的一句话，
      // 而是由 prompt.ts 组装出来（静态规则 + 当前环境信息）。
      const system = buildSystemPrompt();

      const request = {
        model: MODEL,
        max_tokens: 4096,
        system,
        tools: toolDefinitions, // 这一行让模型"知道"有哪些工具可用
        messages: this.messages,
      };

      const reply = await this.client.messages.create(request);

      // 先把模型的文字输出打出来
      for (const block of reply.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
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
