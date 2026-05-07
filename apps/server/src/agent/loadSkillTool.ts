import { z } from "zod";
import type { DeepSeekToolDefinition } from "./deepseek.js";
import { getDefaultSkillLoader, type SkillLoader } from "./skillLoader.js";
import type { ToolExecutionResult } from "../tools/shared/types.js";

export const loadSkillArgsSchema = z.object({
  name: z.string().min(1).max(80)
});

export type LoadSkillArgs = z.infer<typeof loadSkillArgsSchema>;

export const loadSkillToolDefinition: DeepSeekToolDefinition = {
  type: "function",
  function: {
    name: "load_skill",
    description:
      "按需加载一个 SKILL.md 的完整说明。只有当你需要某个技能的详细流程时才调用；不要重复加载同一个技能。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "要加载的技能名称，例如 research_planning_skill、coverage_check_skill 或 evidence_extraction_skill。"
        }
      }
    }
  }
};

export function validateLoadSkillArgs(args: unknown): LoadSkillArgs {
  const result = loadSkillArgsSchema.safeParse(args);
  if (!result.success) {
    throw new Error(`load_skill 参数无效：${result.error.issues.map((issue) => issue.message).join("；")}`);
  }

  return result.data;
}

export function runLoadSkill(args: LoadSkillArgs, loader: SkillLoader = getDefaultSkillLoader()): ToolExecutionResult {
  return {
    output: loader.getContent(args.name)
  };
}
