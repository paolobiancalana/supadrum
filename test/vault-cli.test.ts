import { describe, expect, test } from "vitest";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
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
  type KeychainBackend,
  type KeychainImportSource,
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

class ImportingBackend extends MemoryBackend implements KeychainBackend {
  readonly imports: KeychainImportSource[] = [];

  async import(vaultReference: string, source: KeychainImportSource) {
    this.imports.push(source);
    this.values.set(vaultReference, "imported-secret");
    return { reference: vaultReference, verified: true as const };
  }
}

/** A vault that has never held the reference, as opposed to one that won't say. */
class EmptyBackend extends MemoryBackend {
  override async get(vaultReference: string): Promise<string> {
    const value = this.values.get(vaultReference);
    if (value === undefined) throw new MissingVaultValueError(vaultReference);
    return value;
  }
}

async function withDirectory<T>(
  run: (directory: string) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "supadrum-vault-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
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

  test.each([
    { case: "no service", source: { service: "", account: "operator" } },
    { case: "no account", source: { service: "supabase-pat", account: "" } }
  ])("refuses an import whose source names $case", async ({ source }) => {
    const runner = new RecordingRunner();
    const backend = new MacOsKeychainBackend(runner, "operator");

    await expect(backend.import(reference, source)).rejects.toThrow(
      "Keychain import source is incomplete"
    );
    expect(runner.invocations).toEqual([]);
  });

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

  test("stores what was piped in, not the line ending that carried it", async () => {
    const backend = new MemoryBackend();

    await expect(
      runVaultCli(
        ["keychain", "put", reference],
        io("top-secret-canary\r\n").io,
        { keychain: backend }
      )
    ).resolves.toBe(0);
    expect(backend.values.get(reference)).toBe("top-secret-canary");
  });

  test("does not report a put that the vault did not honour", async () => {
    class DriftingBackend extends MemoryBackend {
      override async put(vaultReference: string): Promise<void> {
        this.values.set(vaultReference, "some-other-value");
      }
    }
    const streams = io("top-secret-canary\n");

    await expect(
      runVaultCli(["keychain", "put", reference], streams.io, {
        keychain: new DriftingBackend()
      })
    ).rejects.toThrow("Keychain put round-trip mismatch");
    expect(streams.stdout).toEqual([]);
  });

  test("imports an existing item and reports only where it landed", async () => {
    const keychain = new ImportingBackend();
    const streams = io("");

    await expect(
      runVaultCli(
        ["keychain", "import", reference, "--service", "supabase-pat", "--account", "operator"],
        streams.io,
        { keychain }
      )
    ).resolves.toBe(0);

    expect(keychain.imports).toEqual([
      { service: "supabase-pat", account: "operator" }
    ]);
    expect(JSON.parse(streams.stdout.join(""))).toEqual({
      reference,
      verified: true
    });
  });

  test("says so when the configured backend has nothing to import from", async () => {
    const streams = io("");

    await expect(
      runVaultCli(
        ["keychain", "import", reference, "--service", "supabase-pat", "--account", "operator"],
        streams.io,
        { keychain: new MemoryBackend() }
      )
    ).rejects.toThrow("Configured backend cannot import Keychain items");
  });

  test.each([
    {
      case: "put without a reference",
      argv: ["keychain", "put"],
      message: "Keychain put requires a vault reference"
    },
    {
      case: "import without a service",
      argv: ["keychain", "import", reference, "--account", "operator"],
      message: "Keychain import requires a reference, --service, and account"
    },
    {
      case: "import without a reference",
      argv: ["keychain", "import", "--service", "supabase-pat"],
      message: "Keychain import requires a reference, --service, and account"
    }
  ])("refuses $case rather than acting on a flag", async ({ argv, message }) => {
    const keychain = new ImportingBackend();

    await expect(
      runVaultCli(argv, io("top-secret-canary\n").io, { keychain })
    ).rejects.toThrow(message);
    expect(keychain.values.size).toBe(0);
    expect(keychain.imports).toEqual([]);
  });

  test.each([
    { case: "nothing at all", argv: [] },
    { case: "an unknown group", argv: ["vault"] },
    { case: "an unknown keychain command", argv: ["keychain", "rotate"] },
    { case: "an unknown sops command", argv: ["sops", "rotate"] },
    { case: "an unknown migration source", argv: ["migrate", "json"] }
  ])("prints usage on stderr and fails for $case", async ({ argv }) => {
    const streams = io("");

    await expect(
      runVaultCli(argv, streams.io, { keychain: new MemoryBackend() })
    ).resolves.toBe(1);
    expect(streams.stdout).toEqual([]);
    expect(streams.stderr.join("")).toContain("Usage: supadrum-vault");
  });
});

