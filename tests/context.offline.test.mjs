// 第 4 周新增：给"压缩触发条件"补一个确定性的单元测试。
// 这是评测集逼出来的问题——阈值原来数「消息条数」，可条数不等于体量：
// 同样读 11 个文件，假模型一轮一个工具 → 23 条，真模型合并进一轮 → 3 条。
// 改成按内容体量（字符数）触发之后，两种节奏就一致了。
import { maybeCompact } from "../dist/context.js";

let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✅" : "❌"} ${msg}`);
  ok ? pass++ : fail++;
};

// 旁路模型：只负责回一段摘要
const fakeClient = {
  messages: {
    async create() {
      return { content: [{ type: "text", text: "（摘要）前面读了一些文件。" }] };
    },
  },
};

const bigText = (n) => "x".repeat(n);
const asst = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const user = (text) => ({ role: "user", content: text });
const WARNING = "请重新调用工具去读";

console.log("== 压缩触发条件（第 4 周修正）离线测试 ==");

// 1) 条数很多、但内容很小 → **不该**压缩（旧阈值会在这里误触发）
const manySmall = [user("开始"), ...Array.from({ length: 24 }, (_, i) => asst(`第 ${i} 句很短的话`))];
const r1 = await maybeCompact(manySmall, fakeClient, "fake");
check(r1.length === manySmall.length, `条数多但内容小 → 不压缩（${manySmall.length} 条保持不动）`);

// 2) 内容很大 → 压缩，并带上"摘要是有损的"警告
const fewBig = [user(bigText(30_000)), asst(bigText(30_000)), asst("收尾"), user("继续")];
const r2 = await maybeCompact(fewBig, fakeClient, "fake");
check(r2.length === 3, `内容大 → 压缩成「摘要 + 最近 2 条」（实际 ${r2.length} 条）`);
check(typeof r2[0].content === "string" && r2[0].content.includes("[Summary of earlier conversation]"), "第 1 条是摘要");
check(typeof r2[0].content === "string" && r2[0].content.includes(WARNING), "摘要后面带「要精确数字请重新读」的警告");
check(r2[1] === fewBig[2] && r2[2] === fewBig[3], "最近 2 条原样保留（压缩不碰它们）");

// 3) 消息太少（就算很大）也不压——没必要为两条消息再花一次 API
const twoBig = [user(bigText(50_000)), asst(bigText(50_000))];
const r3 = await maybeCompact(twoBig, fakeClient, "fake");
check(r3.length === 2, "只有 2 条时不做压缩");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
