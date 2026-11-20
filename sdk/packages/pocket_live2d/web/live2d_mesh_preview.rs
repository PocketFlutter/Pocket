//! Experimental synchronous browser presentation for one contiguous mesh run.

use super::{checked_size, raster, resize, WasmHost};
use pocket_draw_ops::DrawOps;
use pocket_drivers::{
    spec::{draw_op, psm},
    DamageRect, RenderResources,
};
use std::ops::Range;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "pocket_web_mesh")]
extern "C" {
    fn frame(
        width: u32,
        height: u32,
        scale: u32,
        words: *const u32,
        words_len: u32,
        texture: *const u8,
        texture_width: u32,
        texture_height: u32,
        texture_revision: u32,
        linear: u32,
        background: *const u8,
        foreground: *const u8,
        background_revision: u32,
        foreground_revision: u32,
    ) -> i32;
}

#[derive(Default)]
pub(super) struct Cache {
    background: SoftwareLayer,
    foreground: SoftwareLayer,
    atlas: Option<(i32, u64)>,
    atlas_revision: u32,
}

impl Cache {
    pub(super) fn invalidate(&mut self) {
        self.background.key = None;
        self.foreground.key = None;
        self.atlas = None;
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct LayerKey {
    logical: [u32; 2],
    scale: u32,
    raster_revision: u64,
    neutral_scissors: usize,
}

#[derive(Default)]
struct SoftwareLayer {
    key: Option<LayerKey>,
    words: Vec<u32>,
    pixels: Vec<u8>,
    revision: u32,
    opaque: bool,
}

impl SoftwareLayer {
    fn update(
        &mut self,
        ui: &impl RenderResources,
        words: &[u32],
        key: LayerKey,
        len: usize,
        foreground: bool,
    ) -> Option<()> {
        if self.key == Some(key) && self.words == words {
            return Some(());
        }
        resize(&mut self.pixels, len).ok()?;
        self.words
            .try_reserve(words.len().saturating_sub(self.words.len()))
            .ok()?;

        // Keep the exact draw words as the cache key. Reconstruct only the
        // neutral scissor stack discarded at the split before software replay.
        let mut balanced = Vec::new();
        let replay = if key.neutral_scissors == 0 {
            words
        } else if foreground {
            let [width, height] = key.logical;
            balanced
                .try_reserve_exact(words.len() + key.neutral_scissors * 3)
                .ok()?;
            for _ in 0..key.neutral_scissors {
                balanced.extend_from_slice(&[draw_op::SCISSOR, 0, width | (height << 16)]);
            }
            balanced.extend_from_slice(words);
            &balanced
        } else {
            balanced
                .try_reserve_exact(words.len() + key.neutral_scissors)
                .ok()?;
            balanced.extend_from_slice(words);
            balanced.resize(balanced.len() + key.neutral_scissors, draw_op::SCISSOR_POP);
            &balanced
        };
        if foreground {
            raster::render_scaled_premultiplied(ui, replay, &mut self.pixels, key.scale);
        } else {
            raster::render_scaled(ui, replay, &mut self.pixels, key.scale);
            self.opaque = self.pixels.iter().skip(3).step_by(4).all(|&alpha| alpha == 255);
        }
        self.words.clear();
        self.words.extend_from_slice(words);
        self.key = Some(key);
        self.revision = self.revision.wrapping_add(1);
        Some(())
    }
}

struct MeshRun {
    range: Range<usize>,
    texture: i32,
    neutral_scissors: usize,
}

fn split(words: &[u32], viewport: DamageRect) -> Option<MeshRun> {
    let mut ops = DrawOps::new(words, viewport);
    let mut mesh = None::<Range<usize>>;
    let mut texture = None;
    let mut mesh_ended = false;
    let mut clip_depth = 0;
    // A neutral top scissor can still hide a nonneutral ancestor that would
    // be restored later in the foreground. Track every outstanding scope.
    let mut first_nonneutral_depth = None;
    let mut neutral_scissors = 0;
    loop {
        let start = ops.position();
        let Some(op) = ops.next() else { break };
        let op = op.ok()?;
        match op.opcode {
            draw_op::TEX_TRI_FLOAT
            | draw_op::TEX_TRI_REPEAT_FLOAT
            | draw_op::MESH_LAYER_BEGIN
            | draw_op::MESH_MASK_BEGIN
            | draw_op::MESH_LAYER_RESTORE => {
                if mesh_ended || first_nonneutral_depth.is_some() || op.clip != viewport {
                    return None;
                }
                if matches!(
                    op.opcode,
                    draw_op::TEX_TRI_FLOAT | draw_op::TEX_TRI_REPEAT_FLOAT
                ) {
                    let handle = op.words[1] as i32;
                    if texture.is_some_and(|existing| existing != handle)
                        || !op.words[2..14]
                            .iter()
                            .all(|&bits| f32::from_bits(bits).is_finite())
                    {
                        return None;
                    }
                    texture = Some(handle);
                }
                if let Some(range) = &mut mesh {
                    range.end = ops.position();
                } else {
                    neutral_scissors = clip_depth;
                    mesh = Some(start..ops.position());
                }
            }
            draw_op::ROUNDED_RECT
            | draw_op::ARC
            | draw_op::ROUNDED_GRADIENT
            | draw_op::SURFACE_QUAD => return None,
            _ => {
                mesh_ended |= mesh.is_some();
                if op.opcode == draw_op::SCISSOR {
                    clip_depth += 1;
                    if first_nonneutral_depth.is_none() && op.clip != viewport {
                        first_nonneutral_depth = Some(clip_depth);
                    }
                } else if op.opcode == draw_op::SCISSOR_POP {
                    if first_nonneutral_depth == Some(clip_depth) {
                        first_nonneutral_depth = None;
                    }
                    clip_depth -= 1;
                }
            }
        }
    }
    Some(MeshRun {
        range: mesh?,
        texture: texture?,
        neutral_scissors,
    })
}

#[cfg(target_arch = "wasm32")]
fn try_present(h: &WasmHost) -> Option<()> {
    if h.auxiliary.get().is_some() {
        return None;
    }
    let logical = h.logical.get();
    let [width, height] = h.physical.get();
    let scale = width.checked_div(logical[0])?;
    let len = checked_size(logical, scale)?;
    if [width, height] != [logical[0] * scale, logical[1] * scale] {
        return None;
    }
    let mut runtime = h.runtime.try_borrow_mut().ok()?;
    let runtime = runtime.as_mut()?;
    let ops = h.ops.try_borrow().ok()?;
    let mut core = ops.core_mut().ok()?;
    core.draw();
    let words = &core.current_draw_list().words;
    let ui = &core.ui;
    if ui.viewport() != (logical[0] as f32, logical[1] as f32) {
        return None;
    }
    let viewport = DamageRect::new(0, 0, logical[0] as i32, logical[1] as i32);
    let MeshRun {
        range,
        texture,
        neutral_scissors,
    } = split(words, viewport)?;
    let atlas = ui.texture(texture)?;
    if atlas.psm != psm::PSM_8888
        || atlas.palette.is_some()
        || checked_size([atlas.w, atlas.h], 1) != Some(atlas.pixels.len())
    {
        return None;
    }
    let tag = (texture, ui.texture_revision(texture)?);
    let key = LayerKey {
        logical,
        scale,
        raster_revision: ui.raster_revision(),
        neutral_scissors,
    };
    let mut cache = h.live2d_mesh_preview.try_borrow_mut().ok()?;
    cache
        .background
        .update(ui, &words[..range.start], key, len, false)?;
    if !cache.background.opaque {
        return None;
    }
    cache
        .foreground
        .update(ui, &words[range.end..], key, len, true)?;
    if cache.atlas != Some(tag) {
        cache.atlas = Some(tag);
        cache.atlas_revision = cache.atlas_revision.wrapping_add(1);
    }
    let mesh = &words[range];
    // Finish the pending turn before handing it to JavaScript. The normal
    // present remains available if the callback rejects it.
    runtime.skip_presentation().ok()?;

    // The pointers borrow WASM memory for this synchronous call only.
    let accepted = unsafe {
        frame(
            width,
            height,
            scale,
            mesh.as_ptr(),
            mesh.len() as u32,
            atlas.pixels.as_ptr(),
            atlas.w,
            atlas.h,
            cache.atlas_revision,
            u32::from(atlas.linear),
            cache.background.pixels.as_ptr(),
            cache.foreground.pixels.as_ptr(),
            cache.background.revision,
            cache.foreground.revision,
        )
    };
    (accepted == 1).then_some(())
}

#[no_mangle]
pub extern "C" fn web_live2d_mesh_try_present(h: &WasmHost) -> i32 {
    #[cfg(target_arch = "wasm32")]
    return i32::from(try_present(h).is_some());
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = h;
        0
    }
}
