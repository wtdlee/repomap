import * as vscode from 'vscode';
import type { RepomapState } from './repomap-state';

export class RepomapCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly getState: () => RepomapState) {}

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const state = this.getState();
    const insights = state.derived.insightsByFilePath.get(document.uri.fsPath.replace(/\\/g, '/')) ?? [];

    const lenses: vscode.CodeLens[] = [];

    const topRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));

    lenses.push(
      new vscode.CodeLens(topRange, {
        title: 'Repomap: Open',
        command: 'repomap.open',
      })
    );

    lenses.push(
      new vscode.CodeLens(topRange, {
        title: 'Repomap: Refresh',
        command: 'repomap.refresh',
      })
    );

    for (const i of insights) {
      if (i.kind === 'page') {
        lenses.push(
          new vscode.CodeLens(topRange, {
            title: `Page links: to ${i.linkedTo ?? 0} / from ${i.linkedFrom ?? 0}`,
            command: 'repomap.open',
          })
        );
      }

      if (i.kind === 'component') {
        lenses.push(
          new vscode.CodeLens(topRange, {
            title: `Component: used-by ${i.dependents ?? 0} · deps ${i.dependencies ?? 0}`,
            command: 'repomap.open',
          })
        );
      }

      if (i.kind === 'graphql') {
        lenses.push(
          new vscode.CodeLens(topRange, {
            title: `GraphQL usage: ${(i.usedIn ?? 0).toString()}`,
            command: 'repomap.open',
          })
        );
      }
    }

    return lenses;
  }
}
