import * as vscode from 'vscode';

export class NspecSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'nspec.welcomeView';

  constructor(private readonly openPanel: () => void) {}

  private launchInFlight = false;
  private lastLaunchAt = 0;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableCommandUris: true,
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.launchPanel();
      }
    });

    if (webviewView.visible) {
      void this.launchPanel();
    }
  }

  private async launchPanel(): Promise<void> {
    const now = Date.now();
    if (this.launchInFlight || now - this.lastLaunchAt < 250) {
      return;
    }

    this.launchInFlight = true;
    this.lastLaunchAt = now;
    try {
      this.openPanel();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
    } finally {
      this.launchInFlight = false;
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      margin: 0;
      padding: 16px;
    }

    .card {
      border: 1px solid var(--vscode-sideBar-border, var(--vscode-panel-border));
      border-radius: 10px;
      padding: 12px;
      background: var(--vscode-editorWidget-background);
    }

    h1 {
      font-size: 13px;
      margin: 0 0 8px;
    }

    p {
      font-size: 12px;
      line-height: 1.5;
      margin: 0 0 10px;
      color: var(--vscode-descriptionForeground);
    }

    a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-size: 12px;
    }

    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Opening nSpec</h1>
    <p>The sidebar launches the main nSpec panel directly.</p>
    <a href="#" onclick="return false;">Opening the panel...</a>
  </div>
</body>
</html>`;
  }
}
