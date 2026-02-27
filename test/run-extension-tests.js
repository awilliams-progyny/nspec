#!/usr/bin/env node
/**
 * Run extension tests from CLI.
 * Usage: node test/run-extension-tests.js
 */
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, '../out/test/suite/index.js');
  const workspacePath = path.resolve(extensionDevelopmentPath, 'test-workspace');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath],
    });
  } catch (err) {
    console.error('Extension tests failed:', err);
    process.exit(1);
  }
}

main();