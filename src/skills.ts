import { readFileSync, existsSync } from "fs";
import { join } from "path";

// 一个"技能"就是 .mini-skills/<名字>.md 里的一段提示词模板。
// 输入 "/commit ..." 时，把它加载出来，连同后面的附加文字一起当成
// 一整句话发给模型 —— 用起来就像装了个 shell 脚本。
const SKILLS_DIR = join(process.cwd(), ".mini-skills");

export function resolveSkill(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const [name, ...rest] = input.slice(1).split(" ");
  const file = join(SKILLS_DIR, `${name}.md`);
  if (!existsSync(file)) return null;    //文件不存在->不是技能

  const prompt = readFileSync(file, "utf-8").trim();
  const args = rest.join(" ").trim();
  // 模板 + 你在命令后面补的话，拼成一条完整的提示词
  return args ? `${prompt}\n\n${args}` : prompt;
}
