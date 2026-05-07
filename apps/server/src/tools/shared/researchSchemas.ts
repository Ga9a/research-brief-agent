import { z } from "zod";

export const sourceTypeSchema = z.enum(["web", "papers"]);
export const outputFormatSchema = z.enum(["comparison", "summary", "pros_cons", "decision_brief"]);
export const audienceSchema = z.enum(["self_learning", "team_lead", "presentation", "interview"]);
export const lengthSchema = z.enum(["short", "medium", "detailed"]);

export const researchSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().url(),
  sourceType: sourceTypeSchema,
  publisher: z.string().min(1),
  publishedAt: z.string().nullable(),
  summary: z.string().min(1),
  relevanceScore: z.number().min(0).max(1),
  credibilityScore: z.number().min(0).max(1)
});

export const researchSynthesisSchema = z.object({
  focus: z.string().min(1),
  researchQuestion: z.string().min(1).optional(),
  decisionContext: z.string().min(1).optional(),
  evaluationCriteria: z.array(z.string().min(1)).optional(),
  evidenceRequirements: z.array(z.string().min(1)).optional(),
  evidenceGaps: z.array(z.string().min(1)).optional(),
  outputFormat: outputFormatSchema,
  keyFindings: z.array(z.string().min(1)).min(1),
  comparisons: z
    .array(
      z.object({
        dimension: z.string().min(1),
        notes: z.string().min(1)
      })
    )
    .min(1),
  risksOrLimitations: z.array(z.string().min(1)).min(1),
  recommendation: z.string().min(1)
});

export function parseToolInput<T>(schema: z.ZodType<T>, args: unknown, toolLabel: string): T {
  const result = schema.safeParse(args);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "参数"))
      .join("、");
    throw new Error(`${toolLabel} 参数无效：${fields}`);
  }

  return result.data;
}
