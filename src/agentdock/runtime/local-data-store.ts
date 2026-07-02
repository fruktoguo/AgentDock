import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentId, AgentSession, ProviderConfig } from "./types.js";

export type AgentSettings = Partial<Record<AgentId, { enabled: boolean; model?: string | null }>>;

export type PersistedState = {
  version: 1;
  sessions: AgentSession[];
  agents: AgentSettings;
  providers: ProviderConfig[];
};

export class LocalDataStore {
  private pending: PersistedState | null = null;
  private writing = false;

  constructor(private readonly filePath = defaultStatePath()) {}

  async load(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        version: 1,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        agents: isRecord(parsed.agents) ? (parsed.agents as AgentSettings) : {},
        providers: Array.isArray(parsed.providers) ? (parsed.providers as ProviderConfig[]) : [],
      };
    } catch {
      return { version: 1, sessions: [], agents: {}, providers: [] };
    }
  }

  save(state: PersistedState): void {
    this.pending = state;
    if (!this.writing) {
      void this.flush();
    }
  }

  private async flush(): Promise<void> {
    this.writing = true;
    try {
      while (this.pending) {
        const next = this.pending;
        this.pending = null;
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      }
    } catch (error) {
      console.error("保存 AgentDock 本地状态失败", error);
    } finally {
      this.writing = false;
      if (this.pending) {
        void this.flush();
      }
    }
  }
}

function defaultStatePath(): string {
  const baseDir = process.env.AGENTDOCK_HOME || join(process.env.HOME || process.cwd(), ".ad", "agentdock");
  return join(baseDir, "state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
