import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { textOf } from "./probe_session.ts";
import type { Frame, ProbeSession } from "./probe_session.ts";
import { boot, has, openAlpha, tapText } from "./helpers.ts";
import type { FakeStudio } from "./fake_studio.ts";

// The 资源 page on the real native probe (input driven): asset upload through the file dialog capability, host-decoded image
// previews drawn as a real texture, SVG reported honestly, and the placement editor with stale-revision handling.

const imageOps = (frame: Frame) => (frame.ops ?? []).filter((o) => o.type === "image");
const request = (fake: FakeStudio, capability: string) => fake.calls(capability).map((r) => r.params);

async function openResources(session: ProbeSession): Promise<Frame> {
  const frame = await session.frame();
  await tapText(session, frame, "资源", 0);
  return session.until((f) => has(f, "资源 · alpha-app") && has(f, "logo.png") && has(f, "上传资源…"), "the resources page with the asset list", 150);
}

test("assets: selecting an image asset decodes it on the host and draws it as a texture; SVG and audio say why there is no preview", async () => {
  const { fake, session } = await boot((f) => { f.assets = ["logo.png", "hero.jpg", "icon.svg", "clip.wav"]; });
  try {
    await openAlpha(session);
    let frame = await openResources(session);
    assert.equal(imageOps(frame).length, 0, "no image before anything is selected");
    await tapText(session, frame, "logo.png");
    frame = await session.until((f) => has(f, "预览（宿主解码") && has(f, "原图 320×240"), "the decoded preview", 200);
    assert.deepEqual(request(fake, "studio.assets.preview"), [{ project: "alpha-app", name: "logo.png" }]);
    assert.ok(imageOps(frame).length >= 1, `the preview is drawn as an image op: ${JSON.stringify((frame.ops ?? []).map((o) => o.type))}`);
    // Another asset replaces the texture.
    await tapText(session, frame, "hero.jpg");
    frame = await session.until((f) => fake.calls("studio.assets.preview").length === 2 && has(f, "hero.jpg") && has(f, "预览（宿主解码"), "second preview", 200);
    // SVG: no request, an honest sentence.
    await tapText(session, frame, "icon.svg");
    frame = await session.until((f) => has(f, "SVG 无法由宿主解码，没有预览。"), "svg message", 100);
    assert.equal(fake.calls("studio.assets.preview").length, 2, "an SVG never reaches the decoder");
    assert.equal(imageOps(frame).length, 0, "no image is drawn for an SVG");
    await tapText(session, frame, "clip.wav");
    frame = await session.until((f) => has(f, "此类型不是图片，没有预览。"), "audio message", 100);
    assert.equal(fake.calls("studio.assets.preview").length, 2);
  } finally { session.kill(); }
}, 150_000);

test("assets: a decoder refusal from the host is shown with its reason, not hidden or faked", async () => {
  const { fake, session } = await boot((f) => {
    f.previewFailures.set("logo.png", { ok: false, error: { code: "decode_failed", message: "the image could not be decoded" } });
  });
  try {
    await openAlpha(session);
    let frame = await openResources(session);
    await tapText(session, frame, "logo.png");
    frame = await session.until((f) => has(f, "没有预览：the image could not be decoded"), "the refusal", 150);
    assert.equal(imageOps(frame).length, 0);
    assert.equal(fake.calls("studio.assets.preview").length, 1);
  } finally { session.kill(); }
}, 150_000);

test("assets: upload through the open dialog reads and uploads in verified chunks with progress; unsafe names are refused; the list refreshes", async () => {
  const big = Buffer.alloc(300 * 1024 + 3);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 31 + 7) % 256; // binary, not UTF-8
  const { fake, session } = await boot((f) => { f.dialogFiles = { "new-art.png": big, "bad name.png": Buffer.from("x"), "tool.exe": Buffer.from("MZ") }; });
  try {
    await openAlpha(session);
    let frame = await openResources(session);
    await tapText(session, frame, "上传资源…");
    frame = await session.until((f) => has(f, "new-art.png · 300.0 KiB · 完成") || has(f, "已上传 new-art.png"), "the upload finishing", 400);
    frame = await session.until((f) => has(f, "bad name.png") && has(f, "已拒绝") && has(f, "文件名不安全"), "the unsafe name refused", 100);
    assert.ok(has(frame, "tool.exe") && has(frame, "不支持的文件类型"), `wrong type refused\n${textOf(frame)}`);
    assert.deepEqual(request(fake, "files.pickOpen"), [{ accept: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "wav", "mp3", "ogg", "m4a", "aac", "flac", "ttf", "otf", "woff", "woff2"], multiple: true }]);
    const begin = request(fake, "studio.assets.upload.begin");
    assert.equal(begin.length, 1, "refused files never reach the service");
    assert.equal(begin[0]!.name, "new-art.png");
    assert.equal(begin[0]!.totalBytes, big.length);
    assert.deepEqual(request(fake, "studio.fs.upload.chunk").map((p) => p.offset), [0, 131072, 262144]);
    assert.ok(fake.assetFiles.get("new-art.png")!.equals(big), "the service holds the exact bytes");
    assert.equal(fake.releasedHandles.length, 3, "every picked handle is released");
    frame = await session.until((f) => has(f, "new-art.png") && textOf(f).split("\n").filter((t) => t === "new-art.png").length >= 1 && fake.calls("studio.fs.tree").length >= 2, "the asset list reloaded", 150);
    assert.ok(fake.assets.includes("new-art.png"));
  } finally { session.kill(); }
}, 150_000);

