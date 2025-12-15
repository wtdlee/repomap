import * as vscode from 'vscode';
import * as path from 'path';
import type { AnalysisResult } from './repomap-types';
import { computeDerived, type RepomapState } from './repomap-state';
import { generateReportJson } from './repomap-runner';
import { RepomapTreeDataProvider } from './repomap-tree';
import { RepomapContextTreeDataProvider } from './repomap-context-tree';
import { RepomapCodeLensProvider } from './repomap-codelens';
import { buildDiagnostics } from './repomap-diagnostics';
import { getWebviewHtml } from './repomap-webview';
import {
  buildGraphqlStructureTree,
  collectFragmentSpreadNamesFromDefinition,
  extractGraphqlFromEditor,
  extractGraphqlTemplatesFromText,
  parseGraphqlSource,
  type GraphqlSpan,
} from './graphql-structure';
import { getGraphqlStructureWebviewHtml } from './repomap-graphql-structure-webview';

type RepoMapSettings = {
  npxSpecifier: string;
  port: number;
  outputDir: string;
  jsonOutputDir: string;
  useTempOutput: boolean;
  autoRefreshOnSave: boolean;
  autoRefreshDebounceMs: number;
};

function getSettings(): RepoMapSettings {
  const cfg = vscode.workspace.getConfiguration('repomap');
  return {
    npxSpecifier: cfg.get<string>('npxSpecifier', '@wtdlee/repomap'),
    port: cfg.get<number>('port', 3030),
    outputDir: cfg.get<string>('outputDir', '.repomap'),
    jsonOutputDir: cfg.get<string>('jsonOutputDir', '.repomap'),
    useTempOutput: cfg.get<boolean>('useTempOutput', true),
    autoRefreshOnSave: cfg.get<boolean>('autoRefreshOnSave', false),
    autoRefreshDebounceMs: cfg.get<number>('autoRefreshDebounceMs', 3000),
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

async function fileExists(fsPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return true;
  } catch {
    return false;
  }
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function spanToRange(doc: vscode.TextDocument, span: { start: number; end: number }): vscode.Range {
  return new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end));
}

type TextMatch = { uri: vscode.Uri; range: vscode.Range; preview: string };

async function findTextMatchesInWorkspace(args: {
  query: string;
  maxResults: number;
  preferFileFsPath?: string;
}): Promise<TextMatch[]> {
  const results: TextMatch[] = [];
  const q = args.query.trim();
  if (!q) return results;

  const scanText = (uri: vscode.Uri, text: string) => {
    const needle = q.toLowerCase();
    const hay = text.toLowerCase();
    let idx = 0;
    while (results.length < args.maxResults) {
      const at = hay.indexOf(needle, idx);
      if (at < 0) break;
      idx = at + needle.length;

      const before = text.slice(0, at);
      const line = before.split('\n').length - 1;
      const col = before.length - (before.lastIndexOf('\n') + 1);
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineEnd = text.indexOf('\n', at);
      const preview = text
        .slice(lineStart, lineEnd >= 0 ? lineEnd : text.length)
        .replace(/\s+/g, ' ')
        .trim();

      results.push({
        uri,
        range: new vscode.Range(new vscode.Position(line, col), new vscode.Position(line, col + q.length)),
        preview,
      });
    }
  };

  // NOTE: Some VS Code type setups may not expose workspace.findTextInFiles.
  // Implement a small, reliable fallback using findFiles + content scan.
  const candidates = await vscode.workspace.findFiles(
    '**/*.{ts,tsx,js,jsx,graphql,gql,md,rb}',
    '{**/node_modules/**,**/.git/**,**/.next/**,**/dist/**,**/build/**,**/coverage/**}'
  );

  // Prefer scanning a specific file first (e.g. the operation file) to make jumps feel instant.
  if (args.preferFileFsPath) {
    const pref = candidates.find((u) => u.fsPath === args.preferFileFsPath);
    if (pref) {
      try {
        const bytes = await vscode.workspace.fs.readFile(pref);
        const text = new TextDecoder('utf-8').decode(bytes);
        scanText(pref, text);
      } catch {
        // ignore
      }
    }
  }

  for (const uri of candidates) {
    if (results.length >= args.maxResults) break;
    if (args.preferFileFsPath && uri.fsPath === args.preferFileFsPath) continue;
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = new TextDecoder('utf-8').decode(bytes);
    } catch {
      continue;
    }
    scanText(uri, text);
  }

  return results;
}

