import { spawn } from "node:child_process";

/**
 * 运行短生命周期 shell 命令，并统一截断输出。
 * 仅用于环境检测/安装，避免把子进程细节泄漏到路由层。
 */
export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, [], {
      cwd,
      env: process.env,
      shell: true,
      stdio: "pipe",
    });
    let output = "";
    const append = (chunk: unknown) => {
      output = `${output}${String(chunk)}`;
      if (output.length > 20_000) {
        output = output.slice(-20_000);
      }
    };
    const timeout = setTimeout(() => {
      append(`\n命令超时：${command}\n`);
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveRun({ code: 1, output: `${output}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveRun({ code, output });
    });
  });
}

/** 只保留最后若干行，防止安装日志撑爆状态和前端。 */
export function trimOutput(value: string): string {
  return value.trim().split("\n").slice(-40).join("\n");
}
