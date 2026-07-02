import type { AgentId } from "../../agentdock/runtime/types.js";
import type { EnvironmentTarget } from "../types.js";

/** 基础运行环境检测/安装目标。 */
export const environmentTargets: EnvironmentTarget[] = [
  {
    id: "node",
    name: "Node.js",
    binary: "node",
    detectCommand: "node --version",
    installCommand: "npm install -g n",
    description: "检测 Node.js 运行时。安装会先安装 n，后续可通过 n 管理 Node 版本。",
  },
  {
    id: "npm",
    name: "npm",
    binary: "npm",
    detectCommand: "npm --version",
    installCommand: "npm install -g npm",
    description: "检测 npm 包管理器。",
  },
  {
    id: "project",
    name: "项目依赖",
    detectCommand: "npm ls --depth=0 --json >/dev/null",
    installCommand: "npm install",
    description: "检测并安装 AgentDock 本项目 package.json 声明的依赖。",
  },
];

/** 本机 Agent CLI 检测/安装目标；只有 codex / claude 当前有可运行 driver。 */
export const agentTargets: Array<EnvironmentTarget & { id: AgentId }> = [
  {
    id: "codex",
    name: "Codex CLI",
    binary: "codex",
    detectCommand: "command -v codex",
    installCommand: "npm install -g @openai/codex",
    description: "安装 OpenAI Codex 命令行工具。",
  },
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    detectCommand: "command -v claude",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    description: "安装 Claude Code 命令行工具。",
  },
  {
    id: "qwen",
    name: "Qwen Code",
    binary: "qwen",
    detectCommand: "command -v qwen",
    installCommand: "npm install -g @qwen-code/qwen-code",
    description: "安装 Qwen Code 命令行工具。",
  },
  {
    id: "opencode",
    name: "OpenCode",
    binary: "opencode",
    detectCommand: "command -v opencode",
    installCommand: "npm install -g opencode-ai@~1.17.7",
    description: "安装 OpenCode CLI。",
  },
  {
    id: "kimi",
    name: "Kimi Code",
    binary: "kimi",
    detectCommand: "command -v kimi",
    installCommand: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
    description: "通过官方安装脚本安装 Kimi Code。",
  },
  {
    id: "hermes",
    name: "Hermes",
    binary: "hermes",
    detectCommand: "command -v hermes",
    installCommand: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    description: "通过官方安装脚本安装 Hermes Agent。",
  },
  {
    id: "goose",
    name: "Goose",
    binary: "goose",
    detectCommand: "command -v goose",
    installCommand: "brew install block-goose-cli",
    description: "通过 Homebrew 安装 Goose CLI。",
  },
];
