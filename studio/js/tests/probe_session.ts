// Minimal driver for the real native probe (`pocket_probe`): loads the Studio
// bytecode, steps frames, injects pointer events and answers host.request
// packets through a caller-supplied responder (a fake studio.* service).
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { join, resolve } from "node:path";

export type DrawOp = { type?: string; text?: string; x?: number; y?: number; w?: number; h?: number };
export type Frame = { events?: Array<{ name?: string; payload?: Record<string, any> }>; ops?: DrawOp[]; width?: number; height?: number };
export type HostRequest = { requestId: string; capability: string; params: Record<string, any> };
export type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
export type Responder = (request: HostRequest) => Reply | Promise<Reply> | undefined;

const studioRoot = resolve(import.meta.dir, "..", "..");
const sdkRoot = resolve(studioRoot, "..", "sdk");

export function probePath(): string {
  if (process.env.POCKET_NATIVE_PROBE) return resolve(process.env.POCKET_NATIVE_PROBE);
  for (const dir of ["aarch64-apple-darwin/release", "release", "debug"]) {
    const candidate = join(sdkRoot, "native/target", dir, "pocket_probe");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("pocket_probe is required (build sdk/native)");
}

export function artifacts() {
  const assets = join(studioRoot, "assets");
  const metadata = JSON.parse(readFileSync(join(assets, "app.bytecode.json"), "utf8"));
  assert.equal(metadata.entryFormat, "quickjs-bytecode");
  return { bytecodePath: join(assets, "app.qjbc"), pakPath: join(assets, "app.pak") };
}

export const textOf = (frame: Frame): string => (frame.ops ?? []).filter((o) => o.type === "text").map((o) => o.text).join("\n");
export const textOps = (frame: Frame, label: string | RegExp): DrawOp[] =>
  (frame.ops ?? []).filter((o) => o.type === "text" && (typeof label === "string" ? o.text === label : label.test(o.text ?? "")));
export function center(op: DrawOp): { x: number; y: number } {
  return { x: op.x! + op.w! / 2, y: op.y! + op.h! / 2 };
}

/** Encodes a value in the binary bridge wire format (0xB1 TLV; `Uint8Array` maps to the bytes tag). */
export function encodeBinaryMessage(value: unknown): Buffer {
  const out: Buffer[] = [Buffer.from([0xb1])];
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const put = (v: unknown): void => {
    if (v === null || v === undefined) out.push(Buffer.from([0x00]));
    else if (v === false) out.push(Buffer.from([0x01]));
    else if (v === true) out.push(Buffer.from([0x02]));
    else if (typeof v === "number" && Number.isInteger(v)) { const b = Buffer.alloc(9); b[0] = 0x03; b.writeBigInt64LE(BigInt(v), 1); out.push(b); }
    else if (typeof v === "number") { const b = Buffer.alloc(9); b[0] = 0x04; b.writeDoubleLE(v, 1); out.push(b); }
    else if (typeof v === "string") { const t = Buffer.from(v, "utf8"); out.push(Buffer.from([0x05]), u32(t.length), t); }
    else if (v instanceof Uint8Array) out.push(Buffer.from([0x06]), u32(v.length), Buffer.from(v));
    else if (Array.isArray(v)) { out.push(Buffer.from([0x07]), u32(v.length)); for (const item of v) put(item); }
    else { const entries = Object.entries(v as Record<string, unknown>); out.push(Buffer.from([0x08]), u32(entries.length)); for (const [k, item] of entries) { const key = Buffer.from(k, "utf8"); out.push(u32(key.length), key); put(item); } }
  };
  put(value);
  return Buffer.concat(out);
}
const containsBytes = (v: unknown): boolean => v instanceof Uint8Array || (v !== null && typeof v === "object" && Object.values(v as object).some(containsBytes));

const live = new Set<ProbeSession>();
process.once("exit", () => { for (const s of live) s.kill(); });

export class ProbeSession {
  readonly requests: HostRequest[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderr = "";
  private frameWaiters: Array<{ ok: (f: Frame) => void; fail: (e: Error) => void }> = [];
  private lineWaiters: Array<{ ok: (o: any) => void; fail: (e: Error) => void }> = [];
  private failure: Error | undefined;

  /** Receives guest -> host events other than host.request (stream.open / stream.cancel ...). */
  onGuestEvent?: (name: string, payload: Record<string, any>) => void;
  /** Every guest -> host event other than host.request, newest last (bounded). */
  readonly guestEvents: Array<{ name: string; payload: Record<string, any> }> = [];

  constructor(private readonly responder: Responder, private readonly size = { width: 900, height: 640 }, private readonly memory?: { heapLimitBytes?: number; maxPakBytes?: number }) {
    this.child = spawn(probePath(), [], { stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk: Buffer) => this.accept(decoder.write(chunk)));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf8"); });
    this.child.on("exit", (code) => { if (code !== 0) this.fail(new Error(`pocket_probe exited ${code}: ${this.stderr}`)); });
    live.add(this);
  }

  /** OS process id of the native probe (RSS sampling in the profile test). */
  get pid(): number { return this.child.pid!; }

  kill(): void { live.delete(this); if (!this.child.killed) this.child.kill(); }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const w of this.frameWaiters.splice(0)) w.fail(error);
    for (const w of this.lineWaiters.splice(0)) w.fail(error);
    this.kill();
  }

  private accept(text: string): void {
    this.buffer += text;
    for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      const parsed = JSON.parse(line);
      if (parsed.frame) {
        void this.answer(parsed.frame as Frame);
        this.frameWaiters.shift()?.ok(parsed.frame);
      } else if (parsed.ok === false && this.frameWaiters.length > 0 && this.lineWaiters.length === 0) {
        // A guest turn over the 250 ms budget (or any frame failure) answers {"ok":false,"error":...}: reject the pending frame.
        this.frameWaiters.shift()!.fail(new Error(`pocket_probe frame failed: ${parsed.error}`));
      } else this.lineWaiters.shift()?.ok(parsed);
    }
  }

  private send(command: Record<string, unknown>): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private async answer(frame: Frame): Promise<void> {
    for (const item of frame.events ?? []) {
      if (item.name && item.name !== "host.request" && item.payload) {
        this.guestEvents.push({ name: item.name, payload: item.payload });
        if (this.guestEvents.length > 400) this.guestEvents.splice(0, 200);
        this.onGuestEvent?.(item.name, item.payload);
      }
      if (item.name !== "host.request" || !item.payload) continue;
      const request: HostRequest = { requestId: String(item.payload.requestId), capability: String(item.payload.capability), params: item.payload.params ?? {} };
      this.requests.push(request);
      const reply = (await this.responder(request)) ?? { ok: false, error: { code: "capability_unavailable", message: "no provider" } } as Reply;
      try {
        const message = { type: "event", name: "host.response", payload: {
          requestId: request.requestId, capability: request.capability, ok: reply.ok,
          ...(reply.ok ? { result: reply.result } : { error: reply.error }),
        } };
        // Results that carry bytes (image previews) travel on the binary bridge, exactly like the real host.
        if (reply.ok && containsBytes(reply.result)) this.send({ op: "sendBinary", base64: encodeBinaryMessage(message).toString("base64") });
        else this.send({ op: "send", message });
      } catch { /* session closed */ }
    }
  }

  /** Drives a focused InputField like the Flutter overlay: after the tap that opened it, deliver `text` as a native edit. */
  async typeIntoOpenField(text: string): Promise<Frame> {
    const open = [...this.guestEvents].reverse().find((e) => e.name === "textInput.open" && e.payload.id);
    assert.ok(open, "no textInput.open was emitted by the guest");
    const latest = [...this.guestEvents].reverse().find((e) => e.name === "textInput.update" && e.payload.id === open.payload.id);
    const revision = Math.max(Number(open.payload.revision ?? 0), Number(latest?.payload.revision ?? 0));
    this.sendEvent("textInput.edit", {
      id: String(open.payload.id), editingSession: String(open.payload.editingSession),
      revision: revision + 1, jsRevision: Number(latest?.payload.jsRevision ?? open.payload.jsRevision ?? 0),
      text, selectionBase: text.length, selectionExtent: text.length, composingBase: -1, composingExtent: -1,
    });
    return this.frame();
  }

  /** Sends a host -> guest event (stream.data / stream.end, input.text ...). */
  sendEvent(name: string, payload: Record<string, unknown>): void {
    this.send({ op: "send", message: { type: "event", name, payload } });
  }

  private line(): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((ok, fail) => this.lineWaiters.push({ ok, fail }));
  }

  async boot(): Promise<Frame> {
    this.send({ op: "create", ...this.size, ...(this.memory ? { memory: this.memory } : {}), compositorSurfaces: { "dev.pocket.studio.preview": 4 } });
    assert.equal((await this.line()).ok, true, "create failed");
    const { bytecodePath, pakPath } = artifacts();
    this.send({ op: "loadBytecode", bytecodePath, pakPath });
    const loaded = await this.line();
    assert.equal(loaded.ok, true, `loadBytecode failed: ${loaded.error}`);
    return this.settle(20);
  }

  frame(): Promise<Frame> {
    if (this.failure) return Promise.reject(this.failure);
    const promise = new Promise<Frame>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error("pocket_probe frame timed out")), 8000);
      this.frameWaiters.push({ ok: (f) => { clearTimeout(timer); ok(f); }, fail });
    });
    this.send({ op: "frame", deltaMs: 16 });
    return promise;
  }

  async settle(count = 12): Promise<Frame> {
    let latest!: Frame;
    for (let i = 0; i < count; i += 1) { latest = await this.frame(); await new Promise((r) => setTimeout(r, 2)); }
    return latest;
  }

  /** Waits (stepping frames) until the frame text satisfies [predicate]. */
  async until(predicate: (frame: Frame) => boolean, what: string, max = 120): Promise<Frame> {
    let latest = await this.frame();
    for (let i = 0; i < max && !predicate(latest); i += 1) { await new Promise((r) => setTimeout(r, 5)); latest = await this.frame(); }
    assert.ok(predicate(latest), `timed out waiting for ${what}\n${textOf(latest)}`);
    return latest;
  }

  async tap(x: number, y: number): Promise<void> {
    for (const phase of ["down", "up"] as const) {
      this.send({ op: "send", message: { type: "event", name: "input.pointer", payload: { phase, id: 0, x, y } } });
      await this.frame();
    }
  }
}
