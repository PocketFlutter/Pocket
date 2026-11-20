// Package-private WebGL2 replay of canonical mesh layers. Coordinates and
// clips are top-left physical pixels. Atlas textures hold straight RGBA.
const meshVertex = `#version 300 es
layout(location = 0) in vec2 position;
layout(location = 1) in vec2 uv;
layout(location = 2) in float alpha;
uniform vec2 origin;
uniform vec2 size;
out vec2 atlasUv;
out float opacity;
void main() {
  vec2 ndc = (position - origin) * 2.0 / size - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  atlasUv = uv;
  opacity = alpha;
}`;

const meshFragment = `#version 300 es
precision highp float;
in vec2 atlasUv;
in float opacity;
uniform sampler2D atlas;
uniform vec3 tintScale;
uniform vec3 tintOffset;
out vec4 color;
void main() {
  vec4 sampleColor = texture(atlas, atlasUv);
  vec3 tinted = floor(clamp(sampleColor.rgb * tintScale + tintOffset, 0.0, 1.0)
    * 255.0 + 0.5) / 255.0;
  float alpha = floor(clamp(sampleColor.a * opacity, 0.0, 1.0) * 255.0 + 0.5) / 255.0;
  color = vec4(tinted * alpha, alpha);
}`;

const compositeVertex = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const compositeFragment = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D content;
uniform sampler2D mask;
uniform sampler2D backdrop;
uniform ivec2 origin;
uniform int maskMode;
uniform bool multiplyBlend;
out vec4 color;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy) - origin;
  ivec4 source = ivec4(round(texelFetch(content, pixel, 0) * 255.0));
  if (maskMode != 0) {
    int coverage = int(round(texelFetch(mask, pixel, 0).a * 255.0));
    if (maskMode == 2) coverage = 255 - coverage;
    source = (source * coverage + 127) / 255;
  }
  if (source.a == 0) discard;
  if (!multiplyBlend) {
    color = vec4(source) / 255.0;
    return;
  }

  // The pinned rasterizer rounds each of these three terms independently.
  ivec4 destination = ivec4(round(texelFetch(backdrop, pixel, 0) * 255.0));
  ivec3 sourceStraight = min(ivec3(255), (source.rgb * 255 + source.a / 2) / source.a);
  ivec3 destinationStraight = min(ivec3(255),
    (destination.rgb * 255 + destination.a / 2) / max(destination.a, 1));
  ivec3 blended = (sourceStraight * destinationStraight + 127) / 255;
  ivec3 overlap = (blended * source.a * destination.a + 32512) / 65025;
  ivec3 sourceOnly = (source.rgb * (255 - destination.a) + 127) / 255;
  ivec3 destinationOnly = (destination.rgb * (255 - source.a) + 127) / 255;
  int alpha = source.a + (destination.a * (255 - source.a) + 127) / 255;
  color = vec4(ivec4(min(ivec3(255), overlap + sourceOnly + destinationOnly), alpha)) / 255.0;
}`;

function makeProgram(gl, vertexSource, fragmentSource, uniformNames) {
  const shaders = [];
  const program = gl.createProgram();
  if (!program) throw new Error("Could not allocate Live2D mesh program");
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Could not allocate Live2D mesh shader");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Could not compile Live2D mesh shader: ${gl.getShaderInfoLog(shader)}`);
      }
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Could not link Live2D mesh program: ${gl.getProgramInfoLog(program)}`);
    }
    return {
      program,
      uniforms: Object.fromEntries(uniformNames.map((name) => [name, gl.getUniformLocation(program, name)])),
    };
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

function captureState(gl, capabilities) {
  const get = (parameter) => gl.getParameter(parameter);
  const activeTexture = get(gl.ACTIVE_TEXTURE);
  const textures = [];
  for (let unit = 0; unit < 3; unit++) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    textures.push([get(gl.TEXTURE_BINDING_2D), get(gl.SAMPLER_BINDING)]);
  }
  gl.activeTexture(activeTexture);

  const drawFramebuffer = get(gl.DRAW_FRAMEBUFFER_BINDING);
  const readFramebuffer = get(gl.READ_FRAMEBUFFER_BINDING);
  const viewport = get(gl.VIEWPORT);
  const scissor = get(gl.SCISSOR_BOX);
  const program = get(gl.CURRENT_PROGRAM);
  const vao = get(gl.VERTEX_ARRAY_BINDING);
  const arrayBuffer = get(gl.ARRAY_BUFFER_BINDING);
  const unpackBuffer = get(gl.PIXEL_UNPACK_BUFFER_BINDING);
  const colorMask = get(gl.COLOR_WRITEMASK);
  const blendFunction = [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA].map(get);
  const blendEquation = [gl.BLEND_EQUATION_RGB, gl.BLEND_EQUATION_ALPHA].map(get);
  const enabled = capabilities.map((capability) => gl.isEnabled(capability));

  return {
    drawFramebuffer,
    viewport,
    restore() {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFramebuffer);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFramebuffer);
      gl.viewport(...viewport);
      gl.scissor(...scissor);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpackBuffer);
      gl.colorMask(...colorMask);
      gl.blendFuncSeparate(...blendFunction);
      gl.blendEquationSeparate(...blendEquation);
      capabilities.forEach((capability, index) => {
        if (enabled[index]) gl.enable(capability);
        else gl.disable(capability);
      });
      textures.forEach(([texture, sampler], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.bindSampler(unit, sampler);
      });
      gl.activeTexture(activeTexture);
    },
  };
}

function validRect(rect) {
  return rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger)
    && rect.width >= 0 && rect.height >= 0;
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x, y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

export function createLive2dWebMeshCompositor(gl) {
  if (typeof gl?.createVertexArray !== "function" || gl.isContextLost()) {
    throw new Error("Live2D mesh compositing requires a live WebGL2 context");
  }

  const cleanup = [];
  const own = (resource, deleteResource) => {
    if (!resource) throw new Error("Could not allocate a Live2D mesh resource");
    cleanup.push(() => deleteResource.call(gl, resource));
    return resource;
  };
  function dispose() {
    while (cleanup.length) cleanup.pop()();
  }

  try {
    const mesh = makeProgram(gl, meshVertex, meshFragment, ["origin", "size", "atlas", "tintScale", "tintOffset"]);
    own(mesh.program, gl.deleteProgram);
    const composite = makeProgram(gl, compositeVertex, compositeFragment,
      ["origin", "content", "mask", "backdrop", "maskMode", "multiplyBlend"]);
    own(composite.program, gl.deleteProgram);
    const vao = own(gl.createVertexArray(), gl.deleteVertexArray);
    const vbo = own(gl.createBuffer(), gl.deleteBuffer);
    let vertexCapacity = 0;
    let configured = false;
    const maxDimension = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
    const capabilities = [
      gl.BLEND, gl.SCISSOR_TEST, gl.CULL_FACE, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.DITHER,
      gl.POLYGON_OFFSET_FILL, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE, gl.RASTERIZER_DISCARD,
    ];
    const identityTint = [1, 1, 1, 0, 0, 0];
    const transparent = new Float32Array(4);
    const scratch = {};
    const samplers = new Map();

    function sampler(repeat, linear) {
      const key = (repeat ? 2 : 0) + (linear ? 1 : 0);
      if (!samplers.has(key)) {
        const handle = own(gl.createSampler(), gl.deleteSampler);
        const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
        const filter = linear ? gl.LINEAR : gl.NEAREST;
        gl.samplerParameteri(handle, gl.TEXTURE_WRAP_S, wrap);
        gl.samplerParameteri(handle, gl.TEXTURE_WRAP_T, wrap);
        gl.samplerParameteri(handle, gl.TEXTURE_MIN_FILTER, filter);
        gl.samplerParameteri(handle, gl.TEXTURE_MAG_FILTER, filter);
        samplers.set(key, handle);
      }
      return samplers.get(key);
    }

    function surface(name, width, height) {
      const target = scratch[name] ??= {
        texture: own(gl.createTexture(), gl.deleteTexture),
        framebuffer: own(gl.createFramebuffer(), gl.deleteFramebuffer),
        width: 0,
        height: 0,
      };
      if (target.width >= width && target.height >= height) return target;
      const nextWidth = width;
      const nextHeight = height;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nextWidth, nextHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
      if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Could not allocate complete Live2D mesh framebuffer");
      }
      target.width = nextWidth;
      target.height = nextHeight;
      return target;
    }

    function drawPass(target, draws, bounds, clip, tint) {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, bounds.width, bounds.height);
      gl.scissor(0, 0, bounds.width, bounds.height);
      gl.clearBufferfv(gl.COLOR, 0, transparent);
      if (!clip.width || !clip.height) return;

      gl.useProgram(mesh.program);
      gl.uniform2f(mesh.uniforms.origin, bounds.x, bounds.y);
      gl.uniform2f(mesh.uniforms.size, bounds.width, bounds.height);
      gl.uniform1i(mesh.uniforms.atlas, 0);
      gl.uniform3f(mesh.uniforms.tintScale, tint[0] * (1 - tint[3]), tint[1] * (1 - tint[4]), tint[2] * (1 - tint[5]));
      gl.uniform3f(mesh.uniforms.tintOffset, tint[0] * tint[3], tint[1] * tint[4], tint[2] * tint[5]);
      gl.activeTexture(gl.TEXTURE0);
      for (const draw of draws) {
        if (!draw.vertices.length) continue;
        const visible = draw.clip ? intersect(clip, draw.clip) : clip;
        if (!visible.width || !visible.height) continue;
        gl.scissor(visible.x - bounds.x, bounds.y + bounds.height - visible.y - visible.height,
          visible.width, visible.height);
        gl.bindTexture(gl.TEXTURE_2D, draw.texture);
        gl.bindSampler(0, sampler(draw.repeat ?? true, draw.linear ?? true));
        if (draw.vertices.byteLength > vertexCapacity) {
          vertexCapacity = Math.max(draw.vertices.byteLength, vertexCapacity * 2);
          gl.bufferData(gl.ARRAY_BUFFER, vertexCapacity, gl.STREAM_DRAW);
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, draw.vertices);
        gl.drawArrays(gl.TRIANGLES, 0, draw.vertices.length / 5);
      }
    }

    function validateLayer({ bounds, content, mask, blend = 0, tint = identityTint }, width, height, textures) {
      if (!validRect(bounds) || !bounds.width || !bounds.height ||
          bounds.width > maxDimension || bounds.height > maxDimension ||
          bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > width || bounds.y + bounds.height > height ||
          !Number.isInteger(blend) || blend < 0 || blend > 3 ||
          tint?.length !== 6 || !Array.from(tint).every(Number.isFinite) ||
          (mask?.bounds && !validRect(mask.bounds))) {
        throw new Error("Invalid Live2D mesh layer");
      }
      function validateDraws(draws) {
        if (!Array.isArray(draws) || !draws.every((draw) => {
          if (!(draw?.vertices instanceof Float32Array) || draw.vertices.length % 15 !== 0 ||
              (draw.clip && !validRect(draw.clip))) return false;
          if (!draw.vertices.length || textures.has(draw.texture)) return true;
          if (!gl.isTexture(draw.texture)) return false;
          textures.add(draw.texture);
          return true;
        })) {
          throw new Error("Invalid Live2D mesh draw");
        }
      }
      validateDraws(content);
      if (mask) validateDraws(mask.draws);
      return { bounds, content, mask, blend, tint };
    }

    function replayLayer({ bounds, content, mask, blend, tint }, drawFramebuffer, height) {
      const x = bounds.x;
      const y = height - bounds.y - bounds.height;
      gl.enable(gl.SCISSOR_TEST);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const layerTarget = surface("content", bounds.width, bounds.height);
      drawPass(layerTarget, content, bounds, bounds, tint);
      let maskTarget;
      if (mask) {
        maskTarget = surface("mask", bounds.width, bounds.height);
        const maskClip = mask.bounds ? intersect(bounds, mask.bounds) : bounds;
        drawPass(maskTarget, mask.draws, bounds, maskClip, identityTint);
      }

      gl.disable(gl.SCISSOR_TEST);
      let backdrop;
      if (blend === 2) {
        backdrop = surface("backdrop", bounds.width, bounds.height);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, backdrop.framebuffer);
        gl.blitFramebuffer(x, y, x + bounds.width, y + bounds.height,
          0, 0, bounds.width, bounds.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.disable(gl.BLEND);
      } else if (blend === 1) {
        gl.blendFunc(gl.ONE, gl.ONE);
      } else if (blend === 3) {
        // Premultiplied screen is S + D - S*D for RGB and source-over for alpha.
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }

      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFramebuffer);
      gl.viewport(x, y, bounds.width, bounds.height);
      gl.useProgram(composite.program);
      gl.uniform2i(composite.uniforms.origin, x, y);
      gl.uniform1i(composite.uniforms.maskMode, mask ? (mask.inverted ? 2 : 1) : 0);
      gl.uniform1i(composite.uniforms.multiplyBlend, blend === 2 ? 1 : 0);
      for (const [unit, name, target] of [
        [0, "content", layerTarget], [1, "mask", maskTarget ?? layerTarget],
        [2, "backdrop", backdrop ?? layerTarget],
      ]) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        gl.bindSampler(unit, sampler(false, false));
        gl.uniform1i(composite.uniforms[name], unit);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function drawLayers(layers) {
      if (!cleanup.length || gl.isContextLost()) throw new Error("Live2D mesh compositor is unavailable");
      if (gl.getParameter(gl.TRANSFORM_FEEDBACK_ACTIVE)) {
        throw new Error("Live2D mesh compositing does not support active transform feedback");
      }
      const state = captureState(gl, capabilities);
      let previousReadBuffer;
      try {
        const [viewportX, viewportY, width, height] = state.viewport;
        if (viewportX || viewportY) throw new Error("Unsupported Live2D mesh destination viewport");
        const textures = new Set();
        const visibleLayers = layers.map((layer) => validateLayer(layer, width, height, textures))
          .filter(({ content }) => content.some((draw) => draw.vertices.length));
        if (!visibleLayers.length) return false;
        const drawBuffer = gl.getParameter(gl.DRAW_BUFFER0) ?? (state.drawFramebuffer ? gl.NONE : gl.BACK);
        if (drawBuffer === gl.NONE ||
            gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error("Live2D mesh destination is incomplete");
        }
        if (state.drawFramebuffer) {
          for (let index = 1; index < maxDrawBuffers; index++) {
            if (gl.getParameter(gl.DRAW_BUFFER0 + index) !== gl.NONE) {
              throw new Error("Live2D mesh compositing requires a single active draw buffer");
            }
          }
        }
        for (const capability of capabilities) gl.disable(capability);
        gl.colorMask(true, true, true, true);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        if (!configured) {
          for (const [location, size, offset] of [[0, 2, 0], [1, 2, 8], [2, 1, 16]]) {
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, size, gl.FLOAT, false, 20, offset);
          }
          configured = true;
        }
        if (visibleLayers.some(({ blend }) => blend === 2)) {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.drawFramebuffer);
          previousReadBuffer = gl.getParameter(gl.READ_BUFFER);
          if (previousReadBuffer !== drawBuffer) gl.readBuffer(drawBuffer);
        }
        for (const layer of visibleLayers) replayLayer(layer, state.drawFramebuffer, height);
        if (gl.isContextLost()) throw new Error("WebGL2 context lost during Live2D mesh compositing");
        return true;
      } finally {
        if (previousReadBuffer !== undefined) gl.readBuffer(previousReadBuffer);
        state.restore();
      }
    }

    return { drawLayer: (layer) => drawLayers([layer]), drawLayers, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
