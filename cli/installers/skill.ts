import type { HostId } from "../hosts/adapters.js";
import type { HostContext, LaunchMode, PlanConflict, PlanOperation, PlanWarning, Scope, UnsupportedCapability } from "../plan/model.js";

export interface SkillPlanRequest {
  operation: PlanOperation;
  scope: Scope;
  context: HostContext;
  /** Explicit Skill Agent selected with --host; never guessed. */
  host?: HostId;
  /** Absolute path of the in-package skill source (skills/pi-delegate). */
  sourceDir: string;
  packageVersion: string;
  /** Current content hook reserved for a stage-9 managed install manifest. */
  currentContent: string | null;
  /** Launch mode drives the explicit source ref selection (release vs checkout). */
  launchMode: LaunchMode;
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

/**
 * A path that the pinned Skills CLI may replace. The executor re-inspects
 * these paths immediately before running the CLI; ordinary existing skill
 * directories require a default-No confirmation, while unsafe paths are
 * refused outright and cannot be overridden with `--yes`.
 */
export type SkillCliSafetyKind = "existing-skill" | "symlink" | "not-directory" | "lock-conflict";

export interface SkillCliSafetyFinding {
  path: string;
  kind: SkillCliSafetyKind;
  message: string;
}

/**
 * Side-effect-free description of the pinned Skills CLI install. It contains
 * no environment values and no secrets, so it can be printed as part of the
 * plan before any confirmation.
 */
export interface SkillCliPlan {
  installer: "skills-cli";
  cliVersion: string;
  agent: HostId;
  scope: Scope;
  repository: string;
  subpath: string;
  /** Explicit `{repository}/tree/{ref}/{subpath}` argument handed to the CLI. */
  source: string;
  /** The exact pinned ref; never `main`. */
  ref: string;
  refKind: "release" | "commit";
  /** Resolved executable and full argv (no shell interpolation). */
  command: string;
  args: string[];
  /** Working directory for project-scope installs and the CLI run. */
  cwd: string;
  home: string;
  installDir: string;
  skillFile: string;
  contractFile: string;
  lockFile: string;
  expectedSource: string;
  expectedRef: string;
  safety: SkillCliSafetyFinding[];
  lossWarning: boolean;
}

export interface SkillPlan {
  directory: string;
  writes: SkillPlanFile[];
  removals: SkillPlanRemoval[];
  conflicts: PlanConflict[];
  warnings: PlanWarning[];
  /** Present only for the CLI-backed `add skill` installer. */
  cli?: SkillCliPlan;
}

export type SkillPlanResult =
  | { kind: "ok"; plan: SkillPlan }
  | { kind: "unsupported"; capability: UnsupportedCapability };

/**
 * Typed seam between the CLI plan generator and the skill installer. The
 * default implementation is the pinned Vercel Skills CLI installer; tests and
 * the fallback use the unavailable implementation, which plans nothing and
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
