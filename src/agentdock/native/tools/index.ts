// 内置工具注册入口（stub）。
//
// 把 6 个内置工具注册进 ToolRegistry；工具体各自在对应文件里实现。

import type { ToolRegistry } from "../tool.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";

/** 注册全部内置工具。opts.cwd 供后续给工具注入根目录用。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerBuiltins(reg: ToolRegistry, opts: { cwd: string }): void {
  reg.register(bashTool);
  reg.register(readTool);
  reg.register(writeTool);
  reg.register(editTool);
  reg.register(grepTool);
  reg.register(globTool);
}
