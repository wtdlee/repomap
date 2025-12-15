import * as path from 'path';
import type { AnalysisResult, PageInfo, ComponentInfo, GraphQLOperation } from './repomap-types';

export type FileInsights = {
  kind: 'page' | 'component' | 'graphql' | 'unknown';
  title: string;
  linkedTo?: number;
  linkedFrom?: number;
  dependencies?: number;
  dependents?: number;
  usedIn?: number;
};

export type RepomapDerived = {
  pageIncomingByPath: Map<string, number>;
  pageByPath: Map<string, PageInfo>;
  insightsByFilePath: Map<string, FileInsights[]>;
  graphqlByFilePath: Map<string, GraphQLOperation[]>;
  componentByFilePath: Map<string, ComponentInfo[]>;
};

export type RepomapState = {
  report: AnalysisResult | null;
  derived: RepomapDerived;
};

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function resolveWorkspacePath(workspaceRoot: string | undefined, filePath: string): string {
  if (!workspaceRoot) return filePath;
  if (path.isAbsolute(filePath)) return filePath;
  if (/^[A-Za-z]:[\\/]/.test(filePath)) return filePath;
  return path.join(workspaceRoot, filePath);
}

export function computeDerived(report: AnalysisResult | null, workspaceRoot?: string): RepomapDerived {
  const pages = report?.pages ?? [];
  const components = report?.components ?? [];
  const ops = report?.graphqlOperations ?? [];

  const pageIncomingByPath = new Map<string, number>();
  const pageByPath = new Map<string, PageInfo>();

  for (const page of pages) {
    pageByPath.set(page.path, page);
    pageIncomingByPath.set(page.path, 0);
  }

  for (const page of pages) {
    const linked = page.linkedPages ?? [];
    for (const dst of linked) {
      pageIncomingByPath.set(dst, (pageIncomingByPath.get(dst) ?? 0) + 1);
    }
  }

  const insightsByFilePath = new Map<string, FileInsights[]>();
  const graphqlByFilePath = new Map<string, GraphQLOperation[]>();
  const componentByFilePath = new Map<string, ComponentInfo[]>();

  const pushInsight = (filePath: string, insight: FileInsights) => {
    const abs = resolveWorkspacePath(workspaceRoot, filePath);
    const key = normalizePath(abs);
    const arr = insightsByFilePath.get(key) ?? [];
    arr.push(insight);
    insightsByFilePath.set(key, arr);
  };

  for (const page of pages) {
    const incoming = pageIncomingByPath.get(page.path) ?? 0;
    pushInsight(page.filePath, {
      kind: 'page',
      title: `Page: ${page.path}`,
      linkedTo: (page.linkedPages ?? []).length,
      linkedFrom: incoming,
    });
  }

  for (const c of components) {
    const deps = c.dependencies?.length ?? 0;
    const dents = c.dependents?.length ?? 0;
    pushInsight(c.filePath, {
      kind: 'component',
      title: `Component: ${c.name}`,
      dependencies: deps,
      dependents: dents,
    });

    const key = normalizePath(resolveWorkspacePath(workspaceRoot, c.filePath));
    componentByFilePath.set(key, [...(componentByFilePath.get(key) ?? []), c]);
  }

  for (const op of ops) {
    pushInsight(op.filePath, {
      kind: 'graphql',
      title: `GraphQL ${op.type}: ${op.name}`,
      usedIn: (op.usedIn ?? []).length,
    });

    const key = normalizePath(resolveWorkspacePath(workspaceRoot, op.filePath));
    graphqlByFilePath.set(key, [...(graphqlByFilePath.get(key) ?? []), op]);
  }

  return {
    pageIncomingByPath,
    pageByPath,
    insightsByFilePath,
    graphqlByFilePath,
    componentByFilePath,
  };
}
