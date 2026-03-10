#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const packageJsonPath = path.join(root, 'package.json');
const readmePath = path.join(root, 'README.md');
const changelogPath = path.join(root, 'CHANGELOG.md');
const readMeDir = path.join(root, 'readMe');

const errors = [];

function exists(p) {
  return fs.existsSync(p);
}

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}

function collectDocFiles() {
  const files = [
    'README.md',
    'AGENTS.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'PARITY.md',
    'examples/customization-playground/README.md',
  ];

  if (exists(readMeDir)) {
    for (const entry of fs.readdirSync(readMeDir)) {
      if (entry.endsWith('.md')) files.push(path.join('readMe', entry));
    }
  }

  return files.filter((f) => exists(path.join(root, f)));
}

function extractLinkTarget(raw) {
  const trimmed = raw.trim().replace(/^<|>$/g, '');
  const noAnchor = trimmed.split('#')[0];
  if (!noAnchor) return '';
  const spaced = noAnchor.match(/^([^\s]+)\s+".*"$/);
  if (spaced) return spaced[1];
  return noAnchor;
}

function isExternal(target) {
  return /^(https?:|mailto:|command:)/i.test(target);
}

function checkLocalLinks(docPath) {
  const abs = path.join(root, docPath);
  const text = readUtf8(abs);
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;

  while ((match = re.exec(text)) !== null) {
    const rawTarget = match[1] ?? '';
    const target = extractLinkTarget(rawTarget);
    if (!target || target.startsWith('#') || isExternal(target)) continue;

    const resolved = path.resolve(path.dirname(abs), target);
    if (!exists(resolved)) {
      errors.push(`${docPath}: broken local link target: ${rawTarget}`);
    }
  }
}

function checkVersionParity() {
  if (!exists(packageJsonPath) || !exists(readmePath) || !exists(changelogPath)) {
    errors.push('Missing package.json, README.md, or CHANGELOG.md for version parity checks.');
    return;
  }

  const pkg = JSON.parse(readUtf8(packageJsonPath));
  const pkgVersion = String(pkg.version ?? '').trim();
  if (!pkgVersion) {
    errors.push('package.json version is missing or empty.');
    return;
  }

  const readme = readUtf8(readmePath);
  const badgeMatch = readme.match(/version-(\d+\.\d+\.\d+)-/);
  if (!badgeMatch) {
    errors.push('README.md version badge not found (expected pattern: version-x.y.z).');
  } else if (badgeMatch[1] !== pkgVersion) {
    errors.push(
      `README.md version badge (${badgeMatch[1]}) does not match package.json (${pkgVersion}).`
    );
  }

  const changelog = readUtf8(changelogPath);
  const topVersionMatch = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  if (!topVersionMatch) {
    errors.push('CHANGELOG.md top version heading not found (expected pattern: ## [x.y.z]).');
  } else if (topVersionMatch[1] !== pkgVersion) {
    errors.push(
      `CHANGELOG.md top version (${topVersionMatch[1]}) does not match package.json (${pkgVersion}).`
    );
  }
}

function checkSectionsDrift(docFiles) {
  const activeDocs = docFiles.filter((f) => f !== 'CHANGELOG.md');
  const allowContext = /(removed|no longer supported|not supported|unsupported|deprecated|legacy)/i;

  for (const docPath of activeDocs) {
    const text = readUtf8(path.join(root, docPath));
    const lines = text.split(/\r?\n/);

    lines.forEach((line, idx) => {
      if (!line.includes('_sections')) return;
      if (!allowContext.test(line)) {
        errors.push(
          `${docPath}:${idx + 1} mentions _sections without explicitly stating it is removed/unsupported.`
        );
      }
    });
  }
}

function main() {
  const docs = collectDocFiles();
  for (const doc of docs) checkLocalLinks(doc);

  checkVersionParity();
  checkSectionsDrift(docs);

  if (errors.length > 0) {
    console.error('docs:check failed');
    for (const err of errors) console.error(` - ${err}`);
    process.exit(1);
  }

  console.log(`docs:check passed (${docs.length} markdown files checked)`);
}

main();
