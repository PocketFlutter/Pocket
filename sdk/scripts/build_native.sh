#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_ROOT="$ROOT/packages/pocket_flutter"
APPLE_SYMBOLS="$ROOT/native/exported_symbols_apple.txt"
GNU_VERSION_SCRIPT="$ROOT/native/exported_symbols_gnu.lds"

python3 "$ROOT/scripts/prepare_upstream.py"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/native/target}"

build() {
  local target="$1"
  cargo build --locked --offline --release --manifest-path "$ROOT/native/Cargo.toml" --target "$target" --lib
}

# Pre-links a Rust static archive (`ld -r`) against the exact 50-symbol FFI
# allowlist and strips local/debug symbol strings (`strip -S -x`). This drops
# all unreferenced `.rlib` object members (`gimli`, `addr2line`, `object`,
# `rustc_demangle`, unused `std`/`pocket_present`/`pocket_raster` objects)
# directly from `libpocket_flutter.a` on disk.
slim_apple_staticlib() {
  local sdk_name="$1"
  local platform_name="$2"
  local min_version="$3"
  local arch="$4"
  local archive_path="$5"

  local sysroot
  sysroot="$(xcrun --sdk "$sdk_name" --show-sdk-path)"
  local sdk_version
  sdk_version="$(xcrun --sdk "$sdk_name" --show-sdk-version)"
  local tmp_obj="${archive_path%.a}.slim.$$.o"
  local tmp_lib="${archive_path%.a}.slim.$$.a"

  local undef_args=()
  while IFS= read -r sym; do
    [ -n "$sym" ] && undef_args+=("-u" "$sym")
  done < "$APPLE_SYMBOLS"

  rm -f "$tmp_obj" "$tmp_lib"
  xcrun --sdk "$sdk_name" ld -r \
    -arch "$arch" \
    -platform_version "$platform_name" "$min_version" "$sdk_version" \
    -syslibroot "$sysroot" \
    -exported_symbols_list "$APPLE_SYMBOLS" \
    "${undef_args[@]}" \
    "$archive_path" \
    -o "$tmp_obj"
  xcrun --sdk "$sdk_name" strip -S -x "$tmp_obj"
  xcrun --sdk "$sdk_name" libtool -static -o "$tmp_lib" "$tmp_obj"
  mv -f "$tmp_lib" "$archive_path"
  rm -f "$tmp_obj"
}

build_ios_slice() {
  local target="$1"
  local sdk_name="$2"
  local clang_target="$3"
  local platform_name="$4"
  (
    export LIBCLANG_PATH="${LIBCLANG_PATH:-$(dirname "$(xcrun --find clang)")/../lib}"
    export BINDGEN_EXTRA_CLANG_ARGS="--target=$clang_target -isysroot $(xcrun --sdk "$sdk_name" --show-sdk-path)"
    export IPHONEOS_DEPLOYMENT_TARGET=15.0
    build "$target"
  )
  slim_apple_staticlib \
    "$sdk_name" \
    "$platform_name" \
    "15.0" \
    "arm64" \
    "$CARGO_TARGET_DIR/$target/release/libpocket_flutter.a"
}

package_ios_xcframework() {
  local device="$CARGO_TARGET_DIR/aarch64-apple-ios/release/libpocket_flutter.a"
  local simulator="$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/libpocket_flutter.a"
  local output="$PACKAGE_ROOT/ios/pocket_flutter/Frameworks/PocketFlutter.xcframework"
  local lock="$PACKAGE_ROOT/ios/pocket_flutter/Frameworks/.PocketFlutter.xcframework.lock"
  # xcodebuild requires the output argument itself to end in .xcframework.
  local temporary="${output%.xcframework}.tmp.$$.xcframework"
  test -f "$device" && test -f "$simulator"
  if ! mkdir "$lock" 2>/dev/null; then
    echo "PocketFlutter.xcframework packaging is already in progress: $lock" >&2
    exit 73
  fi
  cleanup_xcframework_lock() {
    rmdir "$lock" 2>/dev/null || true
    rm -rf "$temporary"
  }
  trap cleanup_xcframework_lock EXIT
  rm -rf "$temporary"
  xcodebuild -create-xcframework \
    -library "$device" \
    -library "$simulator" \
    -output "$temporary"
  python3 - "$temporary" "$output" <<'PY'
import ctypes
import os
import sys

temporary, output = sys.argv[1:]
at_fdcwd = -2
rename_swap = 0x00000002
if os.path.lexists(output):
    libc = ctypes.CDLL(None, use_errno=True)
    renameatx_np = libc.renameatx_np
    renameatx_np.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameatx_np.restype = ctypes.c_int
    result = renameatx_np(
        at_fdcwd,
        os.fsencode(temporary),
        at_fdcwd,
        os.fsencode(output),
        rename_swap,
    )
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), output)
else:
    os.rename(temporary, output)
PY
  if [ -e "$temporary" ]; then
    rm -rf "$temporary"
  fi
  rm -f "$PACKAGE_ROOT/ios/pocket_flutter/Frameworks/libpocket_flutter.a"
  trap - EXIT
  cleanup_xcframework_lock
}

