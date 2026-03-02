#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import module from 'module';
import posixPath from 'path/posix';

const builtin = new Set(module.builtinModules.map((m) => m.replace(/^node:/, '')));
builtin.add('vscode');

function normalizeSpecToPackageName(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null;
  const normalized = spec.replace(/^node:/, '');
  if (builtin.has(normalized) || builtin.has(normalized.split('/')[0])) return null;
  if (normalized.startsWith('@')) {
    const parts = normalized.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : normalized;
  }
  return normalized.split('/')[0];
}

function extractRequires(jsText) {
  const found = new Set();
  const re = /require\((['"])([^'"]+)\1\)/g;
  let m;
  while ((m = re.exec(jsText)) !== null) {
    const pkg = normalizeSpecToPackageName(m[2]);
    if (pkg) found.add(pkg);
  }
  return found;
}

function isLocalRequire(spec) {
  return spec.startsWith('.') || spec.startsWith('/');
}

function resolveLocalFileDir(baseFile, spec) {
  const baseDir = path.dirname(baseFile);
  const target = path.resolve(baseDir, spec);
  const candidates = [target, `${target}.js`, path.join(target, 'index.js')];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function collectRuntimeExternalRequiresFromDir(entryFile) {
  const visited = new Set();
  const queue = [entryFile];
  const external = new Set();

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || visited.has(file) || !fs.existsSync(file)) continue;
    if (!file.endsWith('.js')) continue;
    visited.add(file);

    const text = fs.readFileSync(file, 'utf-8');
    for (const spec of extractRequires(text)) {
      if (isLocalRequire(spec)) {
        const local = resolveLocalFileDir(file, spec);
        if (local) queue.push(local);
      } else {
        const pkg = normalizeSpecToPackageName(spec);
        if (pkg) external.add(pkg);
      }
    }
  }

  return external;
}

function newestVsixInCwd() {
  const files = fs
    .readdirSync(process.cwd())
    .filter((f) => /^nSpec-.*\.vsix$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(process.cwd(), f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f ?? null;
}

function parsePackageJson(jsonText) {
  const pkg = JSON.parse(jsonText);
  const deps = Object.keys(pkg.dependencies || {});
  const optional = Object.keys(pkg.optionalDependencies || {});
  return { pkg, declaredDeps: new Set([...deps, ...optional]) };
}

function analyzeDirectory(targetDir) {
  const pkgPath = path.join(targetDir, 'package.json');
  const outDir = path.join(targetDir, 'out');
  if (!fs.existsSync(pkgPath)) throw new Error(`Missing package.json in ${targetDir}`);
  if (!fs.existsSync(outDir)) throw new Error(`Missing out/ in ${targetDir}`);

  const { declaredDeps } = parsePackageJson(fs.readFileSync(pkgPath, 'utf-8'));

  const mainRel = (JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).main || '').replace(/^\.\//, '');
  const mainAbs = path.join(targetDir, mainRel);
  if (!mainRel || !fs.existsSync(mainAbs)) {
    throw new Error(`Main entrypoint not found: ${mainAbs}`);
  }
  const required = collectRuntimeExternalRequiresFromDir(mainAbs);

  const undeclared = [];
  const missingInstalled = [];
  for (const dep of required) {
    if (!declaredDeps.has(dep)) {
      undeclared.push(dep);
      continue;
    }
    const depPkg = path.join(targetDir, 'node_modules', dep, 'package.json');
    if (!fs.existsSync(depPkg)) missingInstalled.push(dep);
  }

  return {
    kind: 'directory',
    target: targetDir,
    required: Array.from(required).sort(),
    declared: Array.from(declaredDeps).sort(),
    undeclared,
    missingInstalled,
  };
}

function unzipList(vsixPath) {
  const out = execSync(`unzip -Z1 ${JSON.stringify(vsixPath)}`, { encoding: 'utf-8' });
  return out.split(/\r?\n/).filter(Boolean);
}

function unzipRead(vsixPath, innerPath) {
  return execSync(`unzip -p ${JSON.stringify(vsixPath)} ${JSON.stringify(innerPath)}`, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function analyzeVsix(vsixPath) {
  const files = unzipList(vsixPath);
  const prefix = files.some((f) => f.startsWith('extension/')) ? 'extension/' : '';

  const pkgPath = `${prefix}package.json`;
  if (!files.includes(pkgPath)) throw new Error(`Missing ${pkgPath} in VSIX`);

  const pkgText = unzipRead(vsixPath, pkgPath);
  const { pkg, declaredDeps } = parsePackageJson(pkgText);
  const mainRel = String(pkg.main || '').replace(/^\.\//, '');
  const mainPath = `${prefix}${mainRel}`;
  if (!mainRel || !files.includes(mainPath)) {
    throw new Error(`Main entrypoint not found in VSIX: ${mainPath}`);
  }

  const fileSet = new Set(files);
  const jsCache = new Map();
  const visited = new Set();
  const queue = [mainPath];
  const required = new Set();

  function readJs(inner) {
    if (jsCache.has(inner)) return jsCache.get(inner);
    const text = unzipRead(vsixPath, inner);
    jsCache.set(inner, text);
    return text;
  }

  function resolveLocalInner(fromFile, spec) {
    const baseDir = posixPath.dirname(fromFile);
    const raw = posixPath.normalize(posixPath.resolve(baseDir, spec));
    const candidates = [raw, `${raw}.js`, posixPath.join(raw, 'index.js')];
    for (const c of candidates) {
      if (fileSet.has(c)) return c;
    }
    return null;
  }

  while (queue.length > 0) {
    const inner = queue.shift();
    if (!inner || visited.has(inner)) continue;
    if (!inner.endsWith('.js')) continue;
    if (!fileSet.has(inner)) continue;
    visited.add(inner);

    const text = readJs(inner);
    for (const spec of extractRequires(text)) {
      if (isLocalRequire(spec)) {
        const local = resolveLocalInner(inner, spec);
        if (local) queue.push(local);
      } else {
        const pkgName = normalizeSpecToPackageName(spec);
        if (pkgName) required.add(pkgName);
      }
    }
  }

  const undeclared = [];
  const missingPackaged = [];
  for (const dep of required) {
    if (!declaredDeps.has(dep)) {
      undeclared.push(dep);
      continue;
    }
    const depPkg = `${prefix}node_modules/${dep}/package.json`;
    if (!fileSet.has(depPkg)) missingPackaged.push(dep);
  }

  return {
    kind: 'vsix',
    target: vsixPath,
    required: Array.from(required).sort(),
    declared: Array.from(declaredDeps).sort(),
    undeclared,
    missingPackaged,
  };
}

function printReport(report) {
  console.log(`target_kind=${report.kind}`);
  console.log(`target=${report.target}`);
  console.log(`runtime_requires=${report.required.length ? report.required.join(', ') : '(none)'}`);
  console.log(`declared_dependencies=${report.declared.length ? report.declared.join(', ') : '(none)'}`);

  if (report.undeclared.length > 0) {
    console.error(`ERROR undeclared_runtime_dependencies=${report.undeclared.join(', ')}`);
  }

  if (report.kind === 'directory') {
    const missing = report.missingInstalled || [];
    if (missing.length > 0) {
      console.error(`ERROR missing_installed_dependencies=${missing.join(', ')}`);
    }
    const failed = report.undeclared.length > 0 || missing.length > 0;
    console.log(`status=${failed ? 'FAIL' : 'PASS'}`);
    process.exit(failed ? 1 : 0);
  }

  const missing = report.missingPackaged || [];
  if (missing.length > 0) {
    console.error(`ERROR missing_packaged_dependencies=${missing.join(', ')}`);
  }
  const failed = report.undeclared.length > 0 || missing.length > 0;
  console.log(`status=${failed ? 'FAIL' : 'PASS'}`);
  process.exit(failed ? 1 : 0);
}

function main() {
  const arg = process.argv[2];
  const target = arg || newestVsixInCwd() || process.cwd();

  if (!target) {
    console.error('No target provided and no VSIX found in current directory.');
    process.exit(2);
  }

  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    console.error(`Target not found: ${resolved}`);
    process.exit(2);
  }

  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      printReport(analyzeDirectory(resolved));
      return;
    }
    if (resolved.endsWith('.vsix')) {
      printReport(analyzeVsix(resolved));
      return;
    }
    console.error(`Unsupported target type: ${resolved}`);
    process.exit(2);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
