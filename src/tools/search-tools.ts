import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import fg from "fast-glob";
import { ToolDefinition } from "./registry";

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: '搜索模式，如 "**/*.ts"、"src/*.json"',
      },
      path: { type: "string", description: "搜索起始目录，默认当前目录" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    // 使用 fast-glob 做文件名匹配，并跳过依赖、构建产物等常见噪声目录。
    const results = await fg(pattern, {
      cwd: resolve(path),
      ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`;
    return results.sort().join("\n");
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

    // 搜索单个文本文件，记录匹配行并限制总结果数量，避免返回内容过长。
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

    // 深度遍历目录树，把可读文本文件交给 searchFile 处理。
    function walk(dir: string) {
      if (matches.length >= 50) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const name of entries) {
        if (SKIP.has(name)) continue;
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full);
          } else {
            searchFile(full);
          }
        } catch (error) {
          // skip
        }
      }
    }

    const stat = statSync(baseDir);
    if (stat.isFile()) {
      searchFile(baseDir);
    } else {
      walk(baseDir);
    }

    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`;
    const suffix =
      matches.length >= 50 ? "\n... （结果以截断，共 50+ 条匹配）" : "";
    return matches.join("\n") + suffix;
  },
};
