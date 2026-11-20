# Pocket Web SDK 0.1.29

## Added

- Studio opens ecosystem components alongside the main app in an independent preview session. New extensions can use a companion project with editable sources and its own QJBC and PAK build (`22e76a7`). [Studio ecosystem components](EDITOR_STUDIO.md#ecosystem-components-beside-the-app) · [Studio tooling API](TOOLING_API.md)
- Single-line `InputField` supports `digitsOnly` for numeric keyboard and filtering in Flutter and Studio. `onFocusChange` and `appearance.caretColor` let compound fields coordinate focus styling with the native editor (`8980556`). [Studio text input](STUDIO_TEXT_INPUT.md#a-inputfield-appearance-focus-and-multiline)

## Changed

- Pocket Flutter hosts support a shared reference width across guest surfaces. Generated standalone Flutter hosts set 375 once at the app boundary. Studio Canvas also accepts custom viewport dimensions (`67e31ea`, `29b9927`). [Flutter API](FLUTTER_API.md#choose-an-entry-point) · [Studio viewport controls](EDITOR_STUDIO.md)
- Studio defaults to Direct Web for compatible Live2D previews and supports browser text rendering with the default fonts (`601ce88`). [Web Live2D preview](WEB_LIVE2D.md#opt-in-direct-web-presentation)

## Fixed

- Android and other Flutter hosts route discrete Back through the focused guest and then the SystemUI page handler and kernel. SystemUI acknowledges a dismissal when it takes ownership so the transition can finish on the existing lifecycle path (`01e9ea3`). [Back navigation](BACK_NAVIGATION.md)
- Flutter text uses the same first-line anchor as Studio Canvas. Input fields keep the guest border throughout editing, retain the same hint and edit baseline, and preserve the shell width and right inset for long single-line values (`01e9ea3`, `8980556`). [Text input rendering](INPUT_OVERLAY_DUPLICATE_TEXT.md) · [Studio text input](STUDIO_TEXT_INPUT.md)

## Compatibility

The pinned PocketJS revision and QuickJS bytecode ABI are unchanged. Studio packages target macOS arm64 and Windows x64. The ecosystem companion workflow covers authoring and preview. Native extension deployment uses each platform's build and signing workflow. [Install Studio](INSTALL_STUDIO.md) · [Studio ecosystem components](EDITOR_STUDIO.md#ecosystem-components-beside-the-app)
