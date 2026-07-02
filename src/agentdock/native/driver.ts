// 集成层：NativeAgentDriver 把原生 loop 适配成 AgentDriver。
//
// 载重不变量 #3：一切皆 Runner，driver 只是薄适配器。
// runTurn 将：构造 AnthropicModelClient + ToolRegistry(registerBuiltins) ->
// 调 runAgentLoop -> 把 LoopEvent 经 makeEvent 映射为 AgentEvent。

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { makeEvent } from "../adapters/shared.js";
// import type：DriverRegistry 只作类型注入引用。native → runtime/driver-registry 绝不做值导入，
// 否则会与 driver-registry.ts 对 NativeAgentDriver 的值导入形成运行时环（见架构坑 #2）。
import type { DriverRegistry } from "../runtime/driver-registry.js";
import type {
  AgentDriver,
  AgentEvent,
  AgentSession,
  ProviderConfig,
  RunnerRef,
  RunTurnInput,
} from "../runtime/types.js";
import { runAgentLoop } from "./loop.js";
import { McpManager, resolveMcpSpecs } from "./mcp/manager.js";
import { defaultPolicyConfig } from "./policy.js";
import type { PolicyMode } from "./policy.js";
import { AnthropicModelClient } from "./model.js";
import { SkillRegistry } from "./skills.js";
import type { DispatchFn } from "./tool.js";
import { ToolRegistry } from "./tool.js";
import { registerBuiltins } from "./tools/index.js";
import { createSkillTool } from "./tools/skill.js";
import { createTaskTool } from "./tools/task.js";
import type { ContentPart, Message } from "./types.js";

/** 原生 Agent 的系统提示：一个精炼的编码 agent 人设。 */
const SYSTEM_PROMPT = [
  "你是 AgentDock 的原生编码 Agent，一个能干、严谨的软件工程助手。",
  "你可以使用工具（bash、read、write、edit、grep、glob）在工作目录中探索和修改代码。",
  "工作方式：先用只读工具了解现状，再做最小、正确的改动；不要臆测文件内容。",
  "工具失败时读取其结构化输出并据此调整。任务完成后用简短的自然语言总结你做了什么。",
].join("\n");

/**
 * 解析技能根目录：优先 AGENTDOCK_SKILLS_DIR 环境变量，否则默认 <cwd>/.agentdock/skills。
 * 目录不存在时 SkillRegistry.discover 会静默视为「无技能」。
 */
function resolveSkillsRoot(cwd: string): string {
  const fromEnv = process.env["AGENTDOCK_SKILLS_DIR"]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(cwd, ".agentdock", "skills");
}

/**
 * 解析 L5 策略模式：读环境变量 AGENTDOCK_POLICY_MODE（auto|strict|readonly），
 * 缺省 / 非法值一律回落 "strict"（默认收紧）。
 */
function resolvePolicyMode(): PolicyMode {
  const raw = process.env["AGENTDOCK_POLICY_MODE"]?.trim().toLowerCase();
  if (raw === "auto" || raw === "strict" || raw === "readonly") return raw;
  return "strict";
}

/**
 * 组装系统提示：在基础人设后追加「技能广告」（仅 name + description）。
 * advertisement 为空串（无技能）时返回原始提示，保证无技能时行为不变。
 */
export function buildSystemPrompt(advertisement: string): string {
  return advertisement ? `${SYSTEM_PROMPT}\n\n${advertisement}` : SYSTEM_PROMPT;
}

