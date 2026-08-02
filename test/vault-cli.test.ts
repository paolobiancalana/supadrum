import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MacOsKeychainBackend,
  MissingVaultValueError,
  SopsAgeBackend,
  SopsAgeBackup,
  bootstrapAgeIdentity,
  nodeProcessRunner,
  runVaultCli,
  type ProcessInvocation,
  type ProcessOutcome,
  type ProcessRunner,
  type VaultCliIo
} from "../src/vault-cli.js";
import type { VaultBackend } from "../src/vault.js";

class RecordingRunner implements ProcessRunner {
  readonly invocations: ProcessInvocation[] = [];
  readonly outcomes: ProcessOutcome[] = [];

  async run(invocation: ProcessInvocation): Promise<ProcessOutcome> {
    this.invocations.push(invocation);
    return (
      this.outcomes.shift() ?? {
        exitCode: 0,
        stdout: "",
        stderr: ""
      }
    );
  }
}

class MemoryBackend implements VaultBackend {
  readonly values = new Map<string, string>();

  async get(reference: string): Promise<string> {
    const value = this.values.get(reference);
    if (value === undefined) throw new Error(`Missing reference: ${reference}`);
    return value;
  }

  async put(reference: string, value: string): Promise<void> {
    this.values.set(reference, value);
  }
}

function io(stdin: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const value: VaultCliIo = {
    readStdin: async () => stdin,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text)
  };
  return { io: value, stdout, stderr };
}

const reference = "vault://supabase/example-web/management";

function keychainItem(value: string): string {
  return `supadrum:v1:${Buffer.from(value, "utf8").toString("base64")}`;
}

