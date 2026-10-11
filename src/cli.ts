import * as readline from "readline";
import { pathToFileURL } from "url";
import { readFileSync } from "fs";
import { Agent } from "./agent.js";
import { saveSession, loadSession } from "./session.js";
import { resolveSkill } from "./skills.js";

// ── 我给你的项目加的小改进 ──
// 教程原版不读 .env，需要每次手动设环境变量。加上这段以后，
// 直接 `node dist/cli.js "问题"` 就能跑。
try {
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // 没有 .env 文件就跳过
}

// 一个极简 REPL：读一行 → 交给 Agent → 重复。
// 也支持一次性模式：把问题写在命令行参数里，回答完就退出。
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL) first.");
    process.exit(1);
  }

  const agent = new Agent();

  // ── 第 4 章新增：--resume 先把上次保存的对话读回来 ──
  const resume = argv.includes("--resume");
  argv = argv.filter((a) => a !== "--resume");
  if (resume) {
    const saved = loadSession();
    if (saved) {
      agent.loadHistory(saved as any);
      console.log(`(resumed ${saved.length} messages)`);
    } else {
      console.log("(no saved session found)");
    }
  }

  // ── 第 10 章新增：--plan 进入只读模式 ──
  // Agent 可以读文件、可以分析，但不能写文件、不能跑命令。
  if (argv.includes("--plan")) {
    agent.setMode("plan");
    argv = argv.filter((a) => a !== "--plan");
    console.log("(plan mode: read-only)");
  }

  // ── 第 15 章新增：--auto 进入自动模式 ──
  // 危险操作不再弹框问人，改由一个分类器读一段脱敏的对话记录来判该不该放行。
  if (argv.includes("--auto")) {
    agent.setMode("auto");
    argv = argv.filter((a) => a !== "--auto");
    console.log("(auto mode: a classifier gates each write instead of asking you)");
  }

  // ── 第 15 章新增：Ctrl+C 先停 /loop 和 /goal，再按一次才退出 ──
  let sigints = 0;
  process.on("SIGINT", () => {
    sigints++;
    agent.stopLoops();
    if (sigints >= 2) process.exit(130);
    console.log("\n(已请求停止 /loop 与 /goal；再按一次 Ctrl+C 退出)");
  });

  const oneShot = argv.join(" ").trim();
  if (oneShot) {
    // ── 第 15 章新增：一次性模式也支持 /goal <条件>（跑完整个追目标循环）──
    if (oneShot === "/goal" || oneShot.startsWith("/goal ")) {
      const condition = oneShot.slice("/goal".length).trim();
      if (!condition) {
        console.log("用法：/goal <条件>");
        return;
      }
      await agent.pursueGoal(agent.setGoal(condition));
      saveSession(agent.history());
      await agent.shutdown();
      return;
    }
    // ── 第 9 章的变化："/名字 ..." 走技能模板，其他当成普通消息 ──
    const input = resolveSkill(oneShot) ?? oneShot;  //?? 的意思是"左边是空就用右边"
    await agent.chat(input);
    saveSession(agent.history());
    // ── 第 12 章新增：关掉 MCP 子进程，否则 Node 进程不会自己退出 ──
    await agent.shutdown();
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("mini-claude — type a message, or 'exit' to quit.\n");
  await new Promise<void>((resolve) => {
    // ── 顺手修的小 bug ──
    // 原版在输入流结束时（比如把内容用管道喂进来、或者按 Ctrl+D）会抛
    // ERR_USE_AFTER_CLOSE 崩溃。这里监听 close 事件，让它优雅退出。
    let closed = false;
    rl.on("close", () => {
      closed = true;
      resolve();
    });
    const ask = () => {
      if (closed) return;
      rl.question("you: ", async (line) => {
        const input = line.trim();
        if (input === "exit" || input === "quit") {
          rl.close();
          return;
        }
        // ── 第 15 章新增：/goal 与 /loop 两个自治命令 ──
        if (input === "/goal" || input.startsWith("/goal ")) {
          const condition = input.slice("/goal".length).trim();
          if (!condition) {
            agent.showGoal();
          } else {
            await agent.pursueGoal(agent.setGoal(condition));
            saveSession(agent.history());
          }
          ask();
          return;
        }
        if (input === "/loop" || input.startsWith("/loop ")) {
          await agent.runLoop(input.slice("/loop".length).trim());
          saveSession(agent.history());
          ask();
          return;
        }
        // /clear：清空对话历史（也就等于开了一个新会话）
        if (input === "/clear") {
          agent.clearHistory();
          saveSession(agent.history());
          console.log("(history cleared)");
          ask();
          return;
        }
        if (input) await agent.chat(resolveSkill(input) ?? input);
        if (input) saveSession(agent.history());
        ask();
      });
    };
    ask();
  });
  // ── 第 12 章新增：REPL 退出时同样要收尾 MCP ──
  await agent.shutdown();
}

// 只有直接运行这个文件时才启动（被别人 import 时不启动）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
