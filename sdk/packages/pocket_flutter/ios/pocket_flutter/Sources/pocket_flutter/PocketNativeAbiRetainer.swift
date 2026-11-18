import Foundation

// Force-retains the 50 production C ABI entry points from `libpocket_flutter.a`
// so `ld -dead_strip` in Release / TestFlight / App Store archives preserves
// every symbol resolved dynamically by `dart:ffi` (`DynamicLibrary.process()`)
// without retaining internal `pocket_worker_*` or legacy JSON test helpers.

@_silgen_name("pocket_bytecode_runtime_abi") private func _sym_pocket_bytecode_runtime_abi()
@_silgen_name("pocket_complete_worker_http_request") private func _sym_pocket_complete_worker_http_request()
@_silgen_name("pocket_configure_compositor") private func _sym_pocket_configure_compositor()
@_silgen_name("pocket_configure_guest_security") private func _sym_pocket_configure_guest_security()
@_silgen_name("pocket_configure_offload") private func _sym_pocket_configure_offload()
@_silgen_name("pocket_configure_worker") private func _sym_pocket_configure_worker()
@_silgen_name("pocket_create") private func _sym_pocket_create()
@_silgen_name("pocket_create_with_density") private func _sym_pocket_create_with_density()
@_silgen_name("pocket_create_with_density_and_tick_hz") private func _sym_pocket_create_with_density_and_tick_hz()
@_silgen_name("pocket_create_with_memory_limits") private func _sym_pocket_create_with_memory_limits()
@_silgen_name("pocket_destroy") private func _sym_pocket_destroy()
@_silgen_name("pocket_duplex_abi_version") private func _sym_pocket_duplex_abi_version()
@_silgen_name("pocket_duplex_capacity") private func _sym_pocket_duplex_capacity()
@_silgen_name("pocket_duplex_egress_consume") private func _sym_pocket_duplex_egress_consume()
@_silgen_name("pocket_duplex_egress_peek") private func _sym_pocket_duplex_egress_peek()
@_silgen_name("pocket_duplex_endpoint_acquire") private func _sym_pocket_duplex_endpoint_acquire()
@_silgen_name("pocket_duplex_endpoint_release") private func _sym_pocket_duplex_endpoint_release()
@_silgen_name("pocket_duplex_ingress_publish") private func _sym_pocket_duplex_ingress_publish()
@_silgen_name("pocket_duplex_ingress_reserve") private func _sym_pocket_duplex_ingress_reserve()
@_silgen_name("pocket_duplex_message_size") private func _sym_pocket_duplex_message_size()
@_silgen_name("pocket_duplex_step") private func _sym_pocket_duplex_step()
@_silgen_name("pocket_enable_auxiliary") private func _sym_pocket_enable_auxiliary()
@_silgen_name("pocket_eval") private func _sym_pocket_eval()
@_silgen_name("pocket_frame_binary") private func _sym_pocket_frame_binary()
@_silgen_name("pocket_frame_delta_binary_v2") private func _sym_pocket_frame_delta_binary_v2()
@_silgen_name("pocket_is_perf_sampling_enabled") private func _sym_pocket_is_perf_sampling_enabled()
@_silgen_name("pocket_last_error") private func _sym_pocket_last_error()
@_silgen_name("pocket_last_frame_stage_timings_us") private func _sym_pocket_last_frame_stage_timings_us()
@_silgen_name("pocket_load") private func _sym_pocket_load()
@_silgen_name("pocket_load_bytecode") private func _sym_pocket_load_bytecode()
@_silgen_name("pocket_load_bytecode_files") private func _sym_pocket_load_bytecode_files()
@_silgen_name("pocket_load_files") private func _sym_pocket_load_files()
@_silgen_name("pocket_next_wake_delay_ms") private func _sym_pocket_next_wake_delay_ms()
@_silgen_name("pocket_notify_external_work") private func _sym_pocket_notify_external_work()
@_silgen_name("pocket_offload_complete_binary") private func _sym_pocket_offload_complete_binary()
@_silgen_name("pocket_offload_has_replies") private func _sym_pocket_offload_has_replies()
@_silgen_name("pocket_offload_take_binary") private func _sym_pocket_offload_take_binary()
@_silgen_name("pocket_record_live2d_update_ns") private func _sym_pocket_record_live2d_update_ns()
@_silgen_name("pocket_register_worker_http_bridge") private func _sym_pocket_register_worker_http_bridge()
@_silgen_name("pocket_resize_viewport") private func _sym_pocket_resize_viewport()
@_silgen_name("pocket_send_binary") private func _sym_pocket_send_binary()
@_silgen_name("pocket_set_host_font_metrics") private func _sym_pocket_set_host_font_metrics()
@_silgen_name("pocket_set_host_glyph_measure_callback") private func _sym_pocket_set_host_glyph_measure_callback()
@_silgen_name("pocket_set_host_text_measure_callback") private func _sym_pocket_set_host_text_measure_callback()
@_silgen_name("pocket_set_perf_sampling_enabled") private func _sym_pocket_set_perf_sampling_enabled()
@_silgen_name("pocket_set_scheduler_paused") private func _sym_pocket_set_scheduler_paused()
@_silgen_name("pocket_stop_async") private func _sym_pocket_stop_async()
@_silgen_name("pocket_trace_clock_begin_json") private func _sym_pocket_trace_clock_begin_json()
@_silgen_name("pocket_trace_clock_end_json") private func _sym_pocket_trace_clock_end_json()
@_silgen_name("pocket_trace_clock_mode") private func _sym_pocket_trace_clock_mode()

enum PocketNativeAbiRetainer {
  nonisolated(unsafe) private static var retainedHash: Int = 0

  @inline(never)
  static func retainCAbiSymbols() {
    let table: [UnsafeRawPointer] = [
      unsafeBitCast(_sym_pocket_bytecode_runtime_abi as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_complete_worker_http_request as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_configure_compositor as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_configure_guest_security as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_configure_offload as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_configure_worker as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_create as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_create_with_density as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_create_with_density_and_tick_hz as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_create_with_memory_limits as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_destroy as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_duplex_abi_version as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_duplex_capacity as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_duplex_egress_consume as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_duplex_egress_peek as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_duplex_endpoint_acquire as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_duplex_endpoint_release as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_duplex_ingress_publish as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_duplex_ingress_reserve as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_duplex_message_size as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_duplex_step as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_enable_auxiliary as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_eval as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_frame_binary as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_frame_delta_binary_v2 as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_is_perf_sampling_enabled as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_last_error as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_last_frame_stage_timings_us as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_load as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_load_bytecode as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_load_bytecode_files as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_load_files as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_next_wake_delay_ms as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_notify_external_work as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_offload_complete_binary as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_offload_has_replies as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_offload_take_binary as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_record_live2d_update_ns as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_register_worker_http_bridge as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_resize_viewport as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_send_binary as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_set_host_font_metrics as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_set_host_glyph_measure_callback as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_set_host_text_measure_callback as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_set_perf_sampling_enabled as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_set_scheduler_paused as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_stop_async as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_trace_clock_begin_json as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_trace_clock_end_json as @convention(c) () -> Void, to: UnsafeRawPointer.self),
      unsafeBitCast(_sym_pocket_trace_clock_mode as @convention(c) () -> Void, to: UnsafeRawPointer.self),
    ]
    var acc = 0
    for ptr in table {
      acc ^= Int(bitPattern: ptr)
    }
    retainedHash = acc
  }
}
