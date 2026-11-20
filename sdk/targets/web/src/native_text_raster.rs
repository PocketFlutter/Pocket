//! Browser text enters the software painter at the TEXT_RUN's original position.

use super::{reserve_scratch, Clip, RenderTarget};
use alloc::vec::Vec;

#[link(wasm_import_module = "pocket_web_text")]
extern "C" {
    fn raster(
        words: *const u32,
        word_count: usize,
        scale: i32,
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
        mask: *mut u8,
        capacity: usize,
        rect: *mut i32,
    ) -> i32;
}

pub(super) fn paint(
    words: &[u32],
    target: &mut impl RenderTarget,
    stride: i32,
    scale: i32,
    clip: Clip,
    mask: &mut Vec<u8>,
) {
    let color = words[6];
    let opacity = color >> 24;
    if opacity == 0 || clip.x0 >= clip.x1 || clip.y0 >= clip.y1 {
        return;
    }
    let mut rect = [0; 4];
    let mut rasterize = |mask: &mut Vec<u8>| unsafe {
        raster(
            words.as_ptr(),
            words.len(),
            scale,
            clip.x0,
            clip.y0,
            clip.x1,
            clip.y1,
            mask.as_mut_ptr(),
            mask.len(),
            rect.as_mut_ptr(),
        )
    };
    let mut status = rasterize(mask);
    if status < 0 {
        let capacity = status.unsigned_abs() as usize;
        let max_area = ((clip.x1 - clip.x0) as usize).saturating_mul((clip.y1 - clip.y0) as usize);
        if capacity <= mask.len() || capacity > max_area || reserve_scratch(mask, capacity).is_err()
        {
            return;
        }
        status = rasterize(mask);
    }
    let [left, top, right, bottom] = rect;
    if status != 1
        || left < clip.x0
        || top < clip.y0
        || right > clip.x1
        || bottom > clip.y1
        || left >= right
        || top >= bottom
    {
        return;
    }
    let width = (right - left) as usize;
    let Some(pixels) = width
        .checked_mul((bottom - top) as usize)
        .and_then(|len| mask.get(..len))
    else {
        return;
    };
    let r = (color >> 16) & 255;
    let g = (color >> 8) & 255;
    let b = color & 255;
    for (row, coverage) in pixels.chunks_exact(width).enumerate() {
        let start = (top as usize + row) * stride as usize + left as usize;
        for (column, &alpha) in coverage.iter().enumerate() {
            if alpha != 0 {
                target.blend(
                    start + column,
                    r,
                    g,
                    b,
                    (u32::from(alpha) * opacity + 127) / 255,
                );
            }
        }
    }
}
