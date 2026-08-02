import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

import { isEntrypoint } from "../src/entrypoint.js";

describe("npm binary entrypoints", () => {
  test("recognizes a main module invoked through a symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "supadrum-entrypoint-"));
    const target = join(directory, "target.js");
    const symlink = join(directory, "supadrum");
    writeFileSync(target, "");
    symlinkSync(target, symlink);

    expect(isEntrypoint(pathToFileURL(target).href, symlink)).toBe(true);
  });
});
