// 类别 04：MCP（6 条）。断言的是「你的 server 返回的真实数据到达了模型」——
// 也就是第 3 周计划里的 M3 验收，只不过做成了可自动判定的形式。
const seed = "chore: 评测沙箱初始化";
const second = {
  path: "src/thing.js",
  content: "export const MAGIC = 42;\n",
  message: "feat: 引入 MAGIC 常量 —— 因为上游接口要求固定魔数",
};
const common = {
  fixture: { "README.md": "# sandbox\n" },
  needsMcp: true,
  mcpSeedCommit: seed,
  mcpSecondCommit: second,
};

export default [
  {
    ...common,
    id: "mcp-01",
    category: "04-mcp",
    prompt: "这个仓库最近有哪几次提交？",
    mock: [{ tool: "mcp__archaeology__recent_changes", input: {} }, { text: "最新一次是引入 MAGIC。" }],
    expect: { toolCalls: ["mcp__archaeology__recent_changes"], toolResultsContain: ["引入 MAGIC 常量", seed] },
    expectLive: { anyToolCall: ["mcp__archaeology__recent_changes"], toolResultsContain: ["引入 MAGIC 常量", seed] },
  },
  {
    ...common,
    id: "mcp-02",
    category: "04-mcp",
    prompt: "MAGIC 这个常量是什么时候引入的？",
    mock: [{ tool: "mcp__archaeology__find_introduction", input: { pattern: "MAGIC" } }, { text: "找到了。" }],
    expect: { toolCalls: ["mcp__archaeology__find_introduction"], toolResultsContain: ["最可能"] },
    expectLive: { anyToolCall: ["mcp__archaeology__find_introduction"], toolResultsContain: ["最可能"] },
  },
  {
    ...common,
    id: "mcp-03",
    category: "04-mcp",
    prompt: "src/thing.js 的历史",
    mock: [{ tool: "mcp__archaeology__file_history", input: { path: "src/thing.js" } }, { text: "只有一次。" }],
    expect: { toolCalls: ["mcp__archaeology__file_history"], toolResultsContain: ["引入 MAGIC 常量"] },
    expectLive: {
      anyToolCall: ["mcp__archaeology__file_history", "mcp__archaeology__recent_changes"],
      toolResultsContain: ["引入 MAGIC 常量"],
    },
  },
  {
    ...common,
    id: "mcp-04",
    category: "04-mcp",
    prompt: "src/thing.js 第 1 行是谁写的？",
    mock: [{ tool: "mcp__archaeology__line_blame", input: { path: "src/thing.js", start: 1, end: 1 } }, { text: "是 Eval。" }],
    expect: { toolCalls: ["mcp__archaeology__line_blame"], toolResultsContain: ["Eval", "MAGIC = 42"] },
    expectLive: { anyToolCall: ["mcp__archaeology__line_blame"], toolResultsContain: ["MAGIC = 42"] },
  },
  {
    ...common,
    id: "mcp-05",
    category: "04-mcp",
    prompt: "当初为什么加 MAGIC 常量？",
    mock: [{ tool: "mcp__archaeology__search_history", input: { query: "MAGIC" } }, { text: "因为上游要求。" }],
    expect: { toolCalls: ["mcp__archaeology__search_history"], toolResultsContain: ["因为上游接口要求固定魔数"] },
    // 真模型可能用 find_introduction + commit_info 走到同样的答案——只要拿到理由就算过
    expectLive: {
      anyToolCall: ["mcp__archaeology__search_history", "mcp__archaeology__find_introduction", "mcp__archaeology__commit_info"],
      toolResultsContain: ["因为上游接口要求固定魔数"],
    },
  },
  {
    ...common,
    id: "mcp-06",
    category: "04-mcp",
    prompt: "哪个文件改动最频繁？",
    mock: [{ tool: "mcp__archaeology__churn_hotspots", input: {} }, { text: "是 src/thing.js。" }],
    expect: { toolCalls: ["mcp__archaeology__churn_hotspots"], toolResultsContain: ["src/thing.js"] },
    expectLive: { anyToolCall: ["mcp__archaeology__churn_hotspots"], toolResultsContain: ["src/thing.js"] },
  },
];
