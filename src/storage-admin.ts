import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { safeSegment, type StorageAdminPayload } from "./storage-payload.js";

/** Entries asked of Storage per list page; the walk stops on an empty page, not a short one. */
const LIST_PAGE = 1000;
/** One request, whole body included; a hung Storage must not hold a job forever. */
const REQUEST_TIMEOUT_MS = 300_000;
/** Files `storage.admin` writes at the top of `dest`; no bucket may take their place. */
const RESERVED = new Set(["MANIFEST", "LIST"]);
const MAX_PATH = 1024;
/** Room left on the disk after a download, so the job never fills it to the last byte. */
const DISK_MARGIN = 256 * 1024 * 1024;

/** What the executor hands over: where Storage is, with which key, and how to reach the repo. */
export interface StorageContext {
  /** `<origin>/storage/v1`, no trailing slash. */
  readonly base: string;
  /** The service key of the chamber. It only ever leaves in request headers. */
  readonly key: string;
  readonly request: typeof fetch;
  readonly repository: string;
  /** Confines a requested path to the repository, as every other job path is. */
  readonly repositoryPath: (requested: string, what: string) => string;
  /** True when `git check-ignore` covers the repo-relative path. */
  readonly isIgnored: (relativePath: string) => Promise<boolean>;
  /** Bytes free on the disk holding a path. */
  readonly freeBytes: (path: string) => number;
}

export interface StorageResult {
  readonly output: Record<string, unknown>;
  readonly verification: Record<string, unknown>;
}

interface Entry { readonly bucket: string; readonly path: string; readonly bytes: number; readonly updated: string }
/** `bytes`, when the listing gave it, is what the download must weigh. */
interface Item { readonly bucket: string; readonly path: string; readonly bytes?: number }

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const full = (item: Item) => `${item.bucket}/${item.path}`;
const byPath = (a: Item, b: Item) => (full(a) < full(b) ? -1 : full(a) > full(b) ? 1 : 0);
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
/** The filesystem here is case-insensitive: `.GIT` is the same folder as `.git`. */
const isGit = (segment: string) => segment.toLowerCase() === ".git";

/**
 * Where an object lands under `dest`: bucket, then its path, every segment
 * plain. A name with `..`, an absolute path or an empty part never leaves
 * `dest`, and a bucket may not take the place of the MANIFEST or LIST file.
 */
export function localTarget(dest: string, bucket: string, object: string): string {
  const segments = [bucket, ...object.split("/")];
  if (!segments.every(safeSegment) || segments.some(isGit) || RESERVED.has(bucket.toUpperCase())) {
    throw new Error("Storage name cannot be written under dest");
  }
  return join(dest, ...segments);
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error("Storage returned an unexpected response");
}

function client(context: StorageContext) {
  const auth = { apikey: context.key, Authorization: `Bearer ${context.key}` };
  async function call(method: string, route: string, extra: { headers?: Record<string, string>; body?: string | Uint8Array } = {}) {
    let response: Response;
    try {
      response = await context.request(`${context.base}${route}`, {
        method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { ...auth, ...extra.headers }, ...(extra.body === undefined ? {} : { body: extra.body as BodyInit })
      });
    } catch { throw new Error("Storage request failed"); }
    return response;
  }
  const json = (method: string, route: string, body?: unknown) => call(method, route, body === undefined ? {} : {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  async function array(response: Response): Promise<unknown[]> {
    if (!response.ok) throw new Error(`Storage request failed (${response.status})`);
    try {
      const body: unknown = await response.json();
      if (Array.isArray(body)) return body;
    } catch {}
    throw new Error("Storage returned an unexpected response");
  }
  return { call, json, array };
}

type Client = ReturnType<typeof client>;

async function listBuckets(storage: Client): Promise<Array<{ name: string; public: boolean }>> {
  return (await storage.array(await storage.call("GET", "/bucket"))).map((item) => {
    const row = record(item);
    if (typeof row.name !== "string" || !safeSegment(row.name) || typeof row.public !== "boolean") {
      throw new Error("Storage returned an unexpected response");
    }
    return { name: row.name, public: row.public };
  });
}

/** Every object of a bucket, folders walked and pages followed until Storage runs dry. */
async function listObjects(storage: Client, bucket: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  const prefixes = [""];
  for (let prefix = prefixes.pop(); prefix !== undefined; prefix = prefixes.pop()) {
    for (let offset = 0; ;) {
      const page = await storage.array(await storage.json("POST", `/object/list/${encodeURIComponent(bucket)}`, {
        prefix, limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" }
      }));
      if (page.length === 0) break;
      for (const item of page) {
        const row = record(item);
        if (typeof row.name !== "string" || !safeSegment(row.name)) throw new Error("Storage returned an unsafe object name");
        const path = prefix ? `${prefix}/${row.name}` : row.name;
        if (path.length > MAX_PATH) throw new Error("Storage returned an unsafe object name");
        if (row.id === null) { prefixes.push(path); continue; }
        const size = record(row.metadata).size;
        if (typeof size !== "number") throw new Error("Storage returned an unexpected response");
        const date = row.updated_at ?? row.created_at;
        entries.push({ bucket, path, bytes: size, updated: typeof date === "string" ? date : "" });
      }
      offset += page.length;
    }
  }
  return entries;
}

/** Reads a body but never more than `cap` bytes: an endless one is cut off, not buffered. */
async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (let part = await reader?.read(); part && !part.done; part = await reader!.read()) {
      length += part.value.length;
      if (length > cap) break;
      chunks.push(part.value);
    }
  } catch { throw new Error("Storage download failed"); }
  if (length > cap) {
    await reader?.cancel().catch(() => {});
    throw new Error("Storage download is larger than expected");
  }
  return Buffer.concat(chunks, length);
}

