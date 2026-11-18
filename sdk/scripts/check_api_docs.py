#!/usr/bin/env python3
"""Check/update the reviewable public export inventory. Semantic docs still need review."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

SDK = Path(__file__).resolve().parents[1]
DEST = SDK / 'docs/API_SURFACE.json'
REFERENCES = ('API.md', 'FLUTTER_API.md', 'JS_API.md', 'TOOLING_API.md',
              'HYBRID_HOST_API.md', 'HYBRID_FLUTTER_TAB_HOST.md', 'INSTALL_STUDIO.md',
              'JS_API_SIGNATURES.md', 'DART_API_SIGNATURES.md')

def markdown_prose(value):
    # Source signatures and examples are code, not Markdown links.
    value = re.sub(r'^(`{3,}|~{3,})[^\n]*\n.*?^\1\s*$', '', value, flags=re.M | re.S)
    return re.sub(r'(`+).*?\1', '', value, flags=re.S)

def check_reference_links():
    errors = []
    for name in REFERENCES:
        path = SDK / 'docs' / name
        if not path.exists():
            errors.append(f'Missing API reference: {relative(path)}')
            continue
        for raw in re.findall(r'\[[^\]\n]+\]\(([^)]+)\)', markdown_prose(path.read_text())):
            target = raw.strip().split('#', 1)[0]
            if not target or re.match(r'[a-zA-Z][\w+.-]*:', target):
                continue
            resolved = (path.parent / target).resolve()
            if not resolved.is_relative_to(SDK.parent):
                errors.append(f'{relative(path)}: non-portable local link {raw}')
            elif not resolved.exists():
                errors.append(f'{relative(path)}: broken local link {raw}')
    return errors

def relative(path):
    return path.relative_to(SDK).as_posix()

def source_digest(path):
    # Covers signature/member/default changes as well as added symbol names.
    # Implementation-only edits can require a reviewed baseline refresh too.
    return hashlib.sha256(path.read_bytes()).hexdigest()

def check_signature_sources(snapshot):
    sources = {'JS_API_SIGNATURES.md': {}, 'DART_API_SIGNATURES.md': {}}
    for package in snapshot['javascript']:
        expected = sources['JS_API_SIGNATURES.md']
        expected[package['manifest']] = source_digest(SDK / package['manifest'])
        for record in package['sourceDeclarations']:
            expected[record['file']] = record['sourceSha256']
    for package in snapshot['dart']:
        expected = sources['DART_API_SIGNATURES.md']
        expected[package['manifest']] = source_digest(SDK / package['manifest'])
        for library in package['libraries']:
            for record in library['exports']:
                if 'file' in record:
                    expected[record['file']] = record['sourceSha256']
    errors = []
    for name, expected in sources.items():
        path = SDK / 'docs' / name
        if not path.exists():
            errors.append(f'Missing signature catalog: docs/{name}')
            continue
        pairs = re.findall(r'<!-- api-source: (\S+) ([0-9a-f]{64}) -->', path.read_text())
        markers = dict(pairs)
        missing = sorted(set(expected) - set(markers))
        if missing:
            errors.append(f'docs/{name}: missing source fingerprints: {", ".join(missing)}')
        changed = []
        for file, digest in markers.items():
            source = (SDK / file).resolve()
            if not source.is_relative_to(SDK) or not source.is_file() or source_digest(source) != digest:
                changed.append(file)
        if changed:
            errors.append(f'docs/{name}: stale source signatures: {", ".join(sorted(changed))}')
        if len(pairs) != len(markers):
            errors.append(f'docs/{name}: duplicate source fingerprints')
    return errors

def export_targets(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from export_targets(child)
    elif isinstance(value, list):
        for child in value:
            yield from export_targets(child)

def js_export_sources(manifest, pkg):
    pending = [manifest.parent / target for target in export_targets(pkg.get('exports', {}))
               if target.startswith('./') and '*' not in target]
    seen = set()
    while pending:
        path = pending.pop().resolve()
        if path in seen or not path.is_file() or path.suffix not in {'.ts', '.tsx', '.js', '.mjs', '.cjs'}:
            continue
        seen.add(path)
        # Follow export edges, never ordinary imports into implementation modules.
        for target in re.findall(r'\bexport\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s*[\'\"]([^\'\"]+)[\'\"]', path.read_text(), re.S):
            if not target.startswith('.'):
                continue
            base = path.parent / target
            candidates = [base] + [candidate for suffix in ('.ts', '.tsx', '.js', '.mjs', '.cjs')
                                   for candidate in (base.with_suffix(suffix), base / ('index' + suffix))]
            pending.extend(candidate for candidate in candidates if candidate.is_file())
    return sorted(seen)

def declarations(path, language):
    text = path.read_text()
    if language == 'dart':
        pattern = r'^\s*(?:(?:abstract|base|final|interface|sealed)\s+)*(?:class|enum|mixin|extension(?:\s+type)?|typedef)\s+([A-Za-z]\w*)'
    else:
        pattern = r'^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)'
    return sorted(set(re.findall(pattern, text, re.M)))

def dart_exports(entry, seen=None):
    seen = set() if seen is None else seen
    if entry in seen or not entry.exists():
        return []
    seen.add(entry)
    records = []
    text = entry.read_text()
    records.append({'file': relative(entry), 'declarations': declarations(entry, 'dart'), 'sourceSha256': source_digest(entry)})
    for match in re.finditer(r"\bexport\s+['\"]([^'\"]+)['\"]([^;]*);", text, re.S):
        target, filter_text = match.groups()
        if target.startswith('package:'):
            package, _, tail = target[8:].partition('/')
            base = SDK if package == 'pocket_sdk' else SDK / 'packages' / package
            child = base / 'lib' / tail
        else:
            child = entry.parent / target
        # Cross-package exports are recorded as directives, and enumerated at
        # their own package entry. `show`/`hide` stay visible, not discarded.
        records.append({'from': relative(entry), 'export': target, 'filter': ' '.join(filter_text.split())})
        if not target.startswith('package:'):
            records.extend(dart_exports(child.resolve(), seen))
    return records

def inventory():
    js = []
    for manifest in sorted((SDK / 'packages').glob('*/package.json')):
        pkg = json.loads(manifest.read_text())
        if not pkg.get('name', '').startswith('@pocket/'):
            continue
        files = []
        # Re-exports and members remain authoritative in these source files;
        # the inventory is a coverage guard, not an alternate type system.
        for path in js_export_sources(manifest, pkg):
            symbols = declarations(path, 'ts')
            exports = re.findall(r'^\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*)[^;]*;', path.read_text(), re.M | re.S)
            if symbols or exports:
                files.append({'file': relative(path), 'declarations': symbols, 'sourceSha256': source_digest(path),
                              'reexports': [' '.join(x.split()) for x in exports]})
        js.append({'name': pkg['name'], 'manifest': relative(manifest),
                   'scripts': pkg.get('scripts', {}), 'bin': pkg.get('bin', {}),
                   'exports': pkg.get('exports', {}), 'sourceDeclarations': files})
    dart = []
    for manifest in sorted([SDK / 'pubspec.yaml', *(SDK / 'packages').glob('*/pubspec.yaml')]):
        name = re.search(r'^name:\s*(\S+)', manifest.read_text(), re.M).group(1)
        entries = sorted((manifest.parent / 'lib').glob('*.dart'))
        dart.append({'name': name, 'manifest': relative(manifest),
                     'libraries': [{'entry': relative(entry), 'exports': dart_exports(entry)} for entry in entries]})
    tooling = []
    command_sources = {SDK / 'pocket.ts', SDK / 'scripts/build_guest.ts', SDK / 'scripts/install_studio.mjs',
                       SDK / 'editor/server.ts', SDK / 'editor/directory_picker.ts'}
    for manifest in (SDK.parent / 'package.json', SDK / 'package.json'):
        pkg = json.loads(manifest.read_text())
        tooling.append({'manifest': '../package.json' if manifest.parent == SDK.parent else 'package.json',
                        'scripts': pkg.get('scripts', {}), 'bin': pkg.get('bin', {})})
        for command in pkg.get('scripts', {}).values():
            for target in re.findall(r'(?<![\w./-])((?:sdk/)?(?:scripts|editor|packages)/[\w./-]+\.(?:mjs|ts)|(?:sdk/)?pocket\.ts)', command):
                path = (manifest.parent / target).resolve()
                if path.is_file() and path.is_relative_to(SDK):
                    command_sources.add(path)
    tooling.append({'commandSources': [{'file': relative(path), 'sourceSha256': source_digest(path)}
                                        for path in sorted(command_sources)]})
    return {'schemaVersion': 3,
            'scope': 'Package export graphs, top-level declarations, npm scripts and command entry sources with digests. JS follows re-exports only; Dart filters are recorded, not applied. Source files can contain non-public helpers; package exports and show/hide determine visibility. Digests guard member/signature changes and can also flag implementation-only edits. Consult API references for defaults and runtime semantics.',
            'dart': dart, 'javascript': js, 'tooling': tooling}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--write', action='store_true', help='Regenerate inventory after reviewing and updating API documentation.')
args = parser.parse_args()
snapshot = inventory()
expected = json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n'
if args.write:
    DEST.write_text(expected)
    print('Updated sdk/docs/API_SURFACE.json; review semantic docs and examples before committing.')
elif not DEST.exists() or DEST.read_text() != expected:
    print('Public API inventory changed. Update API docs/examples, then run python3 sdk/scripts/check_api_docs.py --write', file=sys.stderr)
    sys.exit(1)
else:
    print('Public API export inventory matches documentation baseline.')
documentation_errors = check_reference_links() + check_signature_sources(snapshot)
if documentation_errors:
    print('\n'.join(documentation_errors), file=sys.stderr)
    print('Regenerate affected catalogs with node sdk/scripts/generate_api_signatures.mjs and (from sdk/) ../.fvm/flutter_sdk/bin/dart run scripts/generate_api_signatures.dart; review semantic API docs too.', file=sys.stderr)
    sys.exit(1)
