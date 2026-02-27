import * as path from 'path';
import * as fs from 'fs';
import { getWorkspaceRoot } from './workspace';

export interface WorkspaceContext {
  language: string; // 'typescript' | 'python' | 'csharp' | 'java' | 'unknown'
  testFramework: string; // 'jest' | 'vitest' | 'pytest' | 'xunit' | etc
  testDir: string; // relative path, e.g. 'tests/', '__tests__/', 'test/'
  testFileExt: string; // '.test.ts' | '_test.py' | '.spec.ts' | '.Tests.cs'
  existingTestSnippet: string | null; // first 60 lines of an existing test file, for style matching
  hasPackageJson: boolean;
  hasPyProject: boolean;
}

export async function inferWorkspaceContext(): Promise<WorkspaceContext> {
  const root = getWorkspaceRoot();
  const defaults: WorkspaceContext = {
    language: 'unknown',
    testFramework: 'unknown',
    testDir: 'tests/',
    testFileExt: '.test.ts',
    existingTestSnippet: null,
    hasPackageJson: false,
    hasPyProject: false,
  };

  if (!root) return defaults;

  // ── Python ─────────────────────────────────────────────────────────────────
  const pyprojectPath = path.join(root, 'pyproject.toml');
  const requirementsTxtPath = path.join(root, 'requirements.txt');
  const setupPyPath = path.join(root, 'setup.py');
  const isPython =
    fs.existsSync(pyprojectPath) ||
    fs.existsSync(requirementsTxtPath) ||
    fs.existsSync(setupPyPath);

  if (isPython) {
    let framework = 'pytest';
    if (fs.existsSync(pyprojectPath)) {
      const content = fs.readFileSync(pyprojectPath, 'utf-8');
      if (content.includes('unittest')) framework = 'unittest';
    }
    const testDir = fs.existsSync(path.join(root, 'tests'))
      ? 'tests/'
      : fs.existsSync(path.join(root, 'test'))
        ? 'test/'
        : 'tests/';
    return {
      ...defaults,
      language: 'python',
      testFramework: framework,
      testDir,
      testFileExt: '_test.py',
      existingTestSnippet: findExistingTestSnippet(root, ['.py'], ['test_', '_test']),
      hasPyProject: fs.existsSync(pyprojectPath),
    };
  }

  // ── TypeScript / JavaScript ────────────────────────────────────────────────
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    } catch {
      /* ok */
    }

    const devDeps = Object.keys({
      ...((pkg.devDependencies as object) ?? {}),
      ...((pkg.dependencies as object) ?? {}),
    });
    const scripts = JSON.stringify(pkg.scripts ?? {});

    let framework = 'jest';
    if (devDeps.some((d) => d === 'vitest') || scripts.includes('vitest')) framework = 'vitest';
    else if (devDeps.some((d) => d === 'mocha')) framework = 'mocha';

    const isTS = devDeps.some((d) => d === 'typescript' || d.startsWith('@types/'));
    const ext = isTS ? '.test.ts' : '.test.js';
    const specExt = isTS ? '.spec.ts' : '.spec.js';
    const hasSpec = findExistingTestSnippet(root, [specExt], []);
    const actualExt = hasSpec ? specExt : ext;

    const testDir = fs.existsSync(path.join(root, '__tests__'))
      ? '__tests__/'
      : fs.existsSync(path.join(root, 'tests'))
        ? 'tests/'
        : fs.existsSync(path.join(root, 'test'))
          ? 'test/'
          : '__tests__/';

    return {
      ...defaults,
      language: isTS ? 'typescript' : 'javascript',
      testFramework: framework,
      testDir,
      testFileExt: actualExt,
      existingTestSnippet: findExistingTestSnippet(
        root,
        ['.test.ts', '.test.js', '.spec.ts', '.spec.js'],
        []
      ),
      hasPackageJson: true,
    };
  }

  // ── C# ──────────────────────────────────────────────────────────────────────
  const csprojFiles = findFilesGlob(root, '.csproj');
  if (csprojFiles.length > 0) {
    const content = csprojFiles
      .map((f) => {
        try {
          return fs.readFileSync(f, 'utf-8');
        } catch {
          return '';
        }
      })
      .join(' ');
    const framework = content.includes('xunit')
      ? 'xunit'
      : content.includes('nunit')
        ? 'nunit'
        : 'mstest';
    return {
      ...defaults,
      language: 'csharp',
      testFramework: framework,
      testDir: 'Tests/',
      testFileExt: '.Tests.cs',
      existingTestSnippet: findExistingTestSnippet(root, ['.cs'], ['Tests', 'Test', 'Spec']),
    };
  }

  // ── Java ──────────────────────────────────────────────────────────────────
  if (fs.existsSync(path.join(root, 'pom.xml')) || fs.existsSync(path.join(root, 'build.gradle'))) {
    const testDir = fs.existsSync(path.join(root, 'src/test')) ? 'src/test/java/' : 'tests/';
    return {
      ...defaults,
      language: 'java',
      testFramework: 'junit',
      testDir,
      testFileExt: 'Test.java',
      existingTestSnippet: findExistingTestSnippet(root, ['.java'], ['Test', 'Spec']),
    };
  }

  return defaults;
}

function findExistingTestSnippet(
  root: string,
  exts: string[],
  namePrefixes: string[]
): string | null {
  const candidates: string[] = [];
  walkDir(root, candidates, exts, namePrefixes, 0);
  if (candidates.length === 0) return null;
  try {
    const lines = fs.readFileSync(candidates[0], 'utf-8').split('\n').slice(0, 60).join('\n');
    return lines;
  } catch {
    return null;
  }
}

function walkDir(dir: string, out: string[], exts: string[], prefixes: string[], depth: number) {
  if (depth > 4 || out.length >= 1) return;
  const SKIP = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    'coverage',
    '__pycache__',
    '.venv',
    'venv',
  ]);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkDir(full, out, exts, prefixes, depth + 1);
      continue;
    }
    const matchesExt = exts.some((x) => e.name.endsWith(x));
    const matchesPrefix = prefixes.length === 0 || prefixes.some((p) => e.name.includes(p));
    if (matchesExt && matchesPrefix) out.push(full);
  }
}

function findFilesGlob(root: string, ext: string): string[] {
  const results: string[] = [];
  walkDir(root, results, [ext], [], 0);
  return results;
}
