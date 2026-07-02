import { errorMessage } from "../adapters/shared.js";
import type { ProviderStore } from "../config/provider-store.js";
import { OrchestratorDriver } from "./agents/orchestrator.js";
import type { DriverRegistry } from "./driver-registry.js";
import { EventBus } from "./event-bus.js";
import { SessionStore } from "./session-store.js";
import { decodeRunner } from "./types.js";
import type { AgentDriver, AgentEvent, AgentSession, ProviderConfig, RunTurnInput, RunnerOption } from "./types.js";

type ListRunners = () => Promise<RunnerOption[]>;

type SendMessageOptions = {
  /** 选中的 runner id（编排 / cli / api）；缺省时回退到会话上次选择。 */
  runnerId?: string;
  /** 仅对 CLI runner 生效（api runner 的模型已在 ref 里）。 */
  model?: string;
};

export class AgentService {
  private readonly controllers = new Map<string, AbortController>();
  private orchestrator?: OrchestratorDriver;

  constructor(
    private readonly store: SessionStore,
    private readonly bus: EventBus,
    private readonly providerStore: ProviderStore,
    private readonly registry: DriverRegistry,
    private readonly listRunners: ListRunners,
  ) {}

  createSession(): AgentSession {
    return this.store.create();
  }

  listSessions(): AgentSession[] {
    return this.store.list();
  }

  getSession(id: string): AgentSession | undefined {
    return this.store.get(id);
  }

  subscribe(
    sessionId: string,
    listener: (event: AgentEvent | { type: "session.updated"; session: AgentSession }) => void,
  ): () => void {
    return this.bus.subscribe(sessionId, listener);
  }

  async sendMessage(sessionId: string, content: string, options: SendMessageOptions = {}): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error("会话不存在");
    }
    if (session.status === "running") {
      throw new Error("当前会话仍在运行中");
    }

    const runnerId = options.runnerId ?? session.runnerId;
    const ref = decodeRunner(runnerId);
    if (!runnerId || !ref) {
      throw new Error("未选择 runner");
    }
    this.store.setRunner(sessionId, runnerId);

    this.store.addMessage(sessionId, { role: "user", content });
    this.publishSession(sessionId);

    // 解析 driver（编排单独特判）
    let driver: AgentDriver;
    let provider: ProviderConfig | undefined;
    if (ref.kind === "orchestrator") {
      driver = this.getOrchestrator();
    } else {
      const resolved = this.registry.resolve(ref);
      if (!resolved.driver) {
        const failure = this.store.addEvent(sessionId, {
          kind: "error",
          title: "无法解析 runner",
          body: resolved.error ?? "未知错误",
          status: "failed",
        });
        this.bus.publish(sessionId, failure);
        this.store.setStatus(sessionId, "failed");
        this.publishSession(sessionId);
        return;
      }
      driver = resolved.driver;
      provider = resolved.provider;
    }

    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    this.store.setStatus(sessionId, "running");
    this.publishSession(sessionId);

    try {
      const runSession = this.store.get(sessionId) ?? session;
      const runInput: RunTurnInput = {
        session: runSession,
        content,
        runner: ref,
        provider,
        model: ref.kind === "api" || ref.kind === "native" ? ref.model : options.model?.trim() || undefined,
        signal: controller.signal,
      };

      for await (const event of driver.runTurn(runInput)) {
        const storedEvent = this.store.addEvent(sessionId, {
          kind: event.kind,
          title: event.title,
          body: event.body,
          status: event.status,
          rawType: event.rawType,
          source: event.source,
          group: event.group,
        });
        // 落库规则：仅无 group 的 completed message 才转成 assistant 气泡
        if (
          storedEvent.kind === "message" &&
          storedEvent.status === "completed" &&
          !storedEvent.group &&
          storedEvent.body.trim()
        ) {
          this.store.addMessage(sessionId, { role: "assistant", content: storedEvent.body });
        }
        if (storedEvent.rawType === "thread.started" && storedEvent.body.trim()) {
          this.store.setCodexThreadId(sessionId, storedEvent.body.trim());
        }
        if (storedEvent.rawType === "claude.session" && storedEvent.body.trim()) {
          this.store.setClaudeSessionId(sessionId, storedEvent.body.trim());
        }
        this.bus.publish(sessionId, storedEvent);
        this.publishSession(sessionId);
      }
      this.store.setStatus(sessionId, "idle");
    } catch (error) {
      const storedEvent = this.store.addEvent(sessionId, {
        kind: "error",
        title: "运行失败",
        body: errorMessage(error),
        status: "failed",
      });
      this.bus.publish(sessionId, storedEvent);
      this.store.setStatus(sessionId, "failed");
    } finally {
      this.controllers.delete(sessionId);
      this.publishSession(sessionId);
    }
  }

  stop(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId);
    if (!controller) {
      return false;
    }
    controller.abort();
    this.controllers.delete(sessionId);
    this.store.setStatus(sessionId, "idle");
    this.publishSession(sessionId);
    return true;
  }

  private getOrchestrator(): OrchestratorDriver {
    if (!this.orchestrator) {
      this.orchestrator = new OrchestratorDriver(this.registry, this.listRunners);
    }
    return this.orchestrator;
  }

  private publishSession(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (session) {
      this.bus.publish(sessionId, { type: "session.updated", session });
    }
  }
}
