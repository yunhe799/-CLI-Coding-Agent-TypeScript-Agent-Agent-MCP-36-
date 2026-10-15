// 类别 05：多步任务（8 条）。断言**工具调用序列**和**最终产物**——
// 这两样都不随模型措辞波动。
export default [
  {
    id: "multi-01",
    category: "05-multi-step",
    prompt: "先读 config.txt，再把里面的 debug=false 改成 debug=true",
    fixture: { "config.txt": "debug=false\nport=8080\n" },
    mock: [
      { tool: "read_file", input: { file_path: "config.txt" } },
      { tool: "edit_file", input: { file_path: "config.txt", old_string: "debug=false", new_string: "debug=true" } },
      { text: "改好了。" },
    ],
    expect: { toolCalls: ["read_file", "edit_file"], files: { "config.txt": "debug=true\nport=8080\n" } },
  },
  {
    id: "multi-02",
    category: "05-multi-step",
    prompt: "生成 report.md：第一行写「# 报告」，再写一行「结论：一切正常。」，然后读回来核对",
    mock: [
      { tool: "write_file", input: { file_path: "report.md", content: "# 报告\n\n结论：一切正常。\n" } },
      { tool: "read_file", input: { file_path: "report.md" } },
      { text: "核对完成。" },
    ],
    expect: { toolCalls: ["write_file", "read_file"], files: { "report.md": "# 报告\n\n结论：一切正常。\n" } },
    // 真模型可能写得更丰富——只要文件里有结论就算过（措辞是它的自由）
    expectLive: { anyToolCall: ["write_file"], filesContain: { "report.md": "结论" } },
  },
  {
    id: "multi-03",
    category: "05-multi-step",
    prompt: "找到 TODO 标记在哪，读那个文件，把 TODO 改成 DONE",
    fixture: { "src/todo.ts": "// TODO: 待办\nexport const x = 1;\n" },
    mock: [
      { tool: "grep_search", input: { pattern: "TODO", path: "src" } },
      { tool: "read_file", input: { file_path: "src/todo.ts" } },
      { tool: "edit_file", input: { file_path: "src/todo.ts", old_string: "// TODO: 待办", new_string: "// DONE: 已完成" } },
      { text: "处理完了。" },
    ],
    expect: {
      toolCalls: ["grep_search", "read_file", "edit_file"],
      files: { "src/todo.ts": "// DONE: 已完成\nexport const x = 1;\n" },
    },
    expectLive: { anyToolCall: ["edit_file", "write_file"], filesContain: { "src/todo.ts": "DONE" } },
  },
  {
    id: "multi-04",
    category: "05-multi-step",
    prompt: "先列出 docs 下的 md，再读第一个",
    fixture: { "docs/guide.md": "# 指南\n" },
    mock: [
      { tool: "list_files", input: { pattern: "docs/*.md" } },
      { tool: "read_file", input: { file_path: "docs/guide.md" } },
      { text: "读完了。" },
    ],
    expect: { toolCalls: ["list_files", "read_file"], toolResultsContain: ["# 指南"] },
  },
  {
    id: "multi-05",
    category: "05-multi-step",
    prompt: "/explain a.txt",
    fixture: { "a.txt": "line1\n", ".mini-skills/explain.md": "请用 3 句话解释这个文件，并指出设计细节。\n" },
    expandSkill: true,
    mock: [{ tool: "read_file", input: { file_path: "a.txt" } }, { text: "它只有一行。" }],
    // 技能展开发生在 CLI 层：断言「模板 + 文件路径」确实拼进了第一条用户消息
    expect: { userMessageContains: ["请用 3 句话解释", "a.txt"], toolCalls: ["read_file"] },
  },
  {
    id: "multi-06",
    category: "05-multi-step",
    prompt: "在 plan 模式下试着创建一个文件",
    mode: "plan",
    mock: [{ tool: "write_file", input: { file_path: "should-not-exist.txt", content: "x" } }, { text: "被拦住了。" }],
    expect: {
      toolCalls: ["write_file"],
      toolResultsContain: ["Denied: write_file was blocked (plan mode)"],
      filesAbsent: ["should-not-exist.txt"],
    },
    // 真模型在计划模式下往往自己就收手了——那也是合格的；只要"没写进去"就算过
    expectLive: {
      filesAbsent: ["should-not-exist.txt"],
      custom: ({ history }) => {
        const tried = history.some(
          (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && (b.name === "write_file" || b.name === "edit_file")),
        );
        if (!tried) return null; // 自己就不动手
        const denied = history.some(
          (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" && String(b.content).includes("Denied:")),
        );
        return denied ? null : "plan 模式下尝试写文件，但没有被拦下";
      },
    },
  },
  {
    id: "multi-07",
    category: "05-multi-step",
    prompt: "派一个子 Agent 去调查一下这个项目的依赖",
    mock: [{ tool: "agent", input: { task: "调查依赖" } }, { text: "子 Agent 报回来了。" }],
    // 子 Agent 用的也是同一份假模型，它的结论必须回到主对话里
    expect: { toolCalls: ["agent"], toolResultsContain: ["mock 旁路回复"] },
    // 真模型未必愿意派子 Agent（它可能自己就查了），所以这条只在 mock 下跑
    mockOnly: true,
  },
  {
    id: "multi-08",
    category: "05-multi-step",
    prompt: "先查这个仓库最近改了什么，然后把结论写进 CHANGELOG.md",
    fixture: { "README.md": "# sandbox\n" },
    needsMcp: true,
    mcpSeedCommit: "chore: 评测沙箱初始化",
    mock: [
      { tool: "mcp__archaeology__recent_changes", input: {} },
      { tool: "write_file", input: { file_path: "CHANGELOG.md", content: "## 最近改动\n- 评测沙箱初始化\n" } },
      { text: "写好了。" },
    ],
    expect: {
      toolCalls: ["mcp__archaeology__recent_changes", "write_file"],
      files: { "CHANGELOG.md": "## 最近改动\n- 评测沙箱初始化\n" },
      toolResultsContain: ["评测沙箱初始化"],
    },
    expectLive: {
      anyToolCall: ["mcp__archaeology__recent_changes", "mcp__archaeology__commit_info"],
      filesContain: { "CHANGELOG.md": "评测沙箱初始化" },
      toolResultsContain: ["评测沙箱初始化"],
    },
  },
];
