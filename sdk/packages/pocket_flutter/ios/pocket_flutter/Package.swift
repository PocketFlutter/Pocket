// swift-tools-version: 5.9

import PackageDescription
import Foundation

// Flutter 3.47 supplies this package through its generated application graph.
// Keep it optional here so Flutter 3.35 can still resolve the plugin manifest.
let flutterFrameworkPath = "../FlutterFramework"
let hasFlutterFramework = FileManager.default.fileExists(
    atPath: URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent(flutterFrameworkPath)
        .standardized.path
)
let flutterPackageDependencies: [Package.Dependency] = hasFlutterFramework
    ? [.package(name: "FlutterFramework", path: flutterFrameworkPath)]
    : []
let flutterTargetDependencies: [Target.Dependency] = hasFlutterFramework
    ? [.product(name: "FlutterFramework", package: "FlutterFramework")]
    : []

// Runtime availability does not make new UIKit declarations visible to an
// older compiler SDK. Resolve the selected Xcode SDK before admitting them.
// xcrun respects DEVELOPER_DIR, matching Flutter/Xcode's selected toolchain.
func supportsReservedRegionsSDK() -> Bool {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    process.arguments = ["--sdk", "iphoneos", "--show-sdk-version"]
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let version = String(data: data, encoding: .utf8) else { return false }
        let parts = version.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ".").compactMap { Int($0) }
        guard let major = parts.first else { return false }
        return major > 27 || (major == 27 && parts.count > 1 && parts[1] >= 1)
    } catch {
        return false
    }
}
let displayGeometrySwiftSettings: [SwiftSetting] = supportsReservedRegionsSDK()
    ? [.define("POCKET_HAS_RESERVED_REGIONS_SDK", .when(platforms: [.iOS]))]
    : []

let package = Package(
    name: "pocket_flutter",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "pocket-flutter", targets: ["pocket_flutter"]),
    ],
    dependencies: flutterPackageDependencies,
    targets: [
        .target(
            name: "pocket_flutter",
            dependencies: flutterTargetDependencies + [
                .target(name: "PocketFlutterNative"),
            ],
            resources: [.copy("PrivacyInfo.xcprivacy")],
            swiftSettings: displayGeometrySwiftSettings,
            linkerSettings: [
                // Dart FFI resolves the Rust C ABI from the process image. Use
                // targeted `-u` roots instead of `-all_load` so apps linking
                // other Rust staticlibs (e.g. intiface) do not collide on
                // unreferenced `compiler_builtins` object members.
                .unsafeFlags([
                    "-Xlinker", "-u", "-Xlinker", "_pocket_create",
                    "-Xlinker", "-u", "-Xlinker", "_pocket_worker_create",
                    "-Xlinker", "-u", "-Xlinker", "_pocket_worker_quickjs_create",
                    "-Xlinker", "-u", "-Xlinker", "_pocket_worker_ui_attach",
                    "-Xlinker", "-u", "-Xlinker", "_pocket_worker_runner_create",
                    "-Xlinker", "-export_dynamic",
                ]),
                .linkedLibrary("c"),
                .linkedLibrary("m"),
                .linkedLibrary("iconv"),
                .linkedLibrary("c++"),
            ]
        ),
        .binaryTarget(
            name: "PocketFlutterNative",
            path: "Frameworks/PocketFlutter.xcframework"
        ),
    ]
)
