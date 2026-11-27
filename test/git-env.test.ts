import { expect, test } from "vitest";
import { scrubGitEnv } from "./git-env.js";

test("a hook's repository selectors are dropped, the rest of the environment stays", () => {
  const env: NodeJS.ProcessEnv = { GIT_DIR: "/shared/.git", GIT_WORK_TREE: "/shared", GIT_INDEX_FILE: "/shared/.git/index",
    GIT_COMMON_DIR: "/shared/.git", GIT_PREFIX: "sub/", GIT_AUTHOR_NAME: "kept", PATH: "/bin" };
  scrubGitEnv(env);
  expect(env).toEqual({ GIT_AUTHOR_NAME: "kept", PATH: "/bin" });
});
