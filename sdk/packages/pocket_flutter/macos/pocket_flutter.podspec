Pod::Spec.new do |s|
  s.name             = 'pocket_flutter'
  s.version          = '0.1.0'
  s.summary          = 'PocketJS QuickJS FFI renderer'
  s.description      = 'Minimal retained Canvas host for PocketJS guests.'
  s.homepage         = 'https://github.com/pocket-nexus/pocketjs'
  s.license          = { :type => 'MIT', :file => '../LICENSE' }
  s.author           = { 'PocketJS' => 'dev@pocketjs.invalid' }
  s.source           = { :path => '.' }
  s.vendored_libraries = 'Frameworks/libpocket_flutter.a'
  s.osx.deployment_target = '12.0'
  # Match iOS SwiftPM: retain FFI entry roots, not every Rust archive member.
  # export_dynamic preserves the admitted C ABI for Dart process lookups.
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -Wl,-u,_pocket_create -Wl,-u,_pocket_worker_create -Wl,-u,_pocket_worker_quickjs_create -Wl,-u,_pocket_worker_ui_attach -Wl,-u,_pocket_worker_runner_create -lc -lm -liconv -Wl,-export_dynamic'
  }
  s.requires_arc = false
  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -lc++'
  }
end
