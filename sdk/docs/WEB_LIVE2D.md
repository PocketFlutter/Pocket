# Web Live2D build and export

Web Live2D uses the existing JS Live2D/VN implementation and the browser
capability provider. The build keeps the existing `buildGuest` QJBC + PAK
pipeline and adds only the native model files and the explicitly supplied
Cubism Web Core script that the browser provider needs.

## Retained source and adaptation

The retained parent repository was checked before implementation, excluding
`pocket_host/`. Its `web_wasm_preview/index.html` is a standalone Canvas and
ring-buffer demonstration; it contains no PocketJS guest build or Live2D model
loader. No parent Live2D/Web implementation or regression scenario was
available to migrate.

The closest retained host pieces were `lib/core/ffi_bridge.dart`, which owns
generic FFI request/response transport, `lib/core/pocketjs_bundle_runner.dart`,
which loads the Guest bundle, and `lib/render/pocket_ui_components.dart`, which
owns existing rendering components. They provide the same thin host boundary
and were left as-is; none contains a Cubism client, Core bootstrap, model
catalog, or mesh renderer. The Web gap therefore reuses Pocket's retained JS
Live2D transport and PMS1 renderer contract, adding only the Web Core provider
and its Web-specific model asset resolver.

The reusable implementation is in the current SDK:

- `scripts/build_guest.ts` parses `.model3.json` references and writes the
  versioned `novel.native-assets.json` catalog next to the guest output.
- That catalog maps each confined model key, such as `models/actor.moc3`, to a
  content-addressed path such as `native-models/<sha256>.moc3`. Only the model
  binary is kept outside the PAK; textures and the model's JSON data retain
  their existing JS/PAK path.
- `packages/pocket_live2d/src/transport.ts` owns the shared
  `media.live2d.model.load/update/release` contract and PMS1 response parser;
  `packages/pocket_vn/src/live2d.ts` owns motion, physics, pose and model
  instance composition. These remain the JS path for Web and native.
- `packages/pocket_live2d/native/src/pocket_live2d_core.cpp` is the retained native Core boundary and
  coordinate source. The Web provider emits the same PMS1 placement convention
  from official Core Web facts instead of creating another model/render path.
- `build_web.ts` adapts that generated native asset catalog into Web
  `pocket.config.json`; the Web build does not create another model registry.

`build_web.ts` copies only catalog-listed, hash-shaped `.moc3` files. It does
not copy arbitrary files from `native-models/`. If the catalog has model
entries, the build requires a local Core script passed with
`--live2d-core=/path/to/live2dcubismcore.min.js` or
`POCKET_CUBISM_WEB_CORE=/path/to/live2dcubismcore.min.js`. It emits that file as
`live2dcubismcore.min.js` and writes this configuration:

```json
{
  "live2d": {
    "coreUrl": "./live2dcubismcore.min.js",
    "assets": {
      "models/actor.moc3": "native-models/<sha256>.moc3"
    }
  }
}
```

The URL is relative to the hosted Web package. The provider resolves catalog
keys through this map and keeps browser model fetches same-origin. The build
does not add a CDN dependency or treat a missing Core as supported. A project
without bundled Live2D models does not need Core and receives no `live2d`
configuration.

## Local Cubism Web Core bootstrap

The repository does not contain the proprietary Core binary. After reviewing
and accepting Live2D's [Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)
and [Open Software License Agreement](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html), install the pinned official Web Core with:

```sh
sh packages/pocket_live2d/scripts/bootstrap_cubism_web_core.sh
```

The script downloads only from Live2D's official endpoint
`https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`, verifies
SHA-256 `25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f`,
and writes the ignored cache file
`packages/pocket_live2d/.cache/cubism-web-core/live2dcubismcore.min.js`. It
asks for explicit local-development license acceptance and refuses to replace
an existing file with a different hash. The endpoint response was checked
against that digest during this integration; the Core binary remains a local
cache and is never committed. The build script can use the cache by setting
`POCKET_CUBISM_WEB_CORE=packages/pocket_live2d/.cache/cubism-web-core/live2dcubismcore.min.js`.

## Standalone SDK export

The exported SDK includes `packages/pocket_live2d/src`, a Web-only package
manifest, the verified local Core bootstrap script, and the workspace dependency
needed by `@pocket/vn`. It excludes the
Flutter plugin metadata, platform directories, native Core source, tests,
generated caches and Cubism Web Core binaries. Consumers supply a licensed
local Core file only when building a project that includes Live2D models.

