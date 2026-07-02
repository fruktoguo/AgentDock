import { spawn } from "node:child_process";

export type SpawnStreamingOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** 写入 stdin 后立即关闭。 */
  input?: string;
  signal?: AbortSignal;
};

export type SpawnStreamingHandle = {
  /** 逐行读取 stdout（用于 NDJSON / stream-json）。 */
  lines: AsyncGenerator<string>;
  /** 进程结束后 resolve，附带退出码与累积的 stderr。 */
  done: Promise<{ code: number | null; stderr: string }>;
};

/**
 * spawn 一个子进程，把 stdout 按行推成 async generator，
 * 同时累积 stderr，支持 AbortSignal 取消。
 */
export function spawnStreaming(
  command: string,
  args: string[],
  options: SpawnStreamingOptions = {},
): SpawnStreamingHandle {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "pipe",
  });

  const queue: string[] = [];
  const waiters: Array<(value: IteratorResult<string>) => void> = [];
  let finished = false;
  let stdoutBuffer = "";
  let stderr = "";
  let spawnError: Error | null = null;

  const pushLine = (line: string) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value: line, done: false });
    } else {
      queue.push(line);
    }
  };

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    if (stdoutBuffer.trim()) {
      pushLine(stdoutBuffer.trim());
      stdoutBuffer = "";
    }
    for (const waiter of waiters.splice(0)) {
      waiter({ value: undefined as unknown as string, done: true });
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.trim()) {
        pushLine(line);
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 40_000) {
      stderr = stderr.slice(-40_000);
    }
  });

  const done = new Promise<{ code: number | null; stderr: string }>((resolveDone) => {
    child.on("error", (error) => {
      spawnError = error;
      finish();
      resolveDone({ code: 1, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      finish();
      resolveDone({ code, stderr });
    });
  });

  if (options.signal) {
    const onAbort = () => child.kill("SIGTERM");
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  if (options.input !== undefined) {
    try {
      child.stdin.write(options.input);
      child.stdin.end();
    } catch {
      // 忽略：进程可能已退出
    }
  } else {
    try {
      child.stdin.end();
    } catch {
      // 忽略
    }
  }

  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as string;
        continue;
      }
      if (finished) {
        if (spawnError) {
          throw spawnError;
        }
        return;
      }
      const next = await new Promise<IteratorResult<string>>((resolveNext) => {
        waiters.push(resolveNext);
      });
      if (next.done) {
        if (spawnError) {
          throw spawnError;
        }
        return;
      }
      yield next.value;
    }
  }

  return { lines: lines(), done };
}
