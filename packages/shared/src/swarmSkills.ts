export type SkillCategoryId = "workflow" | "quality" | "ops" | "analysis";

export type SwarmSkillId =
  | "incremental_commits"
  | "refactor_only"
  | "monorepo_aware"
  | "test_driven"
  | "code_review"
  | "documentation"
  | "security_audit"
  | "dry_principle"
  | "accessibility"
  | "keep_ci_green"
  | "migration_safe"
  | "performance";

export type SwarmSkillDefinition = {
  id: SwarmSkillId;
  label: string;
  description: string;
  category: SkillCategoryId;
};

const SKILL_DEFINITIONS: Record<SwarmSkillId, SwarmSkillDefinition> = {
  incremental_commits: {
    id: "incremental_commits",
    label: "Incremental Commits",
    category: "workflow",
    description:
      "Commit small, atomic changes frequently so reviews stay short, rollbacks stay easy, and the team can adapt quickly when priorities shift.",
  },
  refactor_only: {
    id: "refactor_only",
    label: "Refactor Only",
    category: "workflow",
    description:
      "Restructure code and documentation without altering observable behavior, keeping the focus on clarity and future maintenance instead of feature churn.",
  },
  monorepo_aware: {
    id: "monorepo_aware",
    label: "Monorepo Aware",
    category: "workflow",
    description:
      "Respect existing package boundaries, shared utilities, and publishing rules so the swarm coexists cleanly with other work in the repository.",
  },
  test_driven: {
    id: "test_driven",
    label: "Test-Driven",
    category: "quality",
    description:
      "Author tests before implementing behavior, then make those tests pass so every release is backed by automated guardrails.",
  },
  code_review: {
    id: "code_review",
    label: "Code Review",
    category: "quality",
    description:
      "Review all changes thoroughly, call out risks, and ensure ownership before landing any work into shared branches.",
  },
  documentation: {
    id: "documentation",
    label: "Documentation",
    category: "quality",
    description:
      "Document public APIs, configuration knobs, and architectural tradeoffs so the reasoning stays discoverable for teammates and future reviewers.",
  },
  security_audit: {
    id: "security_audit",
    label: "Security Audit",
    category: "quality",
    description:
      "Scan for vulnerabilities, privilege escalations, and unsafe defaults on every change to keep the system resilient under attack.",
  },
  dry_principle: {
    id: "dry_principle",
    label: "DRY Principle",
    category: "quality",
    description:
      "Eliminate duplication aggressively by reusing proven abstractions instead of copying logic, even when the surface area feels small.",
  },
  accessibility: {
    id: "accessibility",
    label: "Accessibility",
    category: "quality",
    description:
      "Ensure UI and interactions meet WCAG standards so the experience works for people with diverse assistive needs.",
  },
  keep_ci_green: {
    id: "keep_ci_green",
    label: "Keep CI Green",
    category: "ops",
    description:
      "Let green checks be the signal to move forward, and never merge while suites are failing so dependents stay stable.",
  },
  migration_safe: {
    id: "migration_safe",
    label: "Migration Safe",
    category: "ops",
    description:
      "Treat database and schema changes as reversible, with fallbacks and safe ordering to avoid shipping breaking migrations.",
  },
  performance: {
    id: "performance",
    label: "Performance",
    category: "analysis",
    description:
      "Optimize for speed and resource efficiency, profiling hotspots rather than guessing where the next bottleneck will appear.",
  },
};

export type SkillCategoryDefinition = {
  id: SkillCategoryId;
  label: string;
  description: string;
  skills: SwarmSkillDefinition[];
};

const CATEGORY_DEFINITIONS: Record<
  SkillCategoryId,
  { label: string; description: string; skillIds: SwarmSkillId[] }
> = {
  workflow: {
    label: "Workflow",
    description: "How this swarm prefers to ship code and collaborate.",
    skillIds: ["incremental_commits", "refactor_only", "monorepo_aware"],
  },
  quality: {
    label: "Quality",
    description: "Standards we follow to keep results reliable.",
    skillIds: [
      "test_driven",
      "code_review",
      "documentation",
      "security_audit",
      "dry_principle",
      "accessibility",
    ],
  },
  ops: {
    label: "Ops",
    description: "Operational guardrails and stability practices.",
    skillIds: ["keep_ci_green", "migration_safe"],
  },
  analysis: {
    label: "Analysis",
    description: "How we validate performance and efficiency.",
    skillIds: ["performance"],
  },
};

export const SWARM_SKILL_DETAILS = Object.freeze(SKILL_DEFINITIONS);

export const SWARM_SKILL_CATEGORIES: SkillCategoryDefinition[] = (
  ["workflow", "quality", "ops", "analysis"] as SkillCategoryId[]
).map((categoryId) => {
  const category = CATEGORY_DEFINITIONS[categoryId];
  return {
    id: categoryId,
    label: category.label,
    description: category.description,
    skills: category.skillIds.map((skillId) => SWARM_SKILL_DETAILS[skillId]),
  };
});

export const SWARM_SKILL_LABELS: Record<SwarmSkillId, string> = Object.freeze(
  Object.fromEntries(
    Object.values(SWARM_SKILL_DETAILS).map((skill) => [skill.id, skill.label]),
  ) as Record<SwarmSkillId, string>,
);
