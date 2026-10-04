import { readFileSync } from "fs";
import type Anthropic from "@anthropic-ai/sdk";

// 工具 = 三样东西：名字、给模型看的说明、真正干活的函数。
// 下面这个数组的形状，就是 Anthropic API 要求的样子。
export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file. Returns the file content with line numbers.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to read" },
      },
      required: ["file_path"],
    },
  },
];

// 按名字分发工具调用。不认识的名字返回错误字符串，而不是抛异常——
// 这样模型要是"编"出一个不存在的工具名，它能自己看到错误并纠正。
export async function executeTool(
  name: string,
  input: Record<string, any>
): Promise<string> {
  switch (name) {
    case "read_file":
      return readFile(input as { file_path: string });
    default:
      return `Unknown tool: ${name}`;
  }
}

function readFile(input: { file_path: string }): string {
  try {
    const lines = readFileSync(input.file_path, "utf-8").split("\n");
    // 每行前面加上行号，模型读起来更容易定位
    return lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
  } catch (e: any) {
    return `Error reading file: ${e.message}`;
  }
}
