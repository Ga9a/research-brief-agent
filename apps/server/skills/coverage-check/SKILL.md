---
name: coverage_check_skill
description: Check whether sources and structured findings cover the user goal.
---

# Coverage Check Skill

Use after collecting and synthesizing sources, or when a draft is too general.

Check the topic and use case, required concepts, method comparisons, representative references, risks and uncertainty, and actionable next steps.

- If core aspects are missing, continue calling `collect_sources` with specific gaps.
- If sources exist but findings are unstructured, call `synthesize_evidence`.
- If coverage is sufficient, call `write_brief`.
- Avoid endless collection; each additional search must address a specific gap.

The internal decision should explain what is covered, what remains missing, and why to collect more or write. The final answer should report material evidence gaps without exposing control logic.
