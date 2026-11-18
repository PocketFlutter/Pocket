#!/usr/bin/env node
// Regenerate the public TypeScript/JavaScript signature catalog from package exports.
// Uses the repository-pinned TypeScript compiler; this script adds no runtime dependency.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(sdkRoot, '..');
const surface = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'docs/API_SURFACE.json'), 'utf8'));
const tsPath = path.join(sdkRoot, '.cache/pocketjs/node_modules/typescript/lib/typescript.js');
if (!fs.existsSync(tsPath)) throw new Error(`Pinned TypeScript compiler not found: ${tsPath}`);
const tsModule = await import(pathToFileURL(tsPath));
const ts = tsModule.default ?? tsModule;

function relSdk(file) { return path.relative(sdkRoot, file).split(path.sep).join('/'); }
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function escapeMd(value) { return String(value).replaceAll('|', '\\|').replaceAll('\n', ' '); }
function code(value) {
  const text = String(value);
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const padding = /^[`\s]|[`\s]$/.test(text) ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}
function isPrivateName(name) { return name.startsWith('_') || name.startsWith('#'); }
function hasModifier(node, kind) { return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false; }
function sourceText(node) { return node.getText(node.getSourceFile()).replaceAll('\n', ' ').replaceAll(/\s+/g, ' ').trim(); }

