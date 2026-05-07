import { describe, expect, it } from "vitest";
import { loadSkillToolDefinition, runLoadSkill, validateLoadSkillArgs } from "../agent/loadSkillTool.js";
import { getDefaultSkillLoader, resetDefaultSkillLoaderForTest } from "../agent/skillLoader.js";

describe("SKILL.md 加载机制", () => {
  it("能发现技能名称和简介，用于低成本注入 system prompt", () => {
    resetDefaultSkillLoaderForTest();
    const loader = getDefaultSkillLoader();
    const descriptions = loader.getDescriptions();

    expect(descriptions).toContain("research_planning_skill");
    expect(descriptions).toContain("coverage_check_skill");
    expect(descriptions).toContain("evidence_extraction_skill");
  });

  it("load_skill 能按需返回完整技能正文", () => {
    const args = validateLoadSkillArgs({ name: "coverage_check_skill" });
    const result = runLoadSkill(args);

    expect(result.output).toContain('<skill name="coverage_check_skill">');
    expect(result.output).toContain("Coverage Check Skill");
    expect(result.output).toContain("继续调用 `collect_sources`");
  });

  it("load_skill tool definition 只要求技能名称", () => {
    expect(loadSkillToolDefinition.function.name).toBe("load_skill");
    expect(loadSkillToolDefinition.function.parameters).toMatchObject({
      required: ["name"]
    });
  });
});
