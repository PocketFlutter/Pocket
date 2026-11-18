import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldEcosystemModules } from "../scripts/ecosystem_scaffold.ts";
import { syncNativeEcosystemProject } from "../scripts/native_surface_scaffold.ts";

describe("Pocket SDK Opt-in Native Ecosystem Surface Scaffolding", () => {
  test("1. Zero native bloat when ecosystem modules are empty and XcodeGen is not requested", () => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-native-zero-"));
    try {
      mkdirSync(join(dir, "flutter/ios/Runner"), { recursive: true });
      mkdirSync(join(dir, "flutter/android/app/src/main"), { recursive: true });
      writeFileSync(join(dir, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.pocketjs.zero" }));
      writeFileSync(join(dir, "flutter/pubspec.yaml"), "name: demo\n");

      const res = scaffoldEcosystemModules(dir, []);
      expect(res.modules).toEqual([]);
      expect(existsSync(join(dir, "flutter/ios/PocketWidgets"))).toBe(false);
      expect(existsSync(join(dir, "flutter/ios/project.yml"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("2. Opting into Apple + Android surfaces scaffolds iOS XcodeGen, WidgetKit/LiveActivity/AppGroup & Android AppWidget/LiveUpdate", () => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-native-full-"));
    try {
      const flutterDir = join(dir, "flutter");
      mkdirSync(join(flutterDir, "ios/Runner"), { recursive: true });
      mkdirSync(join(flutterDir, "ios/RunnerTests"), { recursive: true });
      mkdirSync(join(flutterDir, "android/app/src/main/kotlin/fun/selfstudio/demo"), {
        recursive: true,
      });

      writeFileSync(
        join(dir, "pocket.json"),
        JSON.stringify({ pocket: 2, id: "fun.selfstudio.demo", title: "DemoCare" }),
      );
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ protocolVersion: 1, capabilities: { requires: [], optional: [] } }),
      );
      writeFileSync(join(flutterDir, "pubspec.yaml"), "name: demo_care\n");
      writeFileSync(
        join(flutterDir, "ios/Runner/Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleName</key><string>DemoCare</string>
<key>UIApplicationSceneManifest</key><dict><key>UISceneConfigurations</key><dict>
<key>UIWindowSceneSessionRoleApplication</key><array><dict>
<key>UISceneDelegateClassName</key><string>FlutterSceneDelegate</string>
</dict></array></dict></dict></dict></plist>`,
      );
      const scenePath = join(flutterDir, "ios/Runner/SceneDelegate.swift");
      const customScene = "class SceneDelegate: FlutterSceneDelegate { /* consumer code */ }";
      writeFileSync(scenePath, customScene);
      const appDelegatePath = join(flutterDir, "ios/Runner/AppDelegate.swift");
      const originalAppDelegate = "import Flutter\nimport UIKit\n";
      writeFileSync(appDelegatePath, originalAppDelegate);
      const entitlementsPath = join(flutterDir, "ios/Runner/Runner.entitlements");
      writeFileSync(entitlementsPath, `<plist version="1.0"><dict>
<key>aps-environment</key><string>development</string>
<key>com.apple.security.application-groups</key><array><string>group.consumer.existing</string></array>
</dict></plist>`);
      writeFileSync(
        join(flutterDir, "android/app/build.gradle.kts"),
        `android {\n    namespace = "fun.selfstudio.demo"\n    defaultConfig { applicationId = "fun.selfstudio.demo" }\n}\n`,
      );
      writeFileSync(
        join(flutterDir, "android/app/src/main/AndroidManifest.xml"),
        `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="DemoCare">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
        <meta-data android:name="flutterEmbedding" android:value="2" />
    </application>
</manifest>
`,
      );

      const pocketPath = join(dir, "pocket.json");
      const originalPocket = readFileSync(pocketPath, "utf8");
      const infoPath = join(flutterDir, "ios/Runner/Info.plist");
      const originalInfo = readFileSync(infoPath, "utf8");
      const linkManifestPath = join(flutterDir, "android/app/src/main/AndroidManifest.xml");
      const originalLinkManifest = readFileSync(linkManifestPath, "utf8");
      const assertUnchangedProject = () => {
        expect(readFileSync(pocketPath, "utf8")).toBe(originalPocket);
        expect(readFileSync(linkManifestPath, "utf8")).toBe(originalLinkManifest);
        expect(readFileSync(appDelegatePath, "utf8")).toBe(originalAppDelegate);
        expect(existsSync(join(flutterDir, "ios/PocketWidgets"))).toBe(false);
      };
      expect(() =>
        scaffoldEcosystemModules(dir, ["apple-today"], { deepLinkScheme: "https" }),
      ).toThrow("lowercase custom URL scheme");
      expect(readFileSync(infoPath, "utf8")).toBe(originalInfo);
      assertUnchangedProject();

      const customInfo = originalInfo.replace("FlutterSceneDelegate", "$(PRODUCT_MODULE_NAME).SceneDelegate");
      writeFileSync(infoPath, customInfo);
      expect(() =>
        scaffoldEcosystemModules(dir, ["apple-today"], { deepLinkScheme: "democare" }),
      ).toThrow("custom SceneDelegate");
      expect(readFileSync(infoPath, "utf8")).toBe(customInfo);
      expect(readFileSync(scenePath, "utf8")).toBe(customScene);
      assertUnchangedProject();
      writeFileSync(infoPath, originalInfo);

      const res = scaffoldEcosystemModules(
        dir,
        [
          "apple-devices",
          "apple-today",
          "apple-lock",
          "apple-live-activity",
          "android-devices",
          "android-widgets",
          "android-live",
        ],
        {
          bundleId: "fun.selfstudio.demo.set",
          teamId: "L5W9FHSX92",
          deepLinkScheme: "democare",
          useXcodeGen: true,
          embedIosExtensions: true,
          runXcodeGen: false,
        },
      );

      expect(res.modules).toContain("apple-today");
      expect(res.modules).toContain("android-widgets");

      // Verify iOS XcodeGen & WidgetKit/ActivityKit/AppGroup artifacts
      const projectYml = readFileSync(join(flutterDir, "ios/project.yml"), "utf8");
      expect(projectYml).toContain("PRODUCT_BUNDLE_IDENTIFIER: fun.selfstudio.demo.set");
      expect(projectYml).toContain('DEVELOPMENT_TEAM: "L5W9FHSX92"');
      expect(projectYml).toContain("PocketWidgetsExtension:");
      expect(projectYml).toContain("PRODUCT_BUNDLE_IDENTIFIER: fun.selfstudio.demo.set.widgets");
      expect(projectYml).toContain("Runner/Runner.entitlements");

      const infoPlist = readFileSync(join(flutterDir, "ios/Runner/Info.plist"), "utf8");
      expect(infoPlist).toContain("group.fun.selfstudio.demo.set");
      expect(infoPlist).toContain("NSSupportsLiveActivities");
      expect(infoPlist).toContain("PocketDeepLinksEnabled");

      expect(readFileSync(scenePath, "utf8")).toBe(customScene);
      expect(readFileSync(appDelegatePath, "utf8")).toContain("PocketPlatformPlugin.handleIncomingURL");
      const entitlements = readFileSync(entitlementsPath, "utf8");
      expect(entitlements).toContain("aps-environment");
      expect(entitlements).toContain("group.consumer.existing");
      expect(entitlements).toContain("group.fun.selfstudio.demo.set");

      expect(existsSync(join(flutterDir, "ios/PocketWidgets/PocketTodayAndLockWidget.swift"))).toBe(true);
      expect(existsSync(join(flutterDir, "ios/PocketWidgets/PocketLiveActivityWidget.swift"))).toBe(true);
      expect(existsSync(join(flutterDir, "ios/PocketWidgets/PocketWidgetsBundle.swift"))).toBe(true);

      // Verify Android AppWidget Kotlin + XML + Manifest receivers
      const androidManifest = readFileSync(
        join(flutterDir, "android/app/src/main/AndroidManifest.xml"),
        "utf8",
      );
      expect(androidManifest).toContain("PocketSmallWidgetProvider");
      expect(androidManifest).toContain("PocketMediumWidgetProvider");
      expect(androidManifest).toContain("PocketLargeWidgetProvider");
      expect(androidManifest).toContain("PocketSurfaceActionReceiver");
      expect(androidManifest).toContain("android.permission.POST_NOTIFICATIONS");
      expect(androidManifest).toContain("android.software.leanback");
      expect(androidManifest).toContain('android:resizeableActivity="true"');
      expect(androidManifest).toContain("dev.pocketjs.platform.DEEP_LINKS_ENABLED");
      expect(androidManifest).toContain("android.intent.action.VIEW");
      expect(androidManifest).toContain('android:scheme="democare"');

      expect(
        existsSync(
          join(
            flutterDir,
            "android/app/src/main/kotlin/fun/selfstudio/demo/surfaces/PocketSurfaceAppWidgetProviders.kt",
          ),
        ),
      ).toBe(true);

      const options = {
        modules: res.modules,
        bundleId: "fun.selfstudio.demo.set",
        teamId: "L5W9FHSX92",
        deepLinkScheme: "democare",
        appTitle: "DemoCare",
        useXcodeGen: true,
        embedIosExtensions: true,
      } as const;
      const repeated = syncNativeEcosystemProject(flutterDir, options);
      expect(repeated.createdFiles).toEqual([]);
      expect(repeated.updatedFiles).toEqual([]);

      const widgetPath = join(flutterDir, "ios/PocketWidgets/PocketTodayAndLockWidget.swift");
      const customWidget = readFileSync(widgetPath, "utf8") + "\n// consumer widget code\n";
      writeFileSync(widgetPath, customWidget);
      const specPath = join(flutterDir, "ios/project.yml");
      const customSpec = "name: ConsumerProject\n";
      writeFileSync(specPath, customSpec);
      const scriptPath = join(flutterDir, "ios/generate-xcodeproj.sh");
      const customScript = "#!/bin/sh\n# consumer script\n";
      writeFileSync(scriptPath, customScript);
      const refreshed = syncNativeEcosystemProject(flutterDir, {
        ...options,
        appTitle: "Updated title",
        runXcodeGen: true,
      });
      expect(refreshed.xcodegenExecuted).toBe(false);
      expect(readFileSync(widgetPath, "utf8")).toBe(customWidget);
      expect(readFileSync(specPath, "utf8")).toBe(customSpec);
      expect(readFileSync(scriptPath, "utf8")).toBe(customScript);
      expect(readFileSync(entitlementsPath, "utf8")).toBe(entitlements);
      expect(refreshed.updatedFiles).toContain(
        "android/app/src/main/kotlin/fun/selfstudio/demo/surfaces/PocketSurfaceAppWidgetProviders.kt",
      );

      // Verify clean removal of Android widget receivers when android-widgets is turned off
      syncNativeEcosystemProject(flutterDir, {
        modules: ["apple-devices"],
        bundleId: "fun.selfstudio.demo.set",
      });
      const cleanedManifest = readFileSync(
        join(flutterDir, "android/app/src/main/AndroidManifest.xml"),
        "utf8",
      );
      expect(cleanedManifest).not.toContain("PocketSmallWidgetProvider");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
