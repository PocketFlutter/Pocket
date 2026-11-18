import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

let workspace = "";
let server: Awaited<ReturnType<typeof startEditor>>;
let base = "";
let csrf = "";
let projectDir = "";
const outside = mkdtempSync(join(tmpdir(), "pocket-asset-outside-"));

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf5000000301010000c5e2a2a60000000049454e44ae426082", "hex");

async function call(path: string, init: RequestInit & { json?: unknown; auth?: "csrf" | "none" } = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET" && init.auth !== "none") headers.set("x-pocket-csrf", csrf);
  let body = init.body;
  if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
  const response = await fetch(`${base}/api/projects/asset-app${path}`, { method, headers, body });
  const bytes = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, headers: response.headers, body: type.includes("json") ? JSON.parse(bytes.toString("utf8")) : bytes };
}

async function uploadAsset(name: string, bytes: Buffer, chunk = 131072): Promise<{ uploadId: string }> {
  const opened = await call("/uploads", { method: "POST", json: { target: "asset", name, totalBytes: bytes.length, sha256: sha(bytes) } });
  expect(opened.status).toBe(201);
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const put = await call(`/uploads/${opened.body.uploadId}`, { method: "PUT", json: { offset, data: bytes.subarray(offset, offset + chunk).toString("base64") } });
    expect(put.status).toBe(200);
  }
  return { uploadId: opened.body.uploadId };
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "pocket-asset-routes-"));
  server = await startEditor({ port: 0, workspace, buildRunner: async () => { throw new Error("not used"); } });
  base = `http://127.0.0.1:${server.port}`;
  csrf = (await (await fetch(`${base}/health`)).json()).csrfToken;
  const created = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pocket-csrf": csrf },
    body: JSON.stringify({ id: "asset-app", name: "Asset App", version: "0.1.0", tickHz: 60 }),
  });
  expect(created.status).toBe(201);
  projectDir = join(workspace, "projects/asset-app");
});

