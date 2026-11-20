// Match Studio's Canvas2D font slots and TEXT_RUN projection. Pocket owns
// wrapping, layout and clipping. Canvas supplies measurement and glyph coverage.
const fontSizes = [12, 14, 16, 18, 20, 24, 36, 12, 14, 16, 18, 20, 24, 36, 54, 54, 12, 14, 16, 10, 10];
const proportional = "system-ui, -apple-system, sans-serif";
const monospace = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace";
const trackingFlag = 1 << 16;
const affineFlag = 1 << 17;

export function createWebNativeText(output) {
  const canvas = output.canvas.ownerDocument.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const decoder = new TextDecoder();
  const hasLetterSpacing = typeof context.letterSpacing === "string";
  const lineHeights = new Map();

  function setFont(slot, tracking) {
    const size = fontSizes[slot] ?? 14;
    const weight = (slot >= 7 && slot <= 13) || slot === 15 || slot === 20 ? 700 : 400;
    context.font = `${weight} ${size}px ${slot >= 16 && slot <= 18 ? monospace : proportional}`;
    context.textBaseline = "top";
    context.textAlign = "left";
    if (hasLetterSpacing) context.letterSpacing = `${tracking}px`;
    return size;
  }

  function effectiveLineHeight(slot, size, override) {
    if (Number.isFinite(override)) return override;
    if (!lineHeights.has(slot)) {
      const sample = context.measureText("Mg汉");
      const measured = sample.fontBoundingBoxAscent + sample.fontBoundingBoxDescent;
      lineHeights.set(slot, Math.max(size, Math.ceil(measured > 0 ? measured : size * 1.2)));
    }
    return lineHeights.get(slot);
  }

  function glyphRuns(line, tracking) {
    // Older browsers have no Canvas letterSpacing support. Use the same
    // per-code-point advance for measurement and paint on those browsers.
    const chars = tracking && !hasLetterSpacing ? Array.from(line) : [line];
    let width = 0;
    const glyphs = chars.map(value => {
      const metrics = context.measureText(value);
      const glyph = { value, x: width, metrics };
      width += metrics.width + (tracking && !hasLetterSpacing ? tracking : 0);
      return glyph;
    });
    return { width: Math.max(0, width), glyphs };
  }

  function readText(memory, ptr, length) {
    return decoder.decode(new Uint8Array(memory.buffer, ptr, length));
  }

  return {
    measure(memory, ptr, length, slot, tracking, lineHeight, outPtr) {
      const lines = readText(memory, ptr, length).split("\n");
      const size = setFont(slot, tracking);
      let width = 0;
      for (const line of lines) width = Math.max(width, glyphRuns(line, tracking).width);
      const output = new Float32Array(memory.buffer, outPtr, 2);
      output[0] = width;
      output[1] = effectiveLineHeight(slot, size, lineHeight) * lines.length;
      return 1;
    },

    raster(memory, ptr, count, scale, clipLeft, clipTop, clipRight, clipBottom, maskPtr, maskCapacity, rectPtr) {
      if (count < 8 || clipLeft >= clipRight || clipTop >= clipBottom) return 0;
      const words = new Uint32Array(memory.buffer, ptr, count);
      const floats = new Float32Array(memory.buffer, ptr, count);
      const header = words[1];
      const slot = header & 255;
      const align = (header >>> 8) & 255;
      const [x, y, boxWidth, lineHeight] = floats.subarray(2, 6);
      let index = 8;
      const tracking = header & trackingFlag ? floats[index++] : 0;
      const affine = header & affineFlag ? floats.subarray(index, index + 4) : [1, 0, 0, 1];
      if (header & affineFlag) index += 4;
      const [a, b, c, d] = affine;
      if (index * 4 + words[7] > count * 4 || affine.length !== 4 ||
          ![x, y, boxWidth, tracking, a, b, c, d].every(Number.isFinite)) return 0;
      const size = setFont(slot, tracking);
      const step = effectiveLineHeight(slot, size, lineHeight);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const runs = [];
      const lines = readText(memory, ptr + index * 4, words[7]).split("\n");
      for (const [lineIndex, line] of lines.entries()) {
        if (!line) continue;
        const { width, glyphs } = glyphRuns(line, tracking);
        const offset = align === 1 ? (boxWidth - width) / 2 : align === 2 ? boxWidth - width : 0;
        const top = lineIndex * step;
        for (const glyph of glyphs) {
          const left = offset + glyph.x;
          const m = glyph.metrics;
          const boxLeft = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : size;
          const boxRight = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width + size;
          const boxAscent = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : size;
          const boxDescent = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : size * 2;
          const xs = [left - boxLeft, left + boxRight];
          const ys = [top - boxAscent, top + boxDescent];
          for (const u of xs) {
            for (const v of ys) {
              const px = (x + a * u + c * v) * scale;
              const py = (y + b * u + d * v) * scale;
              minX = Math.min(minX, px);
              maxX = Math.max(maxX, px);
              minY = Math.min(minY, py);
              maxY = Math.max(maxY, py);
            }
          }
          runs.push({ value: glyph.value, left, top });
        }
      }
      if (!runs.length) return 0;
      // Leave a physical pixel for Canvas antialiasing along each edge.
      const left = Math.max(clipLeft, Math.floor(minX) - 1);
      const top = Math.max(clipTop, Math.floor(minY) - 1);
      const right = Math.min(clipRight, Math.ceil(maxX) + 1);
      const bottom = Math.min(clipBottom, Math.ceil(maxY) + 1);
      const width = right - left;
      const height = bottom - top;
      if (!(width > 0 && height > 0)) return 0;
      if (width * height > maskCapacity) return -width * height;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.resetTransform();
      context.clearRect(0, 0, width, height);
      setFont(slot, tracking);
      context.setTransform(a * scale, b * scale, c * scale, d * scale, x * scale - left, y * scale - top);
      context.fillStyle = "#fff";
      for (const run of runs) context.fillText(run.value, run.left, run.top);
      const rgba = context.getImageData(0, 0, width, height).data;
      const mask = new Uint8Array(memory.buffer, maskPtr, width * height);
      for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3];
      new Int32Array(memory.buffer, rectPtr, 4).set([left, top, right, bottom]);
      return 1;
    },
  };
}