From an exported SDK repository:

```sh
npm run build:web -- --project-root=/path/to/app --outdir=/path/to/web \
  --live2d-core=/path/to/live2dcubismcore.min.js
```

The equivalent environment configuration is `POCKET_CUBISM_WEB_CORE`. Both
routes feed the same `build_web.ts` option; neither downloads Core.

## Validation boundary

The build tests cover command parsing, the explicit-Core failure, omission of
Core for an empty asset catalog, and copying exactly the model files admitted
by `novel.native-assets.json`. The export tests resolve the Web-only workspace
dependency with an offline npm install and assert that Flutter, native Core,
tests and generated files are absent from the exported Web package.

The package build does not itself validate the visual fidelity of a specific
Cubism model. Validate the JS model interaction and input-driven frame changes
in a browser with the consumer's licensed Core and model assets; report any
unsupported model features explicitly.

## Provider accounting and real Guest evidence

The Web provider reports `nativeBytes` for compatibility with the shared
Live2D transport. Its value is the MOC input byte length plus byte lengths of
numeric typed arrays observable on the Core Web model (`memoryAccounting` is
`core-visible-buffers`). Cubism Core Web does not expose the model's complete
WebAssembly allocation size. The Web provider's 128 MiB budget therefore
bounds these observable buffers and MOC inputs; it does not claim to cap the
actual Core WebAssembly heap. The provider also limits each MOC input to 32
MiB, each runtime to four live models, and each returned frame to 3 MiB.
The shared client preserves that one known marker; responses without it keep
the prior native-provider contract, and unknown accounting markers are
rejected.

Three focused tests exercise the implementation with the official local Core
and the retained Hiyori sample model:

- `bun test scripts/tests/live2d_web_provider.test.ts` runs the provider in
  Chromium against Core Web 5.1.0, loading and deforming the actual Hiyori MOC.
  It also checks PMS1 placement, static-topology caching, cleanup, and the
  legacy Core blend-flag mapping.
- `bun test packages/pocket_live2d/test/live2d.test.ts` checks that the shared
  transport preserves `core-visible-buffers` without inventing the marker for
  existing native responses and rejects unknown accounting bases.
- `POCKET_SOURCE_BUILD=1 POCKET_COMPILER_PATH=.../sdk/.cache/pocketjs/tools/build.ts POCKET_BYTECODE_BIN=.../sdk/native/target/release/pocketjs_bytecode POCKET_NATIVE_PROBE=.../sdk/native/target/release/pocket_probe POCKET_CUBISM_WEB_CORE=.../sdk/packages/pocket_live2d/.cache/cubism-web-core/live2dcubismcore.min.js bun test editor/test/live2d_preview_guest.test.ts`
  builds a temporary Guest through pinned `buildGuest` and runs it in the real
  Preview probe. The Guest calls the shared JS client's `load`, multiple
  `update` requests (including cached topology), and `dispose`; the Preview
  resolves the compiled native-asset catalog with `createPreviewLive2d`, sends
  the mesh-bearing host responses through `encodeMessage` and probe
  `sendBinary`, and the Guest verifies returned `Uint8Array` PMS1 data and
  changed vertices after `ParamAngleX` input. The staged official Hiyori model
  reports 134 drawables; no Core binary is committed.

This validates the Core-to-QJBC request/response path and input-driven mesh
changes. It does not establish browser GPU or compositor pixel fidelity; that
remains a separate visual validation boundary.

## Browser software raster coverage

The retained Flutter painter already defines the mesh effect behavior: it
isolates a layer, applies the Cubism normal/add/multiply/screen blend mode and
RGB tint, and composites normal or inverted masks. The Web software surface
previously rejected those DrawOps, so its raster implementation now reuses
PocketJS's existing fixed-point and subpixel triangle samplers rather than
adding a second triangle renderer. `native/patches/web-live2d-raster.patch`
records the source change and is registered last in `scripts/prepare_upstream.py`
so a clean pinned bootstrap reproduces it after the retained mesh patches.

