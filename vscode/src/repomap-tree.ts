import * as vscode from 'vscode';
import type { AnalysisResult, PageInfo, ComponentInfo, GraphQLOperation } from './repomap-types';

export type RepomapTreeItem = {
  kind: 'section' | 'page' | 'component' | 'graphql';
  label: string;
  description?: string;
  filePath?: string;
  line?: number;
  children?: RepomapTreeItem[];
};

export class RepomapTreeDataProvider implements vscode.TreeDataProvider<RepomapTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    RepomapTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private report: AnalysisResult | null = null;

  setReport(report: AnalysisResult | null): void {
    this.report = report;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RepomapTreeItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.children
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    item.description = element.description;

    if (element.filePath) {
      item.command = {
        command: 'repomap.openFile',
        title: 'Open',
        arguments: [{ filePath: element.filePath, line: element.line }],
      };
    }

    if (element.kind === 'section') item.contextValue = 'repomapSection';
    return item;
  }

  getChildren(element?: RepomapTreeItem): Thenable<RepomapTreeItem[]> {
    if (!this.report) {
      return Promise.resolve([
        {
          kind: 'section',
          label: 'No report loaded',
          description: 'Run Repomap: Refresh',
        },
      ]);
    }

    if (element?.children) {
      return Promise.resolve(element.children);
    }

    if (element) {
      return Promise.resolve([]);
    }

    const pages = (this.report.pages ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    const components = (this.report.components ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const ops = (this.report.graphqlOperations ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    return Promise.resolve([
      this.section(
        'Pages',
        pages.map((p) => this.pageItem(p))
      ),
      this.section(
        'Components',
        components.map((c) => this.componentItem(c))
      ),
      this.section(
        'GraphQL Operations',
        ops.map((o) => this.graphqlItem(o))
      ),
    ]);
  }

  private section(label: string, children: RepomapTreeItem[]): RepomapTreeItem {
    return {
      kind: 'section',
      label,
      description: `${children.length}`,
      children,
    };
  }

  private pageItem(p: PageInfo): RepomapTreeItem {
    return {
      kind: 'page',
      label: p.path,
      description: p.filePath,
      filePath: p.filePath,
    };
  }

  private componentItem(c: ComponentInfo): RepomapTreeItem {
    const usedBy = c.dependents?.length ?? 0;
    const deps = c.dependencies?.length ?? 0;

    return {
      kind: 'component',
      label: c.name,
      description: `${c.type ?? 'component'} · used-by ${usedBy} · deps ${deps}`,
      filePath: c.filePath,
    };
  }

  private graphqlItem(o: GraphQLOperation): RepomapTreeItem {
    return {
      kind: 'graphql',
      label: `${o.type}: ${o.name}`,
      description: `used-in ${(o.usedIn ?? []).length}`,
      filePath: o.filePath,
      line: o.line,
    };
  }
}
