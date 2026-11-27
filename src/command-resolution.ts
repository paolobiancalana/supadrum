import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";

export interface ResolvedCommand {
  readonly argv: readonly string[];
  readonly path: string;
}

export function resolveExecutable(
  name: "git" | "supabase" | "psql" | "prisma",
  environment: NodeJS.ProcessEnv = process.env
): string {
  return resolveNativeExecutable(name, environment);
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveNativeExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const override = environment[`SUPADRUM_${name.toUpperCase()}_BIN`];
  if (override) {
    if (process.platform === "win32" && [".cmd", ".bat"].includes(extname(override).toLowerCase())) {
      throw new Error(`Executable override ${name} must be a native executable; .cmd/.bat require shell interpretation`);
    }
    if (!executable(override)) {
      throw new Error(`Executable override ${name} is not a file with required execute permission`);
    }
    return realpathSync(override);
  }
  const pathValue = Object.entries(environment).find(([key]) =>
    process.platform === "win32" ? key.toLowerCase() === "path" : key === "PATH"
  )?.[1];
  const candidates = [
    ...(pathValue?.split(delimiter).flatMap((directory) =>
      process.platform === "win32"
        ? [`${join(directory, name)}.exe`, join(directory, name)]
        : [join(directory, name)]
    ) ?? []),
    ...(process.platform === "win32" ? [] : [
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`
    ])
  ];
  const candidate = candidates.find((path) => executable(path) &&
    !(process.platform === "win32" && [".cmd", ".bat"].includes(extname(path).toLowerCase()))
  );
  if (candidate) return realpathSync(candidate);
  throw new Error(`Executable ${name} not found; set SUPADRUM_${name.toUpperCase()}_BIN`);
}


function packageBin(packageJson: string, bin: string): string | undefined {
  try {
    const metadata = JSON.parse(readFileSync(packageJson, "utf8")) as {
      readonly bin?: string | Record<string, string>;
    };
    const target = typeof metadata.bin === "string"
      ? metadata.bin
      : metadata.bin?.[bin];
    if (!target) return undefined;
    const entrypoint = resolve(dirname(packageJson), target);
    return existsSync(entrypoint) ? realpathSync(entrypoint) : undefined;
  } catch {
    return undefined;
  }
}

export function findAdjacentNpmEntrypoint(nodeExecutable: string): string | undefined {
  const directory = dirname(nodeExecutable);
  return [
    join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(directory, "node_modules", "npm", "bin", "npm-cli"),
    join(dirname(directory), "node_modules", "npm", "bin", "npm-cli.js")
  ].find((candidate) => existsSync(candidate));
}

export function resolveNodeCommand(
  name: "npm" | "prisma",
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly repository?: string;
  } = {}
): ResolvedCommand {
  const environment = options.environment ?? process.env;
  const override = environment[`SUPADRUM_${name.toUpperCase()}_BIN`];
  if (override) {
    const extension = extname(override).toLowerCase();
    if (extension === ".cmd" || extension === ".bat") {
      throw new Error(`${name} .cmd/.bat overrides are unsupported with shell:false; configure a Node executable and JS entrypoint`);
    }
    if (!existsSync(override) || !statSync(override).isFile()) {
      throw new Error(`${name} override must point to an existing file`);
    }
    const path = realpathSync(override);
    if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
      return { argv: [process.execPath, path], path: dirname(process.execPath) };
    }
    return { argv: [path], path: dirname(path) };
  }

  const entrypoint = name === "npm"
    ? environment.npm_execpath ?? (process.platform === "win32"
      ? findAdjacentNpmEntrypoint(process.execPath)
      : undefined)
    : options.repository
      ? packageBin(join(options.repository, "node_modules", name, "package.json"), name)
      : undefined;
  if (entrypoint && existsSync(entrypoint)) {
    const absoluteEntrypoint = realpathSync(entrypoint);
    return {
      argv: [process.execPath, absoluteEntrypoint],
      path: dirname(process.execPath)
    };
  }

  if (name === "prisma" && options.repository) {
    const platformShim = join(options.repository, "node_modules", ".bin", "prisma");
    if (executable(platformShim)) return { argv: [realpathSync(platformShim)], path: dirname(realpathSync(platformShim)) };
  }

  if (name === "npm" && process.platform !== "win32") {
    const binary = resolveNativeExecutable(name, environment);
    return { argv: [binary], path: dirname(binary) };
  }
  if (name === "prisma" && process.platform !== "win32") {
    const binary = resolveNativeExecutable(name, environment);
    return { argv: [binary], path: dirname(binary) };
  }
  throw new Error(
    `${name} JS entrypoint not found; install it with npm or configure SUPADRUM_${name.toUpperCase()}_BIN`
  );
}
