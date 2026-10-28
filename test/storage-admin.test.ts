import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { ProjectConfig } from "../src/config.js";
import { JobSubmissionSchema, type Job } from "../src/domain.js";
import {
  LiveSupabaseExecutor,
  NodeLiveProcess,
  type LiveProcess
} from "../src/live-executor.js";
import { localTarget } from "../src/storage-admin.js";
import { safeSegment } from "../src/storage-payload.js";

const SECRET = "sb_secret_canary_9f8e7d6c5b4a";
const REF = "abcdefghijklmnopqrst";
const JWT_SECRET = "jwt-secret-canary-32-characters-long";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function jwt(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role, exp: 4102444800 })).toString("base64url");
  const signature = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
const LOCAL_SERVICE_KEY = jwt("service_role");
const LOCAL_STATUS = {
  "API URL": "http://127.0.0.1:54331",
  "DB URL": "postgresql://postgres:db-canary@127.0.0.1:54332/postgres",
  "anon key": jwt("anon"),
  "service_role key": LOCAL_SERVICE_KEY,
  "JWT secret": JWT_SECRET
};

/** A real git repository whose .gitignore covers `out/`, committed, so HEAD is a real OID. */
function makeRepo(gitignore = "out/\n") {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "supadrum-storage-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8"
    });
  git("init", "-q");
  writeFileSync(join(repo, ".gitignore"), gitignore);
  git("add", ".gitignore");
  git("commit", "-q", "-m", "init");
  return { repo, oid: git("rev-parse", "HEAD").trim() };
}

interface Recorded { method: string; url: string; headers: Headers; body: Buffer | undefined; redirect: RequestRedirect | undefined }
interface StoredObject { body: Buffer; type: string }

/** An in-memory Storage API that models the documented endpoints and their failure modes. */
class FakeStorage {
  readonly buckets = new Map<string, { public: boolean; objects: Map<string, StoredObject> }>();
  readonly requests: Recorded[] = [];
  readonly failDownload = new Set<string>();
  readonly lieAboutLength = new Set<string>();
  deleteShortBy = 0;
  /** The most entries one list page may hold, whatever `limit` asks (Storage caps it too). */
  pageCap = Infinity;
  /** Every listed entry shows up twice, as when objects move while pages are being read. */
  duplicateListing = false;
  /** Objects whose listing claims one byte more than the body holds. */
  readonly wrongSize = new Set<string>();
  /** Objects served with this content-encoding header (the body itself is left as stored). */
  readonly encoding = new Map<string, string>();
  /** Objects whose body runs 16 KiB past what the listing says, chunk by chunk. */
  readonly oversize = new Set<string>();
  /** Bodies the client stopped reading before the end. */
  cancelled = 0;
  /** Runs when an object is served, before its body is read: a hook to change the disk mid-job. */
  onDownload: ((key: string) => void) | undefined;
  constructor(readonly key: string, readonly base: string) {}

  put(bucket: string, path: string, content: string, type = "text/plain"): void {
    let entry = this.buckets.get(bucket);
    if (!entry) { entry = { public: false, objects: new Map() }; this.buckets.set(bucket, entry); }
    entry.objects.set(path, { body: Buffer.from(content), type });
  }
  has(bucket: string, path: string): boolean { return this.buckets.get(bucket)?.objects.has(path) ?? false; }
  text(bucket: string, path: string): string | undefined { return this.buckets.get(bucket)?.objects.get(path)?.body.toString(); }
  count(method: string, pattern: RegExp): number {
    return this.requests.filter((request) => request.method === method && pattern.test(request.url)).length;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const body = raw === undefined || raw === null ? undefined
      : typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw as Uint8Array);
    this.requests.push({ method, url: url.toString(), headers, body, redirect: init?.redirect });
    if (!url.toString().startsWith(this.base)) throw new Error(`unexpected host ${url.origin}`);
    if (headers.get("apikey") !== this.key || headers.get("authorization") !== `Bearer ${this.key}`) {
      return Response.json({ message: "unauthorized" }, { status: 401 });
    }
    const route = decodeURIComponent(url.pathname.slice(new URL(this.base).pathname.length));
    if (method === "GET" && route === "/bucket") {
      return Response.json([...this.buckets].map(([name, bucket]) => ({ id: name, name, public: bucket.public })));
    }
    let match = /^\/object\/list\/([^/]+)$/.exec(route);
    if (method === "POST" && match) return this.list(match[1] as string, JSON.parse(String(body)));
    match = /^\/object\/authenticated\/([^/]+)\/(.+)$/.exec(route);
    if (method === "GET" && match) return this.download(match[1] as string, match[2] as string);
    match = /^\/object\/([^/]+)\/(.+)$/.exec(route);
    if (method === "POST" && match) return this.upload(match[1] as string, match[2] as string, headers, body ?? Buffer.alloc(0));
    match = /^\/object\/([^/]+)$/.exec(route);
    if (method === "DELETE" && match) return this.remove(match[1] as string, JSON.parse(String(body)).prefixes);
    throw new Error(`unexpected request ${method} ${route}`);
  };

  private list(bucket: string, request: { prefix?: string; limit?: number; offset?: number }): Response {
    const entry = this.buckets.get(bucket);
    if (!entry) return Response.json({ message: "Bucket not found" }, { status: 404 });
    const prefix = request.prefix ? `${request.prefix}/` : "";
    const found = new Map<string, Record<string, unknown>>();
    for (const [path, object] of entry.objects) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const name = rest.split("/")[0] as string;
      found.set(name, rest.includes("/")
        ? { name, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null }
        : { name, id: `id-${path}`, updated_at: "2026-10-01T10:00:00.000Z", created_at: "2026-09-01T10:00:00.000Z",
            last_accessed_at: null,
            metadata: { size: object.body.length + (this.wrongSize.has(`${bucket}/${path}`) ? 1 : 0), mimetype: object.type } });
    }
    const once = [...found.values()].sort((a, b) => (a.name as string).localeCompare(b.name as string));
    const sorted = this.duplicateListing ? [...once, ...once] : once;
    const offset = request.offset ?? 0;
    return Response.json(sorted.slice(offset, offset + Math.min(request.limit ?? 100, this.pageCap)));
  }

  private download(bucket: string, path: string): Response {
    if (this.failDownload.has(`${bucket}/${path}`)) return Response.json({ message: `boom ${this.key}` }, { status: 500 });
    const object = this.buckets.get(bucket)?.objects.get(path);
    if (!object) return Response.json({ message: "Object not found" }, { status: 404 });
    const key = `${bucket}/${path}`;
    this.onDownload?.(key);
    if (this.oversize.has(key)) {
      const chunks = [object.body, ...Array.from({ length: 16 }, () => Buffer.alloc(1024))];
      const body = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          const next = chunks.shift();
          if (next) controller.enqueue(new Uint8Array(next)); else controller.close();
        },
        cancel: () => { this.cancelled += 1; }
      });
      return new Response(body, { headers: { "content-type": object.type } });
    }
    const length = this.lieAboutLength.has(key) ? object.body.length + 10 : object.body.length;
    const headers: Record<string, string> = { "content-type": object.type, "content-length": String(length) };
    const encoding = this.encoding.get(key);
    if (encoding !== undefined) headers["content-encoding"] = encoding;
    return new Response(new Uint8Array(object.body), { headers });
  }

  private upload(bucket: string, path: string, headers: Headers, body: Buffer): Response {
    const entry = this.buckets.get(bucket);
    if (!entry) return Response.json({ message: "Bucket not found" }, { status: 404 });
    if (entry.objects.has(path) && headers.get("x-upsert") !== "true") {
      return Response.json({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, { status: 400 });
    }
    entry.objects.set(path, { body, type: headers.get("content-type") ?? "" });
    return Response.json({ Id: "id", Key: `${bucket}/${path}` });
  }

  private remove(bucket: string, prefixes: string[]): Response {
    const entry = this.buckets.get(bucket);
    const removed: Array<{ name: string }> = [];
    for (const path of prefixes) if (entry?.objects.delete(path)) removed.push({ name: path });
    return Response.json(removed.slice(0, removed.length - this.deleteShortBy));
  }
}

