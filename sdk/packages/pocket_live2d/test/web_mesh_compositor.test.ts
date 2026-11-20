import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("standalone Live2D GPU mesh prototype composites into a WebGL2 framebuffer", { timeout: 10_000 }, async () => {
  const module = Bun.file(new URL("../src/web_mesh_compositor.js", import.meta.url));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/": return new Response("<!doctype html><canvas width=8 height=6></canvas>", {
          headers: { "content-type": "text/html" },
        });
        case "/web_mesh_compositor.js": return new Response(module, {
          headers: { "content-type": "text/javascript" },
        });
        default: return new Response(null, { status: 404 });
      }
    },
  });
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(server.url.href);
      const result = await page.evaluate(async (modulePath) => {
        const { createLive2dWebMeshCompositor } = await import(modulePath) as
          typeof import("../src/web_mesh_compositor.js");
        const canvas = document.querySelector("canvas")!;
        const { width, height } = canvas;
        const context = canvas.getContext("webgl2", { antialias: false });
        if (!context) throw new Error("WebGL2 is unavailable in Playwright Chromium");
        const gl = context;
        const debug = gl.getExtension("WEBGL_debug_renderer_info");
        const renderer = gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);

        const textures: WebGLTexture[] = [];
        function texture(w: number, h: number, rgba?: number[]) {
          const result = gl.createTexture()!;
          textures.push(result);
          gl.bindTexture(gl.TEXTURE_2D, result);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE,
            rgba ? new Uint8Array(rgba) : null);
          return result;
        }

        const target = texture(width, height);
        const source = texture(1, 1, [160, 80, 40, 128]);
        const red = texture(1, 1, [255, 0, 0, 255]);
        const green = texture(1, 1, [0, 255, 0, 255]);
        const coverage = texture(1, 1, [0, 0, 0, 128]);
        const stripe = texture(2, 1, [255, 0, 0, 255, 0, 0, 255, 255]);
        const framebuffer = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error("RGBA8 destination framebuffer is incomplete");
        }

        const compositor = createLive2dWebMeshCompositor(gl);
        const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
        const bounds = rect(1, 1, 6, 3);
        function quad(texture: WebGLTexture, area = bounds, alpha = 1, u = 0.25) {
          const { x, y, width, height } = area;
          const right = x + width;
          const bottom = y + height;
          return { texture, vertices: new Float32Array([
            x, y, u, 0.5, alpha,
            right, y, u, 0.5, alpha,
            x, bottom, u, 0.5, alpha,
            right, y, u, 0.5, alpha,
            right, bottom, u, 0.5, alpha,
            x, bottom, u, 0.5, alpha,
          ]) };
        }

        const pixels: Record<string, number[]> = {};
        function sample(name: string, x: number, y: number) {
          if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== framebuffer ||
              gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) !== framebuffer) {
            throw new Error("Compositor left a private framebuffer bound");
          }
          const pixel = new Uint8Array(4);
          gl.readPixels(x, height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          pixels[name] = Array.from(pixel);
        }
        function clear(r = 0, g = 0, b = 0, a = 0) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.viewport(0, 0, width, height);
          gl.clearColor(r / 255, g / 255, b / 255, a / 255);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }

        for (const blend of [0, 1, 2, 3]) {
          clear(30, 60, 90, 128);
          compositor.drawLayer({ bounds, blend, content: [quad(source, bounds, 0.5)] });
          sample(`blend ${blend}`, 2, 1);
          sample(`outside blend ${blend}`, 2, 4);
        }
        clear(220, 60, 90, 240);
        compositor.drawLayer({ bounds, blend: 1, content: [quad(source, bounds, 0.5)] });
        sample("additive saturation", 2, 1);

        const draws = [
          quad(coverage, rect(1, 1, 3, 3)),
          quad(coverage, rect(3, 1, 2, 3)),
          quad(coverage, rect(7, 1, 1, 3)),
        ];
        for (const inverted of [false, true]) {
          clear();
          compositor.drawLayer({ bounds, content: [quad(red)], mask: { inverted, draws } });
          const mode = inverted ? "inverted mask" : "mask";
          sample(`${mode} single coverage`, 2, 1);
          sample(`${mode} overlap`, 3, 1);
          sample(`${mode} zero coverage`, 6, 2);
          sample(`${mode} outside layer`, 7, 1);
        }
        clear();
        compositor.drawLayer({ bounds, content: [quad(red)], mask: { inverted: false, draws: [] } });
        sample("empty mask", 3, 1);

        clear();
        compositor.drawLayer({
          bounds,
          tint: [0.5, 1, 1, 0, 0.5, 0],
          content: [
            { ...quad(stripe, bounds, 1, 1.25), repeat: true, linear: false },
            { ...quad(stripe, bounds, 1, 1.25), repeat: false, linear: false, clip: rect(2, 1, 2, 1) },
          ],
        });
        sample("repeat and tint", 1, 1);
        sample("clamp and tint", 2, 1);
        sample("clipped on y", 2, 2);

        compositor.drawLayer({ bounds: rect(2, 1, 1, 1), content: [quad(green)] });
        sample("later layer paints over earlier", 2, 1);
        sample("later layer is limited to its bounds", 3, 1);

        function rejects(draw: () => unknown, pattern: RegExp) {
          try {
            draw();
          } catch (error) {
            return error instanceof Error && pattern.test(error.message);
          }
          return false;
        }
        const invalidBlendRejected = rejects(
          () => compositor.drawLayer({ bounds, blend: 4, content: [quad(red)] }),
          /Invalid Live2D mesh layer/,
        );
        const malformedDrawRejected = rejects(
          () => compositor.drawLayer({ bounds, content: [
            quad(red),
            { texture: red, vertices: new Float32Array(14) },
          ] }),
          /Invalid Live2D mesh draw/,
        );
        const emptyLayerSkipped = compositor.drawLayer({ bounds, content: [] }) === false;
        sample("invalid and empty layers leave destination intact", 2, 1);
        compositor.dispose();
        compositor.dispose();
        const disposedDrawRejected = rejects(
          () => compositor.drawLayer({ bounds, content: [quad(red)] }),
          /compositor is unavailable/,
        );
        const inputTextureStillOwnedByCaller = gl.isTexture(red);
        const error = gl.getError();
        gl.deleteFramebuffer(framebuffer);
        for (const item of textures) gl.deleteTexture(item);
        return {
          error, pixels, renderer, invalidBlendRejected, malformedDrawRejected, emptyLayerSkipped,
          disposedDrawRejected, inputTextureStillOwnedByCaller,
        };
      }, "/web_mesh_compositor.js");

      console.info(`Live2D GPU mesh prototype renderer: ${result.renderer}`);
      expect(result.error).toBe(0);
      expect(result.invalidBlendRejected).toBe(true);
      expect(result.malformedDrawRejected).toBe(true);
      expect(result.emptyLayerSkipped).toBe(true);
      expect(result.disposedDrawRejected).toBe(true);
      expect(result.inputTextureStillOwnedByCaller).toBe(true);
      // These are premultiplied RGBA8 results, with up to two LSBs for
      // intermediate framebuffer rounding and the raster reference's integer math.
      const expected: Record<string, number[]> = {
        "blend 0": [62, 65, 77, 160],
        "blend 1": [70, 80, 100, 192],
        "blend 2": [47, 60, 76, 160],
        "blend 3": [65, 75, 96, 160],
        "outside blend 0": [30, 60, 90, 128],
        "outside blend 1": [30, 60, 90, 128],
        "outside blend 2": [30, 60, 90, 128],
        "outside blend 3": [30, 60, 90, 128],
        "additive saturation": [255, 80, 100, 255],
        "mask single coverage": [128, 0, 0, 128],
        "mask overlap": [192, 0, 0, 192],
        "mask zero coverage": [0, 0, 0, 0],
        "mask outside layer": [0, 0, 0, 0],
        "inverted mask single coverage": [127, 0, 0, 127],
        "inverted mask overlap": [63, 0, 0, 63],
        "inverted mask zero coverage": [255, 0, 0, 255],
        "inverted mask outside layer": [0, 0, 0, 0],
        "empty mask": [0, 0, 0, 0],
        "repeat and tint": [128, 128, 0, 255],
        "clamp and tint": [0, 128, 255, 255],
        "clipped on y": [128, 128, 0, 255],
        "later layer paints over earlier": [0, 255, 0, 255],
        "later layer is limited to its bounds": [0, 128, 255, 255],
        "invalid and empty layers leave destination intact": [0, 255, 0, 255],
      };
      expect(Object.keys(result.pixels).sort()).toEqual(Object.keys(expected).sort());
      for (const [name, rgba] of Object.entries(expected)) {
        const actual = result.pixels[name];
        const error = Math.max(...rgba.map((channel, index) => Math.abs(channel - actual[index])));
        expect(error, `${name} expected [${rgba}], received [${actual}]`).toBeLessThanOrEqual(2);
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
});
