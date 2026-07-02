import { api } from "./api.js";
import { refreshRunners } from "./actions/runners.js";
import { attachDelegatedListeners, setRenderHooks } from "./events.js";
import { icon } from "./icons.js";
import { renderConversationPage, renderStatusbar, sessionListItem } from "./render/conversation.js";
import { renderSettingsPage } from "./render/settings.js";
import { renderTimeline } from "./render/timeline.js";
import { APP_VERSION, currentSession, ensureRunnerSelection, state, upsertSession } from "./state.js";
import type { AgentEvent, AgentSession } from "./types.js";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("app root not found");
}
const appRoot = app;

// —— 渲染管线：稳定外壳与增量刷新 ——
let shellMounted = false;
let frameHandle: number | null = null;

// 开机挂载一次的稳定引用（workspace 内容可重建，外壳和委托监听不重复挂载）。
let shellEl!: HTMLElement;
let navConversationBtn!: HTMLElement;
let openSettingsBtn!: HTMLElement;
let conversationListEl!: HTMLElement;
let workspaceEl!: HTMLElement;

// 会话页区域引用：会话页结构重建后刷新，设置页时置 null。
let timelineEl: HTMLElement | null = null;
let statusbarEl: HTMLElement | null = null;
let composerTextarea: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;

setRenderHooks({
  render,
  scheduleIncremental,
  selectSession,
  getComposerTextarea: () => composerTextarea,
});

void boot();

/** 启动流程：挂载外壳、拉取会话、建立 SSE、刷新 runner。 */
async function boot(): Promise<void> {
  mountShell();
  const data = await api<{ sessions: AgentSession[] }>("/api/sessions");
  state.sessions = data.sessions;
  if (state.sessions.length === 0) {
    const created = await api<{ session: AgentSession }>("/api/sessions", { method: "POST" });
    state.sessions = [created.session];
  }
  selectSession(state.sessions[0]?.id ?? null);
  render();
  await Promise.allSettled([
    refreshRunners(),
    import("./actions/agents.js").then((mod) => mod.refreshAgentOptions({ silent: true })),
  ]);
  render();
}

/** 切换会话时重建 SSE 连接，确保只监听当前会话。 */
export function selectSession(id: string | null): void {
  state.selectedId = id;
  state.eventSource?.close();
  state.eventSource = null;
  if (!id) {
    return;
  }
  state.eventSource = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
  state.eventSource.addEventListener("snapshot", (event) => {
    upsertSession(JSON.parse((event as MessageEvent<string>).data) as AgentSession);
    scheduleIncremental();
  });
  state.eventSource.addEventListener("update", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as
      | AgentEvent
      | { type: "session.updated"; session: AgentSession };
    if ("type" in payload && payload.type === "session.updated") {
      upsertSession(payload.session);
    } else {
      const eventPayload = payload as AgentEvent;
      const session = currentSession();
      if (session && !session.events.some((item) => item.id === eventPayload.id)) {
        session.events.push(eventPayload);
      }
    }
    scheduleIncremental();
  });
}

/** 开机一次：写入永不被整体清空的外壳骨架，缓存稳定引用并挂载委托监听。 */
function mountShell(): void {
  appRoot.innerHTML = `
    <div class="shell">
      <div class="sidebar-backdrop" data-action="close-sidebar"></div>
      <aside class="sidebar">
        <header class="sidebar-head">
          <h1>AgentDock</h1>
          <button class="icon-btn" data-action="new-session" title="新建对话">${icon("plus")}</button>
        </header>
        <nav class="primary-nav">
          <button data-action="open-conversation">${icon("message-square")} 对话</button>
        </nav>
        <div class="conversation-list"></div>
        <footer class="sidebar-foot">
          <button class="sidebar-action" data-action="toggle-settings">
            ${icon("settings")} 设置
          </button>
          <span class="sidebar-version">AgentDock v${APP_VERSION}</span>
        </footer>
      </aside>
      <main class="workspace"></main>
    </div>
  `;
  const shell = appRoot.querySelector<HTMLElement>(".shell");
  const nav = appRoot.querySelector<HTMLElement>(".primary-nav [data-action='open-conversation']");
  const settingsBtn = appRoot.querySelector<HTMLElement>("[data-action='toggle-settings']");
  const list = appRoot.querySelector<HTMLElement>(".conversation-list");
  const workspace = appRoot.querySelector<HTMLElement>(".workspace");
  if (!shell || !nav || !settingsBtn || !list || !workspace) {
    throw new Error("shell mount failed");
  }
  shellEl = shell;
  navConversationBtn = nav;
  openSettingsBtn = settingsBtn;
  conversationListEl = list;
  workspaceEl = workspace;
  attachDelegatedListeners(appRoot);
  shellMounted = true;
}