function escapeGlobSegment(seg: string): string {
  // Escape glob-special chars for vscode.workspace.findFiles (minimatch-like).
  // Most important here: '[' and ']' used by Next.js dynamic routes.
  return seg.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.(tsx?|jsx?)$/i, '');
}

function buildAlternateReportedPaths(reportedPath: string): string[] {
  const normalized = normalizeSlashes(reportedPath);
  const extMatch = normalized.match(/\.(tsx?|jsx?)$/i);
  const ext = extMatch ? extMatch[0] : '';
  const base = path.basename(normalized);
  const dir = path.posix.dirname(normalized);

  const alts: string[] = [];

  // If we got ".../[param].tsx", also try ".../[param]/page.tsx" and ".../[param]/index.tsx".
  // This helps App Router style layouts.
  if (ext) {
    const nameNoExt = stripExtension(base);
    const folderStyle = `${dir}/${nameNoExt}`;
    alts.push(`${folderStyle}/page${ext}`);
    alts.push(`${folderStyle}/index${ext}`);
  }

  // Also try common Next.js conventions even when extension is not present / is unexpected.
  // For example, some reports might point at a route segment rather than a file.
  if (!ext) {
    alts.push(`${normalized}/page.tsx`);
    alts.push(`${normalized}/index.tsx`);
  }

  return Array.from(new Set(alts.filter(Boolean)));
}

