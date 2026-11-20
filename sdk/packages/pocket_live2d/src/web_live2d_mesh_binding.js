import { createLive2dWebMeshCompositor } from "./web_mesh_compositor.js";

// Canonical DrawList opcodes, with one atlas for the complete mesh span.
const LayerBegin = 11;
const MaskBegin = 12;
const LayerRestore = 13;
const Triangle = 15;
const RepeatTriangle = 16;

function rectangle(xy, wh, scale, width, height) {
  const x = ((xy << 16) >> 16) * scale;
  const y = (xy >> 16) * scale;
  return clippedRectangle(x, y, x + (wh & 0xffff) * scale,
    y + (wh >>> 16) * scale, width, height);
}

function clippedRectangle(left, top, right, bottom, width, height) {
  const x = Math.max(0, Math.min(width, left));
  const y = Math.max(0, Math.min(height, top));
  return {
    x, y,
    width: Math.max(0, Math.min(width, right) - x),
    height: Math.max(0, Math.min(height, bottom) - y),
  };
}

function parseMesh(buffer, pointer, length, width, height, scale, vertices) {
  const words = new Uint32Array(buffer, pointer, length);
  const floats = new Float32Array(buffer, pointer, length);
  const layers = [];
  let group;
  let plain;
  let batch;
  let atlas;
  let vertexEnd = 0;

  function flushPlain() {
    if (!plain) return;
    plain.bounds = clippedRectangle(Math.floor(plain.left), Math.floor(plain.top),
      Math.ceil(plain.right), Math.ceil(plain.bottom), width, height);
    if (plain.bounds.width && plain.bounds.height) layers.push(plain);
    plain = undefined;
    batch = undefined;
  }

  for (let index = 0; index < words.length;) {
    const opcode = words[index];
    if (opcode === LayerBegin) {
      if (group || index + 10 > length) return;
      flushPlain();
      const blend = words[index + 3];
      const tint = Array.from(floats.subarray(index + 4, index + 10));
      if (blend > 3 || tint.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) return;
      group = { bounds: rectangle(words[index + 1], words[index + 2], scale, width, height),
        blend, tint, content: [] };
      index += 10;
    } else if (opcode === MaskBegin) {
      if (!group || group.mask || !group.content.length || index + 4 > length || words[index + 1] > 1) return;
      group.mask = {
        inverted: words[index + 1] === 1,
        bounds: rectangle(words[index + 2], words[index + 3], scale, width, height),
        draws: [],
      };
      batch = undefined;
      index += 4;
    } else if (opcode === LayerRestore) {
      if (!group || !group.content.length) return;
      if (group.bounds.width && group.bounds.height) layers.push(group);
      group = undefined;
      batch = undefined;
      index++;
    } else if (opcode === Triangle || opcode === RepeatTriangle) {
      if (index + 15 > length) return;
      atlas ??= words[index + 1];
      const color = words[index + 14];
      if (words[index + 1] !== atlas || (color & 0xffffff) !== 0xffffff) return;
      if (!group && !plain) {
        plain = { content: [], left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      }
      const repeat = opcode === RepeatTriangle;
      if (!batch || batch.repeat !== repeat) {
        batch = { start: vertexEnd, end: vertexEnd, repeat };
        (group?.mask?.draws ?? group?.content ?? plain.content).push(batch);
      }
      const alpha = (color >>> 24) / 255;
      for (let offset = index + 2; offset < index + 14; offset += 4) {
        const x = Math.fround(floats[offset] * scale);
        const y = Math.fround(floats[offset + 1] * scale);
        const u = floats[offset + 2];
        const v = floats[offset + 3];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(u) || !Number.isFinite(v)) return;
        vertices[vertexEnd++] = x;
        vertices[vertexEnd++] = y;
        vertices[vertexEnd++] = u;
        vertices[vertexEnd++] = v;
        vertices[vertexEnd++] = alpha;
        if (plain) {
          plain.left = Math.min(plain.left, x);
          plain.top = Math.min(plain.top, y);
          plain.right = Math.max(plain.right, x);
          plain.bottom = Math.max(plain.bottom, y);
        }
      }
      batch.end = vertexEnd;
      index += 15;
    } else {
      return;
    }
  }
  if (group || atlas === undefined) return;
  flushPlain();
  return layers;
}

