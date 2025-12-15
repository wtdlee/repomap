import * as vscode from 'vscode';

type RepoMapSettings = {
  npxSpecifier: string;
  port: number;
  outputDir: string;
};

function getSettings(): RepoMapSettings {
  const cfg = vscode.workspace.getConfiguration('repomap');
  return {
    npxSpecifier: cfg.get<string>('npxSpecifier', '@wtdlee/repomap'),
    port: cfg.get<number>('port', 3030),
    outputDir: cfg.get<string>('outputDir', '.repomap'),
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
  const quotedCwd = args.cwd.includes(' ') ? `\"${args.cwd}\"` : args.cwd;
  terminal.sendText(`cd ${quotedCwd} && ${args.command}`);
}

export function activate(context: vscode.ExtensionContext): void {
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
