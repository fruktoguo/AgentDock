// L3 技能层：SkillRegistry —— 从技能根目录发现技能并按需加载（渐进式披露）。
//
// 一个 skill = 一个目录，内含 SKILL.md：
//   - frontmatter：--- 包裹的极简 YAML 风格键值（至少 name、description）；
//   - body：--- 之后的正文（真正的操作指令）。
// 渐进式披露：系统提示只「广告」清单（仅 name + description），正文不进系统提示；
// 模型需要时用 skill 工具按 name 加载 body（及随附资源清单）。
//
// 无 yaml 依赖：自己写极简 frontmatter 解析（--- 分隔、逐行 key: value）。

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 技能清单项：仅暴露给系统提示广告用的最小信息。 */
export interface SkillMeta {
  /** 技能名（frontmatter.name，缺省退化为目录名）。 */
  name: string;
  /** 技能一句话描述（frontmatter.description）。 */
  description: string;
  /** 技能目录的绝对路径。 */
  dir: string;
}

/** 加载后的技能详情：含正文与随附资源绝对路径清单。 */
export interface SkillDetail {
  name: string;
  description: string;
  /** 技能目录绝对路径。 */
  dir: string;
  /** SKILL.md 正文（frontmatter 之后的内容，已去除首尾空白）。 */
  body: string;
  /** 随附资源文件的绝对路径清单（不含 SKILL.md 本身）。 */
  resources: string[];
}

/** 内部条目：清单信息 + 已解析的正文。 */
interface SkillEntry {
  meta: SkillMeta;
  body: string;
}

/** SKILL.md 文件名（固定约定）。 */
const SKILL_FILE = "SKILL.md";
/** 资源递归遍历时跳过的重目录。 */
const SKIP_DIRS = new Set([".git", "node_modules"]);
/** 资源清单上限，避免异常巨大的技能目录爆量。 */
const RESOURCE_CAP = 200;

/**
 * 解析极简 frontmatter。
 * 约定：文件以一行 `---` 开头，到下一行 `---` 之间为 frontmatter；其后全部为 body。
 * 不满足该形状时视为无 frontmatter，整体作为 body。
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: normalized.trim() };
  }
  // 定位关闭的 ---。
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // 没有闭合分隔符：不当作 frontmatter，整体作为 body。
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue; // 跳过空行与注释行
    }
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue; // 非 key: value 行，忽略
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // 去掉包裹的成对引号。
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) {
      frontmatter[key] = value;
    }
  }
  const body = lines.slice(end + 1).join("\n").trim();
  return { frontmatter, body };
}

/**
 * 技能注册表：从一个技能根目录发现技能、列举清单、按需加载正文与资源。
 * 发现失败（根目录不存在/不可读）静默视为「无技能」，保证宿主行为不变。
 */
export class SkillRegistry {
  /** 技能根目录（绝对路径）。 */
  private readonly root: string;
  /** name -> 条目。发现顺序按目录名排序，重名后者覆盖前者（确定性）。 */
  private readonly skills = new Map<string, SkillEntry>();

  constructor(root: string) {
    this.root = root;
  }

  /**
   * 扫描根目录，发现全部技能（幂等：每次清空重建）。
   * 只把「含可解析 SKILL.md 的子目录」纳入；根目录缺失即静默返回空。
   */
  async discover(): Promise<void> {
    this.skills.clear();
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return; // 根目录不存在或不可读：无技能。
    }
    // 按目录名排序，保证发现与重名覆盖的确定性。
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const name of dirs) {
      const dir = join(this.root, name);
      let content: string;
      try {
        content = await readFile(join(dir, SKILL_FILE), "utf8");
      } catch {
        continue; // 该子目录没有 SKILL.md，跳过。
      }
      const { frontmatter, body } = parseFrontmatter(content);
      // name 缺省退化为目录名；description 缺省为空串。
      const skillName = (frontmatter["name"] ?? "").trim() || name;
      const description = (frontmatter["description"] ?? "").trim();
      this.skills.set(skillName, { meta: { name: skillName, description, dir }, body });
    }
  }

  /** 列出技能清单（仅 name + description + dir），按 name 排序。 */
  list(): SkillMeta[] {
    return [...this.skills.values()]
      .map((e) => e.meta)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 构造注入系统提示的「技能广告」字符串（仅 name + description，绝不含正文）。
   * 无技能时返回空串，宿主据此保持提示不变。
   */
  advertisement(): string {
    const metas = this.list();
    if (metas.length === 0) {
      return "";
    }
    const lines = metas.map((m) => (m.description ? `- ${m.name}：${m.description}` : `- ${m.name}`));
    return [
      "可用技能（渐进式披露：以下仅为清单；需要时用 skill 工具按 name 加载其完整指令后再执行）：",
      ...lines,
    ].join("\n");
  }

  /**
   * 按 name 加载技能：返回正文 + 随附资源绝对路径清单。
   * 未找到返回 undefined（调用方转成结构化错误）。
   */
  async load(name: string): Promise<SkillDetail | undefined> {
    const entry = this.skills.get(name);
    if (!entry) {
      return undefined;
    }
    const resources = await listResources(entry.meta.dir);
    return {
      name: entry.meta.name,
      description: entry.meta.description,
      dir: entry.meta.dir,
      body: entry.body,
      resources,
    };
  }
}

/** 递归收集技能目录下的资源文件绝对路径（排除 SKILL.md 与重目录，带上限）。 */
async function listResources(dir: string): Promise<string[]> {
  const out: string[] = [];
  await walkResources(dir, dir, out);
  out.sort();
  return out;
}

/** listResources 的递归实现。 */
async function walkResources(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length >= RESOURCE_CAP) {
    return;
  }
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 不可读目录跳过
  }
  for (const entry of entries) {
    if (out.length >= RESOURCE_CAP) {
      return;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walkResources(root, full, out);
    } else if (entry.isFile()) {
      // 根目录下的 SKILL.md 是元数据本身，不算随附资源。
      if (dir === root && entry.name === SKILL_FILE) {
        continue;
      }
      out.push(full);
    }
  }
}
