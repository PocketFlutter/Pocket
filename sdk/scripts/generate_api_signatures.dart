// Regenerate public Dart signatures using the SDK-pinned analyzer AST.
// Run from sdk/: ../.fvm/flutter_sdk/bin/dart run scripts/generate_api_signatures.dart
import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:crypto/crypto.dart' as crypto;

final Directory sdkRoot = Directory.current;
final File inventoryFile = File('${Directory.current.path}/docs/API_SURFACE.json');
final Map<String, CompilationUnit> parseCache = <String, CompilationUnit>{};
final Map<String, String> sourceCache = <String, String>{};
final Map<String, Uri> packageRoots = <String, Uri>{};
final Set<String> unresolvedExports = <String>{};
int publicSymbols = 0;
int publicMembers = 0;

class ApiDeclaration {
  ApiDeclaration(this.name, this.kind, this.node, this.file);

  final String name;
  final String kind;
  final AstNode node;
  final String file;

  int get line {
    final start = signatureStart(node);
    return '\n'.allMatches(sourceFor(file).substring(0, start)).length + 1;
  }
}

int signatureStart(AstNode node) => node is AnnotatedNode ? node.firstTokenAfterCommentAndMetadata.offset : node.offset;

String normalizePath(String value) => Uri.file(value).normalizePath().toFilePath();

String sourceFor(String file) => sourceCache.putIfAbsent(file, () => File(file).readAsStringSync());

CompilationUnit unitFor(String file) {
  final normalized = normalizePath(file);
  return parseCache.putIfAbsent(normalized, () {
    final content = sourceFor(normalized);
    final result = parseString(content: content, path: normalized, throwIfDiagnostics: false);
    return result.unit;
  });
}

String? resolveUri(String baseFile, String rawUri) {
  final uri = Uri.tryParse(rawUri);
  if (uri == null) return null;
  if (uri.scheme == 'package') {
    final packageName = uri.pathSegments.isEmpty ? '' : uri.pathSegments.first;
    final packageRoot = packageRoots[packageName];
    if (packageRoot == null) return null;
    final suffix = uri.pathSegments.skip(1).join('/');
    final target = packageRoot.resolve(suffix);
    return target.scheme == 'file' ? normalizePath(target.toFilePath()) : null;
  }
  if (uri.scheme == 'file') return normalizePath(uri.toFilePath());
  if (uri.hasScheme) return null;
  return normalizePath(File(baseFile).parent.uri.resolveUri(uri).toFilePath());
}

void loadPackageConfig() {
  final configPath = '${Directory.current.path}/.dart_tool/package_config.json';
  final configFile = File(configPath);
  if (!configFile.existsSync()) {
    stderr.writeln('Missing $configPath; run the repository bootstrap before regenerating API docs.');
    exitCode = 2;
    throw StateError('Dart package configuration is unavailable.');
  }
  final config = jsonDecode(configFile.readAsStringSync()) as Map<String, dynamic>;
  addPackageConfig(config, Uri.file(configPath).resolve('.'));
  final packageDirectories = Directory('${Directory.current.path}/packages')
      .listSync()
      .whereType<Directory>()
      .toList();
  for (final packageDirectory in packageDirectories) {
    final packageConfigFile = File('${packageDirectory.path}/.dart_tool/package_config.json');
    if (!packageConfigFile.existsSync()) continue;
    final packageConfig = jsonDecode(packageConfigFile.readAsStringSync()) as Map<String, dynamic>;
    addPackageConfig(packageConfig, Uri.file(packageConfigFile.path).resolve('.'));
  }
}

void addPackageConfig(Map<String, dynamic> config, Uri configDirectory) {
  for (final item in config['packages'] as List<dynamic>) {
    final value = item as Map<String, dynamic>;
    final resolvedRoot = configDirectory.resolve(value['rootUri'] as String);
    final root = resolvedRoot.toString().endsWith('/') ? resolvedRoot : Uri.parse('${resolvedRoot.toString()}/');
    final packageUri = Uri.parse(value['packageUri'] as String);
    packageRoots[value['name'] as String] = root.resolveUri(packageUri);
  }
}

