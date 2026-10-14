import { z } from "zod";
import type { DeepSeekToolDefinition } from "./deepseek.js";

export const childTaskTypeSchema = z.enum(["collect_sources", "synthesize_evidence", "write_brief"]);
export type ChildTaskType = z.infer<typeof childTaskTypeSchema>;

const DEFAULT_TASK_INSTRUCTION = "Complete this subtask using the user question and available research context.";

const taskInstructionSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed;
}, z.string().min(2).default(DEFAULT_TASK_INSTRUCTION));

const inputRefSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}, z.string().min(1).max(120).optional());

export const taskArgsSchema = z.object({
  taskType: childTaskTypeSchema,
  instruction: taskInstructionSchema,
  inputRef: inputRefSchema
});

export type TaskToolArgs = z.infer<typeof taskArgsSchema>;

export const taskStepLabels: Record<ChildTaskType, string> = {
  collect_sources: "Collect sources",
  synthesize_evidence: "Synthesize evidence",
  write_brief: "Write brief"
};

export const taskToolDefinition: DeepSeekToolDefinition = {
  type: "function",
  function: {
    name: "task",
    description:
      "Dispatch a research subtask to an independent child agent. Assess evidence sufficiency and revision needs. When synthesis reports insufficient coverage, collect missing sources and synthesize again before writing. Do not copy sources, synthesis, or other large objects.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["taskType"],
      properties: {
        taskType: {
          type: "string",
          description:
            "Task type: collect_sources for initial or gap-directed collection; synthesize_evidence for collected sources; write_brief for synthesized evidence with sufficient coverage.",
          enum: ["collect_sources", "synthesize_evidence", "write_brief"]
        },
        instruction: {
          type: "string",
          description:
            "Optional short English instruction describing the goal and focus. For additional collection, identify evidence gaps or suggested queries. The server supplies a default when omitted."
        }
      }
    }
  }
};

export function validateTaskArgs(args: unknown): TaskToolArgs {
  const result = taskArgsSchema.safeParse(args);
  if (!result.success) {
    throw new Error(`task Invalid arguments: ${formatTaskValidationIssues(result.error.issues)}`);
  }

  return result.data;
}

function formatTaskValidationIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "arguments";
      if (field === "taskType") {
        return "taskType must be collect_sources, synthesize_evidence, or write_brief";
      }

      if (field === "instruction") {
        return "Missing instructions are tolerated; if validation still fails, supply a short English instruction";
      }

      if (field === "inputRef") {
        return "Omit inputRef unless referencing an existing result";
      }

      return `${field} ${issue.message}`;
    })
    .join("; ");
}
