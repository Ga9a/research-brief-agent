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
      "Load a complete SKILL.md workflow when needed. Do not load the same skill repeatedly.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "Skill name, such as research_planning_skill, coverage_check_skill, or evidence_extraction_skill."
        }
      }
    }
  }
};

export function validateLoadSkillArgs(args: unknown): LoadSkillArgs {
  const result = loadSkillArgsSchema.safeParse(args);
  if (!result.success) {
    throw new Error(`load_skill Invalid arguments: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }

  return result.data;
}

export function runLoadSkill(args: LoadSkillArgs, loader: SkillLoader = getDefaultSkillLoader()): ToolExecutionResult {
  return {
    output: loader.getContent(args.name)
  };
}
