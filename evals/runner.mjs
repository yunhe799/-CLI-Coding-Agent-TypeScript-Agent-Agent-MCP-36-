#!/usr/bin/env node
// 评测跑分器：把 36 条用例跑一遍 → 出分 → 写 results/*.json 与 report.md。
//
//   node evals/runner.mjs --mock                          # 不联网、秒级；必须 100%
//   node evals/runner.mjs --live --model deepseek-chat    # 真模型
//   node evals/runner.mjs --mock --category 02-permissions # 只跑一类
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// ⚠️ harness 必须**动态导入**——agent.ts 里的 `MODEL` 是在模块加载那一刻读
// `process.env.MINI_MODEL` 定死的，而静态 import 会被提升到文件最前面执行，
// 那样下面的 --model / --base-url 就全成了空操作（我第一次就踩了这个坑：
// 传了 --model kimi-k2.7-code，请求却仍然发给了 .env 里的模型）。

// ── 读 .env（--live 需要 key；--mock 不需要）──
try {
  for (const line of readFileSync(join(PROJECT_ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {}

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};

const mode = flag("--live") ? "live" : "mock";
const onlyCategory = opt("--category");
const limit = opt("--limit") ? Number(opt("--limit")) : null;
// --model 用来做多模型对比：报告里的表会自动多一行。
// 用法：node evals/runner.mjs --live --model deepseek-chat
const modelOverride = opt("--model");
if (modelOverride) process.env.MINI_MODEL = modelOverride;
// --base-url 用于换供应商（各家都有 Anthropic 兼容端点）。
// 用法：node evals/runner.mjs --live --model kimi-k2.7-code --base-url https://api.moonshot.cn/anthropic
const baseUrlOverride = opt("--base-url");
if (baseUrlOverride) process.env.ANTHROPIC_BASE_URL = baseUrlOverride;
// 有些账号有 RPM 限制（比如 Kimi 免费档是 3 RPM）。--delay 拉开用例间隔；
// 命中 429 时退避重试；重试仍被限流的用例按 **skipped** 处理——那是环境问题，
// 不该混进通过率里当"模型失败"。
const delayMs = opt("--delay") ? Number(opt("--delay")) : 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimited = (r) => r.failures.some((f) => /429|rate_limit|RPM/i.test(f));

// 环境变量都设好了，这时才把 harness（以及它里面的 Agent）加载进来
const { PROJECT_ROOT, runCase } = await import("./lib/harness.mjs");
const { hasArchaeologyServer } = await import("./lib/harness.mjs");
const model = mode === "live" ? process.env.MINI_MODEL ?? "unknown" : "(mock 假模型)";
// 估算成本用（默认按 deepseek-chat 的公开价格量级，单位：元 / 百万 token）
const PRICE_IN = Number(process.env.EVAL_PRICE_IN ?? 1);
const PRICE_OUT = Number(process.env.EVAL_PRICE_OUT ?? 2);

const CATEGORIES = ["01-file-ops", "02-permissions", "03-context", "04-mcp", "05-multi-step"];

let cases = [];
for (const c of CATEGORIES) {
  const mod = await import(new URL(`./cases/${c}.mjs`, import.meta.url).href);
  cases.push(...mod.default);
}
if (onlyCategory) cases = cases.filter((c) => c.category === onlyCategory);
if (limit) cases = cases.slice(0, limit);

console.log(`\n=== 评测开始 · ${mode} · ${model} · ${cases.length} 条用例 ===\n`);

const results = [];
const skipped = [];
for (const def of cases) {
  // 有些用例测的是"机制"，在真模型下没法稳定触发（比如压缩要按消息条数攒够）
  if ((mode === "live" && def.mockOnly) || (def.needsMcp && !hasArchaeologyServer())) {
    skipped.push(def.id);
    console.log(
      `⏭  ${def.id.padEnd(12)} ${
        def.needsMcp ? "跳过（没找到并列的 codebase-archaeology-mcp 仓库）" : "仅 mock（机制类断言，真模型下不稳定）"
      }`,
    );
    continue;
  }
  let r = await runCase(def, { mode });
  for (let attempt = 0; mode === "live" && isRateLimited(r) && attempt < 3; attempt++) {
    console.log(`   ↻ ${def.id} 命中限流，等 25s 重试（${attempt + 1}/3）`);
    await sleep(25_000);
    r = await runCase(def, { mode });
  }
  if (isRateLimited(r)) {
    skipped.push(def.id);
    console.log(`⏭  ${def.id.padEnd(12)} 限流未通过 → 跳过（不计入分母）`);
    continue;
  }
  results.push(r);
  const tag = r.pass ? "✅" : "❌";
  console.log(`${tag} ${r.id.padEnd(12)} ${String(r.ms).padStart(5)}ms  ${r.observed.toolCalls.join(" → ") || "(无工具)"}`);
  for (const f of r.failures) console.log(`     ↳ ${f}`);
  if (delayMs) await sleep(delayMs);
}

// ── 统计 ──
const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);
const byCategory = {};
for (const c of CATEGORIES) {
  const rs = results.filter((r) => r.category === c);
  if (rs.length === 0) continue;
  byCategory[c] = { total: rs.length, passed: rs.filter((r) => r.pass).length };
}
const passed = results.filter((r) => r.pass).length;
const times = results.map((r) => r.ms).sort((a, b) => a - b);
const p50 = times[Math.floor(times.length * 0.5)] ?? 0;
const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0;
const inTok = results.reduce((s, r) => s + (r.observed.usage?.inputTokens ?? 0), 0);
const outTok = results.reduce((s, r) => s + (r.observed.usage?.outputTokens ?? 0), 0);
const cost = (inTok / 1e6) * PRICE_IN + (outTok / 1e6) * PRICE_OUT;
const avg = (f) => (results.length ? Math.round((results.reduce((s, r) => s + f(r), 0) / results.length) * 10) / 10 : 0);

const summary = {
  mode,
  model,
  when: new Date().toISOString(),
  totals: {
    cases: results.length,
    skipped: skipped.length,
    skippedIds: skipped,
    passed,
    passRate: pct(passed, results.length),
    // 安全类的拦截率必须 100%
    interceptionRate: byCategory["02-permissions"] ? pct(byCategory["02-permissions"].passed, byCategory["02-permissions"].total) : null,
    avgTurns: avg((r) => r.observed.turns),
    avgToolCalls: avg((r) => r.observed.toolCalls.length),
    avgMs: avg((r) => r.ms),
    p50Ms: p50,
    p95Ms: p95,
    inputTokens: inTok,
    outputTokens: outTok,
    estCostCNY: Math.round(cost * 10000) / 10000,
  },
  byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, { ...v, passRate: pct(v.passed, v.total) }])),
  failed: results.filter((r) => !r.pass).map((r) => ({ id: r.id, failures: r.failures })),
};