Set<String> namesFromCombinator(Combinator combinator) {
  if (combinator is ShowCombinator) return combinator.shownNames.map((name) => name.name).toSet();
  if (combinator is HideCombinator) return combinator.hiddenNames.map((name) => name.name).toSet();
  return <String>{};
}

Map<String, ApiDeclaration> localDeclarations(String libraryFile) {
  final unit = unitFor(libraryFile);
  final units = <MapEntry<CompilationUnit, String>>[MapEntry(unit, libraryFile)];
  for (final directive in unit.directives) {
    if (directive is PartDirective) {
      final target = resolveUri(libraryFile, directive.uri.stringValue ?? '');
      if (target != null && File(target).existsSync()) units.add(MapEntry(unitFor(target), target));
    }
  }

  final declarations = <String, ApiDeclaration>{};
  void add(String name, String kind, AstNode node, String file) {
    if (name.isEmpty || name.startsWith('_')) return;
    declarations.putIfAbsent(name, () => ApiDeclaration(name, kind, node, file));
  }

  for (final sourceUnitEntry in units) {
    final sourceUnit = sourceUnitEntry.key;
    final file = sourceUnitEntry.value;
    for (final declaration in sourceUnit.declarations) {
      if (declaration is FunctionDeclaration) {
        add(declaration.name.lexeme, declaration.isGetter ? 'getter' : declaration.isSetter ? 'setter' : 'function', declaration, file);
      } else if (declaration is ClassDeclaration) {
        add(declaration.namePart.typeName.lexeme, 'class', declaration, file);
      } else if (declaration is MixinDeclaration) {
        add(declaration.name.lexeme, 'mixin', declaration, file);
      } else if (declaration is EnumDeclaration) {
        add(declaration.namePart.typeName.lexeme, 'enum', declaration, file);
      } else if (declaration is TypeAlias) {
        add(declaration.name.lexeme, 'typedef', declaration, file);
      } else if (declaration is ExtensionTypeDeclaration) {
        add(declaration.namePart.typeName.lexeme, 'extension type', declaration, file);
      } else if (declaration is ExtensionDeclaration) {
        final extensionName = declaration.name?.lexeme;
        final onType = declaration.onClause?.extendedType.toSource() ?? 'Object';
        add(extensionName ?? '<extension on $onType>', 'extension', declaration, file);
      } else if (declaration is TopLevelVariableDeclaration) {
        for (final variable in declaration.variables.variables) {
          add(variable.name.lexeme, 'top-level variable', variable, file);
        }
      }
    }
  }
  return declarations;
}

Map<String, ApiDeclaration> exportedDeclarations(String libraryFile, [Set<String>? active]) {
  final normalized = normalizePath(libraryFile);
  final stack = active ?? <String>{};
  if (!stack.add(normalized)) return <String, ApiDeclaration>{};
  final result = localDeclarations(normalized);
  final unit = unitFor(normalized);
  for (final directive in unit.directives) {
    if (directive is! ExportDirective) continue;
    final rawUri = directive.uri.stringValue ?? '';
    final target = resolveUri(normalized, rawUri);
    if (target == null || !File(target).existsSync()) {
      unresolvedExports.add('$normalized -> $rawUri');
      continue;
    }
    final child = exportedDeclarations(target, stack);
    final showNames = <String>{};
    final hideNames = <String>{};
    for (final combinator in directive.combinators) {
      if (combinator is ShowCombinator) showNames.addAll(namesFromCombinator(combinator));
      if (combinator is HideCombinator) hideNames.addAll(namesFromCombinator(combinator));
    }
    for (final entry in child.entries) {
      if (showNames.isNotEmpty && !showNames.contains(entry.key)) continue;
      if (hideNames.contains(entry.key)) continue;
      result.putIfAbsent(entry.key, () => entry.value);
    }
  }
  stack.remove(normalized);
  return result;
}

String scrub(String value) => value.replaceAll(RegExp(r'\s+'), ' ').trim();
String mdCode(String value) {
  final runs = RegExp(r'`+').allMatches(value).map((match) => match.group(0)!.length);
  final longestRun = runs.isEmpty ? 0 : runs.reduce((left, right) => left > right ? left : right);
  final fence = '`' * (longestRun + 1);
  final padding = value.startsWith('`') || value.endsWith('`') || value.startsWith(' ') || value.endsWith(' ') ? ' ' : '';
  return '$fence$padding$value$padding$fence';
}

