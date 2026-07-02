declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:child_process" {
  export type ChildProcessWithoutNullStreams = {
    stdout: { on(event: "data", listener: (chunk: unknown) => void): void };
    stderr: { on(event: "data", listener: (chunk: unknown) => void): void };
    stdin: {
      write(chunk: string): void;
      end(): void;
      on(event: "error", listener: (error: Error) => void): void;
      writable: boolean;
    };
    pid?: number;
    on(event: "error", listener: (error: Error) => void): void;
    on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
    once(event: "close", listener: (code: number | null, signal: string | null) => void): void;
    kill(signal?: string): void;
  };

  export function spawn(
    command: string,
    args?: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      shell?: boolean | string;
      stdio?: "pipe" | "ignore" | "inherit" | Array<"pipe" | "ignore" | "inherit">;
    },
  ): ChildProcessWithoutNullStreams;
}

declare module "node:readline" {
  export type Interface = {
    on(event: "line", listener: (line: string) => void): void;
    on(event: "close", listener: () => void): void;
    close(): void;
  };
  export function createInterface(options: { input: unknown; terminal?: boolean }): Interface;
}

declare module "node:fs/promises" {
  export function mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function readFile(path: string | URL, encoding: string): Promise<string>;
  export function writeFile(path: string | URL, data: string, encoding: string): Promise<void>;

  // 目录项：仅暴露原生 Agent 工具所需的最小面
  export type Dirent = {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  };
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

declare module "node:http" {
  export type IncomingMessage = {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: unknown) => void): void;
    on(event: "end", listener: () => void): void;
    on(event: "close", listener: () => void): void;
  };

  export type ServerResponse = {
    statusCode: number;
    setHeader(name: string, value: string): void;
    writeHead(statusCode: number, headers?: Record<string, string>): void;
    write(chunk: string): void;
    end(chunk?: string): void;
  };

  export function createServer(
    listener: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  ): { listen(port: number, host: string, callback?: () => void): void };
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function join(...paths: string[]): string;
  export function normalize(path: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:os" {
  export function tmpdir(): string;
  export function homedir(): string;
}

declare const process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  exitCode?: number;
  /** node 可执行文件绝对路径（spawn 子进程跑 node 脚本用）。 */
  execPath: string;
  /** 向指定 pid 发信号；signal=0 仅探测进程是否存活。 */
  kill(pid: number, signal?: string | number): void;
  /** 立即退出进程（mock server 用）。 */
  exit(code?: number): never;
  stdout: { write(chunk: string): void };
  stdin: unknown;
};

declare const console: {
  error(...args: unknown[]): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
