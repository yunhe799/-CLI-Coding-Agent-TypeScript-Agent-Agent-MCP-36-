// 脚本化的"假模型"：按顺序把预先写好的回复喂给 Agent。
// 它替换掉 Agent 的 this.client，所以**不联网、不用 key、秒级出结果**。
// 用途只有一个：验证**断言本身**没写错（--mock 必须 100% 通过）。
//
// 脚本每一步的写法：
//   { tool: "write_file", input: { ... } }  → 模型请求调用这个工具
//   { text: "做完了" }                       → 模型只回文本，这一轮结束
export function makeMockClient(script) {
  let i = 0;
  const next = () => {
    if (i >= script.length) return { content: [{ type: "text", text: "（脚本结束）" }] };
    const step = script[i++];
    if (step.tool) {
      return { content: [{ type: "tool_use", id: `mock-${i}`, name: step.tool, input: step.input ?? {} }] };
    }
    return { content: [{ type: "text", text: step.text ?? "" }] };
  };
  return {
    messages: {
      stream() {
        let reply = null;
        return {
          on() {},
          async finalMessage() {
            reply = next();
            return reply;
          },
        };
      },
      // 旁路调用（第 7 章的压缩摘要、第 11 章的子 Agent、第 15 章的评估器/分类器）
      // 都走这里。给一句中性回复；需要特定行为的用例自己覆盖。
      async create() {
        return { content: [{ type: "text", text: "（mock 旁路回复）" }] };
      },
    },
  };
}

/** 压缩会额外调一次模型生成摘要——需要"超长对话"的用例用这个客户端。 */
export function makeCompactAwareMockClient(script, summary = "（mock 摘要）前面聊了若干轮，读了几个文件。") {
  const base = makeMockClient(script);
  base.messages.create = async () => ({ content: [{ type: "text", text: summary }] });
  return base;
}
