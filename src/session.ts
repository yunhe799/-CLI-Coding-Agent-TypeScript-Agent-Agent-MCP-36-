import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// 所谓"会话"，其实就是把消息数组存到磁盘上。
// 每轮对话结束后保存一次，启动时加 --resume 就读回来。
// 不需要数据库 —— 整个对话本来就是一个普通的数组。
const SESSION_FILE = join(process.cwd(), ".mini-session.json");

export function saveSession(messages: unknown[]): void {
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(messages, null, 2));
  } catch {}
}

export function loadSession(): unknown[] | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return null;
  }
}