export class NativeAgentDriver implements AgentDriver {
  /**
   * @param registry 供 task 工具派发子 agent 用的 DriverRegistry（构造注入 + import type，避免 import 环）。
   *   缺省（未注入）时不注册 task 工具、也不提供 dispatch，行为退化为「无子 agent 派发」。
   */
  constructor(private readonly registry?: DriverRegistry) {}

  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent> {
    const provider = input.provider;
    const model = input.model;

    // 守卫：缺 provider / model / apiKey 时直接吐错误事件（对齐 ApiAgentDriver）。
    if (!provider) {
      yield makeEvent(input, "error", "缺少 provider", "该原生 runner 没有解析到 provider 配置。", "failed");
      return;
    }
    if (!model) {
      yield makeEvent(input, "error", "缺少模型", "该原生 runner 没有指定模型。", "failed");
      return;
    }
    const apiKey = provider.apiKey?.trim();
    if (!apiKey) {
      yield makeEvent(
        input,
        "error",
        "缺少 API Key",
        `provider "${provider.id}" 未解析到密钥。请在设置里填写 apiKey 或配置 apiKeyEnv 指向的环境变量。`,
        "failed",
      );
      return;
    }

    // 构造 L0 客户端 + L2 工具注册表。
    const modelClient = new AnthropicModelClient({ provider });
    const registry = new ToolRegistry();
    const cwd = process.cwd();
    registerBuiltins(registry, { cwd });

    // L3 技能（渐进式披露）：从技能根目录发现技能。有技能才注册 skill 工具并把
    // 清单广告（仅 name + description）注入系统提示；无技能时行为与之前完全一致。
    const skills = new SkillRegistry(resolveSkillsRoot(cwd));
    await skills.discover();
    if (skills.list().length > 0) {
      registry.register(createSkillTool(skills));
    }
    const system = buildSystemPrompt(skills.advertisement());

    // L2 MCP（可选）：从环境解析 MCP server 规格并把其工具归一化注册进 registry。
    // 无配置（resolveMcpSpecs 返回空）时完全不启动子进程，零影响；有配置时按 server 错误隔离，
    // 单个 server 挂掉只是少几个工具，绝不拖垮本轮。turn 结束在 finally 里统一 stop。
    const mcpSpecs = resolveMcpSpecs();
    // mcp 句柄声明在 try 之外，好让 finally 能在任意退出路径（正常收尾 / 异常 / 被消费者 .return() 中止）访问并 stop；
    // 但真正 spawn 子进程的 start() 与其后的首个 yield 必须放进 try 内（见下），否则一旦生成器在该 yield 处被 .return()，
    // 就会绕过 finally，泄漏已 spawn 的 MCP 子进程。
    let mcp: McpManager | undefined;

    const messages = buildNativeMessages(input);

    // L6 子 agent 派发：仅当注入了 DriverRegistry 时启用 task 工具（否则 dispatch 无从解析子 driver）。
    // depth 从入参透传（根 turn 无 depth -> 0）；子会话由 dispatch 以 depth+1 续接，交给 task 工具封顶。
    const depth = input.depth ?? 0;
    let dispatch: DispatchFn | undefined;
    if (this.registry) {
      dispatch = this.dispatchFor(input, provider, model);
      registry.register(createTaskTool());
    }

    const label = input.sourceLabel ?? `${provider.label ?? provider.id} · ${model} · 原生`;

    try {
      // MCP 子进程在 try 内 spawn：从这一刻起，任何退出路径（异常 / 被 .return() / 正常收尾）都会命中下方
      // finally 的 mcp.stop()。start() 自身做错误隔离不 throw；registerInto 仅把工具挂进 registry，无副作用需回滚。
      if (mcpSpecs.length > 0) {
        mcp = new McpManager(mcpSpecs);
        await mcp.start();
        mcp.registerInto(registry);
      }

      // lifecycle「开始」事件同样放进 try：消费者在该事件上抛错或提前 break 会触发生成器 .return()，
      // 唯有此 yield 身处 try 内，才能保证已 spawn 的 MCP 在 finally 里被 stop（本文件对「统一 stop」的承诺）。
      yield makeEvent(input, "lifecycle", `${label} 开始`, "原生 Agent 循环启动。", "started");

      const loop = runAgentLoop({
        model: modelClient,
        registry,
        system,
        messages,
        modelId: model,
        cwd,
        sessionId: input.session.id,
        signal: input.signal,
        depth,
        dispatch,
        // L5 真实策略：工作区围栏基准 = 本轮 cwd，模式可由环境覆盖（默认 strict）。
        // 闸门在 loop：reject 硬拦、ask 走 ctx.ask（headless 下 loop 兜底自动放行，真实审批 UI 为后续接缝）。
        policy: defaultPolicyConfig(cwd, { mode: resolvePolicyMode() }),
      });

      // 累积缓冲：不逐 delta 落库（对齐 ApiAgentDriver，避免事件存储膨胀与时间线碎片）。
      // 仅在“助手开始调用工具”或“本轮收尾”时，把累积文本/思考作为单条 completed 事件下发。
      let textBuffer = "";
      let thinkingBuffer = "";
      // flush：把缓冲区内容作为整块 completed 事件吐出并清空（无内容则不吐）。
      const flush = function* (): Generator<AgentEvent> {
        if (thinkingBuffer.trim()) {
          yield makeEvent(input, "reasoning", "思考", thinkingBuffer, "completed");
        }
        if (textBuffer.trim()) {
          yield makeEvent(input, "message", input.sourceLabel ?? "回复", textBuffer, "completed");
        }
        textBuffer = "";
        thinkingBuffer = "";
      };

      for await (const ev of loop) {
        switch (ev.kind) {
          case "assistant_text": {
            // 流式文本增量：仅累积，不逐块落库。
            textBuffer += ev.text;
            break;
          }
          case "thinking": {
            // 流式思考增量：仅累积，不逐块落库。
            thinkingBuffer += ev.text;
            break;
          }
          case "tool_start": {
            // 助手在开始动手前已产出的文本/思考，作为整块 completed 先行落库。
            yield* flush();
            yield makeEvent(
              input,
              "tool",
              `调用工具 ${ev.name}`,
              safeStringify(ev.args),
              "started",
              ev.name,
            );
            break;
          }
          case "tool_end": {
            yield makeEvent(
              input,
              "tool",
              `工具 ${ev.name} ${ev.isError ? "失败" : "完成"}`,
              ev.output,
              ev.isError ? "failed" : "completed",
              ev.name,
            );
            break;
          }
          case "usage": {
            yield makeEvent(input, "usage", "Token usage", safeStringify(ev.usage), "completed");
            break;
          }
          case "error": {
            // 出错前先把已累积的文本/思考整块落库，避免丢失部分产出。
            yield* flush();
            yield makeEvent(input, "error", "原生 Agent 错误", ev.message, "failed");
            break;
          }
          case "done": {
            // 收尾：把累积缓冲整块作为 completed 落库（内容即等价于 ev.finalText，无需重复）。
            yield* flush();
            break;
          }
          default: {
            // 穷尽联合；未知种类忽略。
            break;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield makeEvent(input, "error", "原生 Agent 异常", message, "failed");
    } finally {
      // 无论正常收尾还是异常/中止，都关闭本轮启动的 MCP 子进程，避免僵尸进程泄漏。
      if (mcp) {
        await mcp.stop();
      }
    }
  }

  /**
   * 构造本轮的子 agent 派发能力（供 task 工具经 ctx.dispatch 调用）。
   * 流程：定位子 RunnerRef（缺省=同模型 native）-> DriverRegistry.resolve 拿子 driver ->
   * 造一个全新子会话的 RunTurnInput（depth 由 task 工具透传）-> 跑子 driver.runTurn 并流式回吐 AgentEvent。
   * 解析失败（如 orchestrator / 未配置 provider）时吐一个 error 事件，由 task 工具转成结构化错误。
   */
  private dispatchFor(input: RunTurnInput, provider: ProviderConfig, model: string): DispatchFn {
    const registry = this.registry;
    return async function* (ref, prompt, opts): AsyncGenerator<AgentEvent> {
      // 缺省 runner = 与当前完全相同的原生 runner（同 provider + 同 model）。
      const childRef: RunnerRef = ref ?? { kind: "native", provider: provider.id, model };
      if (!registry) {
        yield makeEvent(input, "error", "子 agent 派发不可用", "driver 未注入 DriverRegistry。", "failed");
        return;
      }
      const resolved = registry.resolve(childRef);
      if (resolved.error || !resolved.driver) {
        yield makeEvent(input, "error", "子 runner 解析失败", resolved.error ?? "未知错误", "failed");
        return;
      }
      const childModel = "model" in childRef ? childRef.model : undefined;
      const childInput: RunTurnInput = {
        session: makeChildSession(input, childRef, opts.description),
        content: prompt,
        runner: childRef,
        provider: resolved.provider,
        model: childModel,
        signal: input.signal,
        depth: opts.depth,
        group: input.group,
        sourceLabel: opts.description ? `子任务 · ${opts.description}` : "子任务",
      };
      yield* resolved.driver.runTurn(childInput);
    };
  }
}

/** 造一个全新的、临时的子会话（不入库，仅供子 driver 内部使用；id 随机避免与主会话混淆）。 */
function makeChildSession(parent: RunTurnInput, ref: RunnerRef, description?: string): AgentSession {
  const now = new Date().toISOString();
  return {
    id: `sub_${randomUUID().replaceAll("-", "").slice(0, 18)}`,
    title: description ?? "子任务",
    agent: parent.session.agent,
    model: "model" in ref ? ref.model : null,
    runnerId: null,
    status: "running",
    createdAt: now,
    updatedAt: now,
    codexThreadId: null,
    claudeSessionId: null,
    messages: [],
    events: [],
  };
}

/** 把会话历史 + 本次输入转成 canonical Message[]（system 单独走 opts.system）。 */
function buildNativeMessages(input: RunTurnInput): Message[] {
  const messages: Message[] = [];
  for (const message of input.session.messages) {
    if (message.role === "user" || message.role === "assistant") {
      const part: ContentPart = { type: "text", text: message.content };
      messages.push({ role: message.role, content: [part] });
    }
  }
  // 确保最后一轮是本次用户输入（历史里可能已包含，也可能尚未落库）。
  const last = messages[messages.length - 1];
  const lastText = last && last.content[0]?.type === "text" ? last.content[0].text : null;
  if (!last || last.role !== "user" || lastText !== input.content) {
    messages.push({ role: "user", content: [{ type: "text", text: input.content }] });
  }
  return messages;
}

/** 安全序列化任意值供事件展示。 */
function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