String signatureBeforeBody(AstNode node, FunctionBody body, String file) {
  final content = sourceFor(file);
  var end = body.offset;
  final start = signatureStart(node);
  if (end < start) return scrub(node.toSource());
  var text = content.substring(start, end).trim();
  if (text.endsWith(';')) text = text.substring(0, text.length - 1).trimRight();
  return scrub(text);
}

String constructorSignature(ConstructorDeclaration node, String file) {
  final content = sourceFor(file);
  final start = signatureStart(node);
  return scrub(content.substring(start, node.parameters.end));
}

int bodyBracketOffset(AstNode body) => body is BlockClassBody
    ? body.leftBracket.offset
    : body is BlockEnumBody
        ? body.leftBracket.offset
        : body.offset;

String classHeader(AstNode node, int bracketOffset, String file) {
  final content = sourceFor(file);
  return scrub(content.substring(signatureStart(node), bracketOffset));
}

List<String> fieldSignatures(FieldDeclaration field) {
  final variables = field.fields;
  final modifiers = <String>[];
  if (field.isStatic) modifiers.add('static');
  if (variables.isLate) modifiers.add('late');
  final keyword = variables.keyword?.lexeme;
  if (keyword != null && keyword != 'var') modifiers.add(keyword);
  final type = variables.type?.toSource();
  return variables.variables.where((variable) => !variable.name.lexeme.startsWith('_')).map((variable) {
    final initializer = variable.initializer == null ? '' : ' = ${variable.initializer!.toSource()}';
    final pieces = <String>[...modifiers, if (type != null) type, variable.name.lexeme];
    return '${pieces.join(' ')}$initializer';
  }).toList();
}

String topLevelVariableSignature(VariableDeclaration variable, String file) {
  final declaration = variable.parent?.parent;
  final variables = declaration is TopLevelVariableDeclaration ? declaration.variables : null;
  final pieces = <String>[];
  if (variables?.isLate ?? false) pieces.add('late');
  final keyword = variables?.keyword?.lexeme;
  if (keyword != null && keyword != 'var') pieces.add(keyword);
  final type = variables?.type?.toSource();
  if (type != null) pieces.add(type);
  pieces.add(variable.name.lexeme);
  final initializer = variable.initializer == null ? '' : ' = ${variable.initializer!.toSource()}';
  return '${pieces.join(' ')}$initializer';
}

void appendClassMembers(List<String> lines, List<ClassMember> members, String file, {bool addImplicitConstructor = false, String className = ''}) {
  var constructorsSeen = false;
  for (final member in members) {
    if (member is ConstructorDeclaration) {
      final name = member.name?.lexeme;
      if (name != null && name.startsWith('_')) continue;
      constructorsSeen = true;
      lines.add('- ${mdCode(constructorSignature(member, file))}');
      publicMembers++;
    } else if (member is FieldDeclaration) {
      for (final signature in fieldSignatures(member)) {
        lines.add('- ${mdCode(signature)}');
        publicMembers++;
      }
    } else if (member is MethodDeclaration) {
      if (member.name.lexeme.startsWith('_')) continue;
      lines.add('- ${mdCode(signatureBeforeBody(member, member.body, file))}');
      publicMembers++;
    }
  }
  if (addImplicitConstructor && !constructorsSeen && className.isNotEmpty) {
    lines.add('- ${mdCode('$className()')} _(implicit)_');
    publicMembers++;
  }
}

