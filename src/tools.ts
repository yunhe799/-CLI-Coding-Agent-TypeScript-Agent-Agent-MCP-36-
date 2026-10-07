import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { execSync, execFileSync } from "child_process";
import { glob } from "glob";
import { dirname, join } from "path";
import type Anthropic from "@anthropic-ai/sdk";

// 教程原版这里写死了 "/bin/sh"（Mac/Linux 的 shell），在 Windows 上会失败。
// 所以加一行判断，Windows 上用 PowerShell。
const isWin = process.platform === "win32";

// 工具 = 三样东西：名字、给模型看的说明、真正干活的函数。
// 下面这个数组的形状，就是 Anthropic API 要求的样子。
export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file. Returns the file content with line numbers.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string", description: "The path to the file to read" } },
      required: ["file_path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates it if missing, overwrites if it exists.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact string in a file with new content. old_string must match exactly and be unique.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to edit" },
        old_string: { type: "string", description: "The exact string to find" },
        new_string: { type: "string", description: "The string to replace it with" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "list_files",
    description: 'List files matching a glob pattern (e.g. "**/*.ts").',
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files" },
        path: { type: "string", description: "Base directory. Defaults to cwd." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep_search",
    description: "Search for a regex pattern in files. Returns matching lines with paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search. Defaults to cwd." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_shell",
    description: "Execute a shell command and return its output. For tests, git, package installs, etc.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to execute" } },
      required: ["command"],
    },
  },
];

// 按名字分发工具调用。不认识的名字返回错误字符串，而不是抛异常——
// 这样模型要是"编"出一个不存在的工具名，它能自己看到错误并纠正。
export async function executeTool(name: string, input: Record<string, any>): Promise<string> {
  switch (name) {
    case "read_file": return readFile(input as { file_path: string });
    case "write_file": return writeFile(input as { file_path: string; content: string });
    case "edit_file": return editFile(input as { file_path: string; old_string: string; new_string: string });
    case "list_files": return listFiles(input as { pattern: string; path?: string });
    case "grep_search": return grepSearch(input as { pattern: string; path?: string });
    case "run_shell": return runShell(input as { command: string });
    default: return `Unknown tool: ${name}`;
  }
}

function readFile(input: { file_path: string }): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");
    // ── 修正：按编辑器的方式数行 ──
    // 先去掉结尾的换行，再按行切开（同时兼容 Windows 的 \r\n 和 Unix 的 \n）。
    // 否则多一个结尾换行就会多算一行，而且 \r 会混进输出里。
    const lines = content.replace(/\r?\n$/, "").split(/\r?\n/);
    const numbered = lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
    // ── 修正：把总行数直接算好告诉模型 ──
    // 模型不擅长数数（前面就出现过把 39 行说成 29 行）。
    // 凡是能用代码确定性算出来的东西，都不要交给模型去"估"。
    return `${input.file_path}: ${lines.length} lines\n${numbered}`;
  } catch (e: any) {
    return `Error reading file: ${e.message}`;
  }
}

function writeFile(input: { file_path: string; content: string }): string {
  try {
    const dir = dirname(input.file_path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(input.file_path, input.content);
    const n = input.content.split("\n").length;
    return `Successfully wrote to ${input.file_path} (${n} lines)`;
  } catch (e: any) {
    return `Error writing file: ${e.message}`;
  }
}

// edit_file 是唯一有真正陷阱的工具：匹配到的字符串必须是唯一的，
// 否则你会改错地方。所以我们先数一下出现次数，不唯一就拒绝执行。
function editFile(input: { file_path: string; old_string: string; new_string: string }): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");
    if (!content.includes(input.old_string)) {
      return `Error: old_string not found in ${input.file_path}`;
    }
    const count = content.split(input.old_string).length - 1;
    if (count > 1) {
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique.`;
    }
    // 用 split/join 而不是 String.replace，避免 new_string 里的 $ 被当成替换语法
    const updated = content.split(input.old_string).join(input.new_string);
    writeFileSync(input.file_path, updated);
    return `Successfully edited ${input.file_path}`;
  } catch (e: any) {
    return `Error editing file: ${e.message}`;
  }
}

async function listFiles(input: { pattern: string; path?: string }): Promise<string> {
  try {
    const files = await glob(input.pattern, {
      cwd: input.path || process.cwd(),
      nodir: true,
      ignore: ["node_modules/**", ".git/**"],
    });
    if (files.length === 0) return "No files found matching the pattern.";
    return files.slice(0, 200).join("\n");
  } catch (e: any) {
    return `Error listing files: ${e.message}`;
  }
}

function grepSearch(input: { pattern: string; path?: string }): string {
  // 优先用系统的 grep（Mac/Linux 自带，Windows 装了 Git 也有）；
  // 系统没有就退回到一个用 JS 写的简易搜索器。
  try {
    const out = execFileSync("grep", ["--line-number", "--color=never", "-r", "--", input.pattern, input.path || "."], {
      encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 10000,
    });
    return out.split("\n").filter(Boolean).slice(0, 100).join("\n") || "No matches found.";
  } catch (e: any) {
    if (e.status === 1) return "No matches found.";
    return grepJS(input.pattern, input.path || ".");
  }
}

function grepJS(pattern: string, dir: string): string {
  let re: RegExp;
  try { re = new RegExp(pattern); } catch (e: any) { return `Error: invalid regex: ${e.message}`; }
  const matches: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(d, name);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      try {
        readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
          if (re.test(line) && matches.length < 100) matches.push(`${full}:${i + 1}:${line}`);
        });
      } catch {}
    }
  };
  walk(dir);
  return matches.length ? matches.join("\n") : "No matches found.";
}

function runShell(input: { command: string }): string {
  try {
    return execSync(input.command, {
      encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin ? "powershell.exe" : "/bin/sh",
    }) || "(no output)";
  } catch (e: any) {
    return `Command failed (exit ${e.status})${e.stdout ? `\nStdout: ${e.stdout}` : ""}${e.stderr ? `\nStderr: ${e.stderr}` : ""}`;
  }
}