describe("macOS Keychain backend", () => {
  test("rejects accounts that are unsafe in an interactive command", () => {
    expect(
      () => new MacOsKeychainBackend(new RecordingRunner(), "operator; quit")
    ).toThrow("Keychain account contains unsafe characters");
  });

  test("requires an account when the environment does not name one", () => {
    expect(() => new MacOsKeychainBackend(new RecordingRunner(), "")).toThrow(
      "Keychain account is required"
    );
  });

  test("maps references to deterministic Keychain items", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({
      exitCode: 0,
      stdout: `supadrum:v1:${Buffer.from("resolved-value").toString("base64")}\n`,
      stderr: ""
    });
    const backend = new MacOsKeychainBackend(runner, "operator");

    await expect(backend.get(reference)).resolves.toBe("resolved-value");
    expect(runner.invocations).toEqual([
      {
        argv: [
          "security",
          "find-generic-password",
          "-s",
          `supadrum:${reference}`,
          "-a",
          "operator",
          "-w"
        ]
      }
    ]);
  });

  test.each([
    {
      case: "an item some other tool owns",
      stored: "plain-secret-from-another-tool",
      message: "Keychain item has an unsupported Supadrum format"
    },
    {
      case: "a truncated payload",
      stored: "supadrum:v1:dG9wLXNlY3JldC1jYW5hcm",
      message: "Keychain item has invalid Supadrum encoding"
    },
    {
      case: "a payload that is not the text that was stored",
      stored: `supadrum:v1:${Buffer.from([0xff, 0xfe]).toString("base64")}`,
      message: "Keychain item has invalid Supadrum encoding"
    }
  ])("refuses to hand back $case", async ({ stored, message }) => {
    const runner = new RecordingRunner();
    runner.outcomes.push({ exitCode: 0, stdout: `${stored}\n`, stderr: "" });
    const backend = new MacOsKeychainBackend(runner, "operator");

    await expect(backend.get(reference)).rejects.toThrow(message);
  });

  test("reports a missing item apart from an unreadable one", async () => {
    const missing = new RecordingRunner();
    missing.outcomes.push({ exitCode: 44, stdout: "", stderr: "" });
    const locked = new RecordingRunner();
    locked.outcomes.push({ exitCode: 1, stdout: "", stderr: "denied" });

    await expect(
      new MacOsKeychainBackend(missing, "operator").get(reference)
    ).rejects.toThrow(MissingVaultValueError);
    // A locked or denied Keychain must not read as "no value yet": callers
    // treat that as permission to mint a replacement.
    await expect(
      new MacOsKeychainBackend(locked, "operator").get(reference)
    ).rejects.not.toThrow(MissingVaultValueError);
  });

  test("refuses an item that decodes to nothing", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({ exitCode: 0, stdout: "\n", stderr: "" });

    await expect(
      new MacOsKeychainBackend(runner, "operator").get(reference)
    ).rejects.toThrow("Keychain item is empty");
  });

  test("writes an encoded value through the security interactive stdin", async () => {
    const runner = new RecordingRunner();
    const backend = new MacOsKeychainBackend(runner, "operator");

    await backend.put(reference, "top-secret-canary");

    expect(runner.invocations).toEqual([
      {
        argv: ["security", "-i"],
        stdin:
          `add-generic-password -U -s supadrum:${reference} ` +
          `-a operator -w supadrum:v1:` +
          `${Buffer.from("top-secret-canary").toString("base64")}\n`
      }
    ]);
    expect(JSON.stringify(runner.invocations[0]?.argv)).not.toContain(
      "top-secret-canary"
    );
  });

  test("refuses to overwrite a stored credential with nothing", async () => {
    const runner = new RecordingRunner();
    const backend = new MacOsKeychainBackend(runner, "operator");

    await expect(backend.put(reference, "")).rejects.toThrow(
      "Keychain value cannot be empty"
    );
    expect(runner.invocations).toEqual([]);
  });

  test("surfaces a rejected write instead of reporting success", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({ exitCode: 1, stdout: "", stderr: "denied" });
    const backend = new MacOsKeychainBackend(runner, "operator");

    await expect(backend.put(reference, "top-secret-canary")).rejects.toThrow(
      "Keychain write failed"
    );
  });

  test("imports and verifies an existing Keychain item without returning it", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(
      { exitCode: 0, stdout: "existing-secret\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      {
        exitCode: 0,
        stdout:
          `supadrum:v1:${Buffer.from("existing-secret").toString("base64")}\n`,
        stderr: ""
      }
    );
    const backend = new MacOsKeychainBackend(runner, "operator");

    await expect(
      backend.import(reference, {
        service: "supabase-pat",
        account: "operator"
      })
    ).resolves.toEqual({ reference, verified: true });

    expect(
      runner.invocations.every(
        (invocation) =>
          !JSON.stringify(invocation.argv).includes("existing-secret")
      )
    ).toBe(true);
    expect(runner.invocations[1]?.stdin).toBe(
      `add-generic-password -U -s supadrum:${reference} ` +
        `-a operator -w supadrum:v1:` +
        `${Buffer.from("existing-secret").toString("base64")}\n`
    );
  });

  test.each(["", "operator"])(
    "refuses an import whose source names no service (account %j)",
    async (account) => {
      const runner = new RecordingRunner();
      const backend = new MacOsKeychainBackend(runner, "operator");

      await expect(
        backend.import(reference, { service: "", account })
      ).rejects.toThrow("Keychain import source is incomplete");
      expect(runner.invocations).toEqual([]);
    }
  );

  test("does not report an import as verified when the item did not change", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push(
      { exitCode: 0, stdout: "existing-secret\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: `${keychainItem("stale-secret")}\n`, stderr: "" }
    );
    const backend = new MacOsKeychainBackend(runner, "operator");

    await expect(
      backend.import(reference, { service: "supabase-pat", account: "operator" })
    ).rejects.toThrow("Keychain import round-trip mismatch");
  });
});