case "${1:-}" in
  macos)
    # Pass deployment target only to target C compilations (`CFLAGS_*`) and the
    # final target crate (`cargo rustc -- -C link-arg=...`) so host proc-macros
    # (`libserde_derive.dylib`) are never linked with `-mmacosx-version-min=12.0`
    # on Xcode 27.2+.
    (
      unset MACOSX_DEPLOYMENT_TARGET
      unset CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS
      export CFLAGS_aarch64_apple_darwin="-mmacosx-version-min=12.0"
      cargo rustc --locked --offline --release \
        --manifest-path "$ROOT/native/Cargo.toml" \
        --target aarch64-apple-darwin \
        --lib -- -C link-arg=-mmacosx-version-min=12.0
      cargo rustc --locked --offline --release \
        --manifest-path "$ROOT/native/Cargo.toml" \
        --target aarch64-apple-darwin \
        --bin pocket_probe -- -C link-arg=-mmacosx-version-min=12.0
    )
    mkdir -p "$PACKAGE_ROOT/macos/Frameworks"
    cp "$CARGO_TARGET_DIR/aarch64-apple-darwin/release/libpocket_flutter.a" \
      "$PACKAGE_ROOT/macos/Frameworks/libpocket_flutter.a"
    slim_apple_staticlib \
      "macosx" \
      "macos" \
      "12.0" \
      "arm64" \
      "$PACKAGE_ROOT/macos/Frameworks/libpocket_flutter.a"
    ;;
  ios-sim)
    build_ios_slice aarch64-apple-ios-sim iphonesimulator arm64-apple-ios15.0-simulator ios-simulator
    build_ios_slice aarch64-apple-ios iphoneos arm64-apple-ios15.0 ios
    mkdir -p "$PACKAGE_ROOT/ios/pocket_flutter/Frameworks"
    package_ios_xcframework
    ;;
  ios)
    build_ios_slice aarch64-apple-ios iphoneos arm64-apple-ios15.0 ios
    build_ios_slice aarch64-apple-ios-sim iphonesimulator arm64-apple-ios15.0-simulator ios-simulator
    mkdir -p "$PACKAGE_ROOT/ios/pocket_flutter/Frameworks"
    package_ios_xcframework
    ;;
  android)
    sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$(python3 -c 'import os; print(os.path.expanduser("~/Library/Android/sdk"))')}}"
    ndk="${POCKET_ANDROID_NDK:-$sdk/ndk/28.1.13356709}"
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64)
        if [ -d "$ndk/toolchains/llvm/prebuilt/darwin-arm64" ]; then
          host_tag="darwin-arm64"
        else
          host_tag="darwin-x86_64"
        fi
        ;;
      Darwin-*) host_tag="darwin-x86_64" ;;
      Linux-*) host_tag="linux-x86_64" ;;
      *) echo "Unsupported NDK build host" >&2; exit 2 ;;
    esac
    bin="$ndk/toolchains/llvm/prebuilt/$host_tag/bin"
    test -x "$bin/aarch64-linux-android24-clang" || {
      echo "Set POCKET_ANDROID_NDK to an installed Android NDK" >&2
      exit 1
    }
    export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$bin/aarch64-linux-android24-clang"
    export CC_aarch64_linux_android="$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"
    export AR_aarch64_linux_android="$bin/llvm-ar"
    export LIBCLANG_PATH="${LIBCLANG_PATH:-$(dirname "$(xcrun --find clang 2>/dev/null || command -v clang)")/../lib}"
    export BINDGEN_EXTRA_CLANG_ARGS="--target=aarch64-linux-android24 --sysroot=$ndk/toolchains/llvm/prebuilt/$host_tag/sysroot"
    export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,--gc-sections -C link-arg=-Wl,--version-script=$GNU_VERSION_SCRIPT"
    build aarch64-linux-android
    mkdir -p "$PACKAGE_ROOT/android/src/main/jniLibs/arm64-v8a"
    cp "$CARGO_TARGET_DIR/aarch64-linux-android/release/libpocket_flutter.so" \
      "$PACKAGE_ROOT/android/src/main/jniLibs/arm64-v8a/libpocket_flutter.so"
    if [ -x "$bin/llvm-strip" ]; then
      "$bin/llvm-strip" --strip-unneeded \
        "$PACKAGE_ROOT/android/src/main/jniLibs/arm64-v8a/libpocket_flutter.so"
    fi
    ;;
  linux)
    case "$(uname -m)" in
      aarch64|arm64) linux_target="aarch64-unknown-linux-gnu" ;;
      *) linux_target="x86_64-unknown-linux-gnu" ;;
    esac
    export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,--gc-sections -C link-arg=-Wl,--version-script=$GNU_VERSION_SCRIPT"
    build "$linux_target"
    mkdir -p "$PACKAGE_ROOT/linux/lib"
    cp "$CARGO_TARGET_DIR/$linux_target/release/libpocket_flutter.so" \
      "$PACKAGE_ROOT/linux/lib/libpocket_flutter.so"
    if command -v strip >/dev/null 2>&1; then
      strip --strip-unneeded "$PACKAGE_ROOT/linux/lib/libpocket_flutter.so"
    fi
    ;;
  *)
    echo "Usage: $0 macos|ios-sim|ios|android|linux" >&2
    exit 2
    ;;
esac
