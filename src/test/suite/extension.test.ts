/**
 * Extension integration tests.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('nSpec Extension', () => {
  test('Extension should be present', () => {
    const ext = vscode.extensions.getExtension('nspec.nSpec');
    assert.ok(ext, 'nSpec extension should be loaded');
  });

  test('nSpec commands should be registered', async () => {
    const commands = await vscode.commands.getCommands();
    const specCommands = commands.filter((c) => c.startsWith('nspec.'));
    assert.ok(specCommands.length >= 5, 'Expected at least 5 nSpec commands');
    assert.ok(specCommands.includes('nspec.open'), 'nspec.open should be registered');
  });
});