describe("node process runner", () => {
  const node = (script: string) => [process.execPath, "-e", script];

  test("refuses an invocation that names no program", async () => {
    await expect(nodeProcessRunner.run({ argv: [] })).rejects.toThrow(
      "Process argv cannot be empty"
    );
  });

  test("keeps a child's stdout, stderr and exit code apart", async () => {
    await expect(
      nodeProcessRunner.run({
        argv: node(
          'process.stdout.write("out");process.stderr.write("err");process.exitCode=44'
        )
      })
    ).resolves.toEqual({ exitCode: 44, stdout: "out", stderr: "err" });
  });

  test("feeds the value through stdin rather than the command line", async () => {
    const invocation = {
      argv: node(
        'let d="";process.stdin.on("data",(c)=>{d+=c});' +
          'process.stdin.on("end",()=>process.stdout.write(d.toUpperCase()))'
      ),
      stdin: "top-secret-canary"
    };

    const outcome = await nodeProcessRunner.run(invocation);

    expect(outcome.stdout).toBe("TOP-SECRET-CANARY");
    expect(invocation.argv.join(" ")).not.toContain("top-secret-canary");
  });

  test("rejects when the program is not installed", async () => {
    await expect(
      nodeProcessRunner.run({
        argv: ["supadrum-no-such-binary"],
        stdin: "top-secret-canary"
      })
    ).rejects.toThrow(/ENOENT/);
  });

  test("does not read a killed child as a success", async () => {
    // security and sops are killed rather than exited when a sandbox or an
    // OOM reaper takes them; a null exit status must not pass for zero.
    const outcome = await nodeProcessRunner.run({
      argv: node('process.kill(process.pid,"SIGKILL")')
    });

    expect(outcome.exitCode).not.toBe(0);
  });
});

describe("vault operator CLI", () => {
  test("prints help successfully", async () => {
    const streams = io("");

    const exitCode = await runVaultCli(["--help"], streams.io, {
      keychain: new MemoryBackend()
    });

    expect(exitCode).toBe(0);
    expect(streams.stdout.join("")).toContain("supadrum-vault");
    expect(streams.stderr).toEqual([]);
  });

  test("resolves the stdin reference to stdout", async () => {
    const backend = new MemoryBackend();
    backend.values.set(reference, "resolved-value");
    const streams = io(`${reference}\n`);

    const exitCode = await runVaultCli(
      ["keychain", "resolve"],
      streams.io,
      { keychain: backend }
    );

    expect(exitCode).toBe(0);
    expect(streams.stdout).toEqual(["resolved-value"]);
    expect(streams.stderr).toEqual([]);
  });

  test("puts stdin into the argv reference and prints metadata only", async () => {
    const backend = new MemoryBackend();
    const streams = io("top-secret-canary\n");

    const exitCode = await runVaultCli(
      ["keychain", "put", reference],
      streams.io,
      { keychain: backend }
    );

    expect(exitCode).toBe(0);
    expect(backend.values.get(reference)).toBe("top-secret-canary");
    expect(streams.stdout).toEqual([
      `${JSON.stringify({ reference, verified: true })}\n`
    ]);
    expect(streams.stdout.join("")).not.toContain("top-secret-canary");
  });
});

