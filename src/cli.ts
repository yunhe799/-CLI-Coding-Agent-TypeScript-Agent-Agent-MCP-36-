import * as readline from "readline";
import { pathToFileURL } from "url";
import { readFileSync } from "fs";
import { Agent } from "./agent.js";

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

  const oneShot = argv.join(" ").trim();
  if (oneShot) {
    await agent.chat(oneShot);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("mini-claude — type a message, or 'exit' to quit.\n");
  await new Promise<void>((resolve) => {
    const ask = () => {
      rl.question("you: ", async (line) => {
        const input = line.trim();
        if (input === "exit" || input === "quit") {
          rl.close();
          resolve();
          return;
        }
        if (input) await agent.chat(input);
        ask();
      });
    };
    ask();
  });
}

// 只有直接运行这个文件时才启动（被别人 import 时不启动）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
