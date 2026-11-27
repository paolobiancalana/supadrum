/**
 * A git hook runs with GIT_DIR (and friends) pointing at the repository being
 * committed to. Fixture tests that `git init` a temp directory would then
 * initialise that repository instead and flip a shared .git/config to bare.
 */
const REPOSITORY_SELECTORS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

export function scrubGitEnv(env: NodeJS.ProcessEnv): void {
  for (const name of REPOSITORY_SELECTORS) delete env[name];
}
