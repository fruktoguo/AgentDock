// 极小的 mock MCP server（供 mcp-smoke 用，无网络，纯本地子进程）。
//
// 按行讲 JSON-RPC 2.0 over stdio：实现 initialize + tools/list + tools/call，
// 提供 echo 工具（回显入参 text）。tools/list 故意分两页返回（echo / echo2），
// 用 nextCursor 演示分页，验证客户端会翻页取回全部工具。stdin 读到 EOF 时优雅退出（演示干净关闭）。
// 只用 node 内置模块，独立可 `node <path>` 运行，不依赖项目其它代码。

import { createInterface } from "node:readline";

/** 最小 JSON-RPC 入站消息形状。 */
interface RpcMessage {
  jsonrpc?: unknown;
  id?: number | string | null;
  method?: unknown;
  params?: unknown;
}

/** 写一条 JSON-RPC 消息（单行 + \n）。 */
function send(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** 取 params 里的对象字段（缺省空对象）。 */
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function handle(msg: RpcMessage): void {
  const id = msg.id;
  const method = msg.method;
  const hasId = typeof id === "number" || typeof id === "string";

  switch (method) {
    case "initialize": {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-echo", version: "0.0.1" },
        },
      });
      return;
    }
    case "notifications/initialized": {
      return; // 通知无需响应。
    }
    case "tools/list": {
      const params = asObject(msg.params);
      const cursor = params["cursor"];
      // 演示 MCP tools/list 分页：无 cursor -> 第一页（echo）+ nextCursor；
      // cursor==="page2" -> 第二页（echo2）且无 nextCursor（末页）。
      // 用于验证客户端会翻页取回全部工具，而非只取首页。
      if (cursor === "page2") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "echo2",
                description: "回显输入的文本（第二页工具）。",
                inputSchema: {
                  type: "object",
                  properties: {
                    text: { type: "string", description: "要回显的文本" },
                  },
                  required: ["text"],
                  additionalProperties: false,
                },
              },
            ],
          },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "echo",
              description: "回显输入的文本。",
              inputSchema: {
                type: "object",
                properties: {
                  text: { type: "string", description: "要回显的文本" },
                },
                required: ["text"],
                additionalProperties: false,
              },
            },
          ],
          nextCursor: "page2",
        },
      });
      return;
    }
    case "tools/call": {
      const params = asObject(msg.params);
      const name = params["name"];
      const args = asObject(params["arguments"]);
      if (name !== "echo") {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `未知工具：${String(name)}` } });
        return;
      }
      const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `echo: ${text}` }],
          isError: false,
        },
      });
      return;
    }
    default: {
      if (hasId) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } });
      }
      return;
    }
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  let msg: RpcMessage;
  try {
    msg = JSON.parse(trimmed) as RpcMessage;
  } catch {
    return; // 非 JSON 行忽略。
  }
  if (msg.jsonrpc !== "2.0") {
    return;
  }
  handle(msg);
});
// stdin EOF（客户端关闭 stdin）时优雅退出。
rl.on("close", () => {
  process.exit(0);
});
