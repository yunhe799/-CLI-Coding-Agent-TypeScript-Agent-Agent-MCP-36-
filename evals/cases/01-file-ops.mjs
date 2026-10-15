import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 类别 01：文件操作（10 条）。断言的是**磁盘上的副作用**，不是模型说了什么。
const T = "hello\nworld\n";

export default [
  {
    id: "file-ops-01",
    category: "01-file-ops",
    prompt: "在 src/nested 目录下创建 note.txt，内容是 hi",
    mock: [{ tool: "write_file", input: { file_path: "src/nested/note.txt", content: "hi" } }, { text: "已创建。" }],
    expect: { toolCalls: ["write_file"], files: { "src/nested/note.txt": "hi" } },
  },
  {
    id: "file-ops-02",
    category: "01-file-ops",
    prompt: "读一下 a.txt，告诉我它有多少行",
    fixture: { "a.txt": T },
    mock: [{ tool: "read_file", input: { file_path: "a.txt" } }, { text: "2 行。" }],
    expect: { toolCalls: ["read_file"], toolResultsContain: ["a.txt: 2 lines"] },
  },
  {
    id: "file-ops-03",
    category: "01-file-ops",
    prompt: "把 a.txt 里的 world 改成 earth",
    fixture: { "a.txt": T },
    mock: [
      { tool: "edit_file", input: { file_path: "a.txt", old_string: "world", new_string: "earth" } },
      { text: "改好了。" },
    ],
    expect: { toolCalls: ["edit_file"], files: { "a.txt": "hello\nearth\n" } },
  },
  {
    id: "file-ops-04",
    category: "01-file-ops",
    prompt: "把 a.txt 里的 nothere 改成 x",
    fixture: { "a.txt": T },
    mock: [
      { tool: "edit_file", input: { file_path: "a.txt", old_string: "nothere", new_string: "x" } },
      { text: "找不到，没改。" },
    ],
    expect: { toolResultsContain: ["old_string not found"], files: { "a.txt": T } },
    // 真模型可能先用 grep 确认"根本没有这个词"，然后口头告诉你 —— 也是对的。
    // 只要文件没被动过就算过。
    expectLive: { filesContain: { "a.txt": "world" } },
  },
  {
    id: "file-ops-05",
    category: "01-file-ops",
    prompt: "把 a.txt 里的 o 改成 0",
    fixture: { "a.txt": "foo\nboo\n" },
    mock: [
      { tool: "edit_file", input: { file_path: "a.txt", old_string: "o", new_string: "0" } },
      { text: "它出现多次，我不改。" },
    ],
    expect: { toolResultsContain: ["Must be unique"], files: { "a.txt": "foo\nboo\n" } },
    // 真模型可以逐处替换（把两个 o 都换掉）——那正好是用户想要的。允许"全换"或"不动"，
    // 只不允许留下一半没换的烂摊子。
    expectLive: {
      custom: ({ sandbox }) => {
        const abs = join(sandbox, "a.txt");
        const s = existsSync(abs) ? readFileSync(abs, "utf8") : "";
        if (s === "foo\nboo\n" || s === "f00\nb00\n") return null;
        return `a.txt 落在了"换了一半"的状态：${JSON.stringify(s)}`;
      },
    },
  },
  {
    id: "file-ops-06",
    category: "01-file-ops",
    prompt: "把 a.txt 里的 X 换成 $&（要原样写进去）",
    fixture: { "a.txt": "value=X\n" },
    mock: [
      { tool: "edit_file", input: { file_path: "a.txt", old_string: "X", new_string: "$&" } },
      { text: "写好了。" },
    ],
    // 第 2 章那个坑：用 String.replace 时 $& 会被当成替换语法。必须原样写进去。
    expect: { files: { "a.txt": "value=$&\n" } },
  },
  {
    id: "file-ops-07",
    category: "01-file-ops",
    prompt: "列出 src 下所有 .ts 文件",
    fixture: { "src/one.ts": "export const a = 1;\n", "src/two.ts": "export const b = 2;\n", "src/skip.md": "x\n" },
    mock: [{ tool: "list_files", input: { pattern: "src/**/*.ts" } }, { text: "两个。" }],
    expect: { toolCalls: ["list_files"], toolResultsContain: ["src/one.ts", "src/two.ts"] },
  },
  {
    id: "file-ops-08",
    category: "01-file-ops",
    prompt: "搜一下哪个文件里有 MARKER_TOKEN",
    fixture: { "src/hit.ts": "const a = 1;\nconst MARKER_TOKEN = 2;\n" },
    mock: [{ tool: "grep_search", input: { pattern: "MARKER_TOKEN", path: "src" } }, { text: "在 src/hit.ts。" }],
    expect: { toolCalls: ["grep_search"], toolResultsContain: ["hit.ts:2"] },
  },
  {
    id: "file-ops-09",
    category: "01-file-ops",
    prompt: "读一下不存在的 nope.txt",
    mock: [{ tool: "read_file", input: { file_path: "nope.txt" } }, { text: "读不到，文件不存在。" }],
    expect: { toolResultsContain: ["Error reading file"], finalStopReason: "no_tool_use" },
  },
  {
    id: "file-ops-10",
    category: "01-file-ops",
    prompt: "创建 out.txt，内容就是两行「line1」和「line2」，然后读回来确认",
    mock: [
      { tool: "write_file", input: { file_path: "out.txt", content: "line1\nline2\n" } },
      { tool: "read_file", input: { file_path: "out.txt" } },
      { text: "确认无误。" },
    ],
    expect: {
      toolCalls: ["write_file", "read_file"],
      files: { "out.txt": "line1\nline2\n" },
      toolResultsContain: ["out.txt: 2 lines"],
    },
  },
];
