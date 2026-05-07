import { briefWriterDefinition, runBriefWriter } from "./capabilities/briefWriter.js";
import { evidenceSynthesizerDefinition, runEvidenceSynthesizer } from "./capabilities/evidenceSynthesizer.js";
import { sourceCollectorToolDefinition, runSourceCollector } from "./sourceCollector.js";
import type { RegisteredTool, ToolExecutionResult } from "./shared/types.js";

export const toolRegistry = {
  source_collector: {
    definition: sourceCollectorToolDefinition,
    execute: runSourceCollector
  },
  evidence_synthesizer: {
    definition: evidenceSynthesizerDefinition,
    execute: runEvidenceSynthesizer
  },
  brief_writer: {
    definition: briefWriterDefinition,
    execute: runBriefWriter
  }
} satisfies Record<string, RegisteredTool>;

export type ToolName = keyof typeof toolRegistry;

export const toolDefinitions = Object.values(toolRegistry).map((tool) => tool.definition);

export async function executeRegisteredTool(name: string, args: unknown): Promise<ToolExecutionResult> {
  const tool = toolRegistry[name as ToolName];
  if (!tool) {
    throw new Error(`未知工具：${name}`);
  }

  return await tool.execute(args);
}
