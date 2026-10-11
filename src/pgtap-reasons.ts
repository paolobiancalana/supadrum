import type { PgtapConfigReason } from "./pgtap-config.js";
import type { PgtapPrerequisiteReason } from "./pgtap-stack.js";
import type { PgtapTreeReason } from "./pgtap-tree.js";

/**
 * Why a `pgtap.run` ended without a verdict of its own; the executor writes
 * it in `verification.reason` (#55) and the CLI maps it to an exit code with
 * an exhaustive switch (#56). The three module unions are included, so a new
 * refusal in any of them is a type error here until it is listed and mapped.
 */
export const pgtapReasons = [
  "tree_invalid",
  "tree_incomplete",
  "extraction_failed",
  "docker_unreachable",
  "supabase_cli_missing",
  "supabase_cli_too_old",
  "no_probe_image",
  "space_probe_failed",
  "insufficient_space",
  "reserved_project_id",
  "original_port_left",
  "ports_exhausted",
  "tests_path_missing",
  "cleanup_before_failed",
  "start_failed",
  "phase_timeout",
  "tests_failed",
  "queue_timeout"
] as const;

export type PgtapReason = (typeof pgtapReasons)[number];

type ModuleReason = PgtapTreeReason | PgtapPrerequisiteReason | PgtapConfigReason;
const moduleReasonsAreListed: ModuleReason extends PgtapReason ? true : never = true;
void moduleReasonsAreListed;