describe("SOPS age backend", () => {
  const ageIdentity = [
    "# created: 2026-07-29T00:00:00Z",
    "# public key: age1canaryrecipient",
    "AGE-SECRET-KEY-1CANARY"
  ].join("\n");
  const recipient = "age1canaryrecipient";

  test("extracts one reference with the age identity only in the child environment", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({
      exitCode: 0,
      stdout: "resolved-secret",
      stderr: "non-secret diagnostic that must not reach output"
    });
    const keychain = new MemoryBackend();
    keychain.values.set("vault://supadrum/keys/age", ageIdentity);
    const backend = new SopsAgeBackend(
      "/operator/secrets.enc.json",
      keychain,
      runner
    );

    await expect(backend.get(reference)).resolves.toBe("resolved-secret");

    expect(runner.invocations).toHaveLength(1);
    expect(runner.invocations[0]?.argv).toEqual([
      "sops",
      "decrypt",
      "--extract",
      '["supabase"]["example-web"]["management"]',
      "/operator/secrets.enc.json"
    ]);
    expect(runner.invocations[0]?.env?.SOPS_AGE_KEY).toBe(ageIdentity);
    expect(JSON.stringify(runner.invocations[0]?.argv)).not.toContain(
      ageIdentity
    );
    expect(JSON.stringify(runner.invocations[0]?.argv)).not.toContain(
      "resolved-secret"
    );
  });

  test("bootstraps a missing age identity and returns only its recipient", async () => {
    class EmptyKeychain extends MemoryBackend {
      override async get(vaultReference: string): Promise<string> {
        const value = this.values.get(vaultReference);
        if (value === undefined) {
          throw new MissingVaultValueError(vaultReference);
        }
        return value;
      }
    }
    const keychain = new EmptyKeychain();
    const runner = new RecordingRunner();
    runner.outcomes.push(
      { exitCode: 0, stdout: ageIdentity, stderr: recipient },
      { exitCode: 0, stdout: `${recipient}\n`, stderr: "" }
    );

    await expect(bootstrapAgeIdentity(keychain, runner)).resolves.toBe(
      recipient
    );

    expect(runner.invocations).toEqual([
      { argv: ["age-keygen"] },
      { argv: ["age-keygen", "-y"], stdin: ageIdentity }
    ]);
    expect(
      runner.invocations.every(
        (invocation) => !JSON.stringify(invocation.argv).includes(ageIdentity)
      )
    ).toBe(true);
    expect(keychain.values.get("vault://supadrum/keys/age")).toBe(ageIdentity);
  });

  test("reuses an existing age identity instead of rotating it", async () => {
    const keychain = new MemoryBackend();
    keychain.values.set("vault://supadrum/keys/age", ageIdentity);
    const runner = new RecordingRunner();
    runner.outcomes.push({
      exitCode: 0,
      stdout: `${recipient}\n`,
      stderr: ""
    });

    await expect(bootstrapAgeIdentity(keychain, runner)).resolves.toBe(
      recipient
    );
    expect(runner.invocations).toEqual([
      { argv: ["age-keygen", "-y"], stdin: ageIdentity }
    ]);
  });

  test("does not rotate an identity when Keychain access is denied", async () => {
    class InaccessibleKeychain extends MemoryBackend {
      override async get(): Promise<string> {
        throw new Error("Keychain item is inaccessible");
      }
    }
    const runner = new RecordingRunner();

    await expect(
      bootstrapAgeIdentity(new InaccessibleKeychain(), runner)
    ).rejects.toThrow("Keychain item is inaccessible");
    expect(runner.invocations).toEqual([]);
  });

  test("writes and verifies only encrypted backup bytes before atomic replacement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supadrum-sops-"));
    const path = join(directory, "secrets.enc.json");
    const encrypted = '{"sops":{"version":"test"},"ciphertext":"ENC[...]"}';
    const plaintextTree = {
      supabase: {
        "example-web": {
          management: "top-secret-canary"
        }
      }
    };
    const keychain = new MemoryBackend();
    keychain.values.set("vault://supadrum/keys/age", ageIdentity);
    const runner = new RecordingRunner();
    runner.outcomes.push(
      { exitCode: 0, stdout: encrypted, stderr: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify(plaintextTree),
        stderr: ""
      }
    );

    try {
      const backup = new SopsAgeBackup(path, recipient, keychain, runner);
      await backup.writeAndVerify({
        [reference]: "top-secret-canary"
      });

      expect(await readFile(path, "utf8")).toBe(encrypted);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).not.toContain("top-secret-canary");
      expect(runner.invocations[0]).toEqual({
        argv: [
          "sops",
          "encrypt",
          "--input-type",
          "json",
          "--output-type",
          "json",
          "--filename-override",
          "supadrum-secrets.json",
          "--age",
          recipient
        ],
        stdin: JSON.stringify(plaintextTree)
      });
      expect(runner.invocations[1]?.argv.slice(0, 4)).toEqual([
        "sops",
        "decrypt",
        "--output-type",
        "json"
      ]);
      expect(runner.invocations[1]?.env?.SOPS_AGE_KEY).toBe(ageIdentity);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("leaves the previous encrypted backup unchanged when verification fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supadrum-sops-"));
    const path = join(directory, "secrets.enc.json");
    const previous = '{"previous":"ciphertext"}';
    await writeFile(path, previous, { mode: 0o600 });
    const keychain = new MemoryBackend();
    keychain.values.set("vault://supadrum/keys/age", ageIdentity);
    const runner = new RecordingRunner();
    runner.outcomes.push(
      { exitCode: 0, stdout: '{"new":"ciphertext"}', stderr: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          supabase: { "example-web": { management: "wrong-value" } }
        }),
        stderr: ""
      }
    );

    try {
      const backup = new SopsAgeBackup(path, recipient, keychain, runner);
      await expect(
        backup.writeAndVerify({ [reference]: "top-secret-canary" })
      ).rejects.toThrow("SOPS backup round-trip mismatch");
      expect(await readFile(path, "utf8")).toBe(previous);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("exposes SOPS resolve and bootstrap through metadata-safe CLI commands", async () => {
    const keychain = new MemoryBackend();
    keychain.values.set("vault://supadrum/keys/age", ageIdentity);
    const resolveRunner = new RecordingRunner();
    resolveRunner.outcomes.push({
      exitCode: 0,
      stdout: "resolved-secret",
      stderr: ""
    });
    const resolveStreams = io(`${reference}\n`);

    await expect(
      runVaultCli(
        ["sops", "resolve", "--file", "/operator/secrets.enc.json"],
        resolveStreams.io,
        { keychain, runner: resolveRunner }
      )
    ).resolves.toBe(0);
    expect(resolveStreams.stdout).toEqual(["resolved-secret"]);

    const bootstrapRunner = new RecordingRunner();
    bootstrapRunner.outcomes.push({
      exitCode: 0,
      stdout: `${recipient}\n`,
      stderr: ""
    });
    const bootstrapStreams = io("");
    await expect(
      runVaultCli(["sops", "bootstrap-age"], bootstrapStreams.io, {
        keychain,
        runner: bootstrapRunner
      })
    ).resolves.toBe(0);
    expect(bootstrapStreams.stdout).toEqual([`${recipient}\n`]);
    expect(bootstrapStreams.stdout.join("")).not.toContain("AGE-SECRET");
  });
});