afterAll(async () => {
  await server.stop(true);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("chunked asset upload commits arbitrary binary bytes below assets/, bumps the revision and lists the asset", async () => {
  const bytes = Buffer.alloc(300 * 1024 + 11);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) % 256; // NUL bytes and invalid UTF-8 are fine for assets
  const before = (await call("/status")).body.revision;
  const { uploadId } = await uploadAsset("logo.png", bytes);
  const committed = await call(`/uploads/${uploadId}/commit`, { method: "POST", json: {} });
  expect(committed.status).toBe(200);
  expect(committed.body).toMatchObject({ path: "assets/logo.png", bytes: bytes.length, sha256: sha(bytes), revision: before + 1 });
  expect(committed.body.assets).toContain("logo.png");
  expect(readFileSync(join(projectDir, "assets/logo.png")).equals(bytes)).toBe(true);
  expect((await call("/assets")).body.assets).toContain("logo.png");
  expect((await call("/status")).body.logs.at(-1)).toContain("asset saved: logo.png");
  expect((await call(`/uploads/${uploadId}/commit`, { method: "POST", json: {} })).status).toBe(404);
  // Same name replaces, like the multipart route.
  const again = await uploadAsset("logo.png", Buffer.from("v2"));
  expect((await call(`/uploads/${again.uploadId}/commit`, { method: "POST", json: {} })).status).toBe(200);
  expect(readFileSync(join(projectDir, "assets/logo.png"), "utf8")).toBe("v2");
  // Empty file.
  const empty = await call("/uploads", { method: "POST", json: { target: "asset", name: "empty.bin", totalBytes: 0, sha256: sha("") } });
  expect((await call(`/uploads/${empty.body.uploadId}/commit`, { method: "POST", json: {} })).status).toBe(200);
});

test("asset upload guards: unsafe names, size cap, wrong target, mixed params, bad sha, incomplete, CSRF", async () => {
  const open = (extra: Record<string, unknown>) => call("/uploads", { method: "POST", json: { target: "asset", totalBytes: 1, sha256: sha("a"), ...extra } });
  for (const name of ["../x.png", "a/b.png", ".hidden", "a\\b.png", "", " x.png", "x".repeat(129), "x\0.png", "%2e%2e", "dir/"]) {
    expect((await open({ name })).status).toBe(400);
  }
  expect((await open({})).status).toBe(400); // name required
  expect((await open({ name: "a.png", path: "assets/a.png" })).status).toBe(400); // `path` is not accepted for assets
  expect((await call("/uploads", { method: "POST", json: { target: "source", name: "a.png", totalBytes: 1, sha256: sha("a") } })).status).toBe(400);
  expect((await open({ name: "big.png", totalBytes: 32 * 1024 * 1024 + 1 })).status).toBe(413);
  expect((await open({ name: "ok.png", totalBytes: 32 * 1024 * 1024 })).status).toBe(201);
  expect((await open({ name: "n.png", sha256: "zz" })).status).toBe(400);
  expect((await open({ name: "n.png", totalBytes: -1 })).status).toBe(400);
  expect((await call("/uploads", { method: "POST", json: { target: "asset", name: "n.png", totalBytes: 1, sha256: sha("a") }, auth: "none" })).status).toBe(403);
  // Without target the old policy still refuses assets/ and binary names.
  expect((await call("/uploads", { method: "POST", json: { path: "assets/a.ts", totalBytes: 1, sha256: sha("a") } })).status).toBe(400);
  expect((await call("/uploads", { method: "POST", json: { path: "assets/a.png", totalBytes: 1, sha256: sha("a") } })).status).toBe(400);

  const short = await open({ name: "short.png", totalBytes: 4, sha256: sha("abcd") });
  await call(`/uploads/${short.body.uploadId}`, { method: "PUT", json: { offset: 0, data: Buffer.from("ab").toString("base64") } });
  expect((await call(`/uploads/${short.body.uploadId}/commit`, { method: "POST", json: {} })).status).toBe(409);
  expect((await call(`/uploads/${short.body.uploadId}`, { method: "PUT", json: { offset: 0, data: Buffer.from("cd").toString("base64") } })).status).toBe(409); // not contiguous
  expect((await call(`/uploads/${short.body.uploadId}`, { method: "PUT", json: { offset: 2, data: Buffer.from("cdef").toString("base64") } })).status).toBe(413); // beyond totalBytes
  await call(`/uploads/${short.body.uploadId}`, { method: "PUT", json: { offset: 2, data: Buffer.from("xx").toString("base64") } });
  expect((await call(`/uploads/${short.body.uploadId}/commit`, { method: "POST", json: {} })).status).toBe(422); // sha mismatch
  expect(existsSync(join(projectDir, "assets/short.png"))).toBe(false);
  expect((await call(`/uploads/${short.body.uploadId}`, { method: "DELETE" })).status).toBe(200);
});

test("asset upload refuses a symlinked assets directory or symlinked leaf and never writes outside the project", async () => {
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  writeFileSync(join(outside, "target.png"), "outside");
  symlinkSync(join(outside, "target.png"), join(projectDir, "assets/link.png"));
  const opened = await call("/uploads", { method: "POST", json: { target: "asset", name: "link.png", totalBytes: 1, sha256: sha("a") } });
  expect(opened.status).toBe(400);
  expect(readFileSync(join(outside, "target.png"), "utf8")).toBe("outside");
  expect((await call("/assets/link.png")).status).toBe(400);
  rmSync(join(projectDir, "assets/link.png"));
});

test("GET assets/<name> serves the raw bytes inert and honours the same name policy", async () => {
  const { uploadId } = await uploadAsset("pixel.png", PNG);
  expect((await call(`/uploads/${uploadId}/commit`, { method: "POST", json: {} })).status).toBe(200);
  const response = await call("/assets/pixel.png");
  expect(response.status).toBe(200);
  expect(Buffer.from(response.body).equals(PNG)).toBe(true);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("cache-control")).toBe("no-store");
  writeFileSync(join(projectDir, "assets/clip.wav"), "RIFF");
  expect((await call("/assets/clip.wav")).headers.get("content-type")).toBe("application/octet-stream");
  expect((await call("/assets/missing.png")).status).toBe(404);
  expect((await call("/assets/..%2Fpocket.json")).status).toBe(400);
  expect((await call("/assets/.hidden")).status).toBe(400);
  expect((await call("/assets/a/b.png")).status).toBe(404);
  expect((await call("/assets/pixel.png", { method: "DELETE" })).status).not.toBe(200);
  // The multipart route and its policy are unchanged.
  const form = new FormData();
  form.set("file", new File([PNG], "multi.png"));
  const multi = await fetch(`${base}/api/projects/asset-app/assets`, { method: "POST", headers: { "x-pocket-csrf": csrf }, body: form });
  expect(multi.status).toBe(200);
  expect((await call("/assets")).body.assets).toEqual(expect.arrayContaining(["multi.png", "pixel.png"]));
});

test("GET assets/<name> applies the cross-origin read guard like the other new read routes", async () => {
  const { uploadId } = await uploadAsset("guard.png", PNG);
  expect((await call(`/uploads/${uploadId}/commit`, { method: "POST", json: {} })).status).toBe(200);
  expect((await call("/assets/guard.png", { headers: { Origin: "http://evil.example" } })).status).toBe(403);
  expect((await call("/assets/guard.png", { headers: { Origin: "null" } })).status).toBe(403);
  expect((await call("/assets/guard.png", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
  expect((await call("/assets/guard.png", { headers: { "Sec-Fetch-Site": "same-site" } })).status).toBe(403);
  // Same-origin and no-Origin requests (Flutter host, curl, tests) still read the bytes.
  const sameOrigin = await call("/assets/guard.png", { headers: { Origin: base, "Sec-Fetch-Site": "same-origin" } });
  expect(sameOrigin.status).toBe(200);
  expect(Buffer.from(sameOrigin.body).equals(PNG)).toBe(true);
  const plain = await call("/assets/guard.png");
  expect(plain.status).toBe(200);
  expect(Buffer.from(plain.body).equals(PNG)).toBe(true);
});
