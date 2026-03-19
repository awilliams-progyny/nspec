import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('extension surface simplification', () => {
  it('contributes an activity-bar launcher without quick actions or welcome copy', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')
    ) as {
      contributes?: Record<string, unknown>;
    };
    const contributes = packageJson.contributes ?? {};
    const viewsContainers = contributes.viewsContainers as
      | { activitybar?: Array<{ id?: string }> }
      | undefined;
    const views = contributes.views as Record<string, Array<{ id?: string }>> | undefined;
    const sidebarProvider = fs.readFileSync(
      path.resolve(process.cwd(), 'src/NspecSidebarProvider.ts'),
      'utf-8'
    );

    expect(viewsContainers?.activitybar?.some((entry) => entry.id === 'nspec-sidebar')).toBe(true);
    expect(
      views?.['nspec-sidebar']?.some(
        (entry) =>
          entry.id === 'nspec.welcomeView' && (entry as { type?: string }).type === 'webview'
      )
    ).toBe(true);
    expect(contributes.viewsWelcome).toBeUndefined();
    expect(sidebarProvider).toContain('constructor(private readonly openPanel: () => void)');
    expect(sidebarProvider).toContain('this.openPanel()');
    expect(sidebarProvider).toContain('workbench.action.closeSidebar');
  });

  it('renders verify as a single pane and excludes removed verify workflow actions', () => {
    const panelHtml = fs.readFileSync(path.resolve(process.cwd(), 'media/panel.html'), 'utf-8');
    const panelJs = fs.readFileSync(path.resolve(process.cwd(), 'media/panel.js'), 'utf-8');
    const panelCss = fs.readFileSync(path.resolve(process.cwd(), 'media/panel.css'), 'utf-8');

    expect(panelHtml).toContain('id="verify-single"');
    expect(panelHtml).not.toContain('pre-verify');
    expect(panelHtml).not.toContain('post-verify');

    expect(panelJs).toContain('btn-open-verify');
    expect(panelJs).toContain('btn-refresh-verify');
    expect(panelJs).toContain('btn-copy-verify-jira');
    expect(panelJs).not.toContain('Analyze Gaps');
    expect(panelJs).not.toContain('Copy Gaps & Analysis');
    expect(panelJs).not.toContain('Run Pre-Verify');
    expect(panelJs).not.toContain('Run Post-Verify');
    expect(panelJs).not.toContain('Mark Execution Complete');

    expect(panelCss).toContain('.pill-score.health-good{background:');
    expect(panelCss).toContain('.pill-score.health-fair{background:');
    expect(panelCss).toContain('.pill-score.health-poor{background:');
  });
});
