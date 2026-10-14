import { describe, expect, it } from "vitest";
import { loadSkillToolDefinition, runLoadSkill, validateLoadSkillArgs } from "../agent/loadSkillTool.js";
import { getDefaultSkillLoader, resetDefaultSkillLoaderForTest } from "../agent/skillLoader.js";

describe("skillLoader", () => {
  it("discovers skill metadata", () => {
    resetDefaultSkillLoaderForTest();
    const loader = getDefaultSkillLoader();
    const descriptions = loader.getDescriptions();

    expect(descriptions).toContain("research_planning_skill");
    expect(descriptions).toContain("coverage_check_skill");
    expect(descriptions).toContain("evidence_extraction_skill");
  });

  it("loads complete skill content", () => {
    const args = validateLoadSkillArgs({ name: "coverage_check_skill" });
    const result = runLoadSkill(args);

    expect(result.output).toContain('<skill name="coverage_check_skill">');
    expect(result.output).toContain("Coverage Check Skill");
    expect(result.output).toContain("continue calling `collect_sources`");
  });

  it("requires only the skill name", () => {
    expect(loadSkillToolDefinition.function.name).toBe("load_skill");
    expect(loadSkillToolDefinition.function.parameters).toMatchObject({
      required: ["name"]
    });
  });
});