function job(oid: string, payload: Record<string, unknown>): Job {
  return {
    id: "job-1", project: "app", operation: "storage.admin", payload, repo_sha: oid,
    idempotency_key: "app:storage", capability: "storage", requires_approval: true,
    session_id: null, status: "running", created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z",
    lease_expires_at: null, approved_at: null, approved_by: null, result: null, error: null
  };
}

function remoteProject(repo: string, capabilities: ProjectConfig["capabilities"] = ["storage"]): ProjectConfig {
  return {
    repo, chamber: "app", project_ref: REF,
    credentials: { secret_key: "vault://app/secret", management_token: "vault://app/mgmt", database_access: "vault://app/db" },
    capabilities, mode: "live", migrations: "consumer", migration_driver: "supabase"
  };
}

function localProject(repo: string): ProjectConfig {
  return {
    ...remoteProject(repo), target: "local", project_ref: "", supabase_dir: repo,
    credentials: { secret_key: "", management_token: "", database_access: "" }
  };
}

const credentials = {
  secret_key: SECRET, management_token: "mgmt-canary-token",
  database_access: "postgresql://postgres:db-canary@db.abcdefghijklmnopqrst.supabase.co:5432/postgres"
};

/** `ignore` replaces what `git check-ignore` answers: an exit code, or an error the process throws. */
function setup(options: {
  local?: boolean; gitignore?: string; status?: Record<string, unknown>; ignore?: number | Error; free?: number
} = {}) {
  const { repo, oid } = makeRepo(options.gitignore);
  const storage = options.local
    ? new FakeStorage(LOCAL_SERVICE_KEY, "http://127.0.0.1:54331/storage/v1")
    : new FakeStorage(SECRET, `https://${REF}.supabase.co/storage/v1`);
  const real = new NodeLiveProcess();
  const statusCalls: Array<{ cwd: string }> = [];
  const ignoreCalls: string[][] = [];
  const process: LiveProcess = {
    async run(input) {
      if (input.argv.includes("check-ignore")) {
        ignoreCalls.push([...input.argv]);
        if (options.ignore instanceof Error) throw options.ignore;
        if (options.ignore !== undefined) return { exitCode: options.ignore, stdout: "", stderr: "" };
      }
      if (input.argv[0] === "supabase") {
        statusCalls.push({ cwd: input.cwd });
        return { exitCode: 0, stdout: JSON.stringify(options.status ?? LOCAL_STATUS), stderr: "" };
      }
      return real.run(input);
    }
  };
  const executor = new LiveSupabaseExecutor({
    process, fetch: storage.fetch, ...(options.free === undefined ? {} : { freeBytes: () => options.free! })
  });
  const project = options.local ? localProject(repo) : remoteProject(repo);
  const run = (payload: Record<string, unknown>, overrides: Partial<ProjectConfig> = {}) =>
    executor.execute(job(oid, payload), { ...project, ...overrides }, credentials);
  return { repo, oid, storage, run, statusCalls, ignoreCalls };
}

/** The error a promise rejects with; fails the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error("expected a rejection");
}

/** Nothing the result says may carry the key or an object path. */
function expectClean(result: unknown, ...forbidden: string[]): void {
  const text = JSON.stringify(result);
  for (const value of [SECRET, LOCAL_SERVICE_KEY, "mgmt-canary-token", "db-canary", ...forbidden]) {
    expect(text).not.toContain(value);
  }
}

