---
name: research_planning_skill
description: Turn a research request into a focused plan.
---

# Research Planning Skill

Identify the decision or discussion the user needs to support. Use this workflow when a topic is broad, when choosing initial sources, or when research needs to be refocused.

1. Identify the user goal and decision context.
2. Choose three to six required coverage aspects.
3. Define short, specific queries for each aspect.
4. Collect evidence before writing a final brief.

Keep the plan concise. With no sources, call `task` with `taskType: collect_sources`. With sources but no structured findings, call `synthesize_evidence`. With sufficient synthesized coverage, call `write_brief`.

A useful plan explains the decision, required aspects, questions that can wait, and the immediate next action.
