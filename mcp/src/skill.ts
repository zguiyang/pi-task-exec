import type { HostContext, PlanConflict, PlanWarning, Scope, UnsupportedCapability } from "./plan.js";

export interface SkillPlanRequest {
  scope: Scope;
  context: HostContext;
  /** Absolute path of the in-package skill source (skills/pi-delegate). */
  sourceDir: string;
  packageVersion: string;
  /** Current content hook reserved for a stage-9 managed install manifest. */
  currentContent: string | null;
}

export interface SkillPlanFile {
  path: string;
  content: string;
  baseSha256: string | null;
  summary: string;
}

export interface SkillPlanRemoval {
  path: string;
  sha256: string;
  managedBy: string;
  summary: string;
}

export interface SkillPlan {
  directory: string;
  writes: SkillPlanFile[];
  removals: SkillPlanRemoval[];
  conflicts: PlanConflict[];
  warnings: PlanWarning[];
}

export type SkillPlanResult =
  | { kind: "ok"; plan: SkillPlan }
  | { kind: "unsupported"; capability: UnsupportedCapability };

/**
 * Typed seam between the CLI plan generator and the (stage 9) skill installer.
 * Stage 7 ships only the unavailable implementation, which plans nothing and
 * writes nothing.
 */
export interface SkillInstaller {
  readonly id: string;
  plan(request: SkillPlanRequest): Promise<SkillPlanResult>;
}

export class UnavailableSkillInstaller implements SkillInstaller {
  readonly id = "unavailable";

  async plan(request: SkillPlanRequest): Promise<SkillPlanResult> {
    return {
      kind: "unsupported",
      capability: {
        code: "skill_installer_unavailable",
        target: "skill",
        scope: request.scope,
        message: "Skill installation is deferred to the generic .agents/skills installer stage; no skill files were planned or written.",
      },
    };
  }
}

export function unavailableSkillInstaller(): SkillInstaller {
  return new UnavailableSkillInstaller();
}
