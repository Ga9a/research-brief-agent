import type { DeepSeekToolDefinition } from "../../agent/deepseek.js";

export interface ToolExecutionResult {
  output: string;
}

export interface RegisteredTool {
  definition: DeepSeekToolDefinition;
  execute: (args: unknown) => Promise<ToolExecutionResult>;
}
