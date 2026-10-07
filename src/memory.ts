import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

// 跨会话记忆：把一些"事实"存成 .mini-memory/ 目录下的 .md 文件。
// 每次对话前，挑出和用户这次提问相关的那几条，塞进系统提示词。
// 教程原版用的是"关键词重合度"——不调用模型、不用向量库，足够看清机制。
const MEMORY_DIR = join(process.cwd(), ".mini-memory");

// ── 我改的地方 ──
// 教程原版按空格和非字母字符切词。这对英文有效，但中文没有空格，
// 一整句中文会被切成一个超长的"词"，导致中文记忆永远匹配不上。
// 所以这里改成：非中文按整词（要求 3 字符以上），中文按"两字一组"切开。
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    if (/[\u4e00-\u9fff]/.test(w)) {
      // 例："这个项目用的语言" → 这个 / 个项 / 项目 / 目用 / 用的 / 的语 / 语言
      for (let i = 0; i + 2 <= w.length; i++) tokens.add(w.slice(i, i + 2));
    } else if (w.length > 2) {
      tokens.add(w);
    }
  }
  return tokens;
}

export function recallMemories(query: string): string {
  if (!existsSync(MEMORY_DIR)) return "";
  const queryWords = tokenize(query);
  if (queryWords.size === 0) return "";

  const scored: { text: string; score: number }[] = [];
  for (const file of readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(MEMORY_DIR, file), "utf-8").trim();
    const words = tokenize(text);
    let score = 0;
    for (const w of queryWords) if (words.has(w)) score++;
    if (score > 0) scored.push({ text, score });
  }
  if (scored.length === 0) return "";

  // 只取最相关的 3 条 —— 记忆库可以很大，但每次只花很少的 token
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => `- ${s.text}`)
    .join("\n");
  return `\n\n# Memory (things you remember about the user and project)\n${top}`;
}
