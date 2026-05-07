import { z } from "zod";
import type { DeepSeekToolDefinition } from "./deepseek.js";

export const childTaskTypeSchema = z.enum(["collect_sources", "synthesize_evidence", "write_brief"]);
export type ChildTaskType = z.infer<typeof childTaskTypeSchema>;

const DEFAULT_TASK_INSTRUCTION = "根据用户问题和已有调研上下文完成该子任务。";

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
  collect_sources: "收集资料",
  synthesize_evidence: "整理证据",
  write_brief: "生成简报"
};

export const taskToolDefinition: DeepSeekToolDefinition = {
  type: "function",
  function: {
    name: "task",
    description:
      "把一个明确的调研子任务交给独立子智能体执行。父智能体负责判断资料是否足够、是否需要追加收集、是否需要重新整理或重新生成简报。若上一轮整理证据返回 coverage feedback 且覆盖不足，必须先 collect_sources 补充缺口，再 synthesize_evidence；不要直接 write_brief。不要复制 sources、synthesis 或其他大对象。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["taskType"],
      properties: {
        taskType: {
          type: "string",
          description:
            "子任务类型。collect_sources 可用于首次或按 coverage feedback 补充收集；synthesize_evidence 需要已有资料；write_brief 需要已有证据整理结果且覆盖率足够，覆盖不足时应先补充收集。",
          enum: ["collect_sources", "synthesize_evidence", "write_brief"]
        },
        instruction: {
          type: "string",
          description:
            "可选。给子智能体的一句中文任务说明，只描述目标和关注点；如果是 coverage feedback 后的补充收集，应写清缺失方面或建议检索式；不传时后端会使用默认说明。"
        }
      }
    }
  }
};

export function validateTaskArgs(args: unknown): TaskToolArgs {
  const result = taskArgsSchema.safeParse(args);
  if (!result.success) {
    throw new Error(`task 参数无效：${formatTaskValidationIssues(result.error.issues)}`);
  }

  return result.data;
}

function formatTaskValidationIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "参数";
      if (field === "taskType") {
        return "taskType 必须是 collect_sources、synthesize_evidence 或 write_brief";
      }

      if (field === "instruction") {
        return "instruction 已自动容错为空值；如果仍失败，请传一句简短中文说明";
      }

      if (field === "inputRef") {
        return "inputRef 应省略，除非需要指定已有结果引用";
      }

      return `${field} ${issue.message}`;
    })
    .join("；");
}