describe("storage.admin payloads", () => {
  const submit = (payload: unknown) => JobSubmissionSchema.safeParse({
    project: "app", operation: "storage.admin", payload, repo_sha: "abc123", idempotency_key: "k"
  });
  const digest = sha256("x");

  test("accepts the four documented shapes", () => {
    for (const payload of [
      { action: "list" },
      { action: "list", dest: "out/list" },
      { action: "download", dest: "out/dl" },
      { action: "download", dest: "out/dl", buckets: ["a", "b"] },
      { action: "upload", bucket: "a", object: "dir/x.txt", path: "files/x.txt", digest, content_type: "text/plain" },
      { action: "upload", bucket: "a", object: "x.txt", path: "files/x.txt", digest, content_type: "text/plain", upsert: true },
      { action: "delete", bucket: "a", objects: ["dir/x.txt", "y.txt"], dest: "out/del" }
    ]) {
      expect(submit(payload).success, JSON.stringify(payload)).toBe(true);
    }
  });

  test.each([
    ["an unknown action", { action: "create-bucket", name: "x" }],
    ["no action", { dest: "out" }],
    ["an unknown key", { action: "list", bucket: "a" }],
    ["download without dest", { action: "download" }],
    ["download with an empty bucket list", { action: "download", dest: "out/dl", buckets: [] }],
    ["upload without content_type", { action: "upload", bucket: "a", object: "x", path: "f", digest }],
    ["upload with a short digest", { action: "upload", bucket: "a", object: "x", path: "f", digest: "abc", content_type: "text/plain" }],
    ["upload with a non-boolean upsert", { action: "upload", bucket: "a", object: "x", path: "f", digest, content_type: "text/plain", upsert: "yes" }],
    ["upload to a traversing object name", { action: "upload", bucket: "a", object: "../x", path: "f", digest, content_type: "text/plain" }],
    ["upload to a bucket named like a Storage route", { action: "upload", bucket: "move", object: "x", path: "f", digest, content_type: "text/plain" }],
    ["upload to a route name in capitals", { action: "upload", bucket: "Copy", object: "x", path: "f", digest, content_type: "text/plain" }],
    ["delete in a bucket named like a Storage route", { action: "delete", bucket: "sign", objects: ["x"], dest: "out/del" }],
    ["delete without dest", { action: "delete", bucket: "a", objects: ["x"] }],
    ["delete of nothing", { action: "delete", bucket: "a", objects: [], dest: "out/del" }],
    ["delete of more than 100 objects", { action: "delete", bucket: "a", objects: Array.from({ length: 101 }, (_, i) => `o${i}`), dest: "out/del" }],
    ["delete by prefix", { action: "delete", bucket: "a", objects: ["folder/"], dest: "out/del" }],
    ["delete by wildcard", { action: "delete", bucket: "a", objects: ["folder/*"], dest: "out/del" }],
    ["delete with a parent segment", { action: "delete", bucket: "a", objects: ["a/../b"], dest: "out/del" }],
    ["delete with an absolute path", { action: "delete", bucket: "a", objects: ["/etc/passwd"], dest: "out/del" }],
    ["delete with a repeated path", { action: "delete", bucket: "a", objects: ["x", "x"], dest: "out/del" }],
    ["delete of a whole bucket", { action: "delete", bucket: "a", dest: "out/del" }]
  ])("rejects %s", (_name, payload) => {
    expect(submit(payload).success).toBe(false);
  });

  test("accepts exactly 100 deletes", () => {
    const objects = Array.from({ length: 100 }, (_, i) => `o${i}`);
    expect(submit({ action: "delete", bucket: "a", objects, dest: "out/del" }).success).toBe(true);
  });
});

describe("storage.admin local paths", () => {
  test("safeSegment refuses anything that can move a path", () => {
    for (const bad of ["", ".", "..", "a/b", "a\0b", "a\nb", "a\tb"]) expect(safeSegment(bad), JSON.stringify(bad)).toBe(false);
    for (const good of ["a", "a.txt", "..a", "a..", "file name.png", "è.png", ".hidden"]) expect(safeSegment(good), good).toBe(true);
  });

  test("localTarget stays inside dest", () => {
    const dest = join(tmpdir(), "dest-x");
    expect(localTarget(dest, "photos", "a/b.png")).toBe(join(dest, "photos", "a", "b.png"));
    for (const [bucket, object] of [["photos", "../x"], ["photos", "a/../../x"], ["photos", "/abs"], ["photos", "a//b"],
      ["photos", ""], ["..", "x"], ["a/b", "x"], ["", "x"], ["MANIFEST", "x"], ["LIST", "x"],
      ["photos", "a/.git/config"], [".GIT", "x"], ["photos", ".Git"]] as const) {
      expect(() => localTarget(dest, bucket, object), `${bucket} ${object}`).toThrow();
    }
  });
});

