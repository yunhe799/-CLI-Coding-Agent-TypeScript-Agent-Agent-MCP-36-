// 离线验证第 11 章的子 Agent：用一个"假模型客户端"驱动子 Agent 循环，
// 不联网、不花钱，专门检查两件事——
//   1) 子 Agent 能读文件、并把结论带回来；
//   2) 子 Agent 的写/执行工具请求会被硬拦下（它只拿到了只读工具）。
// 运行：node tests/subagent.offline.test.mjs
import { existsSync, rmSync } from "node:fs";
import { runSubAgent } from "../dist/subagent.js";

const DENY_FILE = "tests/_should_not_exist.txt";
if (existsSync(DENY_FILE)) rmSync(DENY_FILE);

let step = 0;
const seenToolNames = [];
let denials = [];
const fakeClient = {
  messages: {
    async create(req) {
      const call = ++step;
      // 记下子 Agent 实际拿到的工具清单（应为只读三件套）
      if (call === 1) seenToolNames.push(...req.tools.map((t) => t.name));
      if (call === 1) {
        return { content: [{ type: "tool_use", id: "t1", name: "read_file", input: { file_path: "package.json" } }] };
      }
      if (call === 2) {
        // 故意让子 Agent 去干危险的事——它应当被拒绝
        return {
          content: [
            { type: "tool_use", id: "t2", name: "write_file", input: { file_path: DENY_FILE, content: "x" } },
            { type: "tool_use", id: "t3", name: "run_shell", input: { command: "echo hi" } },
          ],
        };
      }
      if (call === 3) {
        // 第三次调用时，上一轮两个工具的结果已经进了消息历史——把拒绝信息捞出来
        const last = req.messages[req.messages.length - 1];
        denials = (last.content || []).filter((b) => b.type === "tool_result").map((b) => b.content);
      }
      return { content: [{ type: "text", text: "调查完毕：结论在此。" }] };
    },
  },
};

let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✅" : "❌"} ${msg}`);
  ok ? pass++ : fail++;
};

console.log("== 第 11 章 子 Agent 离线测试 ==");

const result = await runSubAgent("调查一下项目", fakeClient, "fake-model");

check(result === "调查完毕：结论在此。", `子 Agent 返回了文本结论：${JSON.stringify(result)}`);
check(
  JSON.stringify(seenToolNames) === JSON.stringify(["read_file", "list_files", "grep_search"]),
  `子 Agent 只拿到只读工具：${seenToolNames.join(", ")}`
);
check(!existsSync(DENY_FILE), "子 Agent 的 write_file 被拦下，磁盘上没有生成文件");
check(
  denials.length === 2 && denials.every((d) => String(d).includes("read-only")),
  `write_file 与 run_shell 都被拒绝：${JSON.stringify(denials)}`
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
