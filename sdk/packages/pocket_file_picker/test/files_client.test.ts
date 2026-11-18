import { expect, test } from "bun:test";
import { createHostBridge } from "../../pocket_ui/src/host.ts";
import { POCKET_FILES_CHUNK_BYTES, PocketFilesError, createPocketFilesClient, pickOpenFiles } from "../../pocket_ui/src/files.ts";

const HANDLE = "0123456789abcdef0123456789abcdef";

function setup() {
  const sent: any[] = [];
  const host = createHostBridge(packet => { sent.push(packet); return true; });
  const respond = (index: number, body: Record<string, unknown>) => host.handle({
    type: "event", name: "host.response",
    payload: { requestId: sent[index].payload.requestId, capability: sent[index].payload.capability, ...body },
  });
  return { sent, host, respond };
}

test("pickOpen sends the accept list and returns validated handles", async () => {
  const { sent, host, respond } = setup();
  try {
    const picked = pickOpenFiles(host, { accept: ["png", "wav"], multiple: true });
    expect(sent[0].payload.capability).toBe("files.pickOpen");
    expect(sent[0].payload.params).toEqual({ accept: ["png", "wav"], multiple: true });
    respond(0, { ok: true, result: { files: [{ handle: HANDLE, name: "a.png", size: 12, mime: "image/png" }] } });
    expect(await picked).toEqual([{ handle: HANDLE, name: "a.png", size: 12, mime: "image/png" }]);
    const cancelled = createPocketFilesClient(host).pickOpen();
    expect(sent[1].payload.params).toEqual({});
    respond(1, { ok: true, result: { files: [] } });
    expect(await cancelled).toEqual([]);
  } finally { host.dispose(); }
});

test("pickOpen rejects bad accept entries locally and malformed host answers (paths, bad handles)", async () => {
  const { sent, host, respond } = setup();
  try {
    const client = createPocketFilesClient(host);
    await expect(client.pickOpen({ accept: [".png"] })).rejects.toThrow(TypeError);
    await expect(client.pickOpen({ accept: ["*"] })).rejects.toThrow(TypeError);
    expect(sent).toHaveLength(0);
    const leaked = client.pickOpen();
    respond(0, { ok: true, result: { files: [{ handle: HANDLE, name: "/Users/me/a.png", size: 1, mime: "image/png" }] } });
    await expect(leaked).rejects.toBeInstanceOf(PocketFilesError);
    const bad = client.pickOpen();
    respond(1, { ok: true, result: { files: [{ handle: "../x", name: "a.png", size: 1, mime: "image/png" }] } });
    await expect(bad).rejects.toBeInstanceOf(PocketFilesError);
  } finally { host.dispose(); }
});

test("readChunk validates arguments and the echoed chunk; release maps the boolean; host errors reject", async () => {
  const { sent, host, respond } = setup();
  try {
    const client = createPocketFilesClient(host);
    await expect(client.readChunk("nope", 0, 1)).rejects.toThrow(TypeError);
    await expect(client.readChunk(HANDLE, -1, 1)).rejects.toThrow(RangeError);
    await expect(client.readChunk(HANDLE, 0, POCKET_FILES_CHUNK_BYTES + 1)).rejects.toThrow(RangeError);
    expect(sent).toHaveLength(0);
    const chunk = client.readChunk(HANDLE, 4, 8);
    expect(sent[0].payload).toMatchObject({ capability: "files.readChunk", params: { handle: HANDLE, offset: 4, length: 8 } });
    respond(0, { ok: true, result: { handle: HANDLE, offset: 4, length: 3, size: 7, eof: true, data: "AQID" } });
    expect(await chunk).toEqual({ handle: HANDLE, offset: 4, length: 3, size: 7, eof: true, data: "AQID" });
    const wrong = client.readChunk(HANDLE, 0, 8);
    respond(1, { ok: true, result: { handle: HANDLE, offset: 8, length: 1, size: 9, eof: false, data: "AA==" } });
    await expect(wrong).rejects.toBeInstanceOf(PocketFilesError);
    const released = client.release(HANDLE);
    respond(2, { ok: true, result: { released: true } });
    expect(await released).toBe(true);
    const failing = client.readChunk(HANDLE, 0, 1);
    respond(3, { ok: false, error: { code: "handle_not_found", message: "unknown or released file handle" } });
    await expect(failing).rejects.toMatchObject({ code: "handle_not_found" });
  } finally { host.dispose(); }
});
