import Anthropic from "@anthropic-ai/sdk";
import { executeTool, toolDefinitions } from "./tools.js";

// 派生一个"只读子 Agent"：给它一个任务，它在自己全新的上下文里调查，
// 只把一段简洁的结论带回来 —— 分而治之，而不用把中间步骤全灌进主对话。
// 它自己在进程内跑一个小循环，只有结论会回到主 Agent 手里。
const EXPLORE_TOOLS = ["read_file", "list_files", "grep_search"];

export async function runSubAgent(task: string, client: Anthropic, model: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  // 只把只读工具交给子 Agent —— 它只能看，不能改
  const tools = toolDefinitions.filter((t) => EXPLORE_TOOLS.includes(t.name));

  while (true) {
    const reply = await client.messages.create({
      model,
      max_tokens: 4096,
      system: "You are an explore sub-agent. Investigate read-only and report back a concise summary.",
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: reply.content });

    const toolUses = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    // 子 Agent 的出口和主 Agent 一样：不再请求工具就说明它调查完了
    if (toolUses.length === 0) {
      return reply.content
        .filter((b) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      // 双保险：即使模型"编"出一个非只读工具，这里也会拒绝
      const output = EXPLORE_TOOLS.includes(tu.name)
        ? await executeTool(tu.name, tu.input as Record<string, any>)
        : `Denied: the sub-agent is read-only.`;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}
