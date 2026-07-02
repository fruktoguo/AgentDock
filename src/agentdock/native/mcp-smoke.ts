// L2 · MCP 冒烟测试（无网络，纯本地子进程）。
//
// 用仓库内的极小 mock MCP server（mcp/mcp-mock-server.js，按行讲 JSON-RPC，提供 echo 工具）：
//   场景 A：McpManager.start 后，status 显示 server running、列出归一化工具 mcp__mock__echo。
//   场景 H：tools/list 分页——第二页工具 mcp__mock__echo2 也被翻页取回（不因 nextCursor 丢弃）。
//   场景 B：registerInto 把 mcp__mock__echo 注册进真实 ToolRegistry，其 parameters.type==="object"。
//   场景 C：经 tool.execute 调用 echo，返回 { output 含 "echo: <文本>", isError:false }。
//   场景 D：调用一个不存在的原始工具名 -> 结构化错误（isError:true，不 throw）。
//   场景 E：stop 后子进程干净关闭（status.running=false 且 OS 进程已消失）。
//   场景 F：resolveMcpSpecs 从内联 JSON 环境变量解析规格；非法配置退化为空。
//   场景 G：启动一个根本不存在的命令 -> 错误隔离（该 server 记 error，不 throw、不影响其它）。

import { fileURLToPath } from "node:url";
import { McpManager, mcpToolName, resolveMcpSpecs } from "./mcp/manager.js";
import { McpClient } from "./mcp/client.js";
import { ToolRegistry } from "./tool.js";
import type { ToolContext } from "./tool.js";

/** mock server 脚本的绝对路径（编译后的 .js，位于本文件同级 mcp/ 下）。 */
const MOCK_SERVER = fileURLToPath(new URL("./mcp/mcp-mock-server.js", import.meta.url));

/** headless ToolContext（审批自动放行）。 */
function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "mcp-smoke",
    cwd: process.cwd(),
    ask: async () => ({ approved: true }),
    ...over,
  };
}

/** OS 层判断进程是否存活（kill(pid,0) 不发信号，仅探测）。 */
function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 主流程：启动 mock server、注册、调用、关闭并断言。 */
async function checkManager(failures: string[]): Promise<void> {
  const manager = new McpManager(
    [{ name: "mock", command: process.execPath, args: [MOCK_SERVER] }],
    { requestTimeoutMs: 5_000 },
  );
  await manager.start();

  // 场景 A：server 运行中并列出归一化工具。
  const status = manager.status();
  const server = status[0];
  const expectedName = mcpToolName("mock", "echo");
  if (!server || !server.running || server.error) {
    failures.push(`[A] server 未正常启动：${JSON.stringify(status)}`);
  }
  if (!manager.toolNames().includes(expectedName)) {
    failures.push(`[A] 归一化工具名缺失 ${expectedName}：${JSON.stringify(manager.toolNames())}`);
  }

  // 场景 H：tools/list 分两页（nextCursor），第二页工具 echo2 也应被翻页取回。
  const expectedName2 = mcpToolName("mock", "echo2");
  if (!manager.toolNames().includes(expectedName2)) {
    failures.push(
      `[H] tools/list 未翻页取回第二页工具 ${expectedName2}：${JSON.stringify(manager.toolNames())}`,
    );
  }

  const pid = server?.pid;

  // 场景 B：注册进真实 ToolRegistry，parameters 合法。
  const registry = new ToolRegistry();
  manager.registerInto(registry);
  const tool = registry.get(expectedName);
  if (!tool) {
    failures.push(`[B] 工具未注册进 ToolRegistry：${expectedName}`);
  } else if (tool.parameters["type"] !== "object") {
    failures.push(`[B] 工具 parameters.type 应为 object：${JSON.stringify(tool.parameters)}`);
  }

  // 场景 C：调用 echo。
  if (tool) {
    const res = await tool.execute({ text: "你好-agentdock" }, makeCtx());
    if (res.isError || !res.output.includes("echo: 你好-agentdock")) {
      failures.push(`[C] echo 调用结果不符：${JSON.stringify(res)}`);
    }
  }

  // 场景 D：底层 client 调用不存在的工具 -> server 回 JSON-RPC error，client 以 reject 暴露。
  // （manager.toNativeTool 会把该 reject try/catch 成结构化 { isError:true }，见 manager.ts。）
  const client = new McpClient(
    { name: "mock2", command: process.execPath, args: [MOCK_SERVER] },
    { requestTimeoutMs: 5_000 },
  );
  await client.start();
  try {
    let rejected = false;
    try {
      await client.callTool("nope", {});
    } catch {
      rejected = true;
    }
    if (!rejected) {
      failures.push("[D] 调用不存在工具时 client 应以 reject 暴露错误");
    }
  } finally {
    await client.stop();
  }

  // 场景 E：干净关闭。
  await manager.stop();
  const afterStatus = manager.status();
  if (afterStatus.some((s) => s.running)) {
    failures.push(`[E] stop 后仍有 server running：${JSON.stringify(afterStatus)}`);
  }
  // 给 OS 一点时间回收进程后再探测。
  await delay(200);
  if (isProcessAlive(pid)) {
    failures.push(`[E] stop 后子进程 pid=${String(pid)} 仍存活`);
  }
}

