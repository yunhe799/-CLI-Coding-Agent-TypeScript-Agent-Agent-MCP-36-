import type Anthropic from "@anthropic-ai/sdk";

// 对话变长时，把较早的消息浓缩成一条摘要，避免上下文窗口被撑爆。
// 真实的 Claude Code 是数 token 的；这里我们数"消息条数"，
// 足够让你看清这套机制是怎么运转的。
const COMPACT_THRESHOLD = 6;    // 超过6条消息就要浓缩
const KEEP_RECENT = 2;   // 保留最近2条消息不动

export async function maybeCompact(
  messages: Anthropic.MessageParam[],
  client: Anthropic,
  model: string,
): Promise<Anthropic.MessageParam[]> {
  if (messages.length <= COMPACT_THRESHOLD) return messages;

  const older = messages.slice(0, messages.length - KEEP_RECENT);
  const recent = messages.slice(messages.length - KEEP_RECENT);

  // 额外调用一次模型来总结（先把消息渲染成纯文本，
  // 这样绝不会把 tool_use / tool_result 这一对拆散）
  const transcript = older
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[tool call / result]"}`)
    .join("\n");
  const reply = await client.messages.create({
    model,
    max_tokens: 1024,
    system: "Summarize the conversation so far in a few sentences, keeping key facts.",
    messages: [{ role: "user", content: transcript }],
  });
  const summary = reply.content
    .filter((b) => b.type === "text")
    .map((b: any) => b.text)
    .join("");


  //把较早的消息浓缩成一条摘要，保留最近的消息
  console.log(`  (compacted ${older.length} messages into a summary)`);
  return [{ role: "user", content: `[Summary of earlier conversation]\n${summary}` }, ...recent];
}
