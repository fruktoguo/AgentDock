import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerContext } from "../context.js";
import { sendJson } from "../http.js";

/** Runner 列表 API，供前端输入框下拉选择执行体。 */
export async function handleRunnerRoutes(
  method: string,
  pathname: string,
  _request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/runners") {
    sendJson(response, 200, { runners: await context.environmentService.listRunners() });
    return true;
  }
  return false;
}
