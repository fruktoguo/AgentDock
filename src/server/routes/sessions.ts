import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../context.js";
import { readJson, sendJson } from "../http.js";

/** 会话相关 API：列表、创建、SSE 订阅、发消息、停止运行。 */
export async function handleSessionRoutes(
  method: string,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/sessions") {
    sendJson(response, 200, { sessions: context.service.listSessions() });
    return true;
  }

  if (method === "POST" && pathname === "/api/sessions") {
    sendJson(response, 201, { session: context.service.createSession() });
    return true;
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!sessionMatch) {
    return false;
  }

  const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
  const action = sessionMatch[2] ?? "";
  await routeSession(method, action, sessionId, request, response, context);
  return true;
}

async function routeSession(
  method: string,
  action: string,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
): Promise<void> {
  const session = context.service.getSession(sessionId);
  if (!session) {
    sendJson(response, 404, { error: "会话不存在" });
    return;
  }

  if (method === "GET" && action === "") {
    sendJson(response, 200, { session });
    return;
  }

  if (method === "GET" && action === "events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify(session)}\n\n`);
    const unsubscribe = context.service.subscribe(sessionId, (event) => {
      response.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
    });
    request.on("close", unsubscribe);
    return;
  }

  if (method === "POST" && action === "messages") {
    const body = await readJson<{ content?: string; runner?: string; model?: string }>(request);
    const content = String(body.content ?? "").trim();
    if (!content) {
      sendJson(response, 400, { error: "消息不能为空" });
      return;
    }
    context.service
      .sendMessage(sessionId, content, { runnerId: body.runner, model: body.model })
      .catch((error) => {
        console.error("Agent run failed", error);
      });
    sendJson(response, 202, { ok: true });
    return;
  }

  if (method === "POST" && action === "stop") {
    sendJson(response, 200, { stopped: context.service.stop(sessionId) });
    return;
  }

  sendJson(response, 404, { error: "接口不存在" });
}
