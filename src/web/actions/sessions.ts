import { api } from "../api.js";
import { JSON_HEADERS, currentRunner, currentSession, state } from "../state.js";
import type { AgentSession } from "../types.js";

export type SessionActionHooks = {
  render(): void;
  selectSession(id: string | null): void;
};

let hooks: SessionActionHooks;

export function setSessionActionHooks(next: SessionActionHooks): void {
  hooks = next;
}

/** 创建新会话并立即选中。 */
export async function createSession(): Promise<void> {
  const created = await api<{ session: AgentSession }>("/api/sessions", { method: "POST" });
  state.sessions.unshift(created.session);
  hooks.selectSession(created.session.id);
  hooks.render();
}

/** 发送用户消息；真正的流式回填通过 SSE 处理。 */
export async function sendMessage(input: HTMLTextAreaElement | null): Promise<void> {
  const session = currentSession();
  const content = input?.value.trim() ?? "";
  if (!session || !content) {
    return;
  }
  const runner = currentRunner();
  if (!runner?.available) {
    return;
  }
  if (input) {
    input.value = "";
  }
  state.draft = "";
  await api(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      content,
      runner: runner.id,
      model: runner.backend === "cli" ? state.cliModel || undefined : undefined,
    }),
  });
}
