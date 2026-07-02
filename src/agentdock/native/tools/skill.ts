// skill 工具：按 name 加载某个技能（Skill）的完整指令正文与随附资源清单。
//
// 渐进式披露的「加载」半环：系统提示只广告清单（name + description），
// 模型判断需要某技能时调用本工具，把该 SKILL.md 正文拉进上下文再照其指令执行。
// 因需要访问 SkillRegistry 实例，本工具以工厂函数创建（区别于内置静态工具）。

import { createTool, type Tool } from "../tool.js";
import type { ToolContext, ToolResultData } from "../tool.js";
import type { SkillRegistry } from "../skills.js";

/** 创建 skill 工具（绑定到给定的 SkillRegistry）。 */
export function createSkillTool(registry: SkillRegistry): Tool {
  return createTool({
    name: "skill",
    description:
      "加载指定技能（Skill）的完整指令正文及随附资源清单。先从系统提示的技能清单里挑选 name，" +
      "再用本工具加载，然后严格按加载到的指令执行。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名称（取自系统提示中广告的技能清单）" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnly: true },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResultData> {
      const a = (args ?? {}) as { name?: unknown };
      if (typeof a.name !== "string" || a.name.length === 0) {
        return { output: "name 必须为非空字符串", isError: true };
      }
      const detail = await registry.load(a.name);
      if (!detail) {
        const available = registry.list().map((m) => m.name);
        const hint = available.length > 0 ? `可用技能：${available.join("、")}` : "当前没有可用技能。";
        return { output: `未找到技能 "${a.name}"。${hint}`, isError: true };
      }

      // 拼装：标题 + 描述 + 正文 + 随附资源绝对路径清单（供 read 工具直接消费）。
      const parts: string[] = [`# 技能：${detail.name}`];
      if (detail.description) {
        parts.push(detail.description);
      }
      parts.push("", "---", "", detail.body);
      if (detail.resources.length > 0) {
        parts.push("", "随附资源文件（绝对路径，可用 read 工具读取）：");
        for (const r of detail.resources) {
          parts.push(`- ${r}`);
        }
      }
      return { output: parts.join("\n"), title: `技能 ${detail.name}` };
    },
  });
}
