import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchAndroidHardwareManifest, patchAndroidMinimum } from "../../pocket.ts";

const root = mkdtempSync(join(tmpdir(), "pocket-android-scaffold-test-"));
try {
  const android = join(root, "android");
  const manifestDirectory = join(android, "app/src/main");
  mkdirSync(manifestDirectory, { recursive: true });
  const manifest = join(manifestDirectory, "AndroidManifest.xml");
  writeFileSync(manifest, `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="fixture" />
</manifest>
`);

  // A non-hardware project must not acquire permissions just because an
  // Android project happens to be present.
  const before = readFileSync(manifest, "utf8");
  patchAndroidHardwareManifest(android, false);
  assert.equal(readFileSync(manifest, "utf8"), before);

  patchAndroidHardwareManifest(android, true);
  const once = readFileSync(manifest, "utf8");
  for (const permission of [
    "android.permission.INTERNET",
    "android.permission.CAMERA",
    "android.permission.BLUETOOTH_SCAN",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.USE_BIOMETRIC",
  ]) {
    const escaped = permission.replaceAll(".", "\\.");
    assert.match(once, new RegExp(`android:name="${escaped}"`));
    assert.equal((once.match(new RegExp(`android:name="${escaped}"`, "g")) ?? []).length, 1);
  }
  assert.match(once, /BLUETOOTH_SCAN[^>]*usesPermissionFlags="neverForLocation"/);
  assert.match(once, /BLUETOOTH[^>]*maxSdkVersion="30"/);
  // BiometricPrompt is API 28+; deprecated fingerprint permission is not used.
  for (const removed of [
    "android.permission.USE_FINGERPRINT",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.RECORD_AUDIO",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
    "android.permission.BLUETOOTH_ADVERTISE",
    "android.permission.BODY_SENSORS",
  ]) {
    assert.doesNotMatch(once, new RegExp(`android:name="${removed.replaceAll(".", "\\.")}"`));
  }

  // Generated and existing hosts can both run this patch during init/build;
  // the manifest must stay byte-for-byte stable after the first application.
  patchAndroidHardwareManifest(android, true);
  assert.equal(readFileSync(manifest, "utf8"), once);

  const buildGradle = join(android, "app/build.gradle.kts");
  writeFileSync(buildGradle, `android {
    defaultConfig {
        minSdk = flutter.minSdkVersion
    }
}
`);
  patchAndroidMinimum(android);
  const patchedGradle = readFileSync(buildGradle, "utf8");
  assert.match(patchedGradle, /minSdk = maxOf\(flutter\.minSdkVersion, 24\)/);
  assert.match(patchedGradle, /abiFilters.add\("arm64-v8a"\)/);
  assert.match(patchedGradle, /providers.gradleProperty\("pocket.compressNativeLibraries"\)/);
  assert.match(patchedGradle, /must be true or false/);
  assert.match(patchedGradle, /if \(pocketCompressNativeLibraries != null\)/);
  assert.match(patchedGradle, /findProperty\("split-per-abi"\)/);
  patchAndroidMinimum(android);
  assert.equal(readFileSync(buildGradle, "utf8"), patchedGradle);
  const custom = 'android { defaultConfig { ndk { abiFilters.add("arm64-v8a") } } }\n';
  writeFileSync(buildGradle, custom);
  patchAndroidMinimum(android);
  assert.equal(readFileSync(buildGradle, "utf8"), custom);
  rmSync(buildGradle);
  const groovy = join(android, "app/build.gradle");
  writeFileSync(groovy, "android {\n  defaultConfig {\n    minSdkVersion flutter.minSdkVersion\n  }\n}\n");
  patchAndroidMinimum(android);
  const groovyPatched = readFileSync(groovy, "utf8");
  assert.match(groovyPatched, /abiFilters.add\('arm64-v8a'\)/);
  assert.match(groovyPatched, /def pocketCompressNativeLibraries/);
  assert.match(groovyPatched, /new GradleException/);
  assert.match(groovyPatched, /findProperty\('split-per-abi'\)/);
  patchAndroidMinimum(android);
  assert.equal(readFileSync(groovy, "utf8"), groovyPatched);
  const customPackaging = "android {\n  packaging { jniLibs { useLegacyPackaging = false } }\n}\n";
  writeFileSync(groovy, customPackaging);
  patchAndroidMinimum(android);
  assert.equal(readFileSync(groovy, "utf8"), customPackaging);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("android_scaffold.test: hardware manifest declarations and idempotence passed");
