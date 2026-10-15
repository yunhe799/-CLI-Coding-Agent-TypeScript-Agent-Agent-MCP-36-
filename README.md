# my-coding-agent

**从零手写的一个命令行 Coding Agent**（TypeScript，12 个模块 / 约 1700 行）：自己实现 Agent 主循环、工具层、分层系统提示词、权限闸门、上下文压缩、记忆、技能、Plan 只读模式、多 Agent 子代理、MCP 客户端，以及自治三件套（`/goal` · `/loop` · Auto Mode）。

另外配了一个**自研业务 MCP server**（[codebase-archaeology-mcp](../codebase-archaeology-mcp)：让 Agent 查代码的历史与决策）和一套**自建评测集**（36 条用例，mock/真模型双轨）。

## 它和聊天机器人的区别

> 普通聊天机器人只会回话，**Agent 会自己动手**。

你只说目标、不说步骤；它自己决定读哪个文件、改哪一行、跑什么命令，并用闸门保证不会乱来。

## 架构

```
用户输入
   ↓
cli.ts      加载 .env · 技能展开（/xxx）· --plan 只读 · --auto 分类器 · /goal · /loop
   ↓
agent.ts    主循环：调用模型 → 有 tool_use 就执行 → 结果喂回 → 直到模型不再请求工具
   ├─ context.ts   历史按**内容体量**压缩（摘要 + 有损警告）
   ├─ prompt.ts    静态核心（可缓存）+ 动态环境信息
   ├─ memory.ts    召回与本次提问相关的记忆
   ├─ 工具表 = 7 个内置 + MCP 外部工具 + loop 内临时的 schedule_wakeup
   ├─ 模型（流式输出）
   └─ tool_use 分发：
        ├─ schedule_wakeup → /loop dynamic 排下一次
        ├─ agent           → subagent.ts 派只读子 Agent（独立上下文，只带回结论）
        ├─ mcp__…          → mcp.ts 按前缀转发给外部 MCP 服务器
        ├─ --auto 模式      → autonomy.ts 分类器判该不该放行（只读工具走 fast-path）
        ├─ permissions.ts + plan 模式 → 危险 / 只读模式下要动手 → 拦截
        └─ executeTool      → 结果喂回历史 → 回到循环顶部
   ↓
session.ts  每轮存盘，--resume 可恢复
```

自治三件套（`autonomy.ts`）：`/goal` 用一个独立评估器把停止条件追到底（含 `impossible` 刹车）、`/loop` 支持定时重投与模型自定节奏、Auto Mode 用两段式分类器代替"确认框"。

## 快速开始

```powershell
# 1) 装依赖
npm install

# 2) 配置 .env（复制 .env.example，填 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / MINI_MODEL）
#    没有 key 也能玩：npm test 与 npm run eval:mock 不需要任何 key

# 3) 编译（Windows 上别直接用 .bin/tsc）
node node_modules/typescript/bin/tsc

# 4) 用起来
node dist/cli.js "读一下 package.json，告诉我项目名"      # 一次性提问
node dist/cli.js                                          # 交互式 REPL
node dist/cli.js --resume                                 # 恢复上次会话
node dist/cli.js --plan  "做一个改版计划"                  # 只读（计划）模式
node dist/cli.js --auto  "重构这个模块"                    # Auto Mode：分类器代替确认框
```

> **⚠️ 考古 MCP 需要两个仓库并列 clone**：`my-coding-agent/.mcp.json` 里指向考古 server 的是相对路径 `../codebase-archaeology-mcp/server.js`。只 clone 这一个仓库时它连不上——但**不会报错崩掉**（第 12 章"失败不崩溃"的设计），Agent 照常工作，只是少了 `mcp__archaeology__*` 那 8 个工具。想用考古功能就：
> ```powershell
> cd E:\coding项目
> git clone https://github.com/yunhe799/codebase-archaeology-mcp.git
> cd codebase-archaeology-mcp; npm install
> ```

REPL 里的命令：`/clear` 清空历史 · `/goal <条件>` 挂一个停止条件并追到达成 · `/loop [间隔] <任务>` 定时或自定节奏重投 · 技能 `/explain <文件>`。

### 网页演示台（推荐用它演示）

```powershell
npm run web      # 打开 http://localhost:8787
```

零依赖的本地页面：输入问题（或点预设按钮），页面上会**实时**显示工具调用链、MCP 连接状态和逐字回答。服务端每次请求 spawn 一次真实的 `node dist/cli.js`——**页面里跑的就是命令行那套代码**，不是"演示版"。

## 测试与评测

```powershell
npm test            # 5 套离线单元测试，64 项断言（不联网、不花钱）
npm run eval:mock   # 36 条评测用例，假模型驱动，秒级；必须 100%（验证断言本身没写错）
npm run eval:live   # 36 条评测用例，真模型
```

评测报告自动写入 [evals/report.md](evals/report.md)（含多轮对比表），原始数据在 `evals/results/`。

### 评测结果（2026-10-11）

| 模式 | 模型 | 用例 | 通过率 | 危险操作拦截率 | 平均轮数 | 平均工具调用 | 平均成本/任务 | P50 | P95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mock | 假模型 | 36 | **100%** | 100% | 2.5 | 1.5 | ¥0 | 0.3s | 1.3s |
| live | deepseek-chat | 29 | **96.6%** | **100%** | 2.9 | 2.3 | **¥0.0026** | 3.3s | 9.0s |

说明：live 的分母是 29 而不是 36——有 6 条上下文压缩用例和 1 条子 Agent 用例测的是**机制**，真模型下没法稳定触发，标成"仅 mock"（详见 `evals/cases/03-context.mjs` 顶部注释）。

## 风险与边界（诚实清单）

| 边界 | 说明 |
| --- | --- |
| **压缩是有损的** | 摘要是模型生成的，会丢信息。所以摘要后面强制带一句"要精确数字请重新调用工具去读"（这是第 7 章踩坑换来的）。 |
| **Auto Mode 不是安全保证** | 它只是把"人确认"换成"另一个模型判"，那个模型也会错。所有失败方向都设成"拦截"（fail-closed），但别把它当成铁壁。 |
| **权限闸门靠正则** | 覆盖常见危险命令（Unix 6 条 + Windows 4 条），复杂管道组合可能漏。真实 Claude Code 用 Bash AST 分析，我们没做。 |
| **子 Agent 只读** | 只拿得到 read/list/grep 三个工具，所以它做不了"改了再报"。 |
| **路径防护只在 MCP server 侧** | 内置工具没有工作目录沙箱；考古 server 有允许根目录白名单（`ARCHAEOLOGY_ROOTS`）。 |
| **评测数字是单轮的** | 跑两轮 live 都是 28/29，但**失败的是不同的那一条**（一轮是"多步任务没写完 CHANGELOG"，一轮是文件操作里的某条）——说明它是 96.6% 左右的水平，不是精确值。 |
| **没实现** | web_fetch、并行工具执行、ToolSearch 延迟加载、预算控制（`--max-turns`）、大结果落盘、Hooks、LSP、Coordinator/Swarm。 |

## 许可

学习项目，跟着 [claude-code-from-scratch](https://github.com/windy3f3f3f3f/claude-code-from-scratch) 教程从零实现，与 Anthropic 无关。
