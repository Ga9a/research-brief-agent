import type { DeepSeekToolDefinition } from "./deepseek.js";
import type { ResearchArtifactKind } from "./artifactStore.js";
import type { ChildTaskType } from "./taskTool.js";
import { taskStepLabels } from "./taskTool.js";
import { briefWriterDefinition } from "../tools/capabilities/briefWriter.js";
import { evidenceSynthesizerDefinition } from "../tools/capabilities/evidenceSynthesizer.js";
import { sourceCollectorToolDefinition } from "../tools/sourceCollector.js";

export interface ChildAgentProfile {
  taskType: ChildTaskType;
  stepLabel: string;
  systemPrompt: string;
  toolName: "source_collector" | "evidence_synthesizer" | "brief_writer";
  tools: DeepSeekToolDefinition[];
  outputKind: ResearchArtifactKind;
  requiredInputKind?: ResearchArtifactKind;
}

export const childAgentProfiles: Record<ChildTaskType, ChildAgentProfile> = {
  collect_sources: {
    taskType: "collect_sources",
    stepLabel: taskStepLabels.collect_sources,
    systemPrompt:
      "You collect sources. Call only source_collector to collect real web or paper sources. When coverage feedback is supplied, target its missing aspects and queries. Do not write the final brief.",
    toolName: "source_collector",
    tools: [sourceCollectorToolDefinition],
    outputKind: "sources"
  },
  synthesize_evidence: {
    taskType: "synthesize_evidence",
    stepLabel: taskStepLabels.synthesize_evidence,
    systemPrompt:
      "You synthesize evidence. Call only evidence_synthesizer to organize injected sources into findings, comparisons, limitations, and recommendations. Pass outputFormat if needed; the server injects focus and sources. The parent decides whether to collect additional evidence based on server coverage feedback.",
    toolName: "evidence_synthesizer",
    tools: [evidenceSynthesizerDefinition],
    outputKind: "synthesis",
    requiredInputKind: "sources"
  },
  write_brief: {
    taskType: "write_brief",
    stepLabel: taskStepLabels.write_brief,
    systemPrompt:
      "You write an English research brief. Call only brief_writer with audience and length; the server injects synthesis.",
    toolName: "brief_writer",
    tools: [briefWriterDefinition],
    outputKind: "brief",
    requiredInputKind: "synthesis"
  }
};
