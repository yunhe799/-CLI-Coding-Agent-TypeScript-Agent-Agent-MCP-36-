import type Anthropic from "@anthropic-ai/sdk";

// 对话变长时，把较早的消息浓缩成一条摘要，避免上下文窗口被撑爆。
// 真实的 Claude Code 是数 token 的；这里我们数"消息条数"，
// 足够让你看清这套机制是怎么运转的。
//
// ── 修正一：阈值从 6 提到 20（第 10 章）──
// 6 是教程为了让你几轮就能看到压缩效果而设的"演示值"，实际使用太小了：
// 读 9 个文件就会触发，把刚读到的东西压成摘要，模型只能凭有损的摘要"回忆"，
// 于是开始编造数字（实测把 agent.ts 的 104 行说成 496 行、还编出个 src/index.ts）。
//
// ── 修正二：从"数消息条数"改成"数内容体量"（第 4 周）──
// 条数并不等于体量。同样读 11 个文件：假模型一轮调一个工具 → 23 条消息；
// 真模型会把 11 个 read_file 合并进同一轮 → 只有 3 条消息，20 这个阈值压根不触发。
// 评测集把这个问题照了出来（mock 能触发、live 不能）。所以改成按字符体量估算
// （≈ token 的粗估），这样"攒够多少内容"才压缩，与模型的调用节奏无关。
const COMPACT_THRESHOLD_CHARS = 40_000;  // 约 1 万 token 量级才值得压
const KEEP_RECENT = 2;   // 保留最近2条消息不动

/** 粗估一条消息的体量（字符数）。不追求精确，只要"大就是大"。 */
function messageChars(m: Anthropic.MessageParam): number {
  if (typeof m.content === "string") return m.content.length;
  if (Array.isArray(m.content)) {
    return m.content.reduce((s, b: any) => s + (b?.type === "text" ? String(b.text ?? "").length : JSON.stringify(b ?? {}).length), 0);
  }
  return 0;
}

export async function maybeCompact(
  messages: Anthropic.MessageParam[],
  client: Anthropic,
  model: string,
): Promise<Anthropic.MessageParam[]> {
  const size = messages.reduce((s, m) => s + messageChars(m), 0);
  if (messages.length <= KEEP_RECENT + 1 || size <= COMPACT_THRESHOLD_CHARS) return messages;

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
  console.log(`  (compacted ${older.length} messages / ~${size} chars into a summary)`);

  // ── 修正：摘要是有损的，必须明确告诉模型别拿它当精确数据源 ──
  // 压缩会丢掉原文（包括工具返回的文件内容），如果不提醒，
  // 模型会以为"我读过这些文件了"，然后凭印象编数字。
  const content =
    `[Summary of earlier conversation]\n${summary}\n\n` +
    `注意：以上只是摘要，早先工具返回的原文已经被压缩移除。` +
    `如果需要精确的数字（行数、文件个数、统计值）、代码原文或完整文件清单，` +
    `请重新调用工具去读，不要依据这段摘要回答。`;
  return [{ role: "user", content }, ...recent];
}
