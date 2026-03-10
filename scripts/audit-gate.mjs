#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const root = process.cwd();
const baselinePath = path.join(root, 'security', 'audit-baseline.json');

function isHighOrCritical(severity) {
  const value = String(severity ?? '').toLowerCase();
  return value === 'high' || value === 'critical';
}

function loadBaseline() {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Missing audit baseline file: ${baselinePath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const keys = Array.isArray(parsed.allowedKeys) ? parsed.allowedKeys : [];
  return new Set(keys.map((k) => String(k)));
}

function parseAuditOutput(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('npm audit --json produced empty output.');

  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error('npm audit --json did not produce JSON output.');

  return JSON.parse(trimmed.slice(start));
}

function collectFindings(report) {
  const findings = new Set();

  if (report && typeof report === 'object' && report.vulnerabilities) {
    for (const [pkg, vuln] of Object.entries(report.vulnerabilities)) {
      const pkgSeverity = vuln && typeof vuln === 'object' ? vuln.severity : '';
      const via = vuln && typeof vuln === 'object' && Array.isArray(vuln.via) ? vuln.via : [];
      let added = false;

      for (const item of via) {
        if (typeof item === 'string') {
          if (isHighOrCritical(pkgSeverity)) {
            findings.add(`${pkg}|via:${item}|severity:${String(pkgSeverity).toLowerCase()}`);
            added = true;
          }
          continue;
        }

        if (!item || typeof item !== 'object') continue;

        const severity = isHighOrCritical(item.severity) ? item.severity : pkgSeverity;
        if (!isHighOrCritical(severity)) continue;

        const source = item.source ?? 'none';
        const name = item.name ?? item.dependency ?? 'unknown';
        findings.add(
          `${pkg}|source:${source}|name:${name}|severity:${String(severity).toLowerCase()}`
        );
        added = true;
      }

      if (!added && isHighOrCritical(pkgSeverity)) {
        findings.add(`${pkg}|self|severity:${String(pkgSeverity).toLowerCase()}`);
      }
    }

    return findings;
  }

  if (report && typeof report === 'object' && report.advisories) {
    for (const advisory of Object.values(report.advisories)) {
      if (!advisory || typeof advisory !== 'object') continue;
      if (!isHighOrCritical(advisory.severity)) continue;

      const source = advisory.id ?? 'unknown';
      const moduleName = advisory.module_name ?? 'unknown';
      findings.add(
        `legacy|source:${source}|name:${moduleName}|severity:${String(advisory.severity).toLowerCase()}`
      );
    }
  }

  return findings;
}

function runAudit() {
  const proc = spawnSync('npm', ['audit', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });

  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';
  const merged = `${stdout}\n${stderr}`;
  return parseAuditOutput(merged);
}

function main() {
  const baseline = loadBaseline();
  const report = runAudit();
  const findings = collectFindings(report);

  const unexpected = [...findings].filter((key) => !baseline.has(key)).sort();
  const stale = [...baseline].filter((key) => !findings.has(key)).sort();

  if (unexpected.length > 0) {
    console.error('audit:gate failed - new high/critical vulnerabilities detected:');
    for (const key of unexpected) console.error(` - ${key}`);
    console.error('If intentional, update security/audit-baseline.json.');
    process.exit(1);
  }

  console.log(`audit:gate passed (${findings.size} high/critical finding keys matched baseline)`);
  if (stale.length > 0) {
    console.log('audit:gate note: baseline contains stale keys no longer present:');
    for (const key of stale) console.log(` - ${key}`);
  }
}

main();
