import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ServerContext } from "./context.js";
import { sendJson, serveStatic } from "./http.js";
import { handleEnvironmentRoutes } from "./routes/environment.js";
import { handleProviderRoutes } from "./routes/providers.js";
import { handleRunnerRoutes } from "./routes/runners.js";
import { handleSessionRoutes } from "./routes/sessions.js";

/** 创建 HTTP server；所有路由先按领域模块尝试处理，最后回退静态资源。 */
export function createAgentDockServer(context: ServerContext): ReturnType<typeof createServer> {
  return createServer(async (request, response) => {
    try {
      await route(request, response, context);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function route(request: IncomingMessage, response: ServerResponse, context: ServerContext): Promise<void> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const method = request.method || "GET";
  const pathname = url.pathname;

  if (await handleSessionRoutes(method, pathname, request, response, context)) {
    return;
  }
  if (await handleEnvironmentRoutes(method, pathname, request, response, context)) {
    return;
  }
  if (await handleRunnerRoutes(method, pathname, request, response, context)) {
    return;
  }
  if (await handleProviderRoutes(method, pathname, request, response, context)) {
    return;
  }

  await serveStatic(pathname, response, context);
}
