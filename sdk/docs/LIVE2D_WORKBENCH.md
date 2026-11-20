# Pocket Live2D 看板娘

The optional Pocket mini-app demonstrates the draggable Live2D character from the [acgurl widget](https://github.com/lqbby/acgurl). Use **换装** to take the outer robe on or off on the same official Niziiro Mao model. The character's face, hair, animation and position persist during the outfit change. The original widget requests a legacy Cubism 2 model from a CDN URL that now returns 404. Pocket consumes a `.model3.json` and `.moc3` pair and renders the character on its own surface. [Original widget loader](https://github.com/lqbby/acgurl/blob/main/src/live2d-widget.js#L378)

## Open in Pocket Editor

```sh
bun demo/js/apps/live2d-workbench/stage.ts
```

In the browser-based Pocket Editor, choose **Open Project**, select the directory printed by the command, then build and open Preview. The default project directory is `.pocket-build/live2d-workbench/editor-costumes`. It contains editable guest source, the Pocket project manifest, locally staged resources and references to the pinned SDK packages. Re-running preparation preserves the project and its edits. The Editor uses its configured local Cubism Web Core for preview. [Editor Live2D configuration](WEB_LIVE2D.md#local-cubism-web-core-bootstrap)

## Outfit reference

The pinned Native SDK Niziiro Mao runtime includes independent `PartRobe` and `PartHoodie` groups on one model. The guest switches only the opacity of `PartRobe` through the existing Cubism update request. It keeps the hoodie and the rest of the rig active. [Official Mao sample](https://www.live2d.com/en/learn/sample/niziiro-mao/)

Live2D's Haru authoring demo shows a uniform and a dress. The available runtime exports are separate and contain one outfit per model. A single Haru runtime with both clothes requires re-exporting the authored `.cmo3` with both sets of parts and ArtMeshes included. [Official Haru demo](https://docs.live2d.com/en/cubism-sdk-tutorials/blendexpression/) · [Pose switching notes](https://docs.live2d.com/en/cubism-sdk-tutorials/attention-changepose/)

## Preview on a phone

Connect the phone and development computer to the same network. Set `LIVE2D_PREVIEW_HOST` to the computer's Wi-Fi address and open the URL printed by the command on the phone.

```sh
LIVE2D_PREVIEW_HOST=<computer-wifi-ip> bun demo/js/apps/live2d-workbench/preview.ts
```

The launcher uses the local pinned Cubism Native sample, the official Web Core and Pocket's Web runtime. Set `POCKET_CUBISM_WEB_CORE` to override the local Core file. Source checkouts can set `POCKET_SOURCE_BUILD=1`, `POCKET_WEB_ENGINE` and `POCKET_WEB_RUNTIME` to use the source-built pinned WASM and runtime. The temporary preview link serves the build while the command runs. [Cubism Web Core setup](WEB_LIVE2D.md#local-cubism-web-core-bootstrap)

The build needs macOS `sips` to size the local model textures and the Noto Sans CJK SC Regular font to bake the Chinese labels. Set `POCKET_WORKBENCH_CJK_FONT` to a local `NotoSansCJKsc-Regular.otf` when the Lantern font cache is absent. [Noto CJK source](https://github.com/notofonts/noto-cjk)

### Try the Web GPU preview

From the repository root, build a matching experimental WebAssembly engine
and browser runtime into a new directory, then pass it to the launcher.

```sh
bun sdk/scripts/build_web_engine.ts --live2d-mesh --outdir="$PWD/.pocket-build/mao-web-gpu-engine"
POCKET_SOURCE_BUILD=1 LIVE2D_PREVIEW_GPU_DIR="$PWD/.pocket-build/mao-web-gpu-engine" \
  bun demo/js/apps/live2d-workbench/preview.ts
```

The launcher enables the experimental renderer for this preview. You can
also set `LIVE2D_PREVIEW_HOST` to reach it over Wi-Fi. The local Cubism Core
and font requirements above still apply. Unsupported frames use the usual
software presentation. [Renderer scope and fallback](WEB_LIVE2D.md#opt-in-direct-web-presentation)

## Build the mini-app

```sh
bun demo/js/scripts/build_mini_apps.ts --mini-app=live2d-workbench
```

The opt-in build writes the QJBC, PAK, manifest and trusted MOC catalog to `demo/assets/apps/live2d-workbench/`. A native Pocket host must register `PocketLive2dPlugin` for this guest and supply the catalog. The optional guest stays outside the default Showcase bundle.

To prepare a standalone Flutter host through the pinned SDK scaffold, run `bun demo/js/apps/live2d-workbench/run.ts --prepare-only`. Set `FLUTTER_BIN` if the pinned Flutter version is outside `PATH`. Pass a Flutter device ID in place of `--prepare-only` to launch it on a supported device.

## Assets and provenance

- Source review covered the retained `pocketjs_flutter_demo` parent outside `pocket_host/`. The existing Pocket Live2D integration supplies the engine, model adapter and platform capability transport. The mini-app supplies the touch interactions, interface and outfit control. [Source-first investigation](VISUAL_NOVEL_LIVE2D.md#scope-and-upstream-source-check)
- Mao's official Cubism sample assets and compiled builds stay in ignored local directories. Niziiro Mao is a Live2D Original Character. [Sample terms](https://www.live2d.com/eula/live2d-sample-model-terms_en.html)

This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.

## Validation

The mini-app compiles to QuickJS bytecode and passes the Pocket project check. Real pointer input in the installed Editor took the robe off and put it back on. The rendered frames use the same atlas throughout. Physical Android Chrome showed the same outfit toggle and legible Chinese glyphs. The phone preview serves the font and texture PAK with gzip when Chrome accepts it.

During a drag the guest translates the current pose and resumes animation when the gesture ends. An isolated Editor preview test at 390 × 720 sent the same ten moves to the Mao guest with and without continuous pose updates. Median input acknowledgement fell from 953 ms to 362 ms and release acknowledgement fell from 1,790 ms to 561 ms. The first dragged frame still took about 0.35 seconds to reach the stream, before browser rendering.

The Editor browser can request 128 retained mesh slots within the original 8 MiB limit. Older clients keep the 64-slot configuration. In the Mao drag test, the median stream packet fell from about 1.63 MB to 13 KB after the caches warmed. Frames carrying changed positions still used about 0.93 MB, and the larger cache did not measurably improve input acknowledgement in that test.

## Browser rendering cost

For the direct Web runtime, a desktop Chromium profile kept the display at DPR 3 and the viewport at 390 × 844 CSS pixels. It used the same built Mao guest and 120 held drag moves on the same back-and-forth path at each backing-store density. Timings cover the WebAssembly `web_present` call, including draw-list generation and software rasterization. They do not measure pointer-to-display latency or a physical mobile GPU.

| Backing-store density | Backing dimensions | `web_present` P50 | `web_present` P95 |
| --- | --- | ---: | ---: |
| 3× | 1170 × 2532 | 45.4 ms | 52.1 ms |
| 2× | 780 × 1688 | 22.4 ms | 27.9 ms |
| 1× | 390 × 844 | 8.0 ms | 11.9 ms |

A shorter 21-move sweep yielded 31.4 ms at 3× and 12.6 ms at 2× at P95. In the longer run, median guest advancement took 0.3 ms. Copying and uploading the RGBA buffer took 0.2–2.2 ms at the median. The pinned engine already clips redraws to damaged regions and reuses mask scratch space. Any backing-scale cap affects the full canvas, including text, so 2× is a candidate Workbench option on high-DPR displays. The default canvas density has not changed. An independent browser comparison per mode and density, including a fixed-input-cadence control, found that moving rendering to `OffscreenCanvas` delayed first visible movement at DPR 2 and 3 for this workload; the worker still uses the same software rasterizer.

### Opt-in Web GPU measurement

A desktop Playwright A/B used the same Mao QJBC, PAK, Core, engine and
390 × 844 CSS viewport with a 1170 × 2532 backing store (DPR 3). Each run
sent 120 drag inputs at a target interval of 20 ms. The Chromium experiment
used hardware WebGL2. Both browsers showed the same direction and distance
of motion at the sampled pointer positions. All attempted GPU frames were
accepted in the timing runs.

| Desktop browser | Software present P50 | GPU present P50 | 120-input run, software → GPU |
| --- | ---: | ---: | ---: |
| Chromium, two runs per mode | 18.6–19.8 ms | 3.4–3.6 ms | 3.96–4.04 s → 2.38 s |
| WebKit, one run per mode | 16 ms | 5 ms | 2.38 s → 2.38 s |

Present timing measures CPU-side call time, including draw-list
generation and GPU submission in the experimental path. Run duration
measures the fixed input sequence. GPU completion, pointer-to-display
latency and physical iPhone Safari remain unmeasured.

The drag cadence experiment replayed trusted Chromium pointer events with
the same hardware and density. At a requested 60 Hz, the 95th-percentile
browser frame callback interval went from 33.4 to 16.8 ms when the runtime
delivered the latest move once per frame. At 125 Hz it went from 99.9 to
33.3 ms. At 36 Hz the draw interval stayed near the input interval. These
callback intervals describe browser scheduling opportunity, not display
scanout.

A separate Chromium run used the same QJBC and WASM and counted successful
GPU submissions whose mesh data changed. Aligning successful model-update
replies to a browser frame increased the idle pose rate from 27.6 to 57.7
per second and the TapBody:0 pose rate from 27.7 to 56.4 per second. The
action returned to idle in 3.79 s, down from 7.76 s, for a motion authored
at 3.47 s.