The patch supports texture repeat on fixed and packed-float mesh triangles,
normal and inverted masks, all four Cubism layer blend modes, and the same
multiply/screen RGB tint transform as the Flutter painter. The bounded
`RasterRenderer` surface API keeps opaque RGBA8888 output and returns
`Unsupported` before writing when a mesh layer targets ARGB8888 or RGB565.
The legacy full-frame raster API used by the Web Guest capture exports also
handles mesh groups: `web_capture`'s opaque mode, transparent premultiplied
mode and the `pocket_present` child-surface compositor all use the same mesh
interpreter and layer compositor. Intermediates use premultiplied RGBA scratch
buffers; the captured opaque frame stays opaque, while transparent capture
keeps coverage. Unsupported operations such as native rounded shapes and
gradients remain explicitly rejected by `validate_supported_draw_list`.

Validation runs against the pinned raster package:

```sh
cd .cache/pocketjs/engine
cargo test -p pocket-raster --offline
```

The 21 regression tests cover the four blend modes, partial-opacity additive
blending, RGB tint, normal and inverted masks including pixels beyond a
smaller mask bound, fixed and float packed repeat UVs, nested-layer rejection,
opcode-only layer detection, opaque and premultiplied legacy capture, non-RGBA
surface rejection before writes, and existing raster behavior. The real
browser build and pixel inspection below validates the compiled Web engine
with the Hiyori fixture.

## Completed Web acceptance (SDK 0.1.8)

`live2d_web_browser.test.ts` builds the retained Hiyori fixture through the
pinned QJBC pipeline once, then runs that same guest on the browser main thread
and the OffscreenCanvas render Worker with the rebuilt engine. A real pointer
activates its title action. Both modes return 134 Core drawables, produce
changing mesh coordinates and changing pixels in an upper-body crop that
excludes dialogue, with no runtime or page errors. The local fixture downsizes
its texture pages to 512 pixels for this integration test; it is not a visual
quality benchmark for full-resolution consumer artwork.

The ordinary App main/Worker regression separately exercises input, storage,
custom host capabilities and IME on the same engine. Rust raster regressions
cover normal/inverted masks including smaller mask bounds, partially opaque
additive blending, repeat UV, RGB tint, legacy opaque/premultiplied capture and
opcode-valued payloads. All 21 raster integration cases pass. The patch is
replayed from pinned upstream and checked again for idempotence.

Actual Web execution also exposed a fast-response scheduling loop: delivering
an immediately resolved local Core response synchronously advanced another
Guest frame, which issued another Core request in the same microtask chain.
Host responses now reuse an already queued near frame or the existing timer's
16 ms frame cadence. Input wakes retain their immediate path; hide/dispose
cancel that same timer. This adds no second animation clock or scheduling
state. Boundary tests verify yielding, coalescing, and cancellation.

The consolidated Argon Medium review identified Windows logical asset-key
joins using native backslashes. Model3 reference keys now use POSIX joins;
actual filesystem opens retain the existing native path confinement. Nested
MOC, motion and texture resource route regressions pass.

## GPU presentation design

