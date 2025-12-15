import * as vscode from 'vscode';
import * as path from 'path';
import type { AnalysisResult } from './repomap-types';
import { computeDerived, type RepomapState } from './repomap-state';
import { generateReportJson } from './repomap-runner';
import { RepomapTreeDataProvider } from './repomap-tree';
import { RepomapCodeLensProvider } from './repomap-codelens';
import { buildDiagnostics } from './repomap-diagnostics';
import { getWebviewHtml } from './repomap-webview';

type RepoMapSettings = {
  npxSpecifier: string;
  port: number;
  outputDir: string;
  jsonOutputDir: string;
};

function getSettings(): RepoMapSettings {
  const cfg = vscode.workspace.getConfiguration('repomap');
  return {
    npxSpecifier: cfg.get<string>('npxSpecifier', '@wtdlee/repomap'),
    port: cfg.get<number>('port', 3030),
    outputDir: cfg.get<string>('outputDir', '.repomap'),
    jsonOutputDir: cfg.get<string>('jsonOutputDir', '.repomap'),
  };
}

function getWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder is open.');
  }
  return folder.uri.fsPath;
}

function ensureTerminal(name: string): vscode.Terminal {
  const existing = vscode.window.terminals.find((t) => t.name === name);
  if (existing) return existing;
  return vscode.window.createTerminal({ name });
}

async function runInTerminal(args: { name: string; cwd: string; command: string }): Promise<void> {
  const terminal = ensureTerminal(args.name);
  terminal.show(true);

  // Use a portable "cd" prefix so the command runs in the right folder.
  // VS Code terminals don't reliably support setting cwd after creation.
  const quotedCwd = args.cwd.includes(' ') ? `"${args.cwd}"` : args.cwd;
  terminal.sendText(`cd ${quotedCwd} && ${args.command}`);
}

function resolveWorkspacePath(workspaceRoot: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  // Also support Windows-like absolute paths in report.json.
  if (/^[A-Za-z]:[\\/]/.test(filePath)) return filePath;
  return path.join(workspaceRoot, filePath);
}

async function openFile(
  workspaceRoot: string,
  args: { filePath: string; line?: number }
): Promise<void> {
  const abs = resolveWorkspacePath(workspaceRoot, args.filePath);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (typeof args.line === 'number' && args.line > 0) {
    const pos = new vscode.Position(args.line - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = 'Repomap: Idle';
  status.command = 'repomap.open';
  status.show();
  context.subscriptions.push(status);

  const diagnostics = vscode.languages.createDiagnosticCollection('repomap');
  context.subscriptions.push(diagnostics);

  let state: RepomapState = { report: null, derived: computeDerived(null) };
  const getState = () => state;

  const tree = new RepomapTreeDataProvider();
  const treeView = vscode.window.createTreeView('repomap.explorer', { treeDataProvider: tree });
  const treeViewFallback = vscode.window.createTreeView('repomap.explorer.fallback', { treeDataProvider: tree });
  context.subscriptions.push(treeView, treeViewFallback);

  const codelens = new RepomapCodeLensProvider(getState);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'typescript', scheme: 'file' },
        { language: 'typescriptreact', scheme: 'file' },
        { language: 'javascript', scheme: 'file' },
        { language: 'javascriptreact', scheme: 'file' },
        { language: 'ruby', scheme: 'file' },
      ],
      codelens
    )
  );

  let panel: vscode.WebviewPanel | null = null;

  const setReport = (workspaceRoot: string, report: AnalysisResult | null) => {
    state = { report, derived: computeDerived(report, workspaceRoot) };
    tree.setReport(report);
    codelens.refresh();

    // Diagnostics
    diagnostics.clear();
    const diagsByFile = buildDiagnostics({ workspaceRoot, report });
    for (const [fsPath, diags] of diagsByFile.entries()) {
      diagnostics.set(vscode.Uri.file(fsPath), diags);
    }

    status.text = report ? 'Repomap: Ready' : 'Repomap: Idle';

    if (panel) {
      // Recreate HTML to keep it simple.
      panel.webview.html = getWebviewHtml(panel.webview, { report });
    }
  };

  const ensurePanel = (report: AnalysisResult | null) => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.One);
      return panel;
    }

    panel = vscode.window.createWebviewPanel('repomap', 'Repomap', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => {
      panel = null;
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        const root = getWorkspaceRoot();
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'refresh') {
          await vscode.commands.executeCommand('repomap.refresh');
          return;
        }
        if (msg.type === 'openFile' && typeof msg.filePath === 'string') {
          await openFile(root, { filePath: msg.filePath, line: msg.line });
          return;
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Repomap: ${m}`);
      }
    });

    panel.webview.html = getWebviewHtml(panel.webview, { report });
    return panel;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('repomap.open', async () => {
      try {
        ensurePanel(state.report);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Repomap: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('repomap.refresh', async () => {
      try {
        const root = getWorkspaceRoot();
        const { npxSpecifier, jsonOutputDir } = getSettings();
        status.text = 'Repomap: Analyzing…';
        ensurePanel(state.report);

        const { report } = await generateReportJson({
          workspaceRoot: root,
          npxSpecifier,
          outputDir: jsonOutputDir,
        });

        setReport(root, report);
        vscode.window.showInformationMessage('Repomap: analysis refreshed.');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        status.text = 'Repomap: Error';
        vscode.window.showErrorMessage(`Repomap: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'repomap.openFile',
      async (args: { filePath: string; line?: number }) => {
        try {
          const root = getWorkspaceRoot();
          await openFile(root, args);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          vscode.window.showErrorMessage(`Repomap: ${msg}`);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('repomap.serve', async () => {
      try {
        const root = getWorkspaceRoot();
        const { npxSpecifier, port } = getSettings();

        await runInTerminal({
          name: 'Repomap',
          cwd: root,
          command: `npx ${npxSpecifier} serve --no-open --port ${port}`,
        });

        const open = await vscode.window.showInformationMessage(
          `Repomap server started on http://localhost:${port}`,
          'Open in browser'
        );
        if (open === 'Open in browser') {
          await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Repomap: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('repomap.generate', async () => {
      try {
        const root = getWorkspaceRoot();
        const { npxSpecifier, outputDir } = getSettings();

        await runInTerminal({
          name: 'Repomap',
          cwd: root,
          command: `npx ${npxSpecifier} generate --static --output ${outputDir}`,
        });

        vscode.window.showInformationMessage(
          `Repomap: generation started. Output directory: ${outputDir}`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Repomap: ${msg}`);
      }
    })
  );
}

export function deactivate(): void {
  // noop
}
