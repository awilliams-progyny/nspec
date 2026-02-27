/**
 * Extension test entry. Must export run() for @vscode/test-electron.
 * Run via VS Code "Extension Tests" launch config or: npm run test:extension
 */
import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 60000, color: true });
  const testsRoot = path.resolve(__dirname);

  const files = fs.readdirSync(testsRoot).filter((f) => f.endsWith('.test.js'));
  for (const f of files) {
    mocha.addFile(path.join(testsRoot, f));
  }

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures) {
        reject(new Error(`${failures} test(s) failed`));
      } else {
        resolve();
      }
    });
  });
}
