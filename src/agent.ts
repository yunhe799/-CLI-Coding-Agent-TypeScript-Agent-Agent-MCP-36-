import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, executeTool } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { checkPermission } from "./permissions.js";
import { maybeCompact } from "./context.js";
import { recallMemories } from "./memory.js";
import { runSubAgent } from "./subagent.js";
import { McpManager } from "./mcp.js";
import {
  goalDirective, GOAL_EVALUATOR_SYSTEM, GOAL_TRANSCRIPT_FRAMING, goalJudgeUserMessage,
  parseGoalVerdict, GOAL_MAX_ITERATIONS, type GoalVerdict,
  parseLoopInput, isDailyWording, OFFER_CLOUD_THRESHOLD_SECONDS, type LoopSpec,
  SCHEDULE_WAKEUP_TOOL, clampWakeupDelay, dynamicLoopDirective, LOOP_MAX_ITERATIONS,
  loadAutoModeRules, buildClassifierSystem, AUTO_MODE_FAST_PATH_TOOLS, DENIAL_LIMITS,
  buildClassifierTranscript, parseBlockVerdict, classifierUserMessage,
} from "./autonomy.js";

const MODEL = process.env.MINI_MODEL || "claude-sonnet-4-5-20250929";

// 整个 Agent 就是一个类：一个不断变长的消息数组 + 一个循环。
export class Agent {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  // ── 第 10 章新增：运行模式。"plan" 表示只读模式 ──
  mode = "default";
  // ── 第 12 章新增：外部工具（MCP）管理器 ──
  private mcp = new McpManager();
  private mcpReady = false;
  // ── 第 15 章新增：自治与续跑的状态 ──
  private activeGoal: { condition: string; iterations: number; lastReason?: string; startedAt: number } | null = null;
  private pendingWakeup: { delaySeconds: number; reason: string; prompt: string } | null = null;
  private scheduleWakeupEnabled = false;   // 只在 dynamic loop 期间为 true
  private loopStop = false;
  private goalStop = false;
  // Auto Mode：连续/累计拒绝计数（达上限就退回人工确认）
  private autoConsecutiveDenials = 0;
  private autoTotalDenials = 0;
  // ── 第 4 周新增：token 用量累计（评测报告要算平均 token 与成本）──
  usage = { inputTokens: 0, outputTokens: 0, apiCalls: 0 };

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // 指向 Anthropic 兼容的服务（我们用的是 DeepSeek 的兼容接口）
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
  }

  // ── 第 4 章新增：把对话历史开放给外面，好让 CLI 保存和恢复 ──
  history(): Anthropic.MessageParam[] {
    return this.messages;
  }

  loadHistory(messages: Anthropic.MessageParam[]): void {
    this.messages = messages;
  }

  clearHistory(): void {
    this.messages = [];
  }

  setMode(m: string): void {
    this.mode = m;
  }

  // 一次用户输入 = 一次 chat。
  // 调用模型 → 如果它要工具就执行 → 把结果喂回去 → 再调用，直到模型给出纯文本回答。
  async chat(userText: string): Promise<void> {
    this.messages.push({ role: "user", content: userText });
    // ── 第 12 章新增：真正用到时才连 MCP 服务器（懒加载）──
    // 只是想问句快问题的话，就不用付"启动 MCP 子进程"的代价。
    await this.ensureMcp();

    while (true) {
      // ── 第 7 章的变化：每次调用模型之前，先看历史是不是太长了 ──
      // 太长就把较早的消息压缩成一条摘要。
      this.messages = await maybeCompact(this.messages, this.client, MODEL);

      // 提示词不再是写死的一句话，而是由 prompt.ts 组装出来（静态规则 + 当前环境信息）。
      let system = buildSystemPrompt();
      // ── 第 8 章的变化：把和这次提问相关的记忆召回进提示词 ──
      system += recallMemories(userText);

      // ── 第 12 章新增：把外部 MCP 工具并进工具表 ──
      // 对模型来说它们和内置工具长得一模一样，只是名字带 mcp__ 前缀。
      const mcpTools: Anthropic.Tool[] = this.mcp.getToolDefinitions().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
      const tools: Anthropic.Tool[] = [...toolDefinitions, ...mcpTools];
      // ── 第 15 章新增：dynamic loop 期间才把 schedule_wakeup 挂进工具表 ──
      // 主模型靠它自己排下一次；不调它就说明活干完了，loop 收敛。
      if (this.scheduleWakeupEnabled) tools.push(SCHEDULE_WAKEUP_TOOL as unknown as Anthropic.Tool);

      const request = {
        model: MODEL,
        max_tokens: 4096,
        system,
        tools, // 这一行让模型"知道"有哪些工具可用（内置的 + MCP 的）
        messages: this.messages,
      };

      // ── 第 5 章的变化：流式输出 ──
      // 以前是 create() 等模型把整段话都写完再一次性打印（屏幕空白好几秒）。
      // 现在改成 stream()：模型每吐出一小段文字，就立刻打印出来。
      // 最后用 finalMessage() 取回完整消息 —— 它的结构和不流式调用完全一样，
      // 所以后面的代码一行都不用改。
      const stream = this.client.messages.stream(request);
      stream.on("text", (t) => process.stdout.write(t));
      const reply = await stream.finalMessage();
      process.stdout.write("\n");
      // 累计用量（假模型客户端没有 usage，按 0 处理）
      this.usage.inputTokens += (reply as any).usage?.input_tokens ?? 0;
      this.usage.outputTokens += (reply as any).usage?.output_tokens ?? 0;
      this.usage.apiCalls++;

      // 把模型的完整回复（文字 + 工具调用）记进消息历史
      this.messages.push({ role: "assistant", content: reply.content });

      const toolUses = reply.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      // ★ 循环的出口：模型没有要求调用任何工具，说明这一轮的事情做完了
      if (toolUses.length === 0) return;

      // 执行所有被请求的工具，把结果作为一条 user 消息发回去
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        console.log(`  → ${tu.name}(${JSON.stringify(tu.input)})`);

        // ── 第 15 章新增：schedule_wakeup → 记下来给 loop 驱动读 ──
        if (tu.name === "schedule_wakeup") {
          const output = this.scheduleWakeupEnabled
            ? this.executeScheduleWakeup(tu.input as Record<string, any>)
            : "schedule_wakeup is only available during /loop dynamic mode.";
          results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
          continue;
        }

        // ── 第 11 章新增：agent 工具 → 派一个只读子 Agent ──
        // 子 Agent 有自己独立的上下文，只有结论会回到主对话里，
        // 中间读了什么、翻了多少文件，主对话完全不知道。
        if (tu.name === "agent") {
          const summary = await runSubAgent(String((tu.input as any).task || ""), this.client, MODEL);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: summary });
          continue;
        }

        // ── 第 12 章新增：mcp__<服务器>__<工具> 转发给对应的 MCP 服务器 ──
        // 一行判断、一行转发——MCP 工具对主循环完全透明。
        if (this.mcp.isMcpTool(tu.name)) {
          let output: string;
          try {
            output = await this.mcp.callTool(tu.name, tu.input as Record<string, any>);
          } catch (e: any) {
            output = `MCP call failed: ${e.message}`;
          }
          results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
          continue;
        }

        // ── 第 15 章新增：Auto Mode —— 用一个分类器代替"问人" ──
        // 只读工具走 fast-path 直接放行；其余（写文件/改文件/跑命令/派子 Agent/
        // MCP 工具）交给分类器读一段脱敏记录来判。
        if (this.mode === "auto" && !AUTO_MODE_FAST_PATH_TOOLS.has(tu.name)) {
          const verdict = await this.classifyToolCall(tu.name, tu.input as Record<string, any>);
          if (verdict.action !== "allow") {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `Blocked by auto-mode monitor: ${verdict.message}`,
            });
            continue;
          }
        }

        // ── 第 10 章的变化：在权限闸门之上，再加一层"计划模式"约束 ──
        // plan 模式下，写文件、改文件、跑命令一律拒绝 —— 只能读和思考。
        // 被拒绝的调用根本不会被执行，模型只会收到一条"被拦下了"的结果。
        const blocked =
          checkPermission(tu.name, tu.input as Record<string, any>) === "deny" ||
          (this.mode === "plan" &&
            (tu.name === "write_file" || tu.name === "edit_file" || tu.name === "run_shell"));
        const output = blocked
          ? `Denied: ${tu.name} was blocked (${this.mode} mode).`
          : await executeTool(tu.name, tu.input as Record<string, any>);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }
      this.messages.push({ role: "user", content: results });
    }
  }

  // ══ 第 15 章新增：/goal —— 用独立评估器把一个条件追到底 ══

  /** 设目标，返回第一个 turn 的注入语。 */
  setGoal(condition: string): string {
    this.activeGoal = { condition, iterations: 0, startedAt: Date.now() };
    console.log(`◎ /goal active — Stop hook condition: "${condition}"`);
    return goalDirective(condition);
  }

  /** `/goal` 不带参数时打印当前目标的状态。 */
  showGoal(): void {
    if (!this.activeGoal) {
      console.log("No active goal. Set one with /goal <condition>.");
      return;
    }
    const secs = ((Date.now() - this.activeGoal.startedAt) / 1000).toFixed(1);
    const last = this.activeGoal.lastReason ? `\n  last reason: ${this.activeGoal.lastReason}` : "";
    console.log(
      `◎ /goal active\n  condition: ${this.activeGoal.condition}\n  iterations: ${this.activeGoal.iterations}\n  elapsed: ${secs}s${last}`,
    );
  }

  /** 追目标：跑第一个 turn，然后不停「评估 → 没达成就把原因回灌 → 再跑一个 turn」，
   *  直到达成 / 判不可能 / 撞上迭代上限 / 被中断。 */
  async pursueGoal(directive: string): Promise<void> {
    if (!this.activeGoal) return;
    this.goalStop = false;
    try {
      await this.chat(directive);
      // 先评估刚跑完的这个 turn，再去决定要不要放行下一个 turn——
      // 这样最后一个 turn 的产出永远不会没被判过就被上限截断。
      while (this.activeGoal && !this.goalStop) {
        const verdict = await this.evaluateGoal(this.activeGoal.condition);
        if (verdict.ok) {
          const turns = this.activeGoal.iterations + 1;
          const secs = ((Date.now() - this.activeGoal.startedAt) / 1000).toFixed(1);
          console.log(`✓ Goal achieved (${turns} turn${turns === 1 ? "" : "s"}, ${secs}s): ${verdict.reason}`);
          break;
        }
        if (verdict.impossible) {
          console.log(`Hooks: Prompt hook condition judged impossible: ${verdict.reason}`);
          break;
        }
        // 没达成：记下来，再决定还允不允许跑下一个 turn
        this.activeGoal.iterations++;
        this.activeGoal.lastReason = verdict.reason;
        console.log(`Hooks: Prompt hook condition was not met: ${verdict.reason}`);
        // 硬顶：条件永远不满足、评估器又没喊 impossible 时，靠它终止
        if (this.activeGoal.iterations >= GOAL_MAX_ITERATIONS) {
          console.log(`Goal stopped: reached ${GOAL_MAX_ITERATIONS} iterations without meeting the condition.`);
          break;
        }
        if (this.goalStop) break;
        await this.chat(`Hooks: Prompt hook condition was not met: ${verdict.reason}\n\nKeep working toward the goal.`);
      }
      if (this.goalStop) console.log("Goal pursuit interrupted.");
    } finally {
      // 任何出口（达成 / 不可能 / 撞顶 / 中断）都清掉，免得留下一个过期的目标
      this.activeGoal = null;
    }
  }

  /** 一次评估。记录作为**独立的 assistant 消息**发出（前面用一条 user 消息框定
   *  "这是待判的数据"），这样被判的那个 turn 没法伪造出假的 user/判定文本来污染
   *  评估器。 */
  private async evaluateGoal(condition: string): Promise<GoalVerdict> {
    const transcript = this.transcriptText();
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: GOAL_TRANSCRIPT_FRAMING },
      { role: "assistant", content: transcript || "(no assistant output)" },
      { role: "user", content: goalJudgeUserMessage(condition) },
    ];
    try {
      return parseGoalVerdict(await this.sideQuery(GOAL_EVALUATOR_SYSTEM, messages, 512));
    } catch (e: any) {
      // 评估器出错 → 判"没达成"（绝不能因为评估器坏了就把目标误清掉）
      return { ok: false, reason: `evaluator error: ${e?.message ?? e}` };
    }
  }

  /** 旁路查询：一次不流式的独立调用，专给评估器/分类器用（它们只判断，不干活）。 */
  private async sideQuery(system: string, messages: Anthropic.MessageParam[], maxTokens: number): Promise<string> {
    const resp = await this.client.messages.create({
      model: MODEL, max_tokens: maxTokens, temperature: 0, system, messages,
    });
    return resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  }

  /** 把消息数组渲染成一段记录文本。 */
  private transcriptText(): string {
    return this.messages
      .map((m) => {
        if (typeof m.content === "string") return `${m.role}: ${m.content}`;
        const parts = (m.content as any[])
          .map((b: any) =>
            b.type === "text" ? b.text : b.type === "tool_use" ? `[tool_use ${b.name}]` : "[tool result]",
          )
          .join(" ");
        return `${m.role}: ${parts}`;
      })
      .join("\n");
  }

  // ══ 第 15 章新增：/loop —— 定时重投，或让主模型自己排下一次 ══

  /** `/loop` 的入口：解析输入，再按模式驱动。输入不合法就直接返回、不循环。 */
  async runLoop(rawInput: string): Promise<void> {
    const spec = parseLoopInput(rawInput);
    if ("error" in spec) {
      console.log(spec.error);
      return;
    }
    // 决策点：间隔 ≥ 60 分钟、或"每天"这类措辞时，真实 Claude Code 会问要不要
    // 转成"关了会话也能跑"的云端 schedule。我们没有云端，只把这个点显式说出来。
    const wantsCloud =
      (spec.mode === "interval" && spec.intervalSeconds! >= OFFER_CLOUD_THRESHOLD_SECONDS) ||
      isDailyWording(rawInput);
    if (wantsCloud) {
      console.log("(真实 Claude Code 会在这里问你要不要转成云端 schedule——那样关了会话也能继续跑。这份教学实现没有云端，继续留在会话内。)");
    }
    this.loopStop = false;
    if (spec.mode === "interval") await this.runLoopInterval(spec);
    else await this.runLoopDynamic(spec);
  }

  /** interval 模式：每 N 秒重投一次 prompt，直到撞上限或被打断。
   *  （真实 Claude Code 走的是会话内的 CronCreate；这里用普通定时器代替。） */
  private async runLoopInterval(spec: LoopSpec): Promise<void> {
    console.log(`⟳ /loop 每 ${spec.intervalLabel} 跑一次（只在本次会话内，进程退出就没了）。Ctrl+C 停止。`);
    let iterations = 0;
    while (!this.loopStop) {
      iterations++;
      console.log(`⟳ loop tick ${iterations}`);
      await this.chat(spec.prompt);
      if (iterations >= LOOP_MAX_ITERATIONS) {
        console.log(`Loop stopped: reached ${LOOP_MAX_ITERATIONS} ticks.`);
        break;
      }
      if (await this.interruptibleSleep(spec.intervalSeconds! * 1000)) {
        console.log("Loop stopped.");
        break;
      }
    }
  }

  /** dynamic 模式：跑一拍，然后让主模型用 schedule_wakeup 自己排下一次。
   *  排了就等（夹逼后的）延迟再跑，prompt 用它传回来的那个；没排就说明它认为
   *  活干完了，loop 干净收敛。schedule_wakeup 只在 loop 期间暴露。 */
  private async runLoopDynamic(spec: LoopSpec): Promise<void> {
    console.log("⟳ /loop dynamic（自定节奏）—— 由模型自己排下一次，或者结束循环。Ctrl+C 停止。");
    this.scheduleWakeupEnabled = true;
    let prompt = spec.prompt;
    let iterations = 0;
    try {
      while (!this.loopStop) {
        iterations++;
        this.pendingWakeup = null;
        await this.chat(dynamicLoopDirective(prompt));
        if (!this.pendingWakeup) {
          console.log(`⟳ Loop converged after ${iterations} tick${iterations === 1 ? "" : "s"}（模型没有排下一次）。`);
          break;
        }
        if (iterations >= LOOP_MAX_ITERATIONS) {
          console.log(`Loop stopped: reached ${LOOP_MAX_ITERATIONS} ticks.`);
          break;
        }
        const { delaySeconds, reason, prompt: nextPrompt } = this.pendingWakeup;
        console.log(`⟳ next run in ${delaySeconds}s — ${reason}`);
        prompt = nextPrompt || prompt;
        if (await this.interruptibleSleep(delaySeconds * 1000)) {
          console.log("Loop stopped.");
          break;
        }
      }
    } finally {
      // 收尾：把 schedule_wakeup 摘掉，loop 之外不再暴露
      this.scheduleWakeupEnabled = false;
      this.pendingWakeup = null;
    }
  }

  /** schedule_wakeup 的执行器：把这次唤醒记下来给 loop 驱动读。 */
  private executeScheduleWakeup(input: Record<string, any>): string {
    const delaySeconds = clampWakeupDelay(Number(input.delaySeconds));
    const reason = typeof input.reason === "string" ? input.reason : "";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    this.pendingWakeup = { delaySeconds, reason, prompt };
    return `Wakeup scheduled in ${delaySeconds}s. The loop will resume then; end your turn now.`;
  }

  /** 可以被打断的 sleep：loop 被停掉就提前返回 true，不会卡在一个长间隔上。 */
  private interruptibleSleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (this.loopStop) return resolve(true);
        if (Date.now() - start >= ms) return resolve(false);
        setTimeout(tick, Math.min(200, ms));
      };
      tick();
    });
  }

  /** 停掉正在跑的 /loop 和 /goal 追索（CLI 的 Ctrl+C 处理器调它）。 */
  stopLoops(): void {
    this.loopStop = true;
    this.goalStop = true;
  }

  // ══ 第 15 章新增：Auto Mode —— 脱敏记录分类器 ══

  /** 在 auto 模式下判一次工具调用。硬底线（deny 规则）仍前置；只读工具走
   *  fast-path；其余走两段式：第一段激进廉价闸（不看用户意图、不认 ALLOW 例外），
   *  第一段拦了才进第二段审慎裁决（会权衡用户意图、能解除拦截）。 */
  private async classifyToolCall(
    toolName: string,
    input: Record<string, any>,
  ): Promise<{ action: "allow" | "deny"; message: string }> {
    // 硬底线先行：deny 规则在 Auto Mode 里照样拦
    if (checkPermission(toolName, input) === "deny") {
      return { action: "deny", message: `deny rule matched for ${toolName}` };
    }
    if (AUTO_MODE_FAST_PATH_TOOLS.has(toolName)) return { action: "allow", message: "" };

    let verdict: { block: boolean; reason: string };
    try {
      const rules = loadAutoModeRules();
      const transcript = buildClassifierTranscript(this.messages as any, { toolName, input });
      const system = buildClassifierSystem(rules);
      // 第一段：激进廉价闸（token 预算小，只吐 <block>…）
      const s1 = parseBlockVerdict(
        await this.sideQuery(system, [{ role: "user", content: classifierUserMessage(rules, transcript, rules.suffix_stage1) }], 256),
      );
      verdict = s1.block
        // 第二段：审慎裁决（会发 <thinking>，预算更大）
        ? parseBlockVerdict(
            await this.sideQuery(system, [{ role: "user", content: classifierUserMessage(rules, transcript, rules.suffix_stage2) }], 1024),
          )
        : s1; // 第一段就放行 → 一次调用搞定
    } catch (e: any) {
      // 任何出错都 fail closed（判拦截）：绝不让一个没被判过的动作跑掉
      verdict = { block: true, reason: `classifier error: ${e?.message ?? e}` };
    }

    if (!verdict.block) {
      this.autoConsecutiveDenials = 0;
      return { action: "allow", message: "" };
    }
    this.autoConsecutiveDenials++;
    this.autoTotalDenials++;
    if (
      this.autoConsecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
      this.autoTotalDenials >= DENIAL_LIMITS.maxTotal
    ) {
      // 拦得太频繁，分类器可能卡住了。真实 Claude Code 在这里退回人工确认；
      // 我们是一次性/REPL 的 CLI，没有确认框，所以维持拦截（headless 语义）。
      console.log("Auto Mode: denial limit reached — handing back to manual confirmation.");
      return { action: "deny", message: `${verdict.reason} (denial limit reached — 需要人工确认)` };
    }
    return { action: "deny", message: verdict.reason };
  }

  // ── 第 12 章新增：懒连接 MCP，连不上也不影响内置工具 ──
  private async ensureMcp(): Promise<void> {
    if (this.mcpReady) return;
    this.mcpReady = true;
    try {
      await this.mcp.loadAndConnect();
    } catch (err: any) {
      console.error(`[mcp] init failed: ${err.message}`);
    }
  }

  /** 关掉 MCP 子进程。进程退出前必须调用，否则 Node 不会自己退出。 */
  async shutdown(): Promise<void> {
    await this.mcp.disconnectAll();
  }
}
