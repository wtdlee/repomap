import * as vscode from 'vscode';
import * as path from 'path';
import type { PageInfo, ComponentInfo, GraphQLOperation } from './repomap-types';
import type { RepomapState } from './repomap-state';

type ContextTreeItem = {
  kind:
    | 'section'
    | 'file'
    | 'page'
    | 'pageLinks'
    | 'component'
    | 'componentDeps'
    | 'componentDents'
    | 'graphql'
    | 'graphqlUsedIn'
    | 'note';
  label: string;
  description?: string;
  open?: { filePath: string; line?: number };
  command?: vscode.Command;
  children?: ContextTreeItem[];
};

function normalizeFsPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function relOrBasename(workspaceRoot: string | undefined, fsPath: string): string {
  if (!workspaceRoot) return path.basename(fsPath);
  const rel = path.relative(workspaceRoot, fsPath);
  return rel && !rel.startsWith('..') ? rel : path.basename(fsPath);
}

export class RepomapContextTreeDataProvider implements vscode.TreeDataProvider<ContextTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    ContextTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private activeFileFsPath: string | null = null;
  private workspaceRoot: string | undefined;

  constructor(private readonly getState: () => RepomapState) {}

  setWorkspaceRoot(workspaceRoot: string | undefined): void {
    this.workspaceRoot = workspaceRoot;
  }

  setActiveFile(fsPath: string | null): void {
    this.activeFileFsPath = fsPath ? normalizeFsPath(fsPath) : null;
    this._onDidChangeTreeData.fire();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ContextTreeItem): vscode.TreeItem {
    const collapsible = element.children
      ? element.kind === 'section'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsible);
    item.description = element.description;

    if (element.command) {
      item.command = element.command;
    } else if (element.open) {
      item.command = {
        command: 'repomap.openFile',
        title: 'Open',
        arguments: [{ filePath: element.open.filePath, line: element.open.line }],
      };
    }
    return item;
  }

  getChildren(element?: ContextTreeItem): Thenable<ContextTreeItem[]> {
    const state = this.getState();
    const report = state.report;
    const active = this.activeFileFsPath;

    if (element?.children) return Promise.resolve(element.children);
    if (element) return Promise.resolve([]);

    if (!report) {
      return Promise.resolve([
        {
          kind: 'note',
          label: 'No report loaded',
          description: 'Run Repomap: Refresh',
        },
      ]);
    }

    if (!active) {
      return Promise.resolve([
        {
          kind: 'note',
          label: 'No active file',
          description: 'Focus an editor tab to see context',
        },
      ]);
    }

    const fileLabel = relOrBasename(this.workspaceRoot, active);
    const pagesInFile = state.derived.pagesByFilePath.get(active) ?? [];
    const compsInFile = state.derived.componentByFilePath.get(active) ?? [];
    const opsInFile = state.derived.graphqlByFilePath.get(active) ?? [];

    return Promise.resolve([
      { kind: 'file', label: fileLabel, description: 'Current file' },
      this.section(
        `Pages in file`,
        pagesInFile.length,
        pagesInFile
          .slice()
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((p) => this.pageItem(state, p))
      ),
      this.section(
        `Components in file`,
        compsInFile.length,
        compsInFile
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => this.componentItem(state, c))
      ),
      this.section(
        `GraphQL in file`,
        opsInFile.length,
        opsInFile
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((o) => this.graphqlItem(o))
      ),
    ]);
  }

  private section(label: string, count: number, children: ContextTreeItem[]): ContextTreeItem {
    if (children.length === 0) {
      return {
        kind: 'section',
        label,
        description: '0',
        children: [{ kind: 'note', label: '—', description: 'No items in this file' }],
      };
    }
    return {
      kind: 'section',
      label,
      description: String(count),
      children,
    };
  }

  private pageItem(state: RepomapState, p: PageInfo): ContextTreeItem {
    const linked = p.linkedPages ?? [];
    const incoming = state.derived.pageIncomingByPath.get(p.path) ?? 0;

    const linkChildren: ContextTreeItem[] = [];
    if (linked.length > 0) {
      linkChildren.push({
        kind: 'pageLinks',
        label: `Linked to`,
        description: String(linked.length),
        children: linked
          .slice()
          .sort((a, b) => a.localeCompare(b))
          .map((dstPath) => {
            const dst = state.derived.pageByPath.get(dstPath);
            return dst
              ? {
                  kind: 'page',
                  label: dst.path,
                  description: dst.filePath,
                  open: { filePath: dst.filePath },
                }
              : { kind: 'note', label: dstPath, description: 'No file mapping' };
          }),
      });
    }

    const page: ContextTreeItem = {
      kind: 'page',
      label: p.path,
      description: `in ${incoming} · out ${linked.length}`,
      open: { filePath: p.filePath },
      children: linkChildren.length ? linkChildren : undefined,
    };
    return page;
  }

  private componentItem(state: RepomapState, c: ComponentInfo): ContextTreeItem {
    const deps = c.dependencies ?? [];
    const dents = c.dependents ?? [];

    const depChildren: ContextTreeItem[] =
      deps.length > 0
        ? [
            {
              kind: 'componentDeps',
              label: 'Dependencies',
              description: String(deps.length),
              children: deps
                .slice()
                .sort((a, b) => a.localeCompare(b))
                .map((name) => this.componentRef(state, name)),
            },
          ]
        : [];

    const dentChildren: ContextTreeItem[] =
      dents.length > 0
        ? [
            {
              kind: 'componentDents',
              label: 'Used by',
              description: String(dents.length),
              children: dents
                .slice()
                .sort((a, b) => a.localeCompare(b))
                .map((name) => this.componentRef(state, name)),
            },
          ]
        : [];

    const children = [...dentChildren, ...depChildren];
    return {
      kind: 'component',
      label: c.name,
      description: `${c.type ?? 'component'} · used-by ${dents.length} · deps ${deps.length}`,
      open: { filePath: c.filePath },
      children: children.length ? children : undefined,
    };
  }

  private componentRef(state: RepomapState, name: string): ContextTreeItem {
    const candidates = state.derived.componentByName.get(name) ?? [];
    if (candidates.length === 1) {
      return {
        kind: 'component',
        label: name,
        description: candidates[0].filePath,
        open: { filePath: candidates[0].filePath },
      };
    }
    if (candidates.length > 1) {
      return {
        kind: 'component',
        label: name,
        description: `${candidates.length} matches`,
        children: candidates
          .slice()
          .sort((a, b) => a.filePath.localeCompare(b.filePath))
          .map((c) => ({
            kind: 'component',
            label: relOrBasename(this.workspaceRoot, normalizeFsPath(c.filePath)),
            description: c.filePath,
            open: { filePath: c.filePath },
          })),
      };
    }
    return { kind: 'note', label: name, description: 'No file mapping' };
  }

  private graphqlItem(o: GraphQLOperation): ContextTreeItem {
    const usedIn = o.usedIn ?? [];
    const vars = o.variableNames ?? [];
    const cfg = vscode.workspace.getConfiguration('repomap');
    const hideDocVars = cfg.get<boolean>('hideDocumentVariableNames', false);

    const children: ContextTreeItem[] = [];
    if (usedIn.length > 0) {
      children.push({
        kind: 'graphqlUsedIn',
        label: 'Used in',
        description: String(usedIn.length),
        children: usedIn
          .slice()
          .sort((a, b) => a.localeCompare(b))
          .map((p) => {
            const looksLikePath =
              p.includes('/') ||
              p.includes('\\') ||
              /\.(tsx?|jsx?|rb|graphql|gql|sql|py|go|java|kt|swift)$/i.test(p);
            return looksLikePath
              ? {
                  kind: 'note',
                  label: p,
                  description: 'Open',
                  open: { filePath: p },
                }
              : { kind: 'note', label: p };
          }),
      });
    }
    if (vars.length > 0) {
      const uniq = Array.from(new Set(vars))
        .filter((v) => (hideDocVars ? !/Document$/i.test(v) : true))
        .sort((a, b) => a.localeCompare(b));

      // Show the variables as a list (many codebases actually import/use *Document constants).
      children.push({
        kind: 'section',
        label: 'Variable names',
        description: String(uniq.length),
        children: uniq.map((v) => ({
          kind: 'note',
          label: v,
          description: 'Open first match',
          command: {
            command: 'repomap._findAndOpen',
            title: 'Open first match',
            arguments: [{ query: v, filePath: o.filePath }],
          },
        })),
      });
    }

    return {
      kind: 'graphql',
      label: `${o.type}: ${o.name}`,
      description: `${usedIn.length} uses`,
      open: { filePath: o.filePath, line: o.line },
      children: children.length ? children : undefined,
    };
  }
}
