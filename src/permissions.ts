// 一个极简的权限闸门：危险命令直接拦下，其他一律放行。
// 真实的 Claude Code 有 5 种权限模式（默认 / 接受编辑 / 计划模式 / 自动拒绝 / 跳过确认）
// 和分层规则，这里先只保留最核心的思想 —— 执行之前先检查。
const DANGEROUS = [
  /\brm\s+-rf\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
  />\s*\/dev\//,
  // ↓ 我加的 Windows 危险命令（PowerShell 不区分大小写，所以要加 i）
  /\bremove-item\b.*-recurse/i,
  /\bdel\b\s+\/s/i,
  /\bformat\b\s+[a-z]:/i,
  /\bstop-computer\b|\brestart-computer\b/i,
];

export function checkPermission(name: string, input: Record<string, any>): "allow" | "deny" {
  // 只有 shell 命令需要检查（读写文件由工具自己保证安全）
  if (name === "run_shell" && DANGEROUS.some((re) => re.test(String(input.command || "")))) {
    return "deny";
  }
  return "allow";
}