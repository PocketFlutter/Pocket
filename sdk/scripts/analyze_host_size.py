#!/usr/bin/env python3
"""Inventory an existing .app directory or APK/AAB/IPA ZIP, without extracting it.

Logical file bytes are not store download size or filesystem allocation.
Run on a Release artifact; Debug overhead is reported explicitly.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
import json
from pathlib import Path
import plistlib
import zipfile


def category(name: str) -> str:
    lower = name.lower()
    leaf = lower.rsplit("/", 1)[-1]
    if leaf in {"fluttermacos", "flutter", "flutter.dll", "libflutter.so", "icudtl.dat"}:
        return "flutter_engine"
    if leaf.endswith((".qjbc", ".pak")) or leaf.endswith(".bytecode.json") or leaf == "guest-manifest.json":
        return "guest_packages"
    if leaf in {"kernel_blob.bin", "isolate_snapshot_data", "vm_snapshot_data", "libapp.so"} or lower.endswith("app.framework/versions/a/app") or lower.endswith("app.framework/app"):
        return "dart_code"
    if leaf.endswith((".ttf", ".otf", ".woff", ".woff2")):
        return "fonts"
    if leaf.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".wav", ".mp3", ".ogg", ".m4a", ".mp4", ".moc3", ".model3.json")):
        return "loose_media"
    if leaf.endswith((".so", ".dylib", ".dll", ".exe", ".a")) or "/macos/" in lower or (".framework/" in lower and "/resources/" not in lower and not leaf.endswith((".plist", ".h", ".modulemap"))):
        return "native_host_and_plugins"
    if "flutter_assets/" in lower or lower.startswith("assets/"):
        return "other_flutter_assets"
    return "other"


def inventory(artifact: Path) -> dict:
    entries = []
    archive = artifact.is_file()
    main_executables = set()
    if archive:
        if not zipfile.is_zipfile(artifact):
            raise ValueError("Expected an APK/AAB/IPA/ZIP archive or an app directory")
        with zipfile.ZipFile(artifact) as bundle:
            for name in bundle.namelist():
                if name.endswith(".app/Info.plist"):
                    info = plistlib.loads(bundle.read(name))
                    executable = info.get("CFBundleExecutable")
                    if isinstance(executable, str):
                        main_executables.add(str(Path(name).parent / executable))
            for entry in bundle.infolist():
                if entry.is_dir() or ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                    continue
                entries.append({"path": entry.filename, "bytes": entry.file_size, "compressed_bytes": entry.compress_size})
    else:
        if not artifact.is_dir():
            raise ValueError("Artifact does not exist")
        info_path = artifact / "Info.plist"
        if info_path.is_file():
            info = plistlib.loads(info_path.read_bytes())
            executable = info.get("CFBundleExecutable")
            if isinstance(executable, str):
                main_executables.add(executable)
        # Do not follow framework aliases or count external symlink targets.
        for path in artifact.rglob("*"):
            if path.is_file() and not path.is_symlink():
                entries.append({"path": path.relative_to(artifact).as_posix(), "bytes": path.stat().st_size})
    groups = defaultdict(lambda: {"bytes": 0, "files": 0, **({"compressed_bytes": 0} if archive else {})})
    for entry in entries:
        name = "native_host_and_plugins" if entry["path"] in main_executables else category(entry["path"])
        groups[name]["bytes"] += entry["bytes"]
        groups[name]["files"] += 1
        if archive:
            groups[name]["compressed_bytes"] += entry["compressed_bytes"]
    debug = any(Path(entry["path"]).name in {"kernel_blob.bin", "vm_snapshot_data"} or entry["path"].endswith(".debug.dylib") for entry in entries)
    report = {
        "artifact": str(artifact.resolve()), "kind": "zip-archive" if archive else "directory",
        "has_debug_payload": debug, "files": len(entries),
        "logical_bytes": sum(entry["bytes"] for entry in entries),
        "categories": dict(sorted(groups.items(), key=lambda item: item[1]["bytes"], reverse=True)),
        "largest_files": sorted(entries, key=lambda entry: entry["bytes"], reverse=True)[:20],
        "scope": "Logical file bytes; symlinks excluded. Not store download size or filesystem allocation.",
    }
    if archive:
        report["archive_bytes"] = artifact.stat().st_size
        report["compressed_entry_bytes"] = sum(entry["compressed_bytes"] for entry in entries)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--json", type=Path, help="Save complete machine-readable evidence")
    args = parser.parse_args()
    try:
        report = inventory(args.artifact)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        parser.error(str(error))
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, indent=2) + "\n")
    print(f"{report['artifact']}\nLogical size: {report['logical_bytes'] / 1048576:.3f} MiB ({report['files']} files)")
    if report["has_debug_payload"]:
        print("DEBUG payload detected: do not use this as a Release size baseline.")
    for name, group in report["categories"].items():
        print(f"{name:26s} {group['bytes'] / 1048576:9.3f} MiB  {group['files']:4d} files")
    print("Largest files:")
    for entry in report["largest_files"][:10]:
        print(f"  {entry['bytes'] / 1048576:9.3f} MiB  {entry['path']}")
    print(report["scope"])


if __name__ == "__main__":
    main()
