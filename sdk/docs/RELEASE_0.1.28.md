# Pocket Web SDK 0.1.28

## Added

- Studio includes an optional direct Web preview for eligible Live2D projects. It uses the packaged engine and the locally configured Cubism Web Core (`6842a36`, `a71cbe2`). [Studio modes](LIVE2D_WORKBENCH.md#use-gpu-preview-inside-web-editor)

## Changed

- Studio defaults to the preview that draws text with Canvas2D and uses WebGL2 for compatible model mesh batches. The direct Web mode has its own saved preference and displays baked glyphs (`a71cbe2`). [Live2D preview modes](WEB_LIVE2D.md#opt-in-direct-web-presentation)

## Fixed

- The Workbench starts a drag on visible model geometry, including Mao's hat and cape. Tap actions continue to use Cubism's authored hit areas. The mesh predicate is also available in `@pocketflutter/live2d@0.1.1` (`a71cbe2`, `5b58f55`). [Model mesh hit testing](VISUAL_NOVEL_LIVE2D.md#model-mesh-hit-testing)

## Performance

- Standalone Web builds with Live2D models use WebGL2 for compatible model mesh frames by default. The software renderer draws interface layers and continues to handle frames that cannot use the GPU path (`6fe36a2`, `a71cbe2`). [Web Live2D rendering and fallback](WEB_LIVE2D.md#opt-in-direct-web-presentation)

## Compatibility

The pinned PocketJS revision and QuickJS bytecode ABI are unchanged. The Studio release targets macOS arm64 and Windows x64. Web Live2D requires a separately installed local Cubism Web Core. Live2D acceleration is available for supported main-thread browser frames. [Install Studio](INSTALL_STUDIO.md) · [Cubism Web Core](WEB_LIVE2D.md#local-cubism-web-core-bootstrap)
