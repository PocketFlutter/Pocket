import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { patchMacosMinimum } from "../../pocket.ts";

test("macOS scaffold builds only the shipped arm64 ABI and preserves custom Podfile settings on repeat", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-macos-scaffold-"));
  try {
    mkdirSync(join(root, "Runner.xcodeproj"));
    writeFileSync(join(root, "Runner.xcodeproj/project.pbxproj"), "\n buildSettings = {\n MACOSX_DEPLOYMENT_TARGET = 10.15;\n };\n");
    writeFileSync(join(root, "Podfile"), "platform :osx, '10.15'\npost_install do |installer|\n  installer.pods_project.targets.each do |target|\n    flutter_additional_macos_build_settings(target)\n    # consumer custom setting\n  end\nend\n");
    patchMacosMinimum(root);
    const podfile = readFileSync(join(root, "Podfile"), "utf8");
    const project = readFileSync(join(root, "Runner.xcodeproj/project.pbxproj"), "utf8");
    expect(project).toContain("ARCHS = arm64;");
    expect(project).toContain("MACOSX_DEPLOYMENT_TARGET = 12.0;");
    expect(podfile).toContain("config.build_settings['ARCHS'] = 'arm64'");
    expect(podfile).toContain("# consumer custom setting");
    patchMacosMinimum(root);
    expect(readFileSync(join(root, "Podfile"), "utf8")).toBe(podfile);
    expect(readFileSync(join(root, "Runner.xcodeproj/project.pbxproj"), "utf8")).toBe(project);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