/** 结构性渲染：仅切换 class 并替换 workspace 内容，不触碰外壳骨架/委托监听。 */
export function render(): void {
  if (!shellMounted) {
    mountShell();
  }
  const session = currentSession();
  ensureRunnerSelection(session);
  shellEl.classList.toggle("sidebar-open", state.sidebarOpen);
  navConversationBtn.classList.toggle("selected", !state.settingsOpen);
  openSettingsBtn.classList.toggle("active", state.settingsOpen);
  workspaceEl.classList.toggle("settings-workspace", state.settingsOpen);
  workspaceEl.innerHTML = state.settingsOpen ? renderSettingsPage() : renderConversationPage(session);
  updateConversationList();
  if (state.settingsOpen) {
    clearConversationRefs();
  } else {
    cacheConversationRefs();
    if (timelineEl) {
      timelineEl.scrollTop = timelineEl.scrollHeight;
    }
  }
}

function cacheConversationRefs(): void {
  timelineEl = workspaceEl.querySelector<HTMLElement>(".timeline");
  statusbarEl = workspaceEl.querySelector<HTMLElement>(".statusbar");
  composerTextarea = workspaceEl.querySelector<HTMLTextAreaElement>("#message-input");
  sendBtn = workspaceEl.querySelector<HTMLButtonElement>("#send-message");
}

function clearConversationRefs(): void {
  timelineEl = null;
  statusbarEl = null;
  composerTextarea = null;
  sendBtn = null;
}

function updateConversationList(): void {
  conversationListEl.innerHTML = state.sessions.map((item) => sessionListItem(item)).join("");
}

// —— SSE 高频增量：rAF 合帧 + 保留 details 展开态 ——
export function scheduleIncremental(): void {
  if (frameHandle !== null) {
    return;
  }
  frameHandle = requestAnimationFrame(() => {
    frameHandle = null;
    flushIncremental();
  });
}

function flushIncremental(): void {
  const session = currentSession();
  updateConversationList();
  if (!state.settingsOpen && timelineEl) {
    paintTimeline(session, {});
    updateRunStatus(session);
    updateComposerAvailability(session);
  }
}

function paintTimeline(session: AgentSession | null, opts: { forceBottom?: boolean }): void {
  if (!timelineEl) {
    return;
  }
  const prevScrollTop = timelineEl.scrollTop;
  const atBottom =
    opts.forceBottom === true ||
    timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight < 40;

  const open = new Set<string>();
  for (const d of timelineEl.querySelectorAll<HTMLDetailsElement>("details[data-details-key]")) {
    if (d.open) {
      open.add(d.dataset.detailsKey ?? "");
    }
  }

  timelineEl.innerHTML = session ? renderTimeline(session) : "";

  for (const d of timelineEl.querySelectorAll<HTMLDetailsElement>("details[data-details-key]")) {
    if (open.has(d.dataset.detailsKey ?? "")) {
      d.open = true;
    }
  }

  timelineEl.scrollTop = atBottom ? timelineEl.scrollHeight : prevScrollTop;
}

function updateRunStatus(session: AgentSession | null): void {
  if (statusbarEl) {
    statusbarEl.innerHTML = renderStatusbar(session);
  }
}

function updateComposerAvailability(session: AgentSession | null): void {
  const runner = state.runnerOptions.find((option) => option.id === state.selectedRunnerId);
  const disabled = session?.status === "running" || !runner?.available;
  const placeholder = runner?.available ? "发送消息..." : "没有可用 runner，请到设置里配置 Provider 或安装 CLI";
  if (composerTextarea) {
    composerTextarea.disabled = disabled;
    composerTextarea.placeholder = placeholder;
  }
  if (sendBtn) {
    sendBtn.disabled = disabled;
  }
}
