import { resolve, join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { ToolDefinition } from "./registry";

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "读取指定路径的文件内容",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500, // 演示用，生产环境通常 5000+
  // 读取解析后的本地文件内容；结果会在 ToolRegistry 层按 maxResultChars 截断。
  execute: async ({ path }: { path: string }) => {
    return readFileSync(resolve(path), "utf-8");
  },
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "写入内容到指定文件",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  isConcurrencySafe: false, // 写操作可能引发竞态条件，不能并发执行
  isReadOnly: false,
  // 写入指定路径的完整内容；标记为非并发安全以避免多个写操作交错。
  execute: async ({ path, content }: { path: string; content: string }) => {
    writeFileSync(resolve(path), content, "utf-8");
    return `已写入 ${content.length} 字符到 ${path}`;
  },
};

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "精确替换文件中的制定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆盖写——只改指定的部分",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_string: {
        type: "string",
        description: "要替换的原文本（必须精确匹配）",
      },
      new_string: { type: "string", description: "替换后的新文本" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({
    path,
    old_string,
    new_string,
  }: {
    path: string;
    old_string: string;
    new_string: string;
  }) => {
    // 先确认目标和匹配次数，确保 edit_file 只做一次明确的精确替换。
    const resolved = resolve(path);
    if (!existsSync(resolved)) return `文件不存在: ${path}`;

    const content = readFileSync(resolved, "utf-8");
    const count = content.split(old_string).length - 1;

    if (count === 0)
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`;
    if (count > 1)
      return `找到 ${count} 处匹配内容，请提供更多上下文让 old_string 唯一`;

    const updated = content.replace(old_string, new_string);
    writeFileSync(resolved, updated, "utf-8");
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`;
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "列出指定目录下的文件和子目录",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，默认为当前目录" },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  // 枚举目录下一级内容，并用图标区分文件和子目录，便于模型快速理解结构。
  execute: async ({ path = "." }: { path?: string }) => {
    const resolved = resolve(path);
    return readdirSync(resolved)
      .map((name) => {
        const stat = statSync(join(resolved, name));
        return `${stat.isDirectory() ? "📁 DIR" : "📄 FILE"} ${name}`;
      })
      .join("\n");
  },
};
