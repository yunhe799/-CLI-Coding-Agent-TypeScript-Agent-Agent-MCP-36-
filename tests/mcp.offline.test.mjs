// 离线验证第 12 章的 MCP 集成：不联网、不花钱。
//   1) 直接测 MCP 客户端：连上 .mcp.json 里声明的 demo 服务器 → 发现工具 → 调用它。
//   2) 端到端测集成：用一个"假模型"驱动 Agent，验证外部工具被并进工具表、
//      并且 `mcp__demo__add` 的调用被正确路由到服务器、结果被喂回模型。
// 运行：node tests/mcp.offline.test.mjs（需在项目根目录，才能读到 .mcp.json）
import { McpManager } from "../dist/mcp.js";
import { Agent } from "../dist/agent.js";

let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✅" : "❌"} ${msg}`);
  ok ? pass++ : fail++;
};

console.log("== 第 12 章 MCP 离线测试 ==");

// ── 1) MCP 客户端：握手 → 发现 → 调用 ──
const mgr = new McpManager();
await mgr.loadAndConnect();

const names = mgr.getToolDefinitions().map((d) => d.name);
check(names.includes("mcp__demo__add"), `发现外部工具（带前缀）：${names.join(", ")}`);
check(mgr.isMcpTool("mcp__demo__add") && !mgr.isMcpTool("read_file"), "前缀识别：MCP 工具为真，内置工具为假");

const sum = await mgr.callTool("mcp__demo__add", { a: 17, b: 25 });
check(sum === "42", `调用 mcp__demo__add(17, 25) 得到 ${JSON.stringify(sum)}`);

const ts = await mgr.callTool("mcp__demo__timestamp", {});
check(/^\d{10,}$/.test(ts), `调用 mcp__demo__timestamp 得到 ${JSON.stringify(ts)}`);

let threw = false;
try {
  await mgr.callTool("mcp__nope__foo", {});
} catch {
  threw = true;
}
check(threw, "调用未连接服务器时报错（而不是静默失败）");

await mgr.disconnectAll();

// ── 2) 端到端：假模型驱动 Agent，走完主循环 ──
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
const agent = new Agent();

let call = 0;
const seenTools = [];
// 把 Agent 的模型客户端换成假客户端（编译后 private 字段在 JS 里可直接赋值）
agent.client = {
  messages: {
    stream(req) {
      if (call === 0) seenTools.push(...req.tools.map((t) => t.name));
      call++;
      return {
        on() {},
        async finalMessage() {
          if (call === 1) {
            return { content: [{ type: "tool_use", id: "u1", name: "mcp__demo__add", input: { a: 17, b: 25 } }] };
          }
          return { content: [{ type: "text", text: "17 + 25 = 42。" }] };
        },
      };
    },
  },
};

await agent.chat("用 add 工具算一下 17 + 25");

const blocks = agent.history().flatMap((m) => (Array.isArray(m.content) ? m.content : []));
const toolResult = blocks.find((b) => b.type === "tool_result");
check(seenTools.includes("mcp__demo__add"), `模型看到的工具表里含外部工具：${seenTools.join(", ")}`);
check(toolResult?.content === "42", `MCP 调用结果被喂回模型：${JSON.stringify(toolResult?.content)}`);

await agent.shutdown(); // 收尾：不关子进程的话，Node 会一直不退出

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
