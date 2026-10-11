# my-coding-agent 功能测试指南（第 14 章）

和教程第 14 章一样，这一章不写新代码：把已经造好的 agent 从头到尾验一遍。

Coding agent 的测试和普通软件不同——核心行为由模型决定，输出不确定。所以分两层：

| 层 | 测什么 | 要不要 key |
| --- | --- | --- |
| **自动化** | 确定性的部分：工具函数、MCP 协议、子 Agent 的工具隔离 | 不要（用假模型） |
| **人工验收** | 真正由模型决定的行为：选没选对工具、有没有绕过闸门、召回得准不准 | 要 |

## 一、自动化（先跑这个）

```bash
cd E:\coding项目\my-coding-agent\
npm test
```

| 测试 | 覆盖 | 断言 |
| --- | --- | --- |
| `tests/subagent.offline.test.mjs` | 第 11 章 子 Agent | 只拿到只读三件套；`write_file`/`run_shell` 被拒；只把文本结论带回主对话 |
| `tests/mcp.offline.test.mjs` | 第 12 章 MCP | 握手 → 发现工具 → 前缀识别 → `add(17,25)=42` → 未连接报错 → 结果被喂回模型 |
| `tests/permissions.offline.test.mjs` | 第 6 章 权限闸门 | 6 条危险命令全部拦截、4 条安全命令放行；并用假模型**强行**触发危险命令，验证硬闸门拦下且命令真的没执行 |
| `tests/autonomy.offline.test.mjs` | 第 15 章 自治续跑 | `/loop` 解析（含 `check every PR` 边界）、`/goal` 裁决的保守解析、分类器 fail-closed、脱敏投影、`/goal` 追到达成 / impossible 刹车、Auto Mode 拦写入且只读工具走 fast-path |

两个测试都用假模型客户端驱动，所以**不联网、不花钱、不用 key**。

## 二、人工验收清单（需要 `.env` 里的 key）

准备：

```bash
cd E:\coding项目\my-coding-agent\
npm run build
```

REPL 模式用 `node dist/cli.js`（`exit` 退出）；下面都写成一次性模式，方便复制。

| # | 功能 | 命令 | 预期 |
| --- | --- | --- | --- |
| 1 | 主循环 + 工具调用 | `node dist/cli.js "读一下 package.json，告诉我项目名"` | 出现 `→ read_file(...)`，然后给出项目名 |
| 2 | 流式输出 | 同上 | 回答逐字出现，不是空白几秒后一次性蹦出来 |
| 3 | 权限闸门 | `node dist/cli.js "帮我跑一下 git push origin main"` | 命令**没有真的执行**，模型收到 `Denied: ... was blocked` |
| 4 | Plan 只读 | `node dist/cli.js --plan "在根目录创建一个 hello.txt"` | 写文件被拦，只有读工具放行 |
| 5 | 技能模板 | `node dist/cli.js "/explain src/context.ts"` | 用 3 句话解释（模板来自 `.mini-skills/explain.md`） |
| 6 | 会话恢复 | 先 `node dist/cli.js "记住暗号：BANANA-42"`，再 `node dist/cli.js --resume "我刚才让你记的暗号是什么"` | 第二句答出 `BANANA-42` |
| 7 | /clear | REPL 里输入 `/clear` | 打印 `(history cleared)`，再问刚才的事它就不记得了 |
| 8 | 中文记忆召回 | `node dist/cli.js "这个项目用的什么语言？"` | 召回 `.mini-memory/project.md`（中文按 bigram 切词才召得回） |
| 9 | 子 Agent | `node dist/cli.js "用子 Agent 查一下这个项目有哪些依赖"` | 出现 `→ agent({"task":"..."})`，返回一段结论 |
| 10 | MCP 工具 | `node dist/cli.js "用 add 工具算 17+25"` | `[mcp] Connected to 'demo' — 3 tools`，`→ mcp__demo__add(...)`，答 42 |
| 11 | 错误不崩 | `node dist/cli.js "读一下 /nonexistent/x.txt"` | 工具返回错误信息，进程正常退出 |
| 12 | 上下文压缩 | 连续聊 21 轮以上 | 出现 `(compacted N messages into a summary)`，且摘要末尾带"要精确数字请重新读"的提醒 |

## 三、教程里我们**没实现、所以不测**的

教程第 14 章有 22 个场景，其中这些依赖我们没做的功能：

| 教程测试 | 依赖的功能 | 我们的状态 |
| --- | --- | --- |
| 2 WebFetch | `web_fetch` 工具 | 没做（我们只有 7 个工具） |
| 3 并行工具执行 | 并发安全工具 + streaming 早期启动 | 没做（工具是顺序执行的） |
| 4 语义记忆召回 | 向量 / 异步 prefetch | 简化为关键词重合 |
| 5 `@include` + rules | CLAUDE.md 包含指令 | 没做 |
| 6 Read-before-edit | 代码层强制 | 只在提示词里约束 |
| 7 大结果落盘 | LargeResultPersistence | 没做（只做了摘要过期提醒） |
| 9 ToolSearch | 延迟加载工具 | 没做 |
| 10 `/cost` `/memory` `/compact` `/plan` | REPL 命令 | 只做了 `/clear`；`--plan` 是启动参数 |
| 12 Plan 审批四选一 | 审批流程 | 只做了"只读"这一半 |
| 13 引号规范化 | `normalizeQuotes` | 没做 |
| 16 预算控制 | `--max-turns` / `--max-cost` | 没做 |
| 19 自定义 Agent | `.claude/agents/*.md` | 没做 |
| 20–22 自治 | `/goal` `/loop` `--auto` | 第 15 章再做 |

**这份"没做什么"的清单，就是第 13 章那张对照表的落地**：知道边界在哪，比假装什么都有更有用。