void appendMembersFor(ApiDeclaration api, List<String> lines) {
  final node = api.node;
  if (node is ClassDeclaration) {
    final members = <String>[];
    final hasDeclaredConstructor = node.body.members.any((member) => member is ConstructorDeclaration);
    appendClassMembers(members, node.body.members, api.file,
        addImplicitConstructor: node.abstractKeyword == null && !hasDeclaredConstructor,
        className: node.namePart.typeName.lexeme);
    if (members.isNotEmpty) lines.addAll(<String>['', 'Members:', ...members]);
  } else if (node is MixinDeclaration) {
    final members = <String>[];
    appendClassMembers(members, node.body.members, api.file);
    if (members.isNotEmpty) lines.addAll(<String>['', 'Members:', ...members]);
  } else if (node is EnumDeclaration) {
    final values = node.body.constants.where((constant) => !constant.name.lexeme.startsWith('_')).map((constant) => '- ${mdCode(constant.name.lexeme)}').toList();
    if (values.isNotEmpty) lines.addAll(<String>['', 'Values:', ...values]);
    final members = <String>[];
    appendClassMembers(members, node.body.members, api.file);
    if (members.isNotEmpty) lines.addAll(<String>['', 'Members:', ...members]);
  } else if (node is ExtensionDeclaration) {
    final members = <String>[];
    appendClassMembers(members, node.body.members, api.file);
    if (members.isNotEmpty) lines.addAll(<String>['', 'Members:', ...members]);
  } else if (node is ExtensionTypeDeclaration) {
    final members = <String>[];
    appendClassMembers(members, node.body.members, api.file);
    if (members.isNotEmpty) lines.addAll(<String>['', 'Members:', ...members]);
  }
}

List<String> renderDeclaration(ApiDeclaration declaration) {
  final node = declaration.node;
  final lines = <String>['### ${mdCode(declaration.name)}', ''];
  if (node is ClassDeclaration) {
    lines.add('**Class** ${mdCode(classHeader(node, bodyBracketOffset(node.body), declaration.file))}');
  } else if (node is MixinDeclaration) {
    lines.add('**Mixin** ${mdCode(classHeader(node, bodyBracketOffset(node.body), declaration.file))}');
  } else if (node is EnumDeclaration) {
    lines.add('**Enum** ${mdCode(classHeader(node, bodyBracketOffset(node.body), declaration.file))}');
  } else if (node is ExtensionDeclaration) {
    lines.add('**Extension** ${mdCode(classHeader(node, bodyBracketOffset(node.body), declaration.file))}');
  } else if (node is ExtensionTypeDeclaration) {
    lines.add('**Extension type** ${mdCode(classHeader(node, bodyBracketOffset(node.body), declaration.file))}');
  } else if (node is FunctionDeclaration) {
    lines.add('**${declaration.kind}** ${mdCode(signatureBeforeBody(node, node.functionExpression.body, declaration.file))}');
  } else if (node is TypeAlias) {
    lines.add('**Typedef** ${mdCode(scrub(sourceFor(declaration.file).substring(signatureStart(node), node.end)))}');
  } else if (node is VariableDeclaration) {
    lines.add('**Top-level variable** ${mdCode(topLevelVariableSignature(node, declaration.file))}');
  }
  appendMembersFor(declaration, lines);
  final sourcePath = declaration.file.replaceFirst('${Directory.current.path}/', '');
  lines.addAll(<String>['', 'Source: [$sourcePath](../$sourcePath#L${declaration.line})']);
  publicSymbols++;
  return lines;
}

String sha256(File file) {
  return crypto.sha256.convert(file.readAsBytesSync()).toString();
}

