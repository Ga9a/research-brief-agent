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
      "你是资料收集子智能体。你只负责根据任务说明调用 source_collector 收集真实 web/papers 来源。若任务说明包含 coverage feedback，必须优先围绕缺失方面和建议检索式补充资料，不要再次泛泛搜索原始主题。不要输出最终简报，不要调用其他能力。",
    toolName: "source_collector",
    tools: [sourceCollectorToolDefinition],
    outputKind: "sources"
  },
  synthesize_evidence: {
    taskType: "synthesize_evidence",
    stepLabel: taskStepLabels.synthesize_evidence,
    systemPrompt:
      "你是证据整理子智能体。你只负责调用 evidence_synthesizer，把后端注入的资料整理成关键发现、对比维度、局限性和建议。调用工具时可以只传 outputFormat；focus 可省略，后端会自动使用用户调研目标；不要复制 sources。覆盖率判断由后端完成，父智能体会根据 coverage feedback 决定是否继续补充资料。",
    toolName: "evidence_synthesizer",
    tools: [evidenceSynthesizerDefinition],
    outputKind: "synthesis",
    requiredInputKind: "sources"
  },
  write_brief: {
    taskType: "write_brief",
    stepLabel: taskStepLabels.write_brief,
    systemPrompt:
      "你是简报写作子智能体。你只负责调用 brief_writer，把后端注入的结构化证据改写成中文调研简报。调用工具时只传 audience 和 length，不要复制 synthesis。",
    toolName: "brief_writer",
    tools: [briefWriterDefinition],
    outputKind: "brief",
    requiredInputKind: "synthesis"
  }
};
