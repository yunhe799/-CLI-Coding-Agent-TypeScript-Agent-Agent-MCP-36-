# 我的 Coding Agent

跟着 claude-code-from-scratch 教程，从零实现的一个 Coding Agent（TypeScript）。

## 进度

- [x] 第 1 章 Agent 主循环
- [x] 第 2 章 工具系统
- [x] 第 3 章 System Prompt
- [x] 第 4 章 会话持久化（--resume / /clear）
- [x] 第 5 章 流式输出
- [x] 第 6 章 权限闸门
- [x] 第 7 章 上下文压缩
- [x] 第 8 章 记忆系统
- [x] 第 9 章 技能系统
- [x] 第 10 章 Plan Mode 只读模式
- [x] 第 11 章 多 Agent（Sub-Agent）
- [x] 第 12 章 MCP 集成（连接外部工具服务器）

## 运行

    node node_modules/typescript/bin/tsc   # 编译（Windows 下别直接用 .bin/tsc）
    node dist/cli.js "你的问题"            # 一次性提问
    node dist/cli.js                       # 交互式 REPL
    node dist/cli.js --resume              # 恢复上次会话
    node dist/cli.js --plan                # 只读（计划）模式

## 离线自测（不联网、不花钱）

    node tests/subagent.offline.test.mjs   # 第 11 章：子 Agent 只读隔离
    node tests/mcp.offline.test.mjs        # 第 12 章：MCP 握手 / 发现 / 路由

## MCP 配置

在项目根目录的 .mcp.json 里声明外部工具服务器，Agent 会在首次对话时自动连接：

    {
      "mcpServers": {
        "demo": { "command": "node", "args": ["tests/mcp-demo-server.mjs"] }
      }
    }

服务器提供的每个工具会以 mcp__<服务器名>__<工具名> 的名字挂进 Agent 的工具表。