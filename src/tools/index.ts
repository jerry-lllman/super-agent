import { ToolDefinition } from "./registry";
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
} from "./file-tools";
import { globTool, grepTool } from "./search-tools";
import { bashTool } from "./shell-tools";
import { pickSearchTool, webFetchTool } from "./web-search";

export const allTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  globTool,
  grepTool,
  bashTool,
  pickSearchTool(),
  webFetchTool,
];

export {
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  globTool,
  grepTool,
  bashTool,
};
