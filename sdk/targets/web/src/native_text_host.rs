//! Opt-in host-native layout for generic browser guests.

use super::{status, RuntimeError, Ui, WasmHost};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "pocket_web_text")]
extern "C" {
    fn measure(
        bytes: *const u8,
        length: usize,
        slot: u32,
        tracking: f32,
        line_height: f32,
        result: *mut f32,
    ) -> i32;
}

#[cfg(target_arch = "wasm32")]
pub(super) fn install(ui: &mut Ui) {
    ui.set_text_measure(Some(Box::new(|text, slot, tracking, line_height| {
        let mut result = [0.0; 2];
        let ok = unsafe {
            measure(
                text.as_ptr(),
                text.len(),
                u32::from(slot),
                tracking,
                line_height,
                result.as_mut_ptr(),
            )
        };
        if ok == 1
            && result
                .iter()
                .all(|value| value.is_finite() && *value >= 0.0)
        {
            (result[0], result[1])
        } else {
            (0.0, 0.0)
        }
    })));
    ui.set_native_transformed_text(true);
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn install(_: &mut Ui) {}

#[no_mangle]
pub extern "C" fn web_set_native_text(host: &WasmHost, enabled: u32) -> i32 {
    status(
        host,
        (|| {
            let runtime = host.runtime.try_borrow().map_err(|_| RuntimeError::Busy)?;
            if runtime.is_some() || enabled > 1 {
                return Err(RuntimeError::InvalidArgument);
            }
            host.native_text.set(enabled == 1);
            Ok(())
        })(),
    )
}