function makeBlit(gl) {
  const program = gl.createProgram();
  if (!program) throw new Error("Could not allocate Live2D blit program");
  const shaders = [];
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D image;
out vec4 color;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  pixel.y = textureSize(image, 0).y - 1 - pixel.y;
  color = texelFetch(image, pixel, 0);
}`]]) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Could not allocate Live2D blit shader");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

function createRenderer(gl) {
  const blit = makeBlit(gl);
  const image = gl.getUniformLocation(blit, "image");
  const slots = [];
  let compositor;
  try {
    compositor = createLive2dWebMeshCompositor(gl);
    for (let index = 0; index < 3; index++) {
      const texture = gl.createTexture();
      if (!texture) throw new Error("Could not allocate Live2D frame texture");
      slots.push({ texture });
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
  } catch (error) {
    for (const { texture } of slots) gl.deleteTexture(texture);
    compositor?.dispose();
    gl.deleteProgram(blit);
    throw error;
  }

  function upload(slot, buffer, pointer, width, height, revision) {
    if (slot.width === width && slot.height === height && slot.revision === revision) return;
    const pixels = new Uint8Array(buffer, pointer, width * height * 4);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, slot.texture);
    if (slot.width === width && slot.height === height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    if (gl.getError() !== gl.NO_ERROR) throw new Error("Could not upload Live2D frame texture");
    Object.assign(slot, { width, height, revision });
  }

  function drawImage(slot, blend) {
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.useProgram(blit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindSampler(0, null);
    gl.bindTexture(gl.TEXTURE_2D, slot.texture);
    gl.uniform1i(image, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    maxDimension: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    dispose() {
      for (const { texture } of slots) gl.deleteTexture(texture);
      compositor.dispose();
      gl.deleteProgram(blit);
    },
    draw(buffer, width, height, layers, vertices, atlas, background, foreground, linear) {
      for (const [index, parameters] of [atlas, background, foreground].entries()) {
        upload(slots[index], buffer, ...parameters);
      }
      for (const layer of layers) {
        for (const draws of [layer.content, layer.mask?.draws ?? []]) {
          for (const draw of draws) {
            draw.vertices = vertices.subarray(draw.start, draw.end);
            draw.texture = slots[0].texture;
            draw.linear = linear;
          }
        }
      }
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DITHER);
      drawImage(slots[1], false);
      if (layers.length) compositor.drawLayers(layers);
      drawImage(slots[2], true);
      return gl.getError() === gl.NO_ERROR && !gl.isContextLost();
    },
  };
}

export function createWebLive2dMeshBinding(context) {
  let canvas;
  let gl;
  try {
    canvas = context.canvas.ownerDocument?.createElement("canvas");
    gl = canvas?.getContext("webgl2", { alpha: false, antialias: false, depth: false,
      stencil: false, premultipliedAlpha: true, failIfMajorPerformanceCaveat: true });
    if (!gl) return null;
    // The browser's performance gate can still admit a software backend.
    // Treat masked renderer information as unknown and honor the standard gate.
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    if (debug && /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render driver/i
      .test(String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)))) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return null;
    }
  } catch {
    return null;
  }

  let renderer;
  let disposed = false;
  let unavailable = false;
  let vertices = new Float32Array(0);
  const contextLost = (event) => {
    event.preventDefault();
    renderer = undefined;
  };
  canvas.addEventListener("webglcontextlost", contextLost);

  function available() {
    if (disposed || unavailable) return false;
    if (gl.isContextLost()) {
      renderer = undefined;
      return false;
    }
    try {
      renderer ??= createRenderer(gl);
      return true;
    } catch {
      // Fall back permanently for unsupported WebGL2 implementations, but
      // allow the next frame to rebuild resources after a context loss.
      if (!gl.isContextLost()) unavailable = true;
      return false;
    }
  }

  return {
    available,
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener("webglcontextlost", contextLost);
      try {
        renderer?.dispose();
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } finally {
        renderer = undefined;
        vertices = new Float32Array(0);
        gl = null;
        canvas = null;
      }
    },
    frame(memory, width, height, scale, wordsPtr, wordsLen, texPtr, texWidth, texHeight,
      texRevision, linear, bgPtr, fgPtr, bgRevision, fgRevision) {
      try {
        if (!available() || ![width, height, texWidth, texHeight, scale, wordsLen]
          .every((value) => Number.isSafeInteger(value) && value > 0) ||
          context.canvas.width !== width || context.canvas.height !== height ||
          Math.max(width, height, texWidth, texHeight) > renderer.maxDimension) return 0;
        const buffer = memory.buffer;
        for (const [ptr, length] of [[wordsPtr, wordsLen * 4], [texPtr, texWidth * texHeight * 4],
          [bgPtr, width * height * 4], [fgPtr, width * height * 4]]) {
          if (!Number.isSafeInteger(ptr) || ptr <= 0 || !Number.isSafeInteger(length) ||
              ptr + length > buffer.byteLength) return 0;
        }
        if (wordsLen > vertices.length) {
          vertices = new Float32Array(Math.max(wordsLen, vertices.length * 2));
        }
        const layers = parseMesh(buffer, wordsPtr, wordsLen, width, height, scale, vertices);
        if (!layers) return 0;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) return 0;
        if (!renderer.draw(buffer, width, height, layers, vertices,
          [texPtr, texWidth, texHeight, texRevision], [bgPtr, width, height, bgRevision],
          [fgPtr, width, height, fgRevision], !!linear)) return 0;
        context.save();
        try {
          context.resetTransform();
          context.globalAlpha = 1;
          context.globalCompositeOperation = "copy";
          context.filter = "none";
          context.shadowColor = "transparent";
          context.drawImage(canvas, 0, 0);
        } finally {
          context.restore();
        }
        return 1;
      } catch {
        return 0;
      }
    },
  };
}
