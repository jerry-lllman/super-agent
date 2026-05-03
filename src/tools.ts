import { ToolDefinition } from "./tool-registry";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

export const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "查询指定城市的天气信息",
  parameters: {
    type: "object" as const,
    properties: {
      city: {
        type: "string" as const,
        description: "城市名称，如“北京”、“上海”",
      },
    },
    required: ["city"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ city }: { city: string }) => {
    const mockWeather: Record<string, string> = {
      北京: "晴，15-25°C，东南风 2 级",
      上海: "多云，18-22°C，西南风 3 级",
      深圳: "阵雨，22-28°C，南风 2 级",
      广州: "多云转晴，20-28°C，东风 3 级",
      杭州: "晴，14-24°C，北风 2 级",
      成都: "阴，16-22°C，微风",
    };
    return mockWeather[city] || `${city}：暂无数据`;
  },
};

export const calculatorTool: ToolDefinition = {
  name: "calculate",
  description: "计算数学表达式的结果。当用户提问涉及数学运算时使用",
  parameters: {
    type: "object" as const,
    properties: {
      expression: {
        type: "string" as const,
        description: '数学表达式，如 "2 + 3 * 4"',
      },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ expression }: { expression: string }) => {
    try {
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },
};

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
  execute: async ({ path, content }: { path: string; content: string }) => {
    writeFileSync(resolve(path), content, "utf-8");
    return `已写入 ${content.length} 字符到 ${path}`;
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

export const grepTool: ToolDefinition = {
  name: "grep",
  description: "在文件中搜索匹配指定模式的内容。返回匹配的行号和内容",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "搜索模式（正则表达式）" },
      path: {
        type: "string",
        description: "搜索路径（文件或目录），默认当前目录",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    const baseDir = resolve(path);
    const regex = new RegExp(pattern, "i");
    const matches: string[] = [];
    const SKIP = new Set(["node_modules", ".git", "dist", "build"]);
    const BIN_EXT = new Set([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".bmp",
      ".zip",
      ".tar",
      ".gz",
      ".7z",
      ".woff",
      ".woff2",
      ".eot",
      ".ttf",
      ".otf",
      ".lock",
    ]);

    function searchFile(filePath: string) {
      if (matches.length >= 50) return; // 限制返回的匹配数量，避免过载
      const ext = filePath.slice(filePath.lastIndexOf("."));
      if (BIN_EXT.has(ext)) return; // 跳过常见二进制文件

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch (error) {
        return; // 无法读取的文件（如权限问题）直接跳过
      }

      const lines = content.split("\n");
      const rel = relative(baseDir, filePath);

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
          if (matches.length >= 50) break;
        }
      }
    }

    function walk(dir: string) {
      if (matches.length >= 50) return;
    }
  },
};

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
];
