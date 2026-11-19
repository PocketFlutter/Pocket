import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

test("the optional Lantern installer requires local explicit consent and refuses an invalid configured Core without placing a project", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-optional-demo-"));
  const workspace = join(temporary, "workspace");
  const oldCore = process.env.POCKET_CUBISM_WEB_CORE;
  const oldSdk = process.env.CUBISM_SDK_ROOT;
  const invalidCore = join(temporary, "invalid-core.js");
  await writeFile(invalidCore, "not the pinned Cubism Core\n");
  process.env.POCKET_CUBISM_WEB_CORE = invalidCore;
  process.env.CUBISM_SDK_ROOT = join(temporary, "missing-cubism-sdk");

  const server = await startEditor({ port: 0, workspace });
  const base = `http://127.0.0.1:${server.port}`;
  const endpoint = `${base}/api/examples/lantern`;
  try {
    const read = await fetch(endpoint);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      available: true,
      consentRequired: true,
      modelSourceRequired: true,
      core: "invalid",
    });
    expect((await fetch(endpoint, { headers: { origin: "https://example.com" } })).status).toBe(403);

    function post(body: object, headers: Record<string, string> = {}) {
      return fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pocket-editor": "1", ...headers },
        body: JSON.stringify(body),
      });
    }
    expect((await post({ acceptCubismTerms: false })).status).toBe(400);
    expect((await post({ acceptCubismTerms: "true" })).status).toBe(400);
    expect((await post({ acceptCubismTerms: true }, { origin: "https://example.com" })).status).toBe(403);
    const invalid = await post({ acceptCubismTerms: true });
    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining("Cubism Web Core") });

    expect(await (await fetch(`${base}/api/projects`)).json()).toEqual([]);
    expect(await readdir(join(workspace, "projects"))).toEqual([]);
  } finally {
    server.stop(true);
    if (oldCore === undefined) delete process.env.POCKET_CUBISM_WEB_CORE;
    else process.env.POCKET_CUBISM_WEB_CORE = oldCore;
    if (oldSdk === undefined) delete process.env.CUBISM_SDK_ROOT;
    else process.env.CUBISM_SDK_ROOT = oldSdk;
    await rm(temporary, { recursive: true, force: true });
  }
});
