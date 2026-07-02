import { createAgentDockServer } from "./app.js";
import { createServerContext } from "./context.js";

/** 最薄启动入口：初始化上下文、创建 server、监听端口。 */
const context = await createServerContext();
const server = createAgentDockServer(context);

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

server.listen(port, host, () => {
  console.log(`AgentDock running at http://${host}:${port}`);
});