/** 场景 F：resolveMcpSpecs 解析内联 JSON；非法退化为空。 */
function checkResolveSpecs(failures: string[]): void {
  const good = resolveMcpSpecs({
    AGENTDOCK_MCP_SERVERS: JSON.stringify([
      { name: "s1", command: "node", args: ["a.js"], env: { K: "v" } },
      { name: "", command: "bad" }, // 非法：name 空，应被过滤。
      { command: "no-name" }, // 非法：缺 name。
    ]),
  });
  if (good.length !== 1 || good[0]?.name !== "s1" || good[0]?.command !== "node") {
    failures.push(`[F] resolveMcpSpecs 应仅解析出 1 条合法规格：${JSON.stringify(good)}`);
  }
  if (good[0]?.env?.["K"] !== "v" || good[0]?.args?.[0] !== "a.js") {
    failures.push(`[F] resolveMcpSpecs 未正确保留 args/env：${JSON.stringify(good[0])}`);
  }
  const empty = resolveMcpSpecs({ AGENTDOCK_MCP_SERVERS: "not-json" });
  if (empty.length !== 0) {
    failures.push(`[F] 非法 JSON 应退化为空数组：${JSON.stringify(empty)}`);
  }
  const none = resolveMcpSpecs({});
  if (none.length !== 0) {
    failures.push(`[F] 未配置应返回空数组：${JSON.stringify(none)}`);
  }
}

/** 场景 G：不存在的命令 -> 错误隔离（记 error，不 throw）。 */
async function checkErrorIsolation(failures: string[]): Promise<void> {
  const manager = new McpManager([
    { name: "broken", command: "agentdock-no-such-binary-xyz", args: [] },
  ]);
  // start 不应 throw。
  await manager.start();
  const status = manager.status();
  if (!status[0] || !status[0].error) {
    failures.push(`[G] 不存在命令的 server 应记录 error：${JSON.stringify(status)}`);
  }
  if (status[0]?.running) {
    failures.push("[G] 启动失败的 server 不应标记 running");
  }
  // registerInto 应跳过失败 server（不注册任何工具，也不 throw）。
  const registry = new ToolRegistry();
  manager.registerInto(registry);
  if (registry.list().length !== 0) {
    failures.push(`[G] 失败 server 不应注册任何工具，实际 ${registry.list().length}`);
  }
  await manager.stop();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  const failures: string[] = [];
  await checkManager(failures);
  checkResolveSpecs(failures);
  await checkErrorIsolation(failures);

  if (failures.length === 0) {
    console.log(
      "PASS: MCP 冒烟测试通过（启动 mock server + 归一化注册 mcp__mock__echo + tools/list 翻页取回 echo2 + 调用回显 + 调用错误结构化 + 干净关闭 + 规格解析 + 错误隔离）。",
    );
    process.exitCode = 0;
  } else {
    console.log("FAIL: MCP 冒烟测试未通过。");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.log("FAIL: 冒烟测试抛出异常。");
  console.log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