// ── 落盘 ──
const resultsDir = join(PROJECT_ROOT, "evals", "results");
mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
writeFileSync(join(resultsDir, `${mode}-${stamp}.json`), JSON.stringify({ summary, results }, null, 2), "utf8");

// report.md：顶部是所有跑过的汇总（多模型对比表），下面挂最近一次的明细
const runs = readdirSync(resultsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(resultsDir, f), "utf8")).summary)
  .sort((a, b) => String(a.when).localeCompare(String(b.when)));
const t = summary.totals;
const lines = [
  "# 评测报告",
  "",
  "> 由 `node evals/runner.mjs` 自动生成。断言的是**副作用**（文件内容、工具调用序列、被拦截的事实），不是模型说了什么。",
  "",
  "## 多轮对比（每跑一次追加一行）",
  "",
  "| 模式 | 模型 | 用例 | 通过率 | 拦截率(安全类) | 平均轮数 | 平均工具调用 | 平均成本/任务 | P50 | P95 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...runs.map((r) => {
    const x = r.totals;
    const perTask = x.cases ? (x.estCostCNY / x.cases).toFixed(4) : "0";
    return `| ${r.mode} | ${r.model} | ${x.cases} | **${x.passRate}%** | ${x.interceptionRate ?? "-"}% | ${x.avgTurns} | ${x.avgToolCalls} | ¥${perTask} | ${x.p50Ms}ms | ${x.p95Ms}ms |`;
  }),
  "",
  `## 最近一次：${mode} · ${model}`,
  "",
  `- 整体通过率：**${passed}/${results.length} = ${t.passRate}%**`,
  `- 危险操作拦截率：**${t.interceptionRate}%**（安全类必须 100%）`,
  `- 平均轮数 ${t.avgTurns} / 平均工具调用 ${t.avgToolCalls} / 平均耗时 ${t.avgMs}ms（P50 ${t.p50Ms}ms，P95 ${t.p95Ms}ms）`,
  `- token：输入 ${t.inputTokens} / 输出 ${t.outputTokens}，估算成本 **¥${t.estCostCNY}**（共 ${results.length} 条）`,
  "",
  "### 分类通过率",
  "",
  "| 类别 | 通过 / 总数 | 通过率 |",
  "| --- | --- | --- |",
  ...Object.entries(summary.byCategory).map(([k, v]) => `| ${k} | ${v.passed} / ${v.total} | ${v.passRate}% |`),
  "",
];
if (summary.failed.length) {
  lines.push("### 未通过的用例", "");
  for (const f of summary.failed) lines.push(`- **${f.id}**：${f.failures.join("；")}`);
  lines.push("");
}
writeFileSync(join(PROJECT_ROOT, "evals", "report.md"), lines.join("\n"), "utf8");

console.log(`\n结果：${passed} 通过 / ${results.length - passed} 失败（通过率 ${t.passRate}%）`);
console.log(`报告：evals/report.md    原始数据：evals/results/`);
process.exit(summary.failed.length === 0 ? 0 : 1);