describe("SOPS age backend", () => {
  const ageIdentity = [
    "# created: 2026-07-29T00:00:00Z",
    "# public key: age1canaryrecipient",
    "AGE-SECRET-KEY-1CANARY"
  ].join("\n");
  const recipient = "age1canaryrecipient";

  function identityVault(): MemoryBackend {
    const keychain = new MemoryBackend();
    keychain.values.set("vault://supadrum/keys/age", ageIdentity);
    return keychain;
  }

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
    const keychain = new EmptyBackend();
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

  test.each([
    { case: "age-keygen fails", outcome: { exitCode: 1, stdout: "", stderr: "no entropy" } },
    { case: "age-keygen prints nothing", outcome: { exitCode: 0, stdout: "", stderr: "" } }
  ])("stores no identity when $case", async ({ outcome }) => {
    const keychain = new EmptyBackend();
    const runner = new RecordingRunner();
    runner.outcomes.push(outcome);

    await expect(bootstrapAgeIdentity(keychain, runner)).rejects.toThrow(
      "age identity generation failed"
    );
    expect(keychain.values.size).toBe(0);
  });

  test.each([
    {
      case: "derivation fails",
      outcome: { exitCode: 1, stdout: "", stderr: "bad key" },
      message: "age recipient derivation failed"
    },
    {
      case: "derivation returns something that is not an age recipient",
      outcome: { exitCode: 0, stdout: "Usage: age-keygen [-y]\n", stderr: "" },
      message: "age-keygen returned an invalid recipient"
    }
  ])("refuses to encrypt to a recipient when $case", async ({ outcome, message }) => {
    const keychain = new MemoryBackend();
    keychain.values.set("vault://supadrum/keys/age", ageIdentity);
    const runner = new RecordingRunner();
    runner.outcomes.push(outcome);

    await expect(bootstrapAgeIdentity(keychain, runner)).rejects.toThrow(
      message
    );
  });

  test("refuses a generated identity the Keychain did not store faithfully", async () => {
    class LyingKeychain extends EmptyBackend {
      override async put(vaultReference: string): Promise<void> {
        this.values.set(vaultReference, "truncated-identi");
      }
    }
    const keychain = new LyingKeychain();
    const runner = new RecordingRunner();
    runner.outcomes.push(
      { exitCode: 0, stdout: ageIdentity, stderr: "" },
      { exitCode: 0, stdout: `${recipient}\n`, stderr: "" }
    );

    // Reporting this recipient would hand the operator a backup encrypted
    // to a key whose private half no longer exists anywhere.
    await expect(bootstrapAgeIdentity(keychain, runner)).rejects.toThrow(
      "age identity Keychain round-trip mismatch"
    );
  });

  test("writes and verifies only encrypted backup bytes before atomic replacement", async () => {
    const encrypted = '{"sops":{"version":"test"},"ciphertext":"ENC[...]"}';
    const plaintextTree = {
      supabase: {
        "example-web": {
          management: "top-secret-canary"
        }
      }
    };
    const runner = new RecordingRunner();
    runner.outcomes.push(
      { exitCode: 0, stdout: encrypted, stderr: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify(plaintextTree),
        stderr: ""
      }
    );

    await withDirectory(async (directory) => {
      const path = join(directory, "secrets.enc.json");
      const backup = new SopsAgeBackup(path, recipient, identityVault(), runner);
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
    });
  });

  test.each([
    {
      case: "the round trip returns a different value",
      decrypted: {
        exitCode: 0,
        stdout: JSON.stringify({
          supabase: { "example-web": { management: "wrong-value" } }
        }),
        stderr: ""
      },
      message: "SOPS backup round-trip mismatch"
    },
    {
      case: "the round trip does not reach the value at all",
      decrypted: {
        exitCode: 0,
        stdout: JSON.stringify({ supabase: "flattened-by-a-later-edit" }),
        stderr: ""
      },
      message: "SOPS backup round-trip mismatch"
    },
    {
      case: "decryption fails",
      decrypted: { exitCode: 1, stdout: "", stderr: "no matching key" },
      message: "SOPS backup verification failed"
    },
    {
      case: "decryption returns something that is not JSON",
      decrypted: { exitCode: 0, stdout: "sops: ERROR", stderr: "" },
      message: "SOPS backup verification returned invalid JSON"
    }
  ])(
    "keeps the previous backup and leaves no temporary file when $case",
    async ({ decrypted, message }) => {
      const previous = '{"previous":"ciphertext"}';
      const runner = new RecordingRunner();
      runner.outcomes.push(
        { exitCode: 0, stdout: '{"new":"ciphertext"}', stderr: "" },
        decrypted
      );

      await withDirectory(async (directory) => {
        const path = join(directory, "secrets.enc.json");
        await writeFile(path, previous, { mode: 0o600 });
        const backup = new SopsAgeBackup(
          path,
          recipient,
          identityVault(),
          runner
        );

        await expect(
          backup.writeAndVerify({ [reference]: "top-secret-canary" })
        ).rejects.toThrow(message);
        expect(await readFile(path, "utf8")).toBe(previous);
        expect(await readdir(directory)).toEqual(["secrets.enc.json"]);
      });
    }
  );

  test("writes nothing at all when encryption fails", async () => {
    const runner = new RecordingRunner();
    runner.outcomes.push({ exitCode: 1, stdout: "", stderr: "no recipient" });

    await withDirectory(async (directory) => {
      const backup = new SopsAgeBackup(
        join(directory, "secrets.enc.json"),
        recipient,
        identityVault(),
        runner
      );

      await expect(
        backup.writeAndVerify({ [reference]: "top-secret-canary" })
      ).rejects.toThrow("SOPS backup encryption failed");
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test("surfaces why the backup was not replaced, not why the cleanup failed", async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "secrets.enc.json");
      const runner: ProcessRunner = {
        async run(invocation) {
          if (invocation.argv[1] === "encrypt") {
            return { exitCode: 0, stdout: '{"new":"ciphertext"}', stderr: "" };
          }
          // The operator's directory disappears mid-write: the rename fails,
          // and so does removing the temporary file it was meant to replace.
          await rm(directory, { recursive: true, force: true });
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              supabase: { "example-web": { management: "top-secret-canary" } }
            }),
            stderr: ""
          };
        }
      };
      const backup = new SopsAgeBackup(path, recipient, identityVault(), runner);

      await expect(
        backup.writeAndVerify({ [reference]: "top-secret-canary" })
      ).rejects.toThrow(/rename/);
    });
  });

  test.each([
    {
      case: "a reference that would nest under a stored value",
      values: {
        "vault://legacy/app/db": "first",
        "vault://legacy/app/db/url": "second"
      }
    },
    {
      case: "a reference that would overwrite a nested branch",
      values: {
        "vault://legacy/app/db/url": "first",
        "vault://legacy/app/db": "second"
      }
    },
  ])("refuses to silently drop a secret from the backup: $case", async ({ values }) => {
    const runner = new RecordingRunner();
    const backup = new SopsAgeBackup(
      "/operator/secrets.enc.json",
      recipient,
      identityVault(),
      runner
    );

    await expect(backup.writeAndVerify(values)).rejects.toThrow(
      "SOPS backup reference collision"
    );
    expect(runner.invocations).toEqual([]);
  });

  test("refuses to write a backup with nothing in it", async () => {
    const runner = new RecordingRunner();
    const backup = new SopsAgeBackup(
      "/operator/secrets.enc.json",
      recipient,
      identityVault(),
      runner
    );

    await expect(backup.writeAndVerify({})).rejects.toThrow(
      "SOPS backup cannot be empty"
    );
    expect(runner.invocations).toEqual([]);
  });

  test.each([
    {
      case: "no path to write to",
      build: () => new SopsAgeBackup("", recipient, identityVault()),
      message: "SOPS backup path is required"
    },
    {
      case: "a recipient age never produced",
      build: () =>
        new SopsAgeBackup("/operator/secrets.enc.json", "AGE-SECRET-KEY-1CANARY", identityVault()),
      message: "age-keygen returned an invalid recipient"
    },
    {
      case: "no encrypted file to read",
      build: () => new SopsAgeBackend("", identityVault()),
      message: "SOPS encrypted file is required"
    }
  ])("refuses to be constructed with $case", ({ build, message }) => {
    expect(build).toThrow(message);
  });

  test.each([
    {
      case: "decryption fails",
      outcome: { exitCode: 1, stdout: "", stderr: "no matching key found" },
      message: "SOPS decrypt failed"
    },
    {
      case: "the extract is empty",
      outcome: { exitCode: 0, stdout: "", stderr: "" },
      message: "SOPS extract did not return a non-empty string"
    }
  ])("does not resolve a reference when $case", async ({ outcome, message }) => {
    const runner = new RecordingRunner();
    runner.outcomes.push(outcome);
    const backend = new SopsAgeBackend(
      "/operator/secrets.enc.json",
      identityVault(),
      runner
    );

    const attempt = backend.get(reference);

    await expect(attempt).rejects.toThrow(message);
    // sops writes key material hints to stderr; none of it belongs in an
    // error an operator may paste into a bug report.
    await expect(attempt).rejects.not.toThrow(/matching key/);
  });

  test("refuses to pretend it can write through a reference backend", async () => {
    const backend = new SopsAgeBackend(
      "/operator/secrets.enc.json",
      identityVault(),
      new RecordingRunner()
    );

    await expect(backend.put()).rejects.toThrow(
      "SOPS reference backend is read-only"
    );
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

  test("refuses to resolve without being told which encrypted file to read", async () => {
    const runner = new RecordingRunner();

    await expect(
      runVaultCli(["sops", "resolve"], io(`${reference}\n`).io, {
        keychain: identityVault(),
        runner
      })
    ).rejects.toThrow("SOPS resolve requires --file");
    expect(runner.invocations).toEqual([]);
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

  const mappingUsage = "Each migration mapping must be NAME=vault://reference";

  test.each([
    { case: "a mapping with no reference", map: "DATABASE_URL", message: mappingUsage },
    {
      case: "a mapping whose name is not an environment variable",
      map: "9=vault://legacy/app/db",
      message: mappingUsage
    },
    { case: "a mapping with an empty reference", map: "DATABASE_URL=", message: mappingUsage },
    {
      case: "a reference that is not a vault reference",
      map: "DATABASE_URL=/etc/passwd",
      message: "Expected a vault reference"
    }
  ])("rejects $case before touching the vault", async ({ map, message }) => {
    const keychain = new EmptyBackend();
    const runner = new RecordingRunner();

    await expect(
      runVaultCli(
        ["migrate", "dotenv", "--source", "/nonexistent/.env", "--backup", "/nonexistent/out.json", "--map", map],
        io("").io,
        { keychain, runner }
      )
    ).rejects.toThrow(message);
    // An unusable command line must not leave a freshly minted age identity
    // behind: the operator would then hold a key no backup was encrypted to.
    expect(keychain.values.size).toBe(0);
    expect(runner.invocations).toEqual([]);
  });

  test("rejects the same name mapped twice", async () => {
    const keychain = new EmptyBackend();
    const runner = new RecordingRunner();

    await expect(
      runVaultCli(
        [
          "migrate",
          "dotenv",
          "--source",
          "/nonexistent/.env",
          "--backup",
          "/nonexistent/out.json",
          "--map",
          "DATABASE_URL=vault://legacy/app/db",
          "--map",
          "DATABASE_URL=vault://legacy/app/other"
        ],
        io("").io,
        { keychain, runner }
      )
    ).rejects.toThrow("Duplicate migration mapping: DATABASE_URL");
    expect(keychain.values.size).toBe(0);
  });

  test("rejects a migration that maps nothing", async () => {
    const keychain = new EmptyBackend();

    await expect(
      runVaultCli(
        ["migrate", "dotenv", "--source", "/nonexistent/.env", "--backup", "/nonexistent/out.json"],
        io("").io,
        { keychain, runner: new RecordingRunner() }
      )
    ).rejects.toThrow("Dotenv migration requires at least one --map");
    expect(keychain.values.size).toBe(0);
  });

  test.each([
    { case: "no source", argv: ["migrate", "dotenv", "--backup", "/out.json"] },
    { case: "no backup", argv: ["migrate", "dotenv", "--source", "/.env"] }
  ])("refuses a migration with $case", async ({ argv }) => {
    await expect(
      runVaultCli(argv, io("").io, {
        keychain: new EmptyBackend(),
        runner: new RecordingRunner()
      })
    ).rejects.toThrow("Dotenv migration requires --source and --backup");
  });
});
