// 评测的执行内核：为每条用例准备一个干净的沙箱 → 驱动 Agent 跑一次 →
// 断言**副作用**（文件内容、工具调用、被拦截的事实），而不是模型说的话。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../../dist/agent.js";
import { makeMockClient, makeCompactAwareMockClient } from "./mock-llm.mjs";
import { resolveSkill } from "../../dist/skills.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, "../..");
const ARCHAEOLOGY_SERVER = resolve(PROJECT_ROOT, "../codebase-archaeology-mcp/server.js");

/** 考古 server 在不在？不在时，依赖它的用例要**跳过**而不是判失败——
 *  别人只 clone 这一个仓库是完全合法的用法（README 里就是这么写的）。 */
export const hasArchaeologyServer = () => existsSync(ARCHAEOLOGY_SERVER);

/** 在 chat 期间把 Agent 的流式输出吞掉，免得刷屏；返回后恢复。 */
async function quietly(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = orig;
  }
}

/** 造沙箱：临时目录 + 需要时写入 .mcp.json / 一个带历史的 git 仓库。 */
function makeSandbox(def) {
  const dir = mkdtempSync(join(tmpdir(), "eval-"));
  for (const [rel, content] of Object.entries(def.fixture ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  if (def.needsMcp) {
    // 让 agent 在这个沙箱里能找到考古 server（cwd 就是沙箱，所以 repo 默认就指到这里）
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { archaeology: { command: "node", args: [ARCHAEOLOGY_SERVER] } } }, null, 2),
    );
    const g = (...args) =>
      execFileSync("git", ["-c", "user.name=Eval", "-c", "user.email=e@local", ...args], {
        cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-q", "-m", def.mcpSeedCommit ?? "chore: 评测沙箱初始化");
    if (def.mcpSecondCommit) {
      const abs = join(dir, def.mcpSecondCommit.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, def.mcpSecondCommit.content, "utf8");
      g("add", "-A");
      g("commit", "-q", "-m", def.mcpSecondCommit.message);
    }
  }
  return dir;
}

/** 期望序列是实际序列的**子序列**（允许模型多调用几次别的工具，但顺序要对）。 */
function isSubsequence(actual, expected) {
  let i = 0;
  for (const a of actual) if (i < expected.length && a === expected[i]) i++;
  return i === expected.length;
}

const serialize = (blocks) =>
  blocks.map((b) => (typeof b === "string" ? b : b.type === "text" ? b.text : `[${b.type}${b.name ? " " + b.name : ""}]`)).join(" ");

/** 跑一条用例，返回观察到的副作用 + 断言结果。 */
export async function runCase(def, { mode = "mock" } = {}) {
  const sandbox = makeSandbox(def);
  const started = Date.now();
  const failures = [];
  const observed = { toolCalls: [], toolResults: [], files: {}, usage: null, turns: 0 };
  let agent = null;
  const back = process.cwd();
  try {
    process.chdir(sandbox);
    agent = new Agent();
    if (def.mode) agent.setMode(def.mode);
    if (mode === "mock") {
      const script = typeof def.mock === "function" ? def.mock() : def.mock ?? [{ text: "（没有脚本）" }];
      agent.client = def.longConversation ? makeCompactAwareMockClient(script) : makeMockClient(script);
    }

    // 少数用例要连"技能展开"一起验（这段逻辑在 CLI 层，不在 Agent 里）
    const input = def.expandSkill ? (resolveSkill(def.prompt) ?? def.prompt) : def.prompt;
    await quietly(() => agent.chat(input));

    // ── 收集观察值 ──
    const history = agent.history();
    for (const m of history) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === "tool_use") observed.toolCalls.push(b.name);
        if (b.type === "tool_result") observed.toolResults.push(String(b.content ?? ""));
      }
    }
    observed.turns = history.filter((m) => m.role === "assistant").length;
    observed.usage = { ...agent.usage };

    // ── 断言 ──
    // 按模式分级：mock 下脚本是我们自己写的，可以断言"机制"（必须调某个工具、
    // 必须出现某句拒绝文案）；live 下模型怎么走是它的自由，只断言"效果"
    // （危险的事没发生、文件内容对不对、答案有没有拿到）。用例用 expectLive 覆盖。
    const e = mode === "live" && def.expectLive ? def.expectLive : def.expect ?? {};
    if (e.toolCalls && !isSubsequence(observed.toolCalls, e.toolCalls)) {
      failures.push(`工具调用序列不对：期望（按序）${e.toolCalls.join(" → ")}，实际 ${observed.toolCalls.join(" → ") || "(无)"}`);
    }
    for (const name of e.toolCallsAbsent ?? []) {
      if (observed.toolCalls.includes(name)) failures.push(`不该调用 ${name}，但它被调用了`);
    }
    // 效果型：这几个工具里至少调用一个（不限定必须走哪条路）
    if (e.anyToolCall && !e.anyToolCall.some((n) => observed.toolCalls.includes(n))) {
      failures.push(`这几个工具里至少要调用一个：${e.anyToolCall.join(" / ")}，实际 ${observed.toolCalls.join(" → ") || "(无)"}`);
    }
    const joinedResults = observed.toolResults.join("\n");
    for (const needle of e.toolResultsContain ?? []) {
      if (!joinedResults.includes(needle)) failures.push(`工具结果里没有「${needle}」`);
    }
    for (const [rel, content] of Object.entries(e.files ?? {})) {
      const abs = join(sandbox, rel);
      if (!existsSync(abs)) failures.push(`文件 ${rel} 不存在（期望内容：${JSON.stringify(content).slice(0, 40)}…）`);
      else {
        const actual = readFileSync(abs, "utf8");
        observed.files[rel] = actual;
        if (actual !== content) failures.push(`文件 ${rel} 内容不对：期望 ${JSON.stringify(content)}，实际 ${JSON.stringify(actual)}`);
      }
    }
    for (const rel of e.filesAbsent ?? []) {
      if (existsSync(join(sandbox, rel))) failures.push(`不该生成 ${rel}，但它出现了（说明拦截没生效）`);
    }
    // 效果型：文件存在且**包含**某段文字（不要求逐字相等——措辞是模型的自由）
    for (const [rel, needle] of Object.entries(e.filesContain ?? {})) {
      const abs = join(sandbox, rel);
      if (!existsSync(abs)) failures.push(`文件 ${rel} 不存在`);
      else if (!readFileSync(abs, "utf8").includes(needle)) failures.push(`文件 ${rel} 里没有「${needle}」`);
    }
    const wholeHistory = history.map((m) => serialize(Array.isArray(m.content) ? m.content : [m.content])).join("\n");
    for (const needle of e.historyContains ?? []) {
      if (!wholeHistory.includes(needle)) failures.push(`对话历史里没有「${needle}」`);
    }
    const firstUser = typeof history[0]?.content === "string" ? history[0].content : "";
    for (const needle of e.userMessageContains ?? []) {
      if (!firstUser.includes(needle)) failures.push(`用户消息（展开后）里没有「${needle}」`);
    }
    observed.finalStopReason = observed.toolCalls.length === 0 ? "text_only" : "no_tool_use";
    if (e.finalStopReason && observed.finalStopReason !== e.finalStopReason) {
      failures.push(`结束原因不对：期望 ${e.finalStopReason}，实际 ${observed.finalStopReason}`);
    }
    // 需要更细的结构化断言时，用例自己写一个 custom（返回字符串=失败原因）
    if (e.custom) {
      const reason = e.custom({ observed, history, sandbox });
      if (reason) failures.push(reason);
    }
  } catch (err) {
    failures.push(`用例抛异常：${err?.message ?? err}`);
  } finally {
    if (agent) {
      try {
        await agent.shutdown(); // 关掉 MCP 子进程，否则 runner 不会退出
      } catch {}
      // Windows 上被 kill 的子进程可能还短暂占着 cwd，给它一点时间退出
      await new Promise((r) => setTimeout(r, 120));
    }
    process.chdir(back);
    try {
      // 删不掉也不该让整轮评测崩掉（临时目录留给系统回收）
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      console.error(`  (提示：临时沙箱 ${sandbox} 暂时删不掉，已跳过)`);
    }
  }
  return {
    id: def.id,
    category: def.category,
    mode,
    pass: failures.length === 0,
    failures,
    observed,
    ms: Date.now() - started,
  };
}