/**
 * One object, asked for as identity: a body Storage still encodes is refused,
 * because its sizes would no longer say whether the download is whole.
 */
async function fetchObject(storage: Client, item: Item, cap: number): Promise<Buffer> {
  const response = await storage.call("GET", `/object/authenticated/${encodeURIComponent(item.bucket)}/${encodePath(item.path)}`, {
    headers: { "Accept-Encoding": "identity" }
  });
  if (!response.ok) throw new Error(`Storage download failed (${response.status})`);
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    await response.body?.cancel().catch(() => {});
    throw new Error("Storage served an encoded download");
  }
  const data = await readCapped(response, item.bytes ?? cap);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== data.length) throw new Error("Storage download was truncated");
  if (item.bytes !== undefined && item.bytes !== data.length) throw new Error("Storage download does not match the listing");
  return data;
}

/**
 * Repo-relative segments of a confined path. Neither the root, nor `.git` at
 * any depth, nor a symbolic link on the way: each could point the job at a
 * file outside the repository or inside git's own config.
 */
function plainSegments(context: StorageContext, absolute: string, what: string): string[] {
  const root = resolve(context.repository);
  const segments = relative(root, absolute).split(sep);
  if (segments[0] === "" || segments.some(isGit)) {
    throw new Error(`${what} must be inside the repository, not its root or .git`);
  }
  let walked = root;
  for (const segment of segments) {
    walked = join(walked, segment);
    const stat = lstatSync(walked, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`${what} must not pass through a symbolic link`);
  }
  return segments;
}

/**
 * dest is where the files go, so it must be a folder inside the repository
 * that git ignores and that holds nothing yet. Checked before any request and
 * before anything is created. The ignore probe is a file under dest, because
 * a pattern like `out/` covers what is inside a folder, not a folder that
 * does not exist yet.
 */
async function guardDest(context: StorageContext, requested: string, probe: string): Promise<string> {
  const absolute = context.repositoryPath(requested, "Storage dest");
  const segments = plainSegments(context, absolute, "Storage dest");
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || readdirSync(absolute).length > 0)) {
    throw new Error("Storage dest must be an empty folder or not exist yet");
  }
  if (!(await ignored(context, join(resolve(context.repository), ...segments, probe)))) {
    throw new Error("Storage dest is not covered by .gitignore (git check-ignore)");
  }
  return absolute;
}

/**
 * Creates a file that must not exist yet, in a folder that still resolves
 * under `dest`: a folder swapped for a symbolic link while the job runs is
 * caught here. A collision or a full disk says nothing about the name.
 */
function writeNew(dest: string, path: string, data: string | Uint8Array): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // ponytail: check then write leaves a window a same-user process could still race; openat-style walks if that matters.
    const root = realpathSync(dest);
    const parent = realpathSync(dirname(path));
    if (parent !== root && !parent.startsWith(root + sep)) throw new Error("outside dest");
    writeFileSync(path, data, { flag: "wx" });
  } catch { throw new Error("Storage file could not be written under dest"); }
}

/** `./` keeps a path that starts with `:` from being read as pathspec magic. */
async function ignored(context: StorageContext, absolute: string): Promise<boolean> {
  return context.isIgnored(["."].concat(relative(resolve(context.repository), absolute).split(sep)).join("/"));
}

/**
 * Downloads every item under `dest` and writes the MANIFEST (sha256, bytes,
 * path). Names are checked first, and git must ignore every file the job
 * will write (a `!` rule can re-include one), so a bad one stops the job
 * before any download; one failed download fails the whole job.
 */
async function saveAll(context: StorageContext, storage: Client, dest: string, items: readonly Item[]) {
  const sorted = [...items].sort(byPath);
  // ponytail: one git process per object; `check-ignore --stdin` when buckets hold thousands.
  for (const item of sorted) {
    if (!(await ignored(context, localTarget(dest, item.bucket, item.path)))) {
      throw new Error("Storage dest is not covered by .gitignore (git check-ignore)");
    }
  }
  let bytes = 0;
  const lines: string[] = [];
  for (const item of sorted) {
    // A delete has no listed size: what is left on the disk bounds the body instead.
    const data = await fetchObject(storage, item, context.freeBytes(context.repository) - DISK_MARGIN);
    writeNew(dest, localTarget(dest, item.bucket, item.path), data);
    bytes += data.length;
    lines.push(`${sha256(data)}\t${data.length}\t${full(item)}\n`);
  }
  const manifest = lines.join("");
  writeNew(dest, join(dest, "MANIFEST"), manifest);
  return { objects: sorted.length, bytes, manifest_sha256: sha256(manifest), manifest_bytes: Buffer.byteLength(manifest) };
}