describe("storage.admin list", () => {
  test("reports name, public, objects and bytes per bucket and nothing else", async () => {
    const { storage, run } = setup();
    storage.put("photos", "2026/a-secret-name.png", "12345");
    storage.put("photos", "b.png", "123");
    storage.put("docs", "x.pdf", "1234567");
    storage.buckets.get("docs")!.public = true;
    const result = await run({ action: "list" });
    expect(result.output).toEqual({
      action: "list",
      buckets: [
        { name: "photos", public: false, objects: 2, bytes: 8 },
        { name: "docs", public: true, objects: 1, bytes: 7 }
      ],
      objects: 3,
      bytes: 15
    });
    expectClean(result, "a-secret-name", "b.png", "x.pdf", "2026");
    const first = storage.requests[0]!;
    expect(first.url).toBe(`https://${REF}.supabase.co/storage/v1/bucket`);
    expect(first.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(first.headers.get("apikey")).toBe(SECRET);
    expect(result.verification).toMatchObject({ repo_sha_verified: true, target: "remote" });
  });

  test("walks nested folders and pages beyond the first 1000 entries", async () => {
    const { storage, run } = setup();
    for (let i = 0; i < 2500; i++) storage.put("big", `flat/${String(i).padStart(5, "0")}.bin`, "ab");
    storage.put("big", "deep/er/est/z.bin", "abc");
    const result = await run({ action: "list" });
    expect(result.output).toMatchObject({ objects: 2501, bytes: 5003, buckets: [{ name: "big", objects: 2501, bytes: 5003 }] });
    const pages = storage.requests.filter((r) => /object\/list\/big$/.test(r.url));
    expect(pages.length).toBeGreaterThanOrEqual(5);
    const body = JSON.parse(pages[0]!.body!.toString());
    expect(body).toMatchObject({ limit: 1000, offset: 0, prefix: "" });
  });

  test("a server that serves fewer entries per page than asked is still read to the end", async () => {
    const { storage, run } = setup();
    for (let i = 0; i < 250; i++) storage.put("big", `o${String(i).padStart(3, "0")}.bin`, "abc");
    storage.pageCap = 100;
    const result = await run({ action: "list" });
    expect(result.output).toMatchObject({ objects: 250, bytes: 750 });
  });

  test("with dest writes path, bytes and date to LIST and reports only its digest", async () => {
    const { repo, storage, run } = setup();
    storage.put("photos", "dir/one.png", "1234");
    const result = await run({ action: "list", dest: "out/list" });
    const list = readFileSync(join(repo, "out/list/LIST"), "utf8");
    expect(list).toBe("photos/dir/one.png\t4\t2026-10-01T10:00:00.000Z\n");
    expect(result.output).toMatchObject({ list_sha256: sha256(list), list_bytes: Buffer.byteLength(list) });
    expectClean(result, "one.png", "dir");
  });

  test("with a dest git does not ignore: refuses before any request", async () => {
    const { repo, storage, run } = setup();
    await expect(run({ action: "list", dest: "tracked/list" })).rejects.toThrow(/check-ignore|ignored/i);
    expect(storage.requests).toHaveLength(0);
    expect(existsSync(join(repo, "tracked"))).toBe(false);
  });
});

describe("storage.admin download", () => {
  test("writes every bucket's objects and a MANIFEST; the result holds counts only", async () => {
    const { repo, storage, run } = setup();
    storage.put("photos", "2026/club-secret.png", "PNGDATA");
    storage.put("photos", "top.txt", "hello");
    storage.put("docs", "a/b/c.pdf", "PDFDATA!");
    const result = await run({ action: "download", dest: "out/dl" });
    expect(readFileSync(join(repo, "out/dl/photos/2026/club-secret.png"), "utf8")).toBe("PNGDATA");
    expect(readFileSync(join(repo, "out/dl/photos/top.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(repo, "out/dl/docs/a/b/c.pdf"), "utf8")).toBe("PDFDATA!");
    const manifest = readFileSync(join(repo, "out/dl/MANIFEST"), "utf8");
    expect(manifest.trimEnd().split("\n")).toEqual([
      `${sha256("PDFDATA!")}\t8\tdocs/a/b/c.pdf`,
      `${sha256("PNGDATA")}\t7\tphotos/2026/club-secret.png`,
      `${sha256("hello")}\t5\tphotos/top.txt`
    ]);
    expect(result.output).toEqual({
      action: "download", buckets: 2, objects: 3, bytes: 20,
      manifest_sha256: sha256(manifest), manifest_bytes: Buffer.byteLength(manifest)
    });
    expectClean(result, "club-secret", "top.txt", "c.pdf", "photos", "docs");
  });

  test("only the named buckets are touched", async () => {
    const { repo, storage, run } = setup();
    storage.put("a", "1.txt", "one");
    storage.put("b", "2.txt", "two");
    const result = await run({ action: "download", dest: "out/dl", buckets: ["a"] });
    expect(result.output).toMatchObject({ buckets: 1, objects: 1, bytes: 3 });
    expect(existsSync(join(repo, "out/dl/a/1.txt"))).toBe(true);
    expect(existsSync(join(repo, "out/dl/b"))).toBe(false);
    expect(storage.requests.some((r) => /list\/b$/.test(r.url))).toBe(false);
  });

  test("a named bucket that does not exist stops the job before any download", async () => {
    const { storage, run } = setup();
    storage.put("a", "1.txt", "one");
    await expect(run({ action: "download", dest: "out/dl", buckets: ["a", "ghost"] })).rejects.toThrow(/bucket/i);
    expect(storage.count("GET", /object\/authenticated/)).toBe(0);
  });

  test("a dest git does not ignore is refused before any request", async () => {
    const { repo, storage, run } = setup();
    storage.put("a", "1.txt", "one");
    await expect(run({ action: "download", dest: "backup" })).rejects.toThrow(/check-ignore|ignored/i);
    expect(storage.requests).toHaveLength(0);
    expect(existsSync(join(repo, "backup"))).toBe(false);
  });

  test("a dest that is not empty is refused before any request and left untouched", async () => {
    const { repo, storage, run } = setup();
    mkdirSync(join(repo, "out/dl"), { recursive: true });
    writeFileSync(join(repo, "out/dl/keep.txt"), "mine");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/empty/i);
    expect(storage.requests).toHaveLength(0);
    expect(readdirSync(join(repo, "out/dl"))).toEqual(["keep.txt"]);
  });

  test("an empty existing dest is accepted", async () => {
    const { repo, storage, run } = setup();
    mkdirSync(join(repo, "out/dl"), { recursive: true });
    storage.put("a", "1.txt", "one");
    await run({ action: "download", dest: "out/dl" });
    expect(readFileSync(join(repo, "out/dl/a/1.txt"), "utf8")).toBe("one");
  });

  test("a dest that is a file is refused", async () => {
    const { repo, storage, run } = setup();
    mkdirSync(join(repo, "out"));
    writeFileSync(join(repo, "out/dl"), "a file");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/directory|empty/i);
    expect(storage.requests).toHaveLength(0);
  });

  test.each([
    ["outside the repository", "../escape/out"],
    ["absolute outside the repository", "/tmp/supadrum-escape/out"]
  ])("a dest %s is refused before any request", async (_name, dest) => {
    const { storage, run } = setup({ ignore: 0 });
    await expect(run({ action: "download", dest })).rejects.toThrow(/inside the project repository/);
    expect(storage.requests).toHaveLength(0);
  });

  test.each([
    ["the repository root", "."],
    ["the repository root spelled out", "out/.."],
    ["inside .git", ".git/backup"],
    ["inside .git in capitals", ".GIT/backup"],
    ["inside a nested .git", "out/.git/backup"]
  ])("a dest %s is refused even when git says it is ignored", async (_name, dest) => {
    const { storage, run } = setup({ ignore: 0 });
    await expect(run({ action: "download", dest })).rejects.toThrow(/root or \.git/);
    expect(storage.requests).toHaveLength(0);
  });

  test("a dest reached through a symlink is refused even when git says it is ignored", async () => {
    const { repo, storage, run } = setup({ ignore: 0 });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "supadrum-outside-")));
    mkdirSync(join(repo, "out"));
    symlinkSync(outside, join(repo, "out/link"));
    storage.put("a", "1.txt", "one");
    await expect(run({ action: "download", dest: "out/link" })).rejects.toThrow(/symbolic link/);
    await expect(run({ action: "download", dest: "out/link/sub" })).rejects.toThrow(/symbolic link/);
    expect(storage.requests).toHaveLength(0);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("when git cannot answer, the dest is not ignored", async () => {
    const { storage, run } = setup({ ignore: 128 });
    storage.put("a", "1.txt", "one");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/could not be checked/);
    expect(storage.requests).toHaveLength(0);
  });

  test("a redirect from Storage is never followed, whatever the request", async () => {
    const { storage, run } = setup();
    storage.put("a", "1.txt", "one");
    await run({ action: "download", dest: "out/dl" });
    expect(storage.requests.length).toBeGreaterThan(2);
    expect(storage.requests.map((request) => request.redirect)).toEqual(storage.requests.map(() => "error"));
  });

  test("git is asked about a file under dest, so a rule on the not-yet-created folder counts", async () => {
    const { repo, storage, run, ignoreCalls } = setup({ gitignore: "/out/dl/\n" });
    storage.put("a", "1.txt", "one");
    await run({ action: "download", dest: "out/dl" });
    expect(readFileSync(join(repo, "out/dl/a/1.txt"), "utf8")).toBe("one");
    expect(ignoreCalls.map((call) => call.at(-1))).toEqual(["./out/dl/MANIFEST", "./out/dl/a/1.txt"]);
    expect(ignoreCalls[0]!.slice(-3)).toEqual(["-q", "--", "./out/dl/MANIFEST"]);
    expect(ignoreCalls[0]!.slice(0, 6)).toEqual(["git", "-c", "core.fsmonitor=false", "-C", repo, "check-ignore"]);
  });

  test("a ! rule that re-includes one object stops the job before any download", async () => {
    const { repo, storage, run } = setup({ gitignore: "out/dl/*\n!out/dl/a\n" });
    storage.put("a", "1.txt", "secret");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/check-ignore/);
    expect(storage.count("GET", /\/object\/authenticated\//)).toBe(0);
    expect(existsSync(join(repo, "out/dl"))).toBe(false);
  });

  test("a folder swapped for a symbolic link mid-job is never written through", async () => {
    const { repo, storage, run } = setup();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "supadrum-swap-")));
    storage.put("a", "1.txt", "one");
    storage.put("b", "2.txt", "two");
    storage.onDownload = (key) => {
      if (key === "b/2.txt") symlinkSync(outside, join(repo, "out/dl/b"));
    };
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/written under dest/);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(repo, "out/dl/MANIFEST"))).toBe(false);
  });

  test("the repo's core.fsmonitor never runs when git is asked about dest", async () => {
    const { repo, storage, run } = setup();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "supadrum-fsmonitor-")));
    const hook = join(outside, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${join(outside, "ran")}\n`, { mode: 0o755 });
    execFileSync("git", ["-C", repo, "config", "core.fsmonitor", hook]);
    storage.put("a", "1.txt", "one");
    await run({ action: "download", dest: "out/dl" });
    expect(readFileSync(join(repo, "out/dl/a/1.txt"), "utf8")).toBe("one");
    expect(existsSync(join(outside, "ran"))).toBe(false);
  });

  test("a download that would leave less than the margin free is refused before any object is fetched", async () => {
    const margin = 256 * 1024 * 1024;
    const tight = setup({ free: margin + 8 - 1 });
    tight.storage.put("a", "1.txt", "one");
    tight.storage.put("b", "2.txt", "fives");
    await expect(tight.run({ action: "download", dest: "out/dl" })).rejects.toThrow(/does not fit/);
    expect(tight.storage.count("GET", /\/object\/authenticated\//)).toBe(0);
    expect(existsSync(join(tight.repo, "out/dl"))).toBe(false);
    const exact = setup({ free: margin + 8 });
    exact.storage.put("a", "1.txt", "one");
    exact.storage.put("b", "2.txt", "fives");
    await expect(exact.run({ action: "download", dest: "out/dl" })).resolves.toMatchObject({ output: { bytes: 8 } });
  });

  test("a body that differs from the size the listing gave is an error", async () => {
    const { storage, run } = setup();
    storage.put("a", "1.txt", "one");
    storage.wrongSize.add("a/1.txt");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/does not match the listing/);
  });

  test("a server-side name with .. never leaves dest and stops the job before any download", async () => {
    const { repo, storage, run } = setup();
    storage.put("a", "ok.txt", "fine");
    storage.put("a", "x/../../evil.txt", "pwned");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow();
    expect(storage.count("GET", /object\/authenticated/)).toBe(0);
    expect(existsSync(join(repo, "evil.txt"))).toBe(false);
    expect(existsSync(join(repo, "out/evil.txt"))).toBe(false);
    expect(existsSync(join(repo, "out/dl"))).toBe(false);
  });

  test("a list refuses a server-side name with .. too, though it writes nothing", async () => {
    const { storage, run } = setup();
    storage.put("a", "x/../../evil.txt", "pwned");
    await expect(run({ action: "list" })).rejects.toThrow(/unsafe object name/);
  });

  test("an absolute-looking server name is refused too", async () => {
    const { storage, run } = setup();
    storage.put("a", "/abs.txt", "x");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow();
    expect(storage.count("GET", /object\/authenticated/)).toBe(0);
  });

  test("a bucket named MANIFEST cannot overwrite the manifest", async () => {
    const { storage, run } = setup();
    storage.put("MANIFEST", "x", "x");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow();
  });

  test("a failed object download fails the whole job without echoing path or body", async () => {
    const { storage, run } = setup();
    storage.put("a", "one.txt", "1");
    storage.put("a", "two-secret.txt", "2");
    storage.failDownload.add("a/two-secret.txt");
    const error = await rejection(run({ action: "download", dest: "out/dl" }));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("two-secret");
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("boom");
  });

  test("a body shorter than its content-length is an error", async () => {
    const { storage, run } = setup();
    storage.put("a", "one.txt", "12345");
    storage.lieAboutLength.add("a/one.txt");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/truncated/i);
  });

  test("downloads ask for identity, and a body Storage still encodes is refused", async () => {
    const { repo, storage, run } = setup();
    storage.put("a", "one.txt", "12345");
    storage.encoding.set("a/one.txt", "gzip");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/encoded download/);
    const get = storage.requests.find((request) => /\/object\/authenticated\//.test(request.url));
    expect(get?.headers.get("accept-encoding")).toBe("identity");
    expect(existsSync(join(repo, "out/dl/a/one.txt"))).toBe(false);
  });

  test("identity is no encoding: its sizes are still checked", async () => {
    const { storage, run } = setup();
    storage.put("a", "one.txt", "12345");
    storage.encoding.set("a/one.txt", "Identity");
    storage.lieAboutLength.add("a/one.txt");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/truncated/i);
  });

  test("a body that runs past the listed size is cut off, not buffered", async () => {
    const { repo, storage, run } = setup();
    storage.put("a", "one.txt", "12345");
    storage.oversize.add("a/one.txt");
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/larger than expected/);
    expect(storage.cancelled).toBe(1);
    expect(existsSync(join(repo, "out/dl/a/one.txt"))).toBe(false);
  });

  test("an object listed twice is an error, not a silent overwrite", async () => {
    const { repo, storage, run } = setup();
    storage.put("a", "one.txt", "12345");
    storage.duplicateListing = true;
    await expect(run({ action: "download", dest: "out/dl" })).rejects.toThrow(/written/);
    expect(readFileSync(join(repo, "out/dl/a/one.txt"), "utf8")).toBe("12345");
    expect(existsSync(join(repo, "out/dl/MANIFEST"))).toBe(false);
  });
});

describe("storage.admin upload", () => {
  const content = "contenuto del file";
  function withFile(extra: Partial<Record<string, unknown>> = {}) {
    const ctx = setup();
    mkdirSync(join(ctx.repo, "files"), { recursive: true });
    writeFileSync(join(ctx.repo, "files/banner.png"), content);
    ctx.storage.put("assets", "keep.txt", "keep");
    const payload = {
      action: "upload", bucket: "assets", object: "brand/banner.png", path: "files/banner.png",
      digest: sha256(content), content_type: "image/png", ...extra
    };
    return { ...ctx, payload };
  }

  test("sends the verified bytes with the content type and no upsert header", async () => {
    const { storage, run, payload } = withFile();
    const result = await run(payload);
    const post = storage.requests.find((r) => r.method === "POST")!;
    expect(post.url).toBe(`https://${REF}.supabase.co/storage/v1/object/assets/brand/banner.png`);
    expect(post.headers.get("content-type")).toBe("image/png");
    expect(post.headers.get("x-upsert")).not.toBe("true");
    expect(post.body!.toString()).toBe(content);
    expect(storage.text("assets", "brand/banner.png")).toBe(content);
    expect(result.output).toEqual({ action: "upload", objects: 1, bytes: Buffer.byteLength(content), sha256: sha256(content), upsert: false });
    expectClean(result, "banner", "brand");
  });

  test("a wrong digest is refused before any request, without telling the real one", async () => {
    const { storage, run, payload } = withFile({ digest: sha256("something else") });
    const error = await rejection(run(payload));
    expect(error.message).toMatch(/digest mismatch/i);
    expect(error.message).not.toContain(sha256(content));
    expect(storage.requests).toHaveLength(0);
  });

  test("a file reached through a symlink is refused before any request, even with its right digest", async () => {
    const { repo, storage, run, payload } = withFile();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "supadrum-outside-")));
    writeFileSync(join(outside, "secret.txt"), content);
    symlinkSync(join(outside, "secret.txt"), join(repo, "files/link.png"));
    symlinkSync(outside, join(repo, "linked"));
    for (const path of ["files/link.png", "linked/secret.txt"]) {
      await expect(run({ ...payload, path })).rejects.toThrow(/symbolic link/);
    }
    expect(storage.requests).toHaveLength(0);
  });

  test.each([".git/config", ".GIT/config"])("git's own %s is never uploaded, even with its right digest", async (path) => {
    const { repo, storage, run, payload } = withFile();
    const config = readFileSync(join(repo, ".git/config"));
    await expect(run({ ...payload, path, digest: sha256(config) })).rejects.toThrow(/root or \.git/);
    expect(storage.requests).toHaveLength(0);
  });

  test("a file outside the repository is refused before any request", async () => {
    const { storage, run, payload } = withFile({ path: "../outside.png" });
    await expect(run(payload)).rejects.toThrow(/inside the project repository/);
    expect(storage.requests).toHaveLength(0);
  });

  test("a missing file is refused before any request, without naming it", async () => {
    const { storage, run, payload } = withFile({ path: "files/nope.png" });
    const error = await rejection(run(payload));
    expect(error.message).not.toContain("nope");
    expect(storage.requests).toHaveLength(0);
  });

  test("a missing content_type is refused before any request", async () => {
    const { storage, run, payload } = withFile();
    delete (payload as Record<string, unknown>).content_type;
    await expect(run(payload)).rejects.toThrow(/content_type/);
    expect(storage.requests).toHaveLength(0);
  });

  test("an existing object stops the upload unless upsert is true", async () => {
    const { storage, run, payload } = withFile();
    storage.put("assets", "brand/banner.png", "OLD");
    const error = await rejection(run(payload));
    expect(error.message).toMatch(/already exists/i);
    expect(error.message).not.toContain("banner");
    expect(storage.text("assets", "brand/banner.png")).toBe("OLD");
    const result = await run({ ...payload, upsert: true });
    expect(storage.text("assets", "brand/banner.png")).toBe(content);
    expect(storage.requests.at(-1)!.headers.get("x-upsert")).toBe("true");
    expect(result.output).toMatchObject({ upsert: true });
  });

  test("a failing upload reports the status and nothing the server said", async () => {
    const { storage, run, payload } = withFile({ bucket: "missing" });
    const error = await rejection(run(payload));
    expect(error.message).toContain("404");
    expect(error.message).not.toContain("Bucket not found");
    expect(storage.has("missing", "brand/banner.png")).toBe(false);
  });
});