void main() {
  if (!Directory.current.path.endsWith('/sdk')) {
    stderr.writeln('Run this command from the sdk/ directory so the existing .dart_tool package config is used.');
    exitCode = 2;
    return;
  }
  loadPackageConfig();
  final inventory = jsonDecode(inventoryFile.readAsStringSync()) as Map<String, dynamic>;
  final dartPackages = inventory['dart'] as List<dynamic>;
  final markerFiles = <String, String>{};
  final packageSections = <String>[];

  for (final packageValue in dartPackages) {
    final package = packageValue as Map<String, dynamic>;
    final packageName = package['name'] as String;
    final manifest = package['manifest'] as String;
    final manifestFile = File('${Directory.current.path}/$manifest');
    if (manifestFile.existsSync()) markerFiles[manifest] = sha256(manifestFile);
    final librarySections = <String>[];
    for (final libraryValue in package['libraries'] as List<dynamic>) {
      final library = libraryValue as Map<String, dynamic>;
      final entry = library['entry'] as String;
      final entryFile = File('${Directory.current.path}/$entry').absolute.path;
      final entrypoint = exportedDeclarations(entryFile);
      final allFiles = (library['exports'] as List<dynamic>)
          .whereType<Map<String, dynamic>>()
          .where((row) => row.containsKey('file'));
      for (final row in allFiles) {
        final sourcePath = row['file'] as String;
        final file = File('${Directory.current.path}/$sourcePath');
        if (file.existsSync()) markerFiles[sourcePath] = sha256(file);
      }
      final declarations = entrypoint.values.toList()..sort((a, b) => a.name.compareTo(b.name));
      final rows = <String>[
        '### Import ${mdCode('package:$packageName/${entry.substring(entry.indexOf('/lib/') + 5)}')}',
        '',
        'Entry: [${entry}](../${entry})',
        '',
      ];
      if (declarations.isEmpty) {
        rows.add('_No public declarations._');
      } else {
        for (final declaration in declarations) {
          rows.addAll(renderDeclaration(declaration));
          rows.add('');
        }
      }
      librarySections.add(rows.join('\n').trimRight());
    }
    packageSections.add(<String>['## `$packageName`', '', ...librarySections].join('\n'));
  }

  final markers = markerFiles.entries.toList()..sort((a, b) => a.key.compareTo(b.key));
  final content = <String>[
    '# Dart API signatures',
    '',
    '> Generated by `../.fvm/flutter_sdk/bin/dart run scripts/generate_api_signatures.dart` from `API_SURFACE.json` library entrances and the SDK package graph, using the Dart analyzer AST. Change public declarations/exports and regenerate; do not hand-edit this catalog.',
    '',
    'This catalog lists declarations importable from each package library after applying recursive relative and cross-package exports and every `show`/`hide` combinator. It includes function/type signatures, visible defaults, class constructors (including implicit public default constructors), declared fields, getters/setters, methods, enum values and extension members. Underscore-prefixed declarations and members are omitted. Inherited members are listed in the source package that declares them; Flutter or Dart SDK inherited members are not duplicated here. Runtime behavior, error meaning, permissions, capability setup, and platform support remain in [FLUTTER_API.md](FLUTTER_API.md), [HYBRID_HOST_API.md](HYBRID_HOST_API.md), and the specialized references linked from [API.md](API.md).',
    '',
    'Source-first reuse note: outside the retained parent `pocket_host/`, this work checked `README.md`, `docs/02_ARCHITECTURE_AND_MEMORY_DESIGN.md`, `docs/03_DUAL_HOST_UI_COMPONENTS_SPEC.md`, `docs/04_DEVELOPER_GUIDE_AND_VERIFICATION.md`, and `docs/04_BIDIRECTIONAL_FFI_WASM_AND_YOOASSET_HOTUPDATE.md` in `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`. These preserve the earlier Flutter/WeChat host split, component-to-host projections, and run/regression scenarios. The necessary adaptation is to use only current SDK library exports and apply every Dart `show`/`hide`, keeping app UI policy and composition in JS and Dart at the rendering/input/lifecycle/native boundary. Validation checks the biometrics and root SDK facade filters, default parameter signatures, and current source SHA markers.',
    '',
    'Coverage: $publicSymbols public declarations and $publicMembers declared members across ${dartPackages.fold<int>(0, (sum, value) => sum + ((value as Map<String, dynamic>)['libraries'] as List<dynamic>).length)} library entrances; ${markers.length} inventoried source digests.',
    '',
    '## Packages and imports',
    '',
    ...packageSections,
    '',
    '## Source digests',
    '',
    'Every API_SURFACE source file and Dart package manifest is marked, including files that only re-export declarations. Markers are refreshed from the current source bytes.',
    '',
    ...markers.map((entry) => '<!-- api-source: ${entry.key} ${entry.value} -->'),
    '',
  ].join('\n');
  final output = File('${Directory.current.path}/docs/DART_API_SIGNATURES.md');
  output.writeAsStringSync(content);
  stdout.writeln('Wrote ${output.path}: $publicSymbols symbols, $publicMembers members, ${markers.length} source markers.');
  if (unresolvedExports.isNotEmpty) {
    stderr.writeln('Unresolved export URIs: ${unresolvedExports.join('; ')}');
  }
}

