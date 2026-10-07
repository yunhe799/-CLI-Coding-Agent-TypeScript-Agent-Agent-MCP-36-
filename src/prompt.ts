import { execSync } from "child_process";
import * as os from "os";

// 「静态核心」：身份、规则、工具偏好。
// 它每次运行都一字不变 —— 正因为不变，才能被缓存（真实的 Claude Code 会给
// 这一段打上 cache_control 标记，省下大量重复的输入 token 费用）。
const STATIC_CORE = `You are Mini Claude Code, a small coding assistant CLI.
You help with software engineering tasks using the tools available to you.

# Doing tasks
 - Do not propose changes to code you haven't read. Read files first.
 - Do not create files unless necessary. Prefer editing existing files.
 - Avoid over-engineering. Only make changes that were requested.

# Executing actions with care
 - Prefer reversible actions. For risky or destructive ones (rm -rf, git push,
   dropping tables), confirm with the user before proceeding.

# Using your tools
 - Use read_file / edit_file / list_files / grep_search instead of shell cat,
   sed, ls, grep. Reserve run_shell for actual shell operations.
 - If several tool calls are independent, make them in parallel.
 - 涉及精确数字（行数、文件个数、统计值）时，必须调用工具获取，不要凭记忆或估算回答。

# Tone and style
 - Keep responses short and concise. Lead with the answer.
 - 一律用中文回答。
 - Reference code as file_path:line_number.`;

// 「动态部分」：每次运行都要重新采集的环境信息。
// 故意和静态核心分开，免得它污染缓存。
function buildEnvironmentContext(): string {
  let git = "";
  try {
    const opts = {
      encoding: "utf-8" as const,
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    };
    const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
    git = `\nGit branch: ${branch}`;
  } catch { }
  // 教程原版这里写的是 process.env.SHELL || "/bin/sh"，在 Windows 上
  // 会显示成错误的 "/bin/sh"。加一句判断，Windows 上显示 PowerShell。
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
  return `# Environment
Working directory: ${process.cwd()}
Platform: ${os.platform()} ${os.arch()}
Shell: ${shell}${git}`;
}

// 先静态核心，再环境信息
export function buildSystemPrompt(): string {
  return `${STATIC_CORE}\n\n${buildEnvironmentContext()}`;
}
