这是一个用 TypeScript 从零实现的极简 Coding Agent（项目名 my-coding-agent），跟着 claude-code-from-scratch 教程学习。
核心是 `src/agent.ts` 里的 Agent 类：一个不断变长的 messages 数组加一个循环，调用模型 → 遇到 tool_use 就执行工具 → 把 tool_result 喂回 → 直到模型只回纯文本为止。
`src/tools.ts` 定义了 read_file / write_file / edit_file / list_files / grep_search / run_shell 六个内置工具，外加一个 agent 工具（派一个只读子 Agent 去调查）；
`src/mcp.ts` 让 Agent 能从 `.mcp.json` 动态挂载外部 MCP 工具服务器（每个工具都带 `mcp__<服务器>__<工具>` 前缀，调用时按前缀路由回去）。
`src/cli.ts` 提供 REPL 和一次性命令行两种入口，并支持从 .env 读取 ANTHROPIC_API_KEY 与 ANTHROPIC_BASE_URL。