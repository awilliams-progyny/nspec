/**
 * Extension integration tests.
 */
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('nSpec Extension', () => {
  test('Extension should be present', async () => {
    const ext = vscode.extensions.getExtension('awilliams.nSpec');
    assert.ok(ext, 'nSpec extension should be loaded');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
  });

  test('nSpec commands should be registered', async () => {
    const ext = vscode.extensions.getExtension('awilliams.nSpec');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    const commands = await vscode.commands.getCommands();
    const specCommands = commands.filter((c) => c.startsWith('nspec.'));
    assert.ok(specCommands.length >= 5, 'Expected at least 5 nSpec commands');
    assert.ok(specCommands.includes('nspec.open'), 'nspec.open should be registered');
  });

  test('nSpec contributes an Activity Bar launcher view', async () => {
    const ext = vscode.extensions.getExtension('awilliams.nSpec');
    assert.ok(ext, 'nSpec extension should be loaded');

    const activitybar = ext?.packageJSON?.contributes?.viewsContainers?.activitybar ?? [];
    const views = ext?.packageJSON?.contributes?.views?.['nspec-sidebar'] ?? [];
    const welcome = ext?.packageJSON?.contributes?.viewsWelcome;

    assert.ok(
      activitybar.some((entry: { id?: string }) => entry.id === 'nspec-sidebar'),
      'Expected an nSpec Activity Bar container contribution'
    );
    assert.ok(
      views.some(
        (entry: { id?: string; type?: string }) =>
          entry.id === 'nspec.welcomeView' && entry.type === 'webview'
      ),
      'Expected an nSpec webview launcher contribution'
    );
    assert.strictEqual(welcome, undefined, 'Quick-action welcome content should be removed');
  });
});