test("assets: a host without the file picker disables upload and says so", async () => {
  const { fake, session } = await boot((f) => { f.failPick = { ok: false, error: { code: "capability_unavailable", message: "files.pickOpen" } }; });
  try {
    await openAlpha(session);
    let frame = await openResources(session);
    await tapText(session, frame, "上传资源…");
    frame = await session.until((f) => has(f, "没有启用文件选择器"), "the unavailable note", 100);
    assert.equal(request(fake, "studio.assets.upload.begin").length, 0);
  } finally { session.kill(); }
}, 150_000);

test("placement: edit a placement, save with the seen revision; a stale revision shows the reload prompt and reloading clears it", async () => {
  const { fake, session } = await boot((f) => { f.builtRevision = f.revision; });
  try {
    await openAlpha(session);
    let frame = await openResources(session);
    await tapText(session, frame, "包资源策略");
    frame = await session.until((f) => has(f, "Alpha 应用") && has(f, "asset:assets/logo.png"), "the inventory", 200);
    assert.ok(has(frame, "Beta 包"), "packages are listed");
    assert.ok(has(frame, "基础包（必需）"), "locked resources are marked");
    await tapText(session, frame, "asset:assets/logo.png");
    frame = await session.until((f) => has(f, "选择资源以更改") === false && has(f, "资产文件"), "the resource detail", 100);
    await session.until(() => fake.calls("studio.project.resources.preview").length === 1, "the resource thumbnail request", 200);
    assert.deepEqual(request(fake, "studio.project.resources.preview")[0], { project: "alpha-app", revision: fake.builtRevision, package: "pocket.alpha", key: "asset:assets/logo.png" });
    frame = await session.until((f) => has(f, "预览（宿主解码") && imageOps(f).length >= 1, "the thumbnail drawn", 200);
    await tapText(session, frame, "网络");
    frame = await session.until((f) => has(f, "1 项修改未保存"), "the unsaved count", 100);
    await tapText(session, frame, "保存资源策略");
    frame = await session.until((f) => has(f, "资源策略已保存"), "saved", 200);
    const set = request(fake, "studio.project.resources.set")[0]!;
    assert.equal(set.packageId, "pocket.alpha");
    assert.deepEqual(set.placements, [{ key: "asset:assets/logo.png", placement: "network" }, { key: "asset:assets/hero.jpg", placement: "pak" }, { key: "pak:ui:font.1", placement: "pak" }]);
    assert.equal(fake.resourcePlacements.get("asset:assets/logo.png"), "network");

    // Someone else changed the project: the next save is refused as stale and the page asks to reload.
    fake.resourcesRevisionOffset = 3;
    frame = await session.frame();
    await tapText(session, frame, /资源策略已保存/); // dismiss the toast that covers the save button
    frame = await session.until((f) => !has(f, "资源策略已保存"), "the toast gone", 50);
    await tapText(session, frame, "asset:assets/hero.jpg");
    await session.settle(3);
    frame = await session.frame();
    await tapText(session, frame, "网络");
    frame = await session.until((f) => has(f, "1 项修改未保存"), "second draft", 100);
    await tapText(session, frame, "保存资源策略");
    frame = await session.until((f) => has(f, "修订号过期") && has(f, "重新加载"), "the stale prompt", 200);
    assert.equal(fake.resourcePlacements.get("asset:assets/hero.jpg"), "pak", "a stale save changes nothing");
    assert.ok(has(frame, "1 项修改未保存"), "the draft is kept until the user reloads");
    await tapText(session, frame, "重新加载", 0);
    frame = await session.until((f) => has(f, "重新加载资源清单？"), "the discard confirmation", 100);
    await tapText(session, frame, "重新加载", -1);
    frame = await session.until((f) => !has(f, "修订号过期") && !has(f, "项修改未保存"), "reloaded without the stale banner", 200);
    assert.equal(request(fake, "studio.project.resources.get").length >= 2, true);
  } finally { session.kill(); }
}, 180_000);

test("placement: before the first build the page explains that nothing is listed yet", async () => {
  const { session } = await boot();
  try {
    await openAlpha(session);
    let frame = await openResources(session);
    await tapText(session, frame, "包资源策略");
    frame = await session.until((f) => has(f, "还没有成功的构建"), "the unbuilt note", 150);
    assert.ok(has(frame, "Alpha 应用"));
  } finally { session.kill(); }
}, 120_000);
