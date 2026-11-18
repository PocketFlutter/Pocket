/// Optional open-file dialog capability provider for PocketJS hosts.
///
/// The package is separate from `pocket_sdk`: a consumer depends on it,
/// registers [PocketFilePickerPlugin] in `PocketAppConfig.pluginFactories`, and
/// grants `files.open` in `allowedPermissions`. The guest only ever sees opaque
/// handles, never absolute paths.
library;

export 'src/file_picker_plugin.dart';
