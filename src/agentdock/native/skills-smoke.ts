// L3 技能层冒烟测试（无网络）。
//
// 在临时目录里造一个含 1 个 SKILL.md（+ 1 个随附资源）的技能，验证：
//   场景 A：SkillRegistry.discover + list 能列出它（name + description 来自 frontmatter）。
//   场景 B：skill 工具能加载正文（含 body 内容与随附资源绝对路径）。
//   场景 C：advertisement 含 name + description，但绝不含正文（渐进式披露）。
//   场景 D：无技能根目录时，advertisement 为空串、list 为空（宿主行为不变）。
// 用完清理临时目录。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "./skills.js";
import { createSkillTool } from "./tools/skill.js";
import type { ToolContext } from "./tool.js";

/** 技能正文里的一段特征文本，用于断言「广告不含正文」。 */
const BODY_MARKER = "只把驼峰命名改为下划线命名，且不要触碰测试文件。";
const SKILL_NAME = "rename-vars";
const SKILL_DESC = "按项目约定批量重命名变量的操作规程。";
const RESOURCE_NAME = "mapping.txt";

/** 造一个最小可用的技能根目录，返回根目录绝对路径。 */
async function makeSkillsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentdock-skills-"));
  const skillDir = join(root, "rename-vars-skill"); // 目录名故意与 frontmatter.name 不同
  await mkdir(skillDir, { recursive: true });
  const md = [
    "---",
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESC}`,
    "---",
    "# 重命名变量",
    "",
    BODY_MARKER,
    "",
    `映射表见随附资源 ${RESOURCE_NAME}。`,
  ].join("\n");
  await writeFile(join(skillDir, "SKILL.md"), md, "utf8");
  await writeFile(join(skillDir, RESOURCE_NAME), "fooBar -> foo_bar\n", "utf8");
  return root;
}

/** 构造一个 headless ToolContext（审批自动放行）。 */
function makeCtx(cwd: string): ToolContext {
  return {
    sessionId: "skills-smoke",
    cwd,
    ask: async () => ({ approved: true }),
  };
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const root = await makeSkillsRoot();
  try {
    const registry = new SkillRegistry(root);
    await registry.discover();

    // 场景 A：list 列出技能，name/description 取自 frontmatter（而非目录名）。
    const metas = registry.list();
    if (metas.length !== 1) {
      failures.push(`[A] 期望发现 1 个技能，实际 ${metas.length}`);
    }
    const meta = metas[0];
    if (!meta || meta.name !== SKILL_NAME || meta.description !== SKILL_DESC) {
      failures.push(`[A] 技能清单 name/description 不符：${JSON.stringify(meta)}`);
    }

    // 场景 B：skill 工具加载正文 + 随附资源。
    const tool = createSkillTool(registry);
    const ok = await tool.execute({ name: SKILL_NAME }, makeCtx(root));
    if (ok.isError) {
      failures.push(`[B] 加载技能不应报错：${ok.output}`);
    }
    if (!ok.output.includes(BODY_MARKER)) {
      failures.push("[B] 加载结果未包含技能正文内容");
    }
    if (!ok.output.includes(RESOURCE_NAME)) {
      failures.push("[B] 加载结果未列出随附资源");
    }

    // 场景 B'：加载不存在的技能应结构化报错（不 throw）。
    const miss = await tool.execute({ name: "does-not-exist" }, makeCtx(root));
    if (!miss.isError) {
      failures.push("[B'] 加载不存在的技能应返回 isError:true");
    }

    // 场景 C：广告含 name + description，但绝不含正文。
    const ad = registry.advertisement();
    if (!ad.includes(SKILL_NAME) || !ad.includes(SKILL_DESC)) {
      failures.push(`[C] 广告应含 name 与 description：${ad}`);
    }
    if (ad.includes(BODY_MARKER)) {
      failures.push("[C] 广告不应泄漏技能正文（违反渐进式披露）");
    }

    // 场景 D：根目录不存在时，行为退化为「无技能」。
    const empty = new SkillRegistry(join(root, "no-such-dir"));
    await empty.discover();
    if (empty.list().length !== 0 || empty.advertisement() !== "") {
      failures.push("[D] 无技能根目录时应 list 为空且 advertisement 为空串");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  if (failures.length === 0) {
    console.log("PASS: L3 技能冒烟测试通过（发现清单 + 按需加载正文/资源 + 广告不泄漏正文 + 无技能退化）。");
    process.exitCode = 0;
  } else {
    console.log("FAIL: L3 技能冒烟测试未通过。");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.log("FAIL: 冒烟测试抛出异常。");
  console.log(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