async function resolveExistingFile(
  workspaceRoot: string,
  reportedPath: string
): Promise<{ fsPath: string; tried: string[] }> {
  const tried: string[] = [];

  const abs = resolveWorkspacePath(workspaceRoot, reportedPath);
  tried.push(abs);
  if (await fileExists(abs)) return { fsPath: abs, tried };

  // Try alternate path interpretations (e.g. App Router /page.tsx).
  for (const alt of buildAlternateReportedPaths(reportedPath)) {
    const altAbs = resolveWorkspacePath(workspaceRoot, alt);
    tried.push(altAbs);
    if (await fileExists(altAbs)) return { fsPath: altAbs, tried };
  }

  // Try common repo roots (some reports omit these prefixes).
  const prefixes = ['app', 'pages', 'src', 'src/app', 'src/pages'];
  for (const prefix of prefixes) {
    const prefixed = normalizeSlashes(prefix + '/' + normalizeSlashes(reportedPath));
    const prefAbs = resolveWorkspacePath(workspaceRoot, prefixed);
    tried.push(prefAbs);
    if (await fileExists(prefAbs)) return { fsPath: prefAbs, tried };

    for (const alt of buildAlternateReportedPaths(prefixed)) {
      const altAbs = resolveWorkspacePath(workspaceRoot, alt);
      tried.push(altAbs);
      if (await fileExists(altAbs)) return { fsPath: altAbs, tried };
    }
  }

  // If repomap provided an absolute path that doesn't exist, try locating a close match
  // inside the current workspace by basename + suffix match.
  const basename = path.basename(reportedPath);
  const normalized = normalizeSlashes(reportedPath);
  const parts = normalized.split('/').filter(Boolean);
  const suffixParts = parts.slice(Math.max(0, parts.length - 6));
  const suffix = suffixParts.join('/');

  const candidates = await vscode.workspace.findFiles(
    `**/${escapeGlobSegment(basename)}`,
    '{**/node_modules/**,**/.git/**,**/.next/**,**/dist/**,**/build/**,**/coverage/**}',
    50
  );

  const normReported = normalizeSlashes(reportedPath);

  const scoreCandidate = (p: string): number => {
    const np = normalizeSlashes(p);
    let score = 0;
    if (np.endsWith(normReported)) score += 1000;
    if (suffix && np.endsWith(suffix)) score += 500;
    if (np.endsWith('/' + basename)) score += 200;
    // Prefer closer to workspace root (shorter path) if scores tie.
    score -= Math.min(100, Math.floor(np.length / 50));
    return score;
  };

  const ranked = candidates
    .map((u) => u.fsPath)
    .map((p) => ({ p, score: scoreCandidate(p) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);

  if (ranked.length === 1) {
    tried.push(ranked[0]);
    return { fsPath: ranked[0], tried };
  }

  if (ranked.length > 1) {
    const picked = await vscode.window.showQuickPick(
      ranked.map((p) => ({
        label: path.relative(workspaceRoot, p),
        description: p,
      })),
      { placeHolder: `Multiple matches for '${basename}'. Pick one to open.` }
    );
    if (picked?.description) {
      tried.push(picked.description);
      return { fsPath: picked.description, tried };
    }
  }

  return { fsPath: abs, tried };
}

async function openFile(
  workspaceRoot: string,
  args: { filePath: string; line?: number }
): Promise<void> {
  const resolved = await resolveExistingFile(workspaceRoot, args.filePath);
  if (!(await fileExists(resolved.fsPath))) {
    throw new Error(
      `Unable to resolve nonexistent file '${args.filePath}'. Tried:\n- ${resolved.tried.join('\n- ')}`
    );
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.fsPath));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (typeof args.line === 'number' && args.line > 0) {
    const pos = new vscode.Position(args.line - 1, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

type SearchItem = {
  label: string;
  description?: string;
  detail?: string;
  open?: { filePath: string; line?: number };
  kind:
    | 'page'
    | 'component'
    | 'graphql'
    | 'apiCall'
    | 'apiEndpoint'
    | 'model'
    | 'dataFlow'
    | 'unknown';
};

function buildSearchItems(report: AnalysisResult): SearchItem[] {
  const out: SearchItem[] = [];

  for (const p of report.pages ?? []) {
    out.push({
      kind: 'page',
      label: `Page: ${p.path}`,
      description: p.filePath,
      open: { filePath: p.filePath },
    });
  }

  for (const c of report.components ?? []) {
    const usedBy = c.dependents?.length ?? 0;
    const deps = c.dependencies?.length ?? 0;
    out.push({
      kind: 'component',
      label: `Component: ${c.name}`,
      description: c.filePath,
      detail: `${c.type ?? 'component'} · used-by ${usedBy} · deps ${deps}`,
      open: { filePath: c.filePath },
    });
  }

  for (const o of report.graphqlOperations ?? []) {
    out.push({
      kind: 'graphql',
      label: `GraphQL ${o.type}: ${o.name}`,
      description: o.filePath,
      detail: `used-in ${(o.usedIn ?? []).length}`,
      open: { filePath: o.filePath, line: o.line },
    });
  }

  for (const a of report.apiCalls ?? []) {
    const method = a.method ?? 'CALL';
    const url = a.url ?? a.id;
    out.push({
      kind: 'apiCall',
      label: `API Call: ${method} ${url}`,
      description: a.filePath,
      detail: a.containingFunction ? `in ${a.containingFunction}` : undefined,
      open: { filePath: a.filePath, line: a.line },
    });
  }

  for (const e of report.apiEndpoints ?? []) {
    const controller = e.controller ? ` · ${e.controller}${e.action ? `#${e.action}` : ''}` : '';
    out.push({
      kind: 'apiEndpoint',
      label: `API Endpoint: ${e.method} ${e.path}`,
      description: controller || undefined,
      detail: controller ? `from routes` : 'from routes',
    });
  }

  for (const m of report.models ?? []) {
    out.push({
      kind: 'model',
      label: `Model: ${m.name}`,
      description: m.filePath,
      detail: m.tableName ? `table ${m.tableName}` : undefined,
      open: { filePath: m.filePath },
    });
  }

  for (const d of report.dataFlows ?? []) {
    out.push({
      kind: 'dataFlow',
      label: `DataFlow: ${d.name}`,
      description: d.description,
      detail: d.operations?.length ? `ops ${d.operations.length}` : undefined,
    });
  }

  return out;
}

async function pickAndOpenFromReport(workspaceRoot: string, report: AnalysisResult): Promise<void> {
  const items = buildSearchItems(report).map((it) => ({
    label: it.label,
    description: it.description,
    detail: it.detail,
    it,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: 'Search Repomap: pages, components, GraphQL, API calls, models…',
  });
  if (!picked) return;

  // Open only when we have a real file path.
  if (!picked.it.open) return;
  await openFile(workspaceRoot, {
    filePath: picked.it.open.filePath,
    line: picked.it.open.line,
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Repomap');
  context.subscriptions.push(output);
  output.appendLine('activate()');

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
  const treeViewFallback = vscode.window.createTreeView('repomap.explorer.fallback', {
    treeDataProvider: tree,
  });
  context.subscriptions.push(treeView, treeViewFallback);

  const contextTree = new RepomapContextTreeDataProvider(getState);
  contextTree.setWorkspaceRoot(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  try {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('repomap.context', contextTree)
    );
    output.appendLine('registered treeDataProvider: repomap.context');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    output.appendLine(`failed to register repomap.context: ${msg}`);
    vscode.window.showErrorMessage(`Repomap: failed to init Current File view: ${msg}`);
  }

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
  let graphqlPanel: vscode.WebviewPanel | null = null;
  // Default ON: highlights only the currently focused field (no "highlight all fields").
  let graphqlFollowCursor = true;
  let graphqlSession: null | {
    docUri: string;
    extractedSpan: { start: number; end: number };
    spansById: Map<string, GraphqlSpan>;
    sortedSpans: Array<{ id: string; start: number; end: number; len: number }>;
  } = null;

  const graphqlSelectedDeco = vscode.window.createTextEditorDecorationType({
    borderColor: new vscode.ThemeColor('editor.wordHighlightStrongBorder'),
    borderStyle: 'solid',
    borderWidth: '1px',
    borderRadius: '3px',
  });
  context.subscriptions.push(graphqlSelectedDeco);

  const clearGraphqlHighlights = (editor?: vscode.TextEditor) => {
    const ed = editor ?? vscode.window.activeTextEditor;
    if (!ed) return;
    ed.setDecorations(graphqlSelectedDeco, []);
  };

  const findNodeIdAt = (
    session: NonNullable<typeof graphqlSession>,
    absOffset: number
  ): string | null => {
    if (absOffset < session.extractedSpan.start || absOffset > session.extractedSpan.end)
      return null;
    const rel = absOffset - session.extractedSpan.start;
    for (const s of session.sortedSpans) {
      if (rel >= s.start && rel <= s.end) return s.id;
    }
    return null;
  };

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      try {
        if (!graphqlSession || !graphqlPanel || !graphqlFollowCursor) return;
        if (e.textEditor.document.uri.toString() !== graphqlSession.docUri) return;
        const offset = e.textEditor.document.offsetAt(
          e.selections[0]?.active ?? e.textEditor.selection.active
        );
        const id = findNodeIdAt(graphqlSession, offset);
        if (!id) return;
        const span = graphqlSession.spansById.get(id);
        if (!span) return;
        const absSpan = {
          start: graphqlSession.extractedSpan.start + span.start,
          end: graphqlSession.extractedSpan.start + span.end,
        };
        const range = spanToRange(e.textEditor.document, absSpan);
        e.textEditor.setDecorations(graphqlSelectedDeco, [range]);
        graphqlPanel.webview.postMessage({ type: 'selectNode', id });
      } catch {
        // ignore
      }
    })
  );

  const setReport = (workspaceRoot: string, report: AnalysisResult | null) => {
    state = { report, derived: computeDerived(report, workspaceRoot) };
    tree.setReport(report);
    contextTree.setWorkspaceRoot(workspaceRoot);
    contextTree.refresh();
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

  const doRefresh = async (opts?: { quiet?: boolean }) => {
    const root = getWorkspaceRoot();
    const { npxSpecifier, jsonOutputDir, useTempOutput } = getSettings();
    status.text = 'Repomap: Analyzing…';
    ensurePanel(state.report);

    // Always avoid writing into the repository by default.
    // Use extension global storage as the output root.
    const storageDir = context.globalStorageUri.fsPath;
    const safeOutDir = path.join(storageDir, 'repomap');

    const { report } = await generateReportJson({
      workspaceRoot: root,
      npxSpecifier,
      // If the user explicitly disables temp output, fall back to configured output dir.
      outputDir: useTempOutput ? safeOutDir : jsonOutputDir,
      useTemp: useTempOutput,
    });

    setReport(root, report);
    if (!opts?.quiet) {
      vscode.window.showInformationMessage('Repomap: analysis refreshed.');
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('repomap.refresh', async () => {
      try {
        await doRefresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        status.text = 'Repomap: Error';
        vscode.window.showErrorMessage(`Repomap: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('repomap.search', async () => {
      try {
        const root = getWorkspaceRoot();
        if (!state.report) {
          const choice = await vscode.window.showInformationMessage(
            'Repomap: no report loaded yet. Refresh now?',
            'Refresh',
            'Cancel'
          );
          if (choice !== 'Refresh') return;
          await doRefresh({ quiet: true });
        }
        if (!state.report) return;
        await pickAndOpenFromReport(root, state.report);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Repomap: ${msg}`);
      }
    })
  );

  // Internal: open a match for a text query in workspace (used by Current File view).
  context.subscriptions.push(
    vscode.commands.registerCommand('repomap._findAndOpen', async (args?: unknown) => {
      try {
        const a = args as { query?: unknown; filePath?: unknown } | undefined;
        const query = typeof a?.query === 'string' ? a.query : '';
        if (!query.trim()) return;

        const preferFileFsPath = typeof a?.filePath === 'string' ? a.filePath : undefined;
        const matches = await findTextMatchesInWorkspace({ query, maxResults: 30, preferFileFsPath });
        if (matches.length === 0) {
          vscode.window.showInformationMessage(`Repomap: no matches for '${query}'.`);
          return;
        }

        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const openMatch = async (m: TextMatch) => {
          const doc = await vscode.workspace.openTextDocument(m.uri);
          const editor = await vscode.window.showTextDocument(doc, { preview: false });
          editor.selection = new vscode.Selection(m.range.start, m.range.end);
          editor.revealRange(m.range, vscode.TextEditorRevealType.InCenter);
        };

        if (matches.length === 1) {
          await openMatch(matches[0]);
          return;
        }

        const picked = await vscode.window.showQuickPick(
          matches.map((m) => ({
            label: root ? vscode.workspace.asRelativePath(m.uri, false) : m.uri.fsPath,
            description: `${m.range.start.line + 1}:${m.range.start.character + 1}`,
            detail: m.preview,
            m,
          })),
          { placeHolder: `Multiple matches for '${query}'. Pick one.` }
        );
        if (!picked) return;
        await openMatch(picked.m);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Repomap: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('repomap.graphqlStructure', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage('Repomap: no active editor.');
          return;
        }

        const ext = extractGraphqlFromEditor({
          document: editor.document,
          selection: editor.selection,
        });
        if (!ext.extracted) {
          vscode.window.showErrorMessage(`Repomap: ${ext.reason ?? 'No GraphQL found.'}`);
          return;
        }
        const extracted = ext.extracted;

        const parsedRes = parseGraphqlSource(ext.extracted.sourceText);
        if (!parsedRes.parsed) {
          vscode.window.showErrorMessage(
            `Repomap: GraphQL parse error: ${parsedRes.error ?? 'unknown'}`
          );
          return;
        }
        const parsed = parsedRes.parsed;
        const fragmentOrigin = new Map<
          string,
          { uri: vscode.Uri; baseOffset: number; nameSpan: { start: number; end: number } }
        >();

        const rememberFragmentOrigins = (args: {
          uri: vscode.Uri;
          baseOffset: number;
          fragmentsByName: Map<string, { name?: { loc?: { start: number; end: number } } }>;
        }) => {
          for (const [name, def] of args.fragmentsByName.entries()) {
            const nameLoc = def?.name?.loc;
            if (!nameLoc) continue;
            fragmentOrigin.set(name, {
              uri: args.uri,
              baseOffset: args.baseOffset,
              nameSpan: { start: nameLoc.start, end: nameLoc.end },
            });
          }
        };

        // Origins from the primary extracted template.
        rememberFragmentOrigins({
          uri: editor.document.uri,
          baseOffset: extracted.sourceSpanInDoc.start,
          fragmentsByName: parsed.fragmentsByName,
        });

        // Also collect fragment definitions from other gql`...` templates in the same file.
        // This covers common co-location patterns (multiple documents per file).
        try {
          const docText = editor.document.getText();
          const templates = extractGraphqlTemplatesFromText(docText).filter(
            (t) =>
              !(
                t.sourceSpanInDoc.start === extracted.sourceSpanInDoc.start &&
                t.sourceSpanInDoc.end === extracted.sourceSpanInDoc.end
              )
          );
          for (const t of templates) {
            const p = parseGraphqlSource(t.sourceText);
            if (!p.parsed) continue;
            for (const [name, def] of p.parsed.fragmentsByName.entries()) {
              if (!parsed.fragmentsByName.has(name)) parsed.fragmentsByName.set(name, def);
            }
            rememberFragmentOrigins({
              uri: editor.document.uri,
              baseOffset: t.sourceSpanInDoc.start,
              fragmentsByName: p.parsed.fragmentsByName,
            });
          }
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          output.appendLine(`graphqlStructure: failed to scan other templates in file: ${m}`);
        }

        if (parsed.definitions.length === 0) {
          vscode.window.showErrorMessage(
            'Repomap: no operation/fragment definition found in the extracted GraphQL.'
          );
          return;
        }

        const cursorDocOffset = editor.document.offsetAt(editor.selection.active);
        const cursorInSource = cursorDocOffset - extracted.sourceSpanInDoc.start;

        const containing = parsed.definitions
          .map((d) => {
            const loc = d.node.loc;
            if (!loc) return null;
            if (cursorInSource < loc.start || cursorInSource > loc.end) return null;
            const size = loc.end - loc.start;
            return { d, size };
          })
          .filter(Boolean)
          .sort((a, b) => (a!.size ?? 0) - (b!.size ?? 0));

        let picked = containing[0]?.d ?? null;
        if (!picked) {
          if (parsed.definitions.length === 1) {
            picked = parsed.definitions[0];
          } else {
            const qp = await vscode.window.showQuickPick(
              parsed.definitions.map((d) => ({
                label: d.label,
                description: d.kind,
                d,
              })),
              { placeHolder: 'Pick an operation/fragment to visualize' }
            );
            if (!qp) return;
            picked = qp.d;
          }
        }

        // Resolve missing fragments from report index (cross-file).
        // NOTE: We only expand structure; spans/line highlight is only reliable for the current extracted template.
        const root = getWorkspaceRoot();
        const fragmentIndex = new Map<string, { filePath: string; line?: number }>();
        for (const op of state.report?.graphqlOperations ?? []) {
          if (op.type === 'fragment') {
            fragmentIndex.set(op.name, { filePath: op.filePath, line: op.line });
          }
        }

        const loadFragmentsFromFile = async (filePath: string): Promise<void> => {
          const resolved = await resolveExistingFile(root, filePath);
          if (!(await fileExists(resolved.fsPath))) return;
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved.fsPath));
          const txt = doc.getText();
          const templates = extractGraphqlTemplatesFromText(txt);
          // Also include raw .graphql files (whole file).
          const sources =
            resolved.fsPath.endsWith('.graphql') || resolved.fsPath.endsWith('.gql')
              ? [{ sourceText: txt, sourceSpanInDoc: { start: 0, end: txt.length } }]
              : templates;
          for (const t of sources) {
            const p = parseGraphqlSource(t.sourceText);
            if (!p.parsed) continue;
            for (const [name, def] of p.parsed.fragmentsByName.entries()) {
              if (!parsed.fragmentsByName.has(name)) parsed.fragmentsByName.set(name, def);
            }
            rememberFragmentOrigins({
              uri: doc.uri,
              baseOffset: t.sourceSpanInDoc.start,
              fragmentsByName: p.parsed.fragmentsByName,
            });
          }
        };

        const tryLoadFragmentByWorkspaceSearch = async (fragName: string): Promise<void> => {
          if (parsed.fragmentsByName.has(fragName)) return;
          const query = `fragment ${fragName}`;
          const matches = await findTextMatchesInWorkspace({ query, maxResults: 5 });
          for (const m of matches) {
            try {
              const doc = await vscode.workspace.openTextDocument(m.uri);
              const txt = doc.getText();
              const templates = extractGraphqlTemplatesFromText(txt);
              const sources =
                m.uri.fsPath.endsWith('.graphql') || m.uri.fsPath.endsWith('.gql')
                  ? [{ sourceText: txt, sourceSpanInDoc: { start: 0, end: txt.length } }]
                  : templates;
              for (const t of sources) {
                const p = parseGraphqlSource(t.sourceText);
                if (!p.parsed) continue;
                for (const [name, def] of p.parsed.fragmentsByName.entries()) {
                  if (!parsed.fragmentsByName.has(name)) parsed.fragmentsByName.set(name, def);
                }
                rememberFragmentOrigins({
                  uri: doc.uri,
                  baseOffset: t.sourceSpanInDoc.start,
                  fragmentsByName: p.parsed.fragmentsByName,
                });
              }
              if (parsed.fragmentsByName.has(fragName)) return;
            } catch {
              // keep trying other matches
            }
          }
        };

        const pending = collectFragmentSpreadNamesFromDefinition(picked.node);
        let safety = 0;
        while (pending.size > 0 && safety++ < 50) {
          const [name] = pending;
          pending.delete(name);
          if (parsed.fragmentsByName.has(name)) continue;
          const hit = fragmentIndex.get(name);
          if (hit) {
            await loadFragmentsFromFile(hit.filePath);
          } else {
            await tryLoadFragmentByWorkspaceSearch(name);
          }
          const def = parsed.fragmentsByName.get(name);
          if (def) {
            for (const n of collectFragmentSpreadNamesFromDefinition(def)) pending.add(n);
          }
        }

        const treeRes = buildGraphqlStructureTree({
          definition: picked.node,
          definitionLabel: picked.label,
          fragmentsByName: parsed.fragmentsByName,
        });
        editor.setDecorations(graphqlSelectedDeco, []);

        if (graphqlPanel) {
          graphqlPanel.reveal(vscode.ViewColumn.Beside, true);
        } else {
          graphqlPanel = vscode.window.createWebviewPanel(
            'repomap.graphqlStructure',
            'Repomap: GraphQL Structure',
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
          );
          graphqlPanel.onDidDispose(() => {
            graphqlPanel = null;
            clearGraphqlHighlights(editor);
            graphqlSession = null;
          });
        }

        // Update session for follow-cursor.
        const spans = Array.from(treeRes.spansById.entries())
          .map(([id, sp]) => ({ id, start: sp.start, end: sp.end, len: sp.end - sp.start }))
          .sort((a, b) => a.len - b.len);
        graphqlSession = {
          docUri: editor.document.uri.toString(),
          extractedSpan: extracted.sourceSpanInDoc,
          spansById: treeRes.spansById,
          sortedSpans: spans,
        };

        graphqlPanel.webview.onDidReceiveMessage(async (msg) => {
          try {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'clearHighlight') {
              clearGraphqlHighlights(editor);
              return;
            }
            if (msg.type === 'setFollowCursor') {
              const enabled = (msg as { enabled?: unknown }).enabled;
              graphqlFollowCursor = typeof enabled === 'boolean' ? enabled : true;
              graphqlPanel?.webview.postMessage({
                type: 'setFollowCursor',
                enabled: graphqlFollowCursor,
              });
              return;
            }
            if (msg.type === 'focusNode' && typeof msg.id === 'string') {
              // If the clicked node is a fragment spread ("...Foo"), jump to fragment definition when known.
              const fragMatch = msg.id.match(/(?:^|\/)fragment:([^/]+)$/);
              if (fragMatch) {
                const fragName = fragMatch[1];
                let origin = fragmentOrigin.get(fragName);
                if (!origin) {
                  await tryLoadFragmentByWorkspaceSearch(fragName);
                  origin = fragmentOrigin.get(fragName);
                }
                if (origin) {
                  const doc = await vscode.workspace.openTextDocument(origin.uri);
                  const abs = {
                    start: origin.baseOffset + origin.nameSpan.start,
                    end: origin.baseOffset + origin.nameSpan.end,
                  };
                  const range = spanToRange(doc, abs);
                  const shown = await vscode.window.showTextDocument(doc, {
                    viewColumn: editor.viewColumn,
                    preserveFocus: false,
                    selection: range,
                  });
                  shown.revealRange(range, vscode.TextEditorRevealType.InCenter);
                  shown.setDecorations(graphqlSelectedDeco, [range]);
                  graphqlPanel?.webview.postMessage({ type: 'selectNode', id: msg.id });
                  return;
                }
              }

              const span = treeRes.spansById.get(msg.id) as GraphqlSpan | undefined;
              if (!span) return;
              // If the node lives under a fragment definition, jump using that fragment's origin (file + baseOffset).
              // Otherwise, jump within the currently extracted template.
              const parts = msg.id.split('/');
              const fragParts = parts.filter((p) => p.startsWith('fragment:'));
              const lastFrag = fragParts.length ? fragParts[fragParts.length - 1].slice('fragment:'.length) : null;

              const origin = lastFrag ? fragmentOrigin.get(lastFrag) : null;
              const targetDoc = origin
                ? await vscode.workspace.openTextDocument(origin.uri)
                : editor.document;
              const baseOffset = origin ? origin.baseOffset : extracted.sourceSpanInDoc.start;

              const absSpan = { start: baseOffset + span.start, end: baseOffset + span.end };
              const range = spanToRange(targetDoc, absSpan);
              const shown = await vscode.window.showTextDocument(targetDoc, {
                viewColumn: editor.viewColumn,
                preserveFocus: false,
                selection: range,
              });
              shown.revealRange(range, vscode.TextEditorRevealType.InCenter);
              shown.setDecorations(graphqlSelectedDeco, [range]);
              graphqlPanel?.webview.postMessage({ type: 'selectNode', id: msg.id });
              return;
            }
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            output.appendLine(`graphqlStructure webview error: ${m}`);
          }
        });

        graphqlPanel.webview.html = getGraphqlStructureWebviewHtml(graphqlPanel.webview, {
          title: picked.label,
          tree: treeRes.root,
        });

        graphqlPanel.webview.postMessage({ type: 'setFollowCursor', enabled: graphqlFollowCursor });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Repomap: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('repomap.openFile', async (args?: unknown) => {
      try {
        const root = getWorkspaceRoot();
        const a = args as { filePath?: unknown; line?: unknown } | undefined;
        if (!a || typeof a.filePath !== 'string') {
          // Internal command used by tree/webview items; not meant to be run manually.
          vscode.window.showInformationMessage('Repomap: Open File is an internal command.');
          return;
        }
        await openFile(root, {
          filePath: a.filePath,
          line: typeof a.line === 'number' ? a.line : undefined,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Repomap: ${msg}`);
      }
    })
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

  // Auto refresh (optional) - debounced to avoid running heavy analysis too frequently.
  let autoRefreshTimer: NodeJS.Timeout | null = null;
  let autoRefreshInFlight = false;
  const scheduleAutoRefresh = () => {
    const { autoRefreshOnSave, autoRefreshDebounceMs } = getSettings();
    if (!autoRefreshOnSave) return;
    if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(
      async () => {
        if (autoRefreshInFlight) return;
        autoRefreshInFlight = true;
        try {
          await doRefresh({ quiet: true });
        } catch {
          // Intentionally swallow errors for auto refresh to avoid noisy popups.
          status.text = 'Repomap: Error';
        } finally {
          autoRefreshInFlight = false;
        }
      },
      Math.max(500, autoRefreshDebounceMs)
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // Only react to workspace files. Ignore untitled/virtual docs.
      if (doc.uri.scheme !== 'file') return;
      // Keep it simple: refresh on save regardless of language, but only when enabled.
      scheduleAutoRefresh();
    })
  );

  // Context view: follow active editor.
  const syncActiveEditor = () => {
    const editor = vscode.window.activeTextEditor;
    contextTree.setActiveFile(
      editor?.document?.uri?.scheme === 'file' ? editor.document.uri.fsPath : null
    );
  };
  syncActiveEditor();
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(syncActiveEditor));
}

export function deactivate(): void {
  // noop
}