In the [Mao drag profile](LIVE2D_WORKBENCH.md#browser-rendering-cost), 3× `web_present` reached 52.1 ms at P95 while guest advancement took 0.3 ms at the median. `PocketRuntime::present` builds a DrawList and submits it to the renderer. The Web host currently uses the software rasterizer and copies its RGBA output to Canvas2D. The existing retained image meshes live in the scene tree, but `emit_mesh_triangles` and `emit_mesh_mask` transform, clip, and expand them into screen-space triangles at presentation. Moving a frozen model still exercises these loops and rerasterizes its coverage.

The first experiment should use a renderer device at the existing `FrameInput` boundary. It should replay actual Mao DrawLists and resource updates before integrating a live guest. Use one GPU render target in paint order. Color and mask passes should stay in GPU framebuffer textures, and target-dependent blends must read the correct previous destination. Present to the browser canvas without copying a full RGBA frame through JS. Hold density, texture filtering, viewport, and input/model sequence fixed. Compare against the current software output, including the two outfits, normal and inverse masks, repeat UVs, non-normal blend modes, and viewport clipping.

The pinned `devices/web/pocket-web-render` batching, textures, and draw validation are useful references. Its current `WgpuRenderer` rejects wasm construction and repeat textured triangles, so it is not a ready browser backend. The Editor's WebGL2 batch implementation returns to Canvas2D between batches and does masking and composition there. Its shader and state code can inform a WebGL2 prototype, while those transfer boundaries should be excluded from the experiment. The [official Cubism WebGL renderer](https://github.com/Live2D/CubismWebFramework/blob/develop/src/rendering/cubismrenderer_webgl.ts) is a reference for mask targets and blend ordering.

After the replay experiment, add retained indexed mesh submission for a validated backend. Keep atlas textures, UVs, indices, and mask links resident for a resource generation. Submit changed model positions and draw state on pose updates. During translation of an unchanged pose, reuse geometry and submit only the transform and clip. Reuse a mask only while its geometry, texture, model-relative transform, and relevant clip remain valid. A generation change, renderer reset, or context loss invalidates GPU resources. An unsupported GPU frame should select the existing software path as a whole, preserving z-order, backdrop-dependent blending, and the same guest state.

Measure CPU draw-list creation, GPU submission and completion, painted-frame cadence, and pointer-to-visible movement separately. Track peak texture and render target memory. Test 3× in Android Chrome and iOS Safari as well as desktop; keep the software path as a fidelity reference and watch for context loss and resize.

### Package-owned compositor prototype

`packages/pocket_live2d/src/web_mesh_compositor.js` implements the package-private WebGL2 mesh drawing and compositing step. It accepts prepared texture draws and isolated mesh groups in paint order and targets the caller's bound framebuffer. It uses reusable scratch framebuffer textures, keeps mask and color composition in WebGL2, and copies only the affected GPU destination region for multiply blending. Atlas textures are supplied by the host and remain host-owned. The source-first implementation uses the pinned Rust raster blend formulas and the existing Editor's WebGL2 state and texture batching patterns. The retained parent had no GPU Live2D compositor to port.

The package's browser regression uses actual WebGL2 and checks both forms of masking, all four blend modes on translucent backgrounds, texture repeat, tint, clipping, paint order, and resource ownership. A separate Apple M4 Chromium/ANGLE Metal replay used real Mao mesh draws captured from the Pocket Probe for both outfits at 1170 × 2532. Both produced the expected silhouette and outfit without GL errors. Submission plus waiting for the GPU fence took 14.3 ms at the median for 27 masked groups with the robe and 12.1 ms for 25 masked groups without it. These are repeated mesh-only replays against a solid backdrop. Normal UI rendering, frame extraction, and pointer latency are outside this measurement. GPU sampler and fixed-function blend rounding can differ from the software implementation and still need full-scene pixel comparison.

### Opt-in direct Web presentation

The source-built Workbench experiment connects the package compositor to the
live pinned Web runtime. The retained parent's `web_wasm_preview/index.html`
uses Canvas2D. The experiment reuses the pinned DrawList decoder and
software rasterizer, plus the package-owned WebGL2 compositor described
above. Core Web, QJBC, PAK, the Guest's UI and gesture handling, and the
normal runtime presentation entry remain the same.

The private WASM adapter requires one contiguous mesh run that uses a single
RGBA8888 atlas. It submits the original float triangle, repeat, and mesh
layer/mask records. The pinned software renderer keeps the preceding UI in
an opaque RGBA buffer and the following UI in a premultiplied RGBA buffer.
Each buffer rerenders on an exact draw-word, raster-resource revision, or
surface geometry change. The browser reads those buffers, the atlas and
mesh words through synchronous WASM views. Texture uploads track revisions.
The WebGL2 surface composites background, meshes, and foreground in paint
order, then the existing display canvas presents it with `drawImage`.

A frame uses the ordinary software renderer when the mesh run fails
validation, the background is translucent, the mesh crosses a clipping
scope smaller than the viewport, it needs multiple atlases, or it shares
the frame with compositor surfaces or an auxiliary surface. The WebGL2
context must pass the browser's performance check. When renderer identity
is available, the adapter also declines known software renderers. If
WebGL2 loses its context or rejects a frame, software presentation
continues. After context restoration the next eligible frame can rebuild
the GPU resources. The renderer keeps the existing expanded triangle
submission, including during drags.

The direct preview delivers the latest pointer movement once per browser
animation frame. Down, up, and cancel stay ordered, with any queued move
delivered before the boundary.
Successful local Live2D update replies also wake the Guest on a browser
frame, bounded by its configured simulation frequency. This avoids an
extra fixed-delay timer while respecting the simulation rate on
high-refresh displays.

This experiment is off by default and runs only on the main-thread direct
Web preview. Published SDK builds, Editor rendering, render Workers and
native hosts use their existing presentation paths. Use the matching
source-built WASM and browser runtime through the Workbench launcher.
[Build and launch the experiment](LIVE2D_WORKBENCH.md#try-the-web-gpu-preview) ·
[Same-guest browser measurements](LIVE2D_WORKBENCH.md#opt-in-web-gpu-measurement)
