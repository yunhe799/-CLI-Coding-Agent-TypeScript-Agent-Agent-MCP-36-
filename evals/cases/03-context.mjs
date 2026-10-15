// 类别 03：上下文压缩（6 条）——第 7 章那条「压缩会丢信息」的坑，用可判定的方式钉住。
// 每条都造一段**超长对话**（>20 条消息）触发压缩，再断言「压缩之后取数还是准的」。
const FILES = 11;
// 每个文件 ≈5KB（两行各 2500 字符）：读 11 个 ≈55KB，超过 40KB 的**体量**阈值。
// （阈值已经不再数"消息条数"了——那样 mock 能触发、live 不能，见 context.ts 的注释。）
const BIG = "a".repeat(2500) + "\n" + "b".repeat(2500) + "\n";
const fixture = Object.fromEntries(Array.from({ length: FILES }, (_, i) => [`f${i}.txt`, BIG]));
const readAll = Array.from({ length: FILES }, (_, i) => ({ tool: "read_file", input: { file_path: `f${i}.txt` } }));
const SUMMARY = "[Summary of earlier conversation]";
const afterSummary = (history) => {
  const i = history.findIndex((m) => typeof m.content === "string" && m.content.includes(SUMMARY));
  return { i, tail: i < 0 ? [] : history.slice(i) };
};
const tailHas = (history, needle) =>
  afterSummary(history).tail.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" && String(b.content).includes(needle)),
  );

const cases = [
  {
    id: "ctx-01",
    category: "03-context",
    prompt: "把 f0.txt 到 f10.txt 一个个读一遍",
    fixture,
    longConversation: true,
    mock: [...readAll, { text: "读完了。" }],
    expect: { toolCalls: ["read_file"], historyContains: [SUMMARY, "请重新调用工具去读"] },
  },
  {
    id: "ctx-02",
    category: "03-context",
    prompt: "先读一堆文件，然后重新读 f0.txt 确认行数",
    fixture,
    longConversation: true,
    mock: [...readAll, { tool: "read_file", input: { file_path: "f0.txt" } }, { text: "2 行。" }],
    expect: {
      custom: ({ history }) => {
        if (afterSummary(history).i < 0) return "没有发生压缩";
        return tailHas(history, "f0.txt: 2 lines") ? null : "压缩之后重新读 f0.txt 没拿到精确行数";
      },
    },
  },
  {
    id: "ctx-03",
    category: "03-context",
    prompt: "挨个读完这些文件",
    fixture,
    longConversation: true,
    mock: [...readAll, { text: "好了。" }],
    expect: {
      custom: ({ history }) => {
        if (afterSummary(history).i < 0) return "超长对话没有触发压缩";
        return history.length > 4 ? null : `压缩后历史只剩 ${history.length} 条，太激进`;
      },
    },
  },
  {
    id: "ctx-04",
    category: "03-context",
    prompt: "读这些文件，中途会触发压缩",
    fixture,
    longConversation: true,
    mock: [...readAll, { text: "好了。" }],
    expect: {
      // 压缩绝不能把 tool_use / tool_result 这一对拆散（否则下一次请求会被 API 拒）
      custom: ({ history }) => {
        const useIds = new Set();
        const resultIds = new Set();
        for (const m of history) {
          if (!Array.isArray(m.content)) continue;
          for (const b of m.content) {
            if (b.type === "tool_use") useIds.add(b.id);
            if (b.type === "tool_result") resultIds.add(b.tool_use_id);
          }
        }
        const orphan = [...useIds].filter((id) => !resultIds.has(id));
        return orphan.length === 0 ? null : `有 ${orphan.length} 个 tool_use 没有配对的 tool_result`;
      },
    },
  },
  {
    id: "ctx-05",
    category: "03-context",
    prompt: "读四个文件就够了",
    fixture,
    longConversation: true,
    mock: [...readAll.slice(0, 4), { text: "好了。" }],
    expect: {
      custom: ({ history }) =>
        history.some((m) => typeof m.content === "string" && m.content.includes(SUMMARY))
          ? "没到阈值却触发了压缩"
          : null,
    },
  },
  {
    id: "ctx-06",
    category: "03-context",
    prompt: "读一堆文件，然后搜一个精确标记",
    fixture: { ...fixture, "src/hit.ts": "const A = 1;\nconst MARKER_TOKEN = 2;\n" },
    longConversation: true,
    mock: [...readAll, { tool: "grep_search", input: { pattern: "MARKER_TOKEN", path: "src" } }, { text: "找到了。" }],
    expect: {
      custom: ({ history }) => {
        if (afterSummary(history).i < 0) return "没有发生压缩";
        return tailHas(history, "hit.ts:2") ? null : "压缩之后 grep 的精确结果没进历史";
      },
    },
  },
];

// 整个类别只在 mock 下跑：这里测的是**压缩机制**，而压缩按「消息条数」触发——
// mock 里一轮一个工具，11 轮必然攒够 23 条；真模型会把多个 read_file 合并进
// 同一轮，条纹数根本到不了阈值，断言必然误报。这是"机制类断言"的典型例子。
export default cases.map((c) => ({ ...c, mockOnly: true }));