const sum = (entries: readonly Entry[]) => entries.reduce((total, entry) => total + entry.bytes, 0);

async function list(context: StorageContext, storage: Client, dest: string | undefined): Promise<StorageResult> {
  const target = dest === undefined ? undefined : await guardDest(context, dest, "LIST");
  const buckets: Array<{ name: string; public: boolean; objects: number; bytes: number }> = [];
  const all: Entry[] = [];
  for (const bucket of await listBuckets(storage)) {
    const entries = await listObjects(storage, bucket.name);
    buckets.push({ ...bucket, objects: entries.length, bytes: sum(entries) });
    all.push(...entries);
  }
  const output: Record<string, unknown> = { action: "list", buckets, objects: all.length, bytes: sum(all) };
  if (target !== undefined) {
    const text = [...all].sort(byPath).map((entry) => `${full(entry)}\t${entry.bytes}\t${entry.updated}\n`).join("");
    writeNew(target, join(target, "LIST"), text);
    output.list_sha256 = sha256(text);
    output.list_bytes = Buffer.byteLength(text);
  }
  return { output, verification: target === undefined ? {} : { dest: relative(resolve(context.repository), target) } };
}

async function download(context: StorageContext, storage: Client, payload: Extract<StorageAdminPayload, { action: "download" }>): Promise<StorageResult> {
  const dest = await guardDest(context, payload.dest, "MANIFEST");
  const known = new Set((await listBuckets(storage)).map((bucket) => bucket.name));
  const names = payload.buckets ?? [...known];
  if (!names.every((name) => known.has(name))) throw new Error("Requested storage bucket does not exist");
  const items: Entry[] = [];
  for (const name of names) items.push(...await listObjects(storage, name));
  if (sum(items) + DISK_MARGIN > context.freeBytes(context.repository)) {
    throw new Error("Storage download does not fit on the disk");
  }
  const saved = await saveAll(context, storage, dest, items);
  return {
    output: { action: "download", buckets: names.length, ...saved },
    verification: { dest: relative(resolve(context.repository), dest) }
  };
}

async function upload(context: StorageContext, storage: Client, payload: Extract<StorageAdminPayload, { action: "upload" }>): Promise<StorageResult> {
  const absolute = context.repositoryPath(payload.path, "Upload file");
  plainSegments(context, absolute, "Upload file");
  let data: Buffer;
  try { data = readFileSync(absolute); }
  catch { throw new Error("Upload file is not readable"); }
  const actual = sha256(data);
  if (actual !== payload.digest) {
    throw new Error(`Upload file digest mismatch: expected ${payload.digest}`);
  }
  const upsert = payload.upsert === true;
  const response = await storage.call("POST", `/object/${encodeURIComponent(payload.bucket)}/${encodePath(payload.object)}`, {
    headers: { "Content-Type": payload.content_type, "x-upsert": String(upsert) }, body: new Uint8Array(data)
  });
  if (!response.ok) {
    const body = record(await response.json().catch(() => ({})));
    if (response.status === 409 || body.statusCode === "409" || body.error === "Duplicate") {
      throw new Error("Storage object already exists; send upsert: true to replace it");
    }
    throw new Error(`Storage upload failed (${response.status})`);
  }
  return { output: { action: "upload", objects: 1, bytes: data.length, sha256: actual, upsert }, verification: {} };
}

async function remove(context: StorageContext, storage: Client, payload: Extract<StorageAdminPayload, { action: "delete" }>): Promise<StorageResult> {
  const dest = await guardDest(context, payload.dest, "MANIFEST");
  const saved = await saveAll(context, storage, dest, payload.objects.map((path) => ({ bucket: payload.bucket, path })));
  const removed = await storage.array(await storage.json("DELETE", `/object/${encodeURIComponent(payload.bucket)}`, { prefixes: payload.objects }));
  if (removed.length !== payload.objects.length) {
    throw new Error(`Storage deleted ${removed.length} of ${payload.objects.length} objects`);
  }
  return {
    output: { action: "delete", objects: saved.objects, deleted: removed.length, bytes: saved.bytes,
      manifest_sha256: saved.manifest_sha256, manifest_bytes: saved.manifest_bytes },
    verification: { dest: relative(resolve(context.repository), dest) }
  };
}

/**
 * `storage.admin`: list, download, upload and delete objects through the
 * Storage REST API. Results carry counts, bytes and digests only; object paths
 * and contents exist nowhere but in the files written under `dest`.
 */
export async function runStorageAdmin(payload: StorageAdminPayload, context: StorageContext): Promise<StorageResult> {
  const storage = client(context);
  const result = payload.action === "list" ? await list(context, storage, payload.dest)
    : payload.action === "download" ? await download(context, storage, payload)
    : payload.action === "upload" ? await upload(context, storage, payload)
    : await remove(context, storage, payload);
  return { output: result.output, verification: { storage_action: payload.action, ...result.verification } };
}
