import * as vscode from 'vscode';
import type { AnalysisResult } from './repomap-types';

function toUri(workspaceRoot: string, filePath: string): vscode.Uri {
  const p =
    filePath.startsWith('/') || /^[A-Za-z]:\\/.test(filePath)
      ? filePath
      : vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), filePath).fsPath;
  return vscode.Uri.file(p);
}

function makeDiag(message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
  const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = 'repomap';
  return d;
}

export function buildDiagnostics(args: {
  workspaceRoot: string;
  report: AnalysisResult | null;
}): Map<string, vscode.Diagnostic[]> {
  const out = new Map<string, vscode.Diagnostic[]>();
  const report = args.report;
  if (!report) return out;

  const pages = report.pages ?? [];
  const components = report.components ?? [];
  const ops = report.graphqlOperations ?? [];

  // Page incoming links (heuristic for "unlinked page").
  const incomingByPath = new Map<string, number>();
  for (const p of pages) incomingByPath.set(p.path, 0);
  for (const p of pages) {
    for (const dst of p.linkedPages ?? []) {
      incomingByPath.set(dst, (incomingByPath.get(dst) ?? 0) + 1);
    }
  }

  const push = (file: string, d: vscode.Diagnostic) => {
    const key = file.replace(/\\/g, '/');
    out.set(key, [...(out.get(key) ?? []), d]);
  };

  // Unused GraphQL operations (heuristic).
  // If variableNames exist, the operation is likely referenced via codegen/wrappers even when usedIn mapping fails.
  for (const op of ops) {
    const usedInCount = (op.usedIn ?? []).length;
    const varNameCount = (op.variableNames ?? []).length;
    if (usedInCount === 0 && varNameCount === 0) {
      push(
        toUri(args.workspaceRoot, op.filePath).fsPath,
        makeDiag(
          `Repomap: GraphQL ${op.type} '${op.name}' appears unused`,
          vscode.DiagnosticSeverity.Warning
        )
      );
    }
  }

  // Potentially unused components (heuristic: no dependents and not a page).
  for (const c of components) {
    const dependents = c.dependents?.length ?? 0;
    const type = c.type ?? '';
    if (dependents === 0 && type !== 'page') {
      push(
        toUri(args.workspaceRoot, c.filePath).fsPath,
        makeDiag(
          `Repomap: Component '${c.name}' has no dependents (possible unused)`,
          vscode.DiagnosticSeverity.Hint
        )
      );
    }
  }

  // Unlinked pages (heuristic: no incoming links and not root-like).
  for (const p of pages) {
    const incoming = incomingByPath.get(p.path) ?? 0;
    if (incoming === 0 && p.path !== '/' && p.path !== '') {
      push(
        toUri(args.workspaceRoot, p.filePath).fsPath,
        makeDiag(
          `Repomap: Page '${p.path}' has no incoming links (possible orphan)`,
          vscode.DiagnosticSeverity.Information
        )
      );
    }
  }

  return out;
}