describe("storage.admin delete", () => {
  function seeded() {
    const ctx = setup();
    ctx.storage.put("photos", "2026/a.png", "AAAA");
    ctx.storage.put("photos", "2026/b.png", "BBBBBB");
    ctx.storage.put("photos", "2026/c.png", "CC");
    ctx.storage.put("other", "x.txt", "keep");
    return ctx;
  }
  const payload = (objects: string[], dest = "out/del") => ({ action: "delete", bucket: "photos", objects, dest });

  test("downloads every object first, then deletes exactly those", async () => {
    const { repo, storage, run } = seeded();
    const result = await run(payload(["2026/a.png", "2026/b.png"]));
    expect(readFileSync(join(repo, "out/del/photos/2026/a.png"), "utf8")).toBe("AAAA");
    expect(readFileSync(join(repo, "out/del/photos/2026/b.png"), "utf8")).toBe("BBBBBB");
    const manifest = readFileSync(join(repo, "out/del/MANIFEST"), "utf8");
    expect(manifest).toBe(`${sha256("AAAA")}\t4\tphotos/2026/a.png\n${sha256("BBBBBB")}\t6\tphotos/2026/b.png\n`);
    expect(storage.has("photos", "2026/a.png")).toBe(false);
    expect(storage.has("photos", "2026/b.png")).toBe(false);
    expect(storage.has("photos", "2026/c.png")).toBe(true);
    expect(storage.has("other", "x.txt")).toBe(true);
    expect(result.output).toEqual({
      action: "delete", objects: 2, deleted: 2, bytes: 10,
      manifest_sha256: sha256(manifest), manifest_bytes: Buffer.byteLength(manifest)
    });
    const firstDelete = storage.requests.findIndex((r) => r.method === "DELETE");
    expect(storage.requests.slice(0, firstDelete).filter((r) => /object\/authenticated/.test(r.url))).toHaveLength(2);
    expect(storage.requests.slice(firstDelete + 1).filter((r) => /object\/authenticated/.test(r.url))).toHaveLength(0);
    expect(JSON.parse(storage.requests[firstDelete]!.body!.toString())).toEqual({ prefixes: ["2026/a.png", "2026/b.png"] });
    expectClean(result, "a.png", "b.png", "2026");
  });

  test("a failed download deletes nothing", async () => {
    const { storage, run } = seeded();
    storage.failDownload.add("photos/2026/b.png");
    const error = await rejection(run(payload(["2026/a.png", "2026/b.png", "2026/c.png"])));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("b.png");
    expect(storage.count("DELETE", /.*/)).toBe(0);
    for (const name of ["a.png", "b.png", "c.png"]) expect(storage.has("photos", `2026/${name}`)).toBe(true);
  });

  test("a truncated download deletes nothing", async () => {
    const { storage, run } = seeded();
    storage.lieAboutLength.add("photos/2026/a.png");
    await expect(run(payload(["2026/a.png"]))).rejects.toThrow();
    expect(storage.count("DELETE", /.*/)).toBe(0);
    expect(storage.has("photos", "2026/a.png")).toBe(true);
  });

  test("an object that is not there deletes nothing", async () => {
    const { storage, run } = seeded();
    await expect(run(payload(["2026/a.png", "2026/ghost.png"]))).rejects.toThrow();
    expect(storage.count("DELETE", /.*/)).toBe(0);
    expect(storage.has("photos", "2026/a.png")).toBe(true);
  });

  test("a folder name given as if it were an object deletes nothing", async () => {
    const { storage, run } = seeded();
    await expect(run(payload(["2026"]))).rejects.toThrow();
    expect(storage.count("DELETE", /.*/)).toBe(0);
    expect(storage.has("photos", "2026/a.png")).toBe(true);
  });

  test("a prefix with a trailing slash, a wildcard or a hundred and one paths never reaches the network", async () => {
    const { storage, run } = seeded();
    await expect(run(payload(["2026/"]))).rejects.toThrow();
    await expect(run(payload(["2026/*"]))).rejects.toThrow();
    await expect(run(payload(Array.from({ length: 101 }, (_, i) => `2026/${i}.png`)))).rejects.toThrow();
    expect(storage.requests).toHaveLength(0);
  });

  test("a dest git does not ignore or that is not empty is refused before any request", async () => {
    const { repo, storage, run } = seeded();
    await expect(run(payload(["2026/a.png"], "backup"))).rejects.toThrow(/check-ignore|ignored/i);
    mkdirSync(join(repo, "out/del"), { recursive: true });
    writeFileSync(join(repo, "out/del/keep"), "x");
    await expect(run(payload(["2026/a.png"]))).rejects.toThrow(/empty/i);
    expect(storage.requests).toHaveLength(0);
    expect(storage.has("photos", "2026/a.png")).toBe(true);
  });

  test("with no listed size, a body bigger than the free disk is cut off and nothing is deleted", async () => {
    const margin = 256 * 1024 * 1024;
    const ctx = setup({ free: margin + 3 });
    ctx.storage.put("photos", "2026/a.png", "AAAA");
    await expect(ctx.run(payload(["2026/a.png"]))).rejects.toThrow(/larger than expected/);
    expect(ctx.storage.count("DELETE", /\/object\//)).toBe(0);
    expect(ctx.storage.has("photos", "2026/a.png")).toBe(true);
    const fits = setup({ free: margin + 4 });
    fits.storage.put("photos", "2026/a.png", "AAAA");
    await expect(fits.run(payload(["2026/a.png"]))).resolves.toBeDefined();
    expect(fits.storage.has("photos", "2026/a.png")).toBe(false);
  });

  test("a server that removes fewer objects than asked is reported as an error", async () => {
    const { storage, run } = seeded();
    storage.deleteShortBy = 1;
    await expect(run(payload(["2026/a.png", "2026/b.png"]))).rejects.toThrow(/1 of 2/);
  });
});

describe("storage.admin chambers and secrets", () => {
  test("a local chamber uses the service key from supabase status on the loopback API", async () => {
    const { repo, storage, run, statusCalls } = setup({ local: true });
    storage.put("photos", "a.png", "AAAA");
    const result = await run({ action: "list" });
    expect(result.output).toMatchObject({ objects: 1, bytes: 4 });
    expect(storage.requests[0]!.url).toBe("http://127.0.0.1:54331/storage/v1/bucket");
    expect(storage.requests[0]!.headers.get("authorization")).toBe(`Bearer ${LOCAL_SERVICE_KEY}`);
    expect(statusCalls).toEqual([{ cwd: repo }]);
    expect(result.verification).toMatchObject({ target: "local", local_preflight: true });
    expectClean(result);
  });

  test("a local chamber works for download too, and never touches the remote host", async () => {
    const { repo, storage, run } = setup({ local: true });
    storage.put("photos", "a.png", "AAAA");
    await run({ action: "download", dest: "out/dl" });
    expect(readFileSync(join(repo, "out/dl/photos/a.png"), "utf8")).toBe("AAAA");
    expect(storage.requests.every((r) => r.url.startsWith("http://127.0.0.1:54331/"))).toBe(true);
  });

  test("a local status that points off the loopback is refused before any request", async () => {
    const { storage, run } = setup({ local: true, status: { ...LOCAL_STATUS, "API URL": "http://storage.example.com:54331" } });
    await expect(run({ action: "list" })).rejects.toThrow(/loopback/i);
    expect(storage.requests).toHaveLength(0);
  });

  test("a project without the storage capability is refused", async () => {
    const { repo, storage, run } = setup();
    await expect(run({ action: "list" }, remoteProject(repo, ["sql"]))).rejects.toThrow(/storage capability/i);
    expect(storage.requests).toHaveLength(0);
  });

  test("a remote project ref that could change the host is refused", async () => {
    const { storage, run } = setup();
    await expect(run({ action: "list" }, { project_ref: "evil.example.com/" })).rejects.toThrow(/project_ref/);
    expect(storage.requests).toHaveLength(0);
  });

  test("a server body that echoes the key never reaches the error", async () => {
    const { storage, run } = setup();
    storage.put("a", "x", "1");
    storage.failDownload.add("a/x");
    const error = await rejection(run({ action: "download", dest: "out/dl" }));
    expect(error.message).not.toContain(SECRET);
  });

  test("a network failure whose message holds the key never reaches the error", async () => {
    const { repo, oid } = makeRepo();
    const executor = new LiveSupabaseExecutor({ fetch: async () => { throw new Error(`connect failed for ${SECRET}`); } });
    const error = await rejection(executor.execute(job(oid, { action: "list" }), remoteProject(repo), credentials));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(SECRET);
  });

  test("a process failure whose message holds the key never reaches the error", async () => {
    const { storage, run } = setup({ ignore: new Error(`spawn failed with ${SECRET}`) });
    storage.put("a", "x", "1");
    const error = await rejection(run({ action: "download", dest: "out/dl" }));
    expect(error.message).toContain("spawn failed");
    expect(error.message).not.toContain(SECRET);
  });

  test("a local process failure whose message holds the service key never reaches the error", async () => {
    const { storage, run } = setup({ local: true, ignore: new Error(`spawn failed with ${LOCAL_SERVICE_KEY}`) });
    storage.put("a", "x", "1");
    const error = await rejection(run({ action: "download", dest: "out/dl" }));
    expect(error.message).toContain("spawn failed");
    expect(error.message).not.toContain(LOCAL_SERVICE_KEY);
  });

  test("an unknown action is an explicit error at the executor too", async () => {
    const { storage, run } = setup();
    await expect(run({ action: "create-bucket" })).rejects.toThrow(/storage\.admin/i);
    await expect(run({ action: "list", extra: 1 })).rejects.toThrow(/storage\.admin/i);
    expect(storage.requests).toHaveLength(0);
  });
});