describe("dotenv migration CLI", () => {
  test("moves allow-listed values to Keychain and SOPS with metadata-only output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supadrum-migrate-"));
    const source = join(directory, ".env");
    const backupPath = join(directory, "legacy.enc.json");
    const databaseReference =
      "vault://legacy/example-service-env/database-url";
    const jwtReference = "vault://legacy/example-service-env/jwt-secret";
    const ageIdentity = "TEST-PRIVATE-AGE-IDENTITY";
    const recipient = "age1canaryrecipient";
    const keychain = new MemoryBackend();
    keychain.values.set("vault://supadrum/keys/age", ageIdentity);
    const runner = new RecordingRunner();
    runner.outcomes.push(
      { exitCode: 0, stdout: `${recipient}\n`, stderr: "" },
      {
        exitCode: 0,
        stdout: '{"ciphertext":"ENC[...]","sops":{"version":"test"}}',
        stderr: ""
      },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          legacy: {
            "example-service-env": {
              "database-url": "database-canary",
              "jwt-secret": "jwt-canary"
            }
          }
        }),
        stderr: ""
      }
    );
    const streams = io("");

    try {
      await writeFile(
        source,
        [
          "DATABASE_URL=database-canary",
          "JWT_SECRET=jwt-canary",
          "PORT=3000",
          ""
        ].join("\n"),
        { mode: 0o600 }
      );

      await expect(
        runVaultCli(
          [
            "migrate",
            "dotenv",
            "--source",
            source,
            "--backup",
            backupPath,
            "--map",
            `DATABASE_URL=${databaseReference}`,
            "--map",
            `JWT_SECRET=${jwtReference}`,
            "--apply"
          ],
          streams.io,
          { keychain, runner }
        )
      ).resolves.toBe(0);

      const sanitized = await readFile(source, "utf8");
      expect(sanitized).toContain(
        `# vault-managed: DATABASE_URL -> ${databaseReference}`
      );
      expect(sanitized).toContain("PORT=3000");
      expect(sanitized).not.toContain("database-canary");
      expect(sanitized).not.toContain("jwt-canary");
      expect(await readFile(backupPath, "utf8")).not.toContain(
        "database-canary"
      );
      expect(keychain.values.get(databaseReference)).toBe("database-canary");
      expect(keychain.values.get(jwtReference)).toBe("jwt-canary");
      expect(streams.stdout.join("")).not.toContain("database-canary");
      expect(streams.stdout.join("")).not.toContain("jwt-canary");
      expect(JSON.parse(streams.stdout.join(""))).toEqual({
        applied: true,
        entries: [
          {
            name: "DATABASE_URL",
            reference: databaseReference,
            verified: true
          },
          {
            name: "JWT_SECRET",
            reference: jwtReference,
            verified: true
          }
        ]
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
