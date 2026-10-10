// 第 14 章新增：权限闸门的自动化测试。
// 分两层验：
//   1) checkPermission 规则表（纯函数，确定性的）
//   2) 端到端：用假模型**强行**让 Agent 去调一条危险命令 —— 硬闸门必须拦下，
//      而且命令真的没被执行（用"标记文件是否生成"来验证）。
// 第 2 层很关键：真模型往往在提示词层就自己拒绝了，只有假模型才能逼出代码层的拦截。
import { existsSync, rmSync } from "node:fs";
import { checkPermission } from "../dist/permissions.js";
import { Agent } from "../dist/agent.js";

let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✅" : "❌"} ${msg}`);
  ok ? pass++ : fail++;
};

console.log("== 第 14 章 权限闸门离线测试 ==");

// ── 1) 规则表 ──
const dangerous = [
  "rm -rf /tmp/x",
  "git push origin main",
  "git reset --hard HEAD~1",
  "sudo rm file",
  "Remove-Item -Recurse -Force C:\\tmp",
  "Stop-Computer",
];
const safe = ["ls -la", "node --version", "git status", "Get-ChildItem"];

for (const c of dangerous) check(checkPermission("run_shell", { command: c }) === "deny", `拦截危险命令：${c}`);
for (const c of safe) check(checkPermission("run_shell", { command: c }) === "allow", `放行安全命令：${c}`);
check(checkPermission("read_file", { file_path: "x" }) === "allow", "读文件不走命令闸门");

// ── 2) 端到端：危险命令被拦下，且真的没执行 ──
const MARK = "tests/_should_not_exist_permission.txt";
if (existsSync(MARK)) rmSync(MARK);

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
const agent = new Agent();
let call = 0;
agent.client = {
  messages: {
    stream() {
      call++;
      return {
        on() {},
        async finalMessage() {
          if (call === 1) {
            return {
              content: [
                {
                  type: "tool_use",
                  id: "p1",
                  name: "run_shell",
                  // 含 "git push" → 命中危险规则；后半句是"如果闸门失守就会留下证据"的标记
                  input: { command: `git push origin main; New-Item -ItemType File -Force "${MARK}"` },
                },
              ],
            };
          }
          return { content: [{ type: "text", text: "done" }] };
        },
      };
    },
  },
};

await agent.chat("跑一条危险命令");
const blocks = agent.history().flatMap((m) => (Array.isArray(m.content) ? m.content : []));
const tr = blocks.find((b) => b.type === "tool_result");
check(String(tr?.content || "").includes("Denied"), `硬闸门拦下，模型收到：${JSON.stringify(tr?.content)}`);
check(!existsSync(MARK), "命令没有真的执行（标记文件不存在）");
await agent.shutdown();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
