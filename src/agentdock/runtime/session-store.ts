import { createId, nowIso } from "./id.js";
import type { AgentEvent, AgentMessage, AgentSession, AgentStatus } from "./types.js";

export class SessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(
    initialSessions: AgentSession[] = [],
    private readonly onChange: (sessions: AgentSession[]) => void = () => {},
  ) {
    for (const session of initialSessions) {
      this.sessions.set(session.id, {
        ...session,
        agent: session.agent ?? "codex",
        model: session.model ?? null,
        runnerId: session.runnerId ?? null,
        codexThreadId: session.codexThreadId ?? null,
        claudeSessionId: session.claudeSessionId ?? null,
        status: session.status === "running" ? "idle" : session.status,
      });
    }
  }

  list(): AgentSession[] {
    return [...this.sessions.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  create(): AgentSession {
    const now = nowIso();
    const session: AgentSession = {
      id: createId("sess"),
      title: "New conversation",
      agent: "codex",
      model: null,
      runnerId: null,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      codexThreadId: null,
      claudeSessionId: null,
      messages: [],
      events: [],
    };
    this.sessions.set(session.id, session);
    this.persist();
    return session;
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  setStatus(sessionId: string, status: AgentStatus): AgentSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.status = status;
    session.updatedAt = nowIso();
    this.persist();
    return session;
  }

  setCodexThreadId(sessionId: string, threadId: string): AgentSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.codexThreadId = threadId;
    session.updatedAt = nowIso();
    this.persist();
    return session;
  }

  setClaudeSessionId(sessionId: string, claudeSessionId: string): AgentSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.claudeSessionId = claudeSessionId;
    session.updatedAt = nowIso();
    this.persist();
    return session;
  }

  setRunner(sessionId: string, runnerId: string | null): AgentSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.runnerId = runnerId;
    session.updatedAt = nowIso();
    this.persist();
    return session;
  }

  setAgentSelection(sessionId: string, agent: AgentSession["agent"], model: string | null): AgentSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.agent = agent;
    session.model = model;
    session.updatedAt = nowIso();
    this.persist();
    return session;
  }

  addMessage(sessionId: string, message: Omit<AgentMessage, "id" | "createdAt">): AgentMessage {
    const session = this.require(sessionId);
    const next: AgentMessage = {
      id: createId("msg"),
      createdAt: nowIso(),
      ...message,
    };
    session.messages.push(next);
    if (message.role === "user" && session.title === "New conversation") {
      session.title = message.content.trim().slice(0, 42) || session.title;
    }
    session.updatedAt = next.createdAt;
    this.persist();
    return next;
  }

  addEvent(sessionId: string, event: Omit<AgentEvent, "id" | "sessionId" | "createdAt">): AgentEvent {
    const session = this.require(sessionId);
    const next: AgentEvent = {
      id: createId("evt"),
      sessionId,
      createdAt: nowIso(),
      ...event,
    };
    session.events.push(next);
    session.updatedAt = next.createdAt;
    this.persist();
    return next;
  }

  private persist(): void {
    this.onChange(this.list());
  }

  private require(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    return session;
  }
}