const exportEntries = [];
const tsPaths = {};
for (const item of surface.javascript) {
  const manifestFile = path.join(sdkRoot, item.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const exports = manifest.exports ?? {};
  for (const [subpath, targetValue] of Object.entries(exports)) {
    const target = resolveExportTarget(targetValue);
    if (!target) throw new Error(`No source target found for ${manifest.name} ${subpath}`);
    const targetFile = path.resolve(path.dirname(manifestFile), target);
    if (!fs.existsSync(targetFile)) throw new Error(`Missing export target ${relSdk(targetFile)}`);
    const importName = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.replace(/^\.\//, '')}`;
    exportEntries.push({ packageName: manifest.name, subpath, importName, file: targetFile });
    tsPaths[importName] = [relSdk(targetFile)];
  }
}
function resolveExportTarget(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  for (const condition of ['types', 'import', 'node', 'browser', 'default']) {
    if (Object.hasOwn(value, condition)) {
      const found = resolveExportTarget(value[condition]);
      if (found) return found;
    }
  }
  for (const child of Object.values(value)) {
    const found = resolveExportTarget(child);
    if (found) return found;
  }
  return undefined;
}

const rootNames = [...new Set(exportEntries.map((entry) => entry.file))];
const options = {
  allowJs: true,
  checkJs: true,
  allowImportingTsExtensions: true,
  baseUrl: sdkRoot,
  paths: tsPaths,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.Preserve,
  noEmit: true,
  skipLibCheck: true,
  strict: false,
  types: [],
};
const program = ts.createProgram(rootNames, options);
const checker = program.getTypeChecker();
const diagnostics = program.getSyntacticDiagnostics().filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
if (diagnostics.length) {
  const message = diagnostics.slice(0, 12).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')).join('\n');
  throw new Error(`TypeScript signature extraction has syntax errors:\n${message}`);
}

const markers = new Map();
for (const item of surface.javascript) {
  const manifestPath = path.join(sdkRoot, item.manifest);
  markers.set(item.manifest, sha256(manifestPath));
  for (const source of item.sourceDeclarations ?? []) {
    const file = path.join(sdkRoot, source.file);
    markers.set(source.file, sha256(file));
  }
}
// Export targets are guaranteed to carry a marker even if an older inventory omitted a leaf.
for (const entry of exportEntries) {
  const relative = relSdk(entry.file);
  markers.set(relative, sha256(entry.file));
}

const sections = [];
let symbolCount = 0;
let exportNameCount = 0;
let memberCount = 0;
const signatureAnchors = new Map();

function portableTypeImports(signature) {
  return signature.replace(/import\("([^"]+)"\)\.([\w$]+)/g, (match, importPath, name) => {
    if (!path.isAbsolute(importPath)) return match;
    const relative = path.relative(repoRoot, importPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return match;
    const target = path.normalize(importPath).replace(/\.[cm]?[jt]sx?$/, '');
    const entry = exportEntries.find(({ file }) => file.replace(/\.[cm]?[jt]sx?$/, '') === target);
    const source = entry && program.getSourceFile(entry.file);
    const symbol = source && checker.getSymbolAtLocation(source);
    const exported = symbol && checker.getExportsOfModule(symbol).some((item) => item.getName() === name);
    const portablePath = exported ? entry.importName : `./${relative.split(path.sep).join('/')}`;
    return `import("${portablePath}").${name}`;
  });
}

function typeString(type, location) {
  return portableTypeImports(checker.typeToString(type, location, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope));
}
function symbolName(symbol) { return symbol.getName(); }
function actualSymbol(symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}
function declarations(symbol, kind) {
  return (symbol.getDeclarations() ?? []).filter((declaration) => kind === undefined || declaration.kind === kind);
}
function modifiers(node) {
  return node.modifiers?.filter((modifier) => modifier.kind !== ts.SyntaxKind.Decorator).map((modifier) => modifier.getText()).join(' ') ?? '';
}
function genericText(node) {
  return node.typeParameters?.length ? `<${node.typeParameters.map((parameter) => sourceText(parameter)).join(', ')}>` : '';
}
function parameterText(parameter) {
  const name = sourceText(parameter.name);
  const rest = parameter.dotDotDotToken ? '...' : '';
  const optional = parameter.questionToken && !parameter.initializer ? '?' : '';
  const inferredType = checker.getTypeAtLocation(parameter);
  const type = parameter.type ? sourceText(parameter.type) : typeString(inferredType, parameter);
  const initializer = parameter.initializer ? ` = ${sourceText(parameter.initializer)}` : '';
  return `${rest}${name}${optional}: ${type}${initializer}`;
}
function signatureText(node, name = node.name ? sourceText(node.name) : '') {
  const typeParams = genericText(node);
  const parameters = node.parameters?.map(parameterText).join(', ') ?? '';
  const signature = checker.getSignatureFromDeclaration(node);
  const returnType = node.type ? sourceText(node.type) : signature ? typeString(checker.getReturnTypeOfSignature(signature), node) : 'unknown';
  return `${name}${typeParams}(${parameters}): ${returnType}`;
}
function overloads(symbol, kinds) {
  const entries = [];
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (kinds && !kinds.includes(declaration.kind)) continue;
    if (!declaration.parameters) continue;
    entries.push(signatureText(declaration, declaration.name ? sourceText(declaration.name) : symbolName(symbol)));
  }
  return [...new Set(entries)];
}
function shouldSkipDeclaration(node) {
  return hasModifier(node, ts.SyntaxKind.PrivateKeyword) || hasModifier(node, ts.SyntaxKind.ProtectedKeyword) ||
    (node.name && isPrivateName(node.name.getText(node.getSourceFile()).replaceAll(/^['"]|['"]$/g, '')));
}
function memberLines(type, location, staticSide = false) {
  const rows = [];
  const properties = checker.getPropertiesOfType(type);
  for (const property of properties) {
    const name = symbolName(property);
    if (isPrivateName(name)) continue;
    if (staticSide && ['length', 'name', 'prototype', 'arguments', 'caller'].includes(name)) continue;
    const declarationsForProperty = property.getDeclarations() ?? [];
    const visible = declarationsForProperty.filter((node) => !shouldSkipDeclaration(node));
    if (!visible.length) continue;
    const accessors = visible.filter((node) => node.kind === ts.SyntaxKind.GetAccessor || node.kind === ts.SyntaxKind.SetAccessor);
    const methods = visible.filter((node) => node.kind === ts.SyntaxKind.MethodDeclaration || node.kind === ts.SyntaxKind.MethodSignature);
    const ordinary = visible.filter((node) => !accessors.includes(node) && !methods.includes(node));
    if (accessors.length) {
      const getter = accessors.find((node) => node.kind === ts.SyntaxKind.GetAccessor);
      const setter = accessors.find((node) => node.kind === ts.SyntaxKind.SetAccessor);
      if (getter) rows.push(`- ${code(`get ${name}(): ${getter.type ? sourceText(getter.type) : typeString(checker.getTypeOfSymbolAtLocation(property, getter), getter)}`)}`);
      if (setter) rows.push(`- ${code(`set ${name}(${setter.parameters.map(parameterText).join(', ')}): void`)}`);
      continue;
    }
    if (methods.length) {
      for (const method of overloads(property, [ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.MethodSignature])) {
        rows.push(`- ${code(method)}`);
      }
      continue;
    }
    const memberType = checker.getTypeOfSymbolAtLocation(property, visible[0] ?? location);
    const optional = property.flags & ts.SymbolFlags.Optional ? '?' : '';
    const readonly = visible.some((node) => hasModifier(node, ts.SyntaxKind.ReadonlyKeyword)) ? 'readonly ' : '';
    const staticText = staticSide ? 'static ' : '';
    rows.push(`- ${code(`${staticText}${readonly}${name}${optional}: ${typeString(memberType, location)}`)}`);
  }
  if (!staticSide) {
    for (const constructor of (location.members ?? []).filter((node) => node.kind === ts.SyntaxKind.Constructor && !shouldSkipDeclaration(node))) {
      rows.push(`- ${code(`constructor(${constructor.parameters.map(parameterText).join(', ')})`)}`);
    }
    // Public parameter properties are fields as well as constructor parameters.
    for (const constructor of (location.members ?? []).filter((node) => node.kind === ts.SyntaxKind.Constructor)) {
      for (const parameter of constructor.parameters) {
        const isProperty = parameter.modifiers?.some((modifier) => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.OverrideKeyword].includes(modifier.kind));
        if (!isProperty || isPrivateName(parameter.name.getText())) continue;
        const name = parameter.name.getText();
        if (!rows.some((row) => row.includes(` ${name}:`))) rows.push(`- ${code(`${name}${parameter.questionToken ? '?' : ''}: ${parameter.type ? sourceText(parameter.type) : 'unknown'}`)}`);
      }
    }
  }
  return [...new Set(rows)].sort((a, b) => a.localeCompare(b));
}
function signatureKey(exportedSymbol, fallbackImport) {
  const target = actualSymbol(exportedSymbol);
  const declaration = (target.getDeclarations() ?? []).find((node) => !shouldSkipDeclaration(node));
  return declaration
    ? `${relSdk(declaration.getSourceFile().fileName)}:${declaration.getStart()}:${symbolName(target)}`
    : `${fallbackImport}:${symbolName(exportedSymbol)}`;
}
function signatureId(key) { return createHash('sha256').update(key).digest('hex').slice(0, 16); }
function renderPublicSymbol(exportedSymbol, sourceFile, id) {
  const visibleName = symbolName(exportedSymbol);
  const target = actualSymbol(exportedSymbol);
  if (isPrivateName(visibleName) || isPrivateName(symbolName(target))) return [];
  const targetDeclarations = target.getDeclarations() ?? [];
  // Checker-resolved public declarations can originate in a JS re-export or
  // alias target. Fingerprint the actual source as well as inventory entries.
  for (const node of targetDeclarations) {
    const file = node.getSourceFile().fileName;
    const relative = relSdk(file);
    if (relative.startsWith('packages/') && !relative.split('/').includes('node_modules')) {
      markers.set(relative, sha256(file));
    }
  }
  const declaration = targetDeclarations.find((node) => !shouldSkipDeclaration(node)) ?? targetDeclarations[0];
  const exportAlias = visibleName !== symbolName(target) ? ` (re-export alias of ${code(symbolName(target))})` : '';
  const result = [`<a id="api-sig-${id}"></a>`, `### ${code(visibleName)}${exportAlias}`];
  const flags = target.flags;
  if (flags & ts.SymbolFlags.Class) {
    const classDeclaration = targetDeclarations.find((node) => node.kind === ts.SyntaxKind.ClassDeclaration || node.kind === ts.SyntaxKind.ClassExpression);
    const classType = checker.getDeclaredTypeOfSymbol(target);
    const typeText = classDeclaration ? `${classDeclaration.typeParameters?.length ? genericText(classDeclaration) : ''}` : '';
    result.push('', `**Class** ${code(`${visibleName}${typeText}`)}`);
    if (classDeclaration) {
      const members = memberLines(classType, classDeclaration);
      const staticType = checker.getTypeOfSymbolAtLocation(target, classDeclaration);
      const staticMembers = memberLines(staticType, classDeclaration, true).filter((line) => !line.includes('constructor('));
      if (members.length || staticMembers.length) {
        result.push('', 'Members:');
        result.push(...members, ...staticMembers);
        memberCount += members.length + staticMembers.length;
      }
    }
  } else if (flags & ts.SymbolFlags.Interface) {
    const interfaceDeclaration = targetDeclarations.find((node) => node.kind === ts.SyntaxKind.InterfaceDeclaration);
    const type = checker.getDeclaredTypeOfSymbol(target);
    result.push('', `**Interface** ${code(`${visibleName}${interfaceDeclaration ? genericText(interfaceDeclaration) : ''}`)}`);
    const members = memberLines(type, interfaceDeclaration ?? declaration);
    if (members.length) { result.push('', 'Members:', ...members); memberCount += members.length; }
  } else if (flags & ts.SymbolFlags.TypeAlias) {
    const aliasDeclaration = targetDeclarations.find((node) => node.kind === ts.SyntaxKind.TypeAliasDeclaration);
    const type = checker.getDeclaredTypeOfSymbol(target);
    result.push('', `**Type** ${code(`${visibleName}${aliasDeclaration ? genericText(aliasDeclaration) : ''} = ${aliasDeclaration?.type ? sourceText(aliasDeclaration.type) : typeString(type, declaration)}`)}`);
    const members = memberLines(type, aliasDeclaration ?? declaration);
    if (members.length && (aliasDeclaration?.type?.kind === ts.SyntaxKind.TypeLiteral || aliasDeclaration?.type?.kind === ts.SyntaxKind.IntersectionType)) {
      result.push('', 'Members:', ...members); memberCount += members.length;
    }
  } else if (flags & ts.SymbolFlags.Function) {
    const functionSignatures = overloads(target, [ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.MethodDeclaration]);
    const signatureList = functionSignatures.length ? functionSignatures : [typeString(checker.getTypeOfSymbolAtLocation(target, declaration), declaration)];
    result.push('', `**Function** ${signatureList.map((signature) => code(signature)).join(' · ')}`);
  } else if (flags & ts.SymbolFlags.Enum) {
    const enumDeclaration = targetDeclarations.find((node) => node.kind === ts.SyntaxKind.EnumDeclaration);
    result.push('', `**Enum** ${code(visibleName)}`);
    if (enumDeclaration) {
      const values = enumDeclaration.members.filter((member) => !isPrivateName(member.name.getText())).map((member) => `- ${code(sourceText(member))}`);
      if (values.length) result.push('', 'Values:', ...values);
    }
  } else if (flags & ts.SymbolFlags.Variable || flags & ts.SymbolFlags.Property) {
    const valueType = checker.getTypeOfSymbolAtLocation(target, declaration);
    const callSignatures = checker.getSignaturesOfType(valueType, ts.SignatureKind.Call);
    if (callSignatures.length) {
      const variableFunction = declaration?.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
        ? [signatureText(declaration.initializer, visibleName)]
        : callSignatures.map((signature) => portableTypeImports(checker.signatureToString(signature, declaration, ts.TypeFormatFlags.NoTruncation)));
      result.push('', `**Function value** ${variableFunction.map((signature) => code(signature)).join(' · ')}`);
    } else {
      result.push('', `**Value** ${code(`${visibleName}: ${declaration?.type ? sourceText(declaration.type) : typeString(valueType, declaration)}`)}`);
    }
  } else if (flags & ts.SymbolFlags.NamespaceModule) {
    result.push('', '**Namespace**');
  } else {
    const type = checker.getTypeOfSymbolAtLocation(target, declaration ?? sourceFile);
    result.push('', `**Export** ${code(`${visibleName}: ${typeString(type, declaration ?? sourceFile)}`)}`);
  }
  if (declaration) {
    const source = relSdk(declaration.getSourceFile().fileName);
    const line = declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
    result.push('', `Source: [${source}](../${source}#L${line})`);
  }
  symbolCount += 1;
  return result;
}

for (const packageName of [...new Set(exportEntries.map((entry) => entry.packageName))].sort()) {
  const entries = exportEntries.filter((entry) => entry.packageName === packageName).sort((a, b) => a.subpath.localeCompare(b.subpath));
  const packageSections = [`## ${packageName}`];
  for (const entry of entries) {
    const source = program.getSourceFile(entry.file);
    if (!source) throw new Error(`TypeScript program omitted export source: ${relSdk(entry.file)}`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`Cannot resolve module exports for ${entry.importName} (${relSdk(entry.file)})`);
    const exports = checker.getExportsOfModule(moduleSymbol).filter((symbol) => !isPrivateName(symbolName(symbol)));
    packageSections.push('', `### Import ${code(entry.importName)}`, '', `Entry: [${relSdk(entry.file)}](../${relSdk(entry.file)})`, '');
    if (exports.length === 0) packageSections.push('_No named exports._');
    const exportIndex = [];
    const definitionBlocks = [];
    for (const exported of exports.sort((a, b) => symbolName(a).localeCompare(symbolName(b)))) {
      const visibleName = symbolName(exported);
      const target = actualSymbol(exported);
      const key = signatureKey(exported, entry.importName);
      const id = signatureAnchors.get(key) ?? signatureId(key);
      exportNameCount += 1;
      const alias = visibleName !== symbolName(target) ? ` → ${code(symbolName(target))}` : '';
      exportIndex.push(`- ${code(visibleName)}${alias} — [signature](#api-sig-${id})`);
      if (!signatureAnchors.has(key)) {
        signatureAnchors.set(key, id);
        definitionBlocks.push(...renderPublicSymbol(exported, source, id), '');
      }
    }
    packageSections.push('Exports:', ...exportIndex, '', 'Signatures:', ...definitionBlocks);
  }
  sections.push(packageSections.join('\n').trimEnd());
}

const markerBlock = [...markers.entries()].sort(([a], [b]) => a.localeCompare(b))
  .map(([file, digest]) => `<!-- api-source: ${file} ${digest} -->`).join('\n');
const content = [
  '# JavaScript / TypeScript API signatures',
  '',
  '> Generated by `node sdk/scripts/generate_api_signatures.mjs` from the current package `exports` maps using the pinned TypeScript compiler. Edit source declarations and exports, then regenerate; do not hand-edit this catalog.',
  '',
  'Each import path lists every directly exported name and alias, linking to one shared signature definition per underlying source declaration. It includes visible function and type parameters, defaults, class/interface properties, getters/setters, and methods; underscore and ECMAScript private names are omitted. Runtime behavior, errors, permissions, platform support, and interaction guarantees remain documented in [JS_API.md](JS_API.md) and the specialized references linked there.',
  '',
  'Source-first reuse note: outside the retained parent `pocket_host/`, this work checked `README.md`, `docs/02_ARCHITECTURE_AND_MEMORY_DESIGN.md`, `docs/03_DUAL_HOST_UI_COMPONENTS_SPEC.md`, `docs/04_DEVELOPER_GUIDE_AND_VERIFICATION.md`, and `docs/04_BIDIRECTIONAL_FFI_WASM_AND_YOOASSET_HOTUPDATE.md` in `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`. These preserve the earlier Flutter/WeChat host split, component-to-host projection notes, and run/regression scenarios. Their historical 38-component and QuickJS/WeChat-specific claims are not treated as this SDK API; the necessary adaptation is to enumerate current package exports, with UI policy and composition owned by JS. Validation uses TypeScript parser/checker exports, default-value examples, and source SHA markers.',
  '',
  `Coverage: ${exportNameCount} importable export names, ${symbolCount} shared signature definitions, and ${memberCount} listed members across ${exportEntries.length} direct import paths. Source digests cover ${markers.size} inventoried files.`,
  '',
  '## Packages and imports',
  '',
  ...sections,
  '',
  '## Source digests',
  '',
  'The following markers cover all inventoried declaration sources and package manifests; they must remain complete and match each corresponding file SHA-256. Re-export-only files are included even when they own no declarations.',
  '',
  markerBlock,
  '',
].join('\n');

const output = path.join(sdkRoot, 'docs/JS_API_SIGNATURES.md');
fs.writeFileSync(output, content);
console.log(`Wrote ${relSdk(output)}: ${exportNameCount} export names, ${symbolCount} shared signatures, ${memberCount} members, ${exportEntries.length} import paths, ${markers.size} source markers.`);
