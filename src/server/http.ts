import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type { ServerContext } from "./context.js";

/** 写 JSON 响应，所有 API 路由统一使用这个出口。 */
export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

/** 读取并解析 JSON body；空 body 视为 `{}`。 */
export function readJson<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(raw ? (JSON.parse(raw) as T) : ({} as T));
      } catch (error) {
        rejectBody(error);
      }
    });
  });
}

/**
 * 静态资源服务：app.js 来自 dist/web，其余资源来自 src/web。
 * 路径会先 normalize，避免通过 ../ 逃逸公开目录。
 */
export async function serveStatic(pathname: string, response: ServerResponse, context: ServerContext): Promise<void> {
  const path = pathname === "/" ? "/index.html" : pathname;
  const isJavaScriptModule = path.endsWith(".js");
  const baseDir = isJavaScriptModule ? context.compiledWebDir : context.publicDir;
  const safePath = normalize(path).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(baseDir, safePath);
  const normalizedBase = baseDir.endsWith("/") || baseDir.endsWith("\\") ? baseDir : `${baseDir}/`;
  if (filePath !== baseDir && !filePath.startsWith(normalizedBase)) {
    sendJson(response, 403, { error: "禁止访问" });
    return;
  }
  try {
    const content = await readFile(filePath, "utf8");
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch {
    if (isJavaScriptModule) {
      response.writeHead(404, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(`// JavaScript module not found: ${path}\n`);
      return;
    }
    const index = await readFile(join(context.publicDir, "index.html"), "utf8");
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(index);
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/plain; charset=utf-8";
  }
}
