import express from 'express';
import { Server } from 'socket.io';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { marked } from 'marked';
import type {
  DocGeneratorConfig,
  DocumentationReport,
  VariableInfo,
  GraphQLField,
} from '../types.js';
import { DocGeneratorEngine } from '../core/engine.js';
import { PageMapGenerator } from '../generators/page-map-generator.js';

export interface DocServerOptions {
  noCache?: boolean;
}

/**
 * Documentation server with live reload
 * ライブリロード機能付きドキュメントサーバー
 */
export class DocServer {
  private config: DocGeneratorConfig;
  private port: number;
  private app: express.Express;
  private server: http.Server;
  private io: Server;
  private engine: DocGeneratorEngine;
  private currentReport: DocumentationReport | null = null;

  constructor(config: DocGeneratorConfig, port: number = 3030, options?: DocServerOptions) {
    this.config = config;
    this.port = port;
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new Server(this.server);
    this.engine = new DocGeneratorEngine(config, { noCache: options?.noCache });

    this.setupRoutes();
    this.setupSocketIO();
  }

  private setupRoutes(): void {
    // Serve static assets
    this.app.use('/assets', express.static(path.join(this.config.outputDir, 'assets')));

    // Main page - redirect to page-map
    this.app.get('/', (req, res) => {
      res.redirect('/page-map');
    });

    // Interactive page map (main view)
    this.app.get('/page-map', (req, res) => {
      if (!this.currentReport) {
        res.status(503).send('Documentation not ready yet');
        return;
      }
      const generator = new PageMapGenerator();
      res.send(generator.generatePageMapHtml(this.currentReport));
    });

    // Markdown pages - index
    this.app.get('/docs', async (req, res) => {
      res.send(await this.renderPage('index'));
    });

    // Markdown pages - specific path
    this.app.get('/docs/*', async (req, res) => {
      const pagePath = (req.params as Record<string, string>)[0] || 'index';
      res.send(await this.renderPage(pagePath));
    });

    // API endpoints
    this.app.get('/api/report', (req, res) => {
      res.json(this.currentReport);
    });

    this.app.get('/api/diagram/:name', (req, res) => {
      const diagram = this.currentReport?.diagrams.find(
        (d) => d.title.toLowerCase().replace(/\s+/g, '-') === req.params.name
      );
      if (diagram) {
        res.json(diagram);
      } else {
        res.status(404).json({ error: 'Diagram not found' });
      }
    });

    // Regenerate endpoint
    this.app.post('/api/regenerate', async (req, res) => {
      try {
        await this.regenerate();
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: (error as Error).message });
      }
    });
  }

  private setupSocketIO(): void {
    this.io.on('connection', (socket) => {
      console.log('Client connected');

      socket.on('disconnect', () => {
        console.log('Client disconnected');
      });
    });
  }

  private async renderPage(pagePath: string): Promise<string> {
    // Remove .md extension if present
    const cleanPath = pagePath.replace(/\.md$/, '');
    const mdPath = path.join(this.config.outputDir, `${cleanPath}.md`);
    let content = '';

    try {
      const markdown = await fs.readFile(mdPath, 'utf-8');
      // Parse markdown to HTML
      let html = await marked.parse(markdown);
      // Convert mermaid code blocks to mermaid divs
      // marked renders: <pre><code class="language-mermaid">...</code></pre>
      // mermaid expects: <div class="mermaid">...</div>
      html = html.replace(
        /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
        '<div class="mermaid">$1</div>'
      );
      // Wrap tables for horizontal scroll
      html = html.replace(/<table>/g, '<div class="table-wrapper"><table>');
      html = html.replace(/<\/table>/g, '</table></div>');
      content = html;
    } catch (e) {
      console.error(`Failed to render page: ${mdPath}`, e);
      content = `<h1>Page not found</h1><p>Path: ${cleanPath}</p>`;
    }

    return this.getHtmlTemplate(content);
  }

  private getGraphQLData(): string {
    if (!this.currentReport) return '[]';
    const ops: Array<{
      name: string;
      type: string;
      returnType: string;
      variables: VariableInfo[];
      fields: GraphQLField[];
      usedIn: string[];
    }> = [];
    for (const repo of this.currentReport.repositories) {
      for (const op of repo.analysis?.graphqlOperations || []) {
        ops.push({
          name: op.name,
          type: op.type,
          returnType: op.returnType,
          variables: op.variables,
          fields: op.fields,
          usedIn: op.usedIn,
        });
      }
    }
    return JSON.stringify(ops);
  }

  private getApiCallsData(): string {
    if (!this.currentReport) return '[]';
    const calls: Array<{
      id: string;
      method: string;
      url: string;
      callType: string;
      filePath: string;
      line: number;
      containingFunction: string;
      requiresAuth: boolean;
    }> = [];
    for (const repo of this.currentReport.repositories) {
      for (const call of repo.analysis?.apiCalls || []) {
        calls.push({
          id: call.id,
          method: call.method,
          url: call.url,
          callType: call.callType,
          filePath: call.filePath,
          line: call.line,
          containingFunction: call.containingFunction,
          requiresAuth: call.requiresAuth,
        });
      }
    }
    return JSON.stringify(calls);
  }

  private getHtmlTemplate(content: string): string {
    const graphqlData = this.getGraphQLData();
    const apiCallsData = this.getApiCallsData();
    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.config.site.title}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <script src="/socket.io/socket.io.js"></script>
  <script>
    window.graphqlOps = ${graphqlData};
    window.apiCalls = ${apiCallsData};
    // Create multiple lookup maps for different naming conventions
    window.gqlMap = new Map();
    window.gqlMapNormalized = new Map();

    // Normalize name: remove Query/Mutation suffix, convert to lowercase
    function normalizeName(name) {
      return name
        .replace(/Query$|Mutation$|Fragment$/i, '')
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .toLowerCase();
    }

    // Convert to UPPER_SNAKE_CASE
    function toUpperSnake(name) {
      return name
        .replace(/Query$|Mutation$|Fragment$/i, '')
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .toUpperCase();
    }

    window.graphqlOps.forEach(op => {
      // Store by exact name
      window.gqlMap.set(op.name, op);
      // Store by name without suffix
      window.gqlMap.set(op.name.replace(/Query$|Mutation$|Fragment$/i, ''), op);
      // Store by normalized name
      window.gqlMapNormalized.set(normalizeName(op.name), op);
      // Store by UPPER_SNAKE_CASE
      window.gqlMap.set(toUpperSnake(op.name), op);
      // Store by return type if available
      if (op.returnType) {
        window.gqlMap.set(op.returnType, op);
        window.gqlMapNormalized.set(op.returnType.toLowerCase(), op);
      }
    });

    // Enhanced lookup function
    window.findGraphQLOp = function(name) {
      if (!name) return null;
      // Try exact match first
      let op = window.gqlMap.get(name);
      if (op) return op;

      // Try normalized match
      op = window.gqlMapNormalized.get(normalizeName(name));
      if (op) return op;

      // Try UPPER_SNAKE_CASE
      op = window.gqlMap.get(name.toUpperCase().replace(/-/g, '_'));
      if (op) return op;

      // Try partial match
      for (const [key, val] of window.gqlMap.entries()) {
        if (key.toLowerCase().includes(name.toLowerCase()) ||
            name.toLowerCase().includes(key.toLowerCase())) {
          return val;
        }
      }

      return null;
    };
  </script>
  <style>
    :root {
      --bg-primary: #ffffff;
      --bg-secondary: #f5f5f5;
      --text-primary: #1a1a1a;
      --text-secondary: #666666;
      --accent: #0066cc;
      --border: #e0e0e0;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-secondary);
      color: var(--text-primary);
      line-height: 1.6;
    }

    /* Container and sidebar styles moved to top-header section */

    .sidebar nav a {
      display: block;
      padding: 8px 12px;
      color: var(--text-secondary);
      text-decoration: none;
      border-radius: 6px;
      margin-bottom: 4px;
      transition: all 0.2s;
    }

    .sidebar nav a:hover {
      background: var(--bg-secondary);
      color: var(--accent);
    }

    .sidebar nav a.active {
      background: var(--accent);
      color: white;
    }

    .nav-group {
      margin-bottom: 8px;
    }

    .nav-group-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--text-secondary);
      letter-spacing: 0.5px;
      display: block;
      padding: 8px 12px 4px;
    }

    .nav-subitems {
      margin-left: 16px;
      border-left: 2px solid var(--border);
      padding-left: 8px;
    }

    .nav-subitems a {
      font-size: 13px;
    }

    .sidebar nav a.highlight {
      background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
      color: white;
      font-weight: 600;
      margin-top: 16px;
    }

    .sidebar nav a.highlight:hover {
      opacity: 0.9;
    }

    .main {
      flex: 1;
      padding: 32px;
      min-width: 0; /* Allow flex shrinking */
      max-width: calc(100vw - 280px);
    }

    .content {
      background: var(--bg-primary);
      padding: 32px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
      overflow-x: auto;
      max-width: 100%;
    }

    .content h1 {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 20px;
      border-bottom: 3px solid var(--accent);
      padding-bottom: 10px;
      letter-spacing: -0.5px;
    }

    .content h2 {
      font-size: 20px;
      font-weight: 600;
      margin-top: 32px;
      margin-bottom: 14px;
      color: var(--text-primary);
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    .content h3 {
      font-size: 16px;
      font-weight: 600;
      margin-top: 20px;
      margin-bottom: 10px;
      color: var(--text-primary);
    }

    .content h4 {
      font-size: 14px;
      font-weight: 600;
      margin-top: 16px;
      margin-bottom: 8px;
      color: var(--text-secondary);
    }

    .content p {
      margin-bottom: 12px;
      line-height: 1.6;
    }

    .content code {
      background: #f1f5f9;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      font-size: 13px;
      color: #0f172a;
      border: 1px solid #e2e8f0;
    }

    .content pre {
      background: #0f172a;
      color: #e2e8f0;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 12px 0;
      font-size: 13px;
      line-height: 1.5;
    }

    .content pre code {
      background: none;
      padding: 0;
      color: inherit;
      border: none;
      font-size: inherit;
    }

    .table-wrapper {
      overflow-x: auto;
      margin: 12px 0;
      border-radius: 8px;
      border: 1px solid var(--border);
    }

    .content table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .content th, .content td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      text-align: left;
    }

    .content td {
      max-width: 500px;
      vertical-align: middle;
    }

    /* Allow gql-ops-inline to wrap */
    .gql-ops-inline {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    }

    .content th {
      background: #f8fafc;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
    }

    .content tr:hover td {
      background: #f8fafc;
    }

    .content blockquote {
      border-left: 3px solid var(--accent);
      padding: 12px 16px;
      margin: 12px 0;
      background: #f8fafc;
      border-radius: 0 6px 6px 0;
      color: var(--text-secondary);
      font-size: 14px;
    }

    .content ul, .content ol {
      margin: 10px 0;
      padding-left: 20px;
    }

    .content li {
      margin-bottom: 6px;
      line-height: 1.5;
    }

    .content a {
      color: var(--accent);
      text-decoration: none;
    }

    .content a:hover {
      text-decoration: underline;
    }

    .content hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 16px 0;
    }

    /* Tag styles */
    .content code:first-child {
      font-weight: 500;
    }

    /* Clickable operation names */
    .gql-op {
      cursor: pointer;
      padding: 2px 8px;
      background: #dbeafe;
      border-radius: 4px;
      border: 1px solid #93c5fd;
      color: #1d4ed8;
      font-weight: 500;
      transition: all 0.15s;
      display: inline-block;
      margin: 2px;
    }

    .gql-op:hover {
      background: #bfdbfe;
      border-color: #60a5fa;
    }

    .gql-op.mutation {
      background: #fce7f3;
      border-color: #f9a8d4;
      color: #be185d;
    }

    .gql-op.mutation:hover {
      background: #fbcfe8;
      border-color: #f472b6;
    }

    /* Component references */
    .gql-ref {
      cursor: pointer;
      padding: 2px 8px;
      background: #f0fdf4;
      border-radius: 4px;
      border: 1px solid #86efac;
      color: #166534;
      font-weight: 500;
      transition: all 0.15s;
      display: inline-block;
      margin: 2px;
    }

    .gql-ref:hover {
      background: #dcfce7;
      border-color: #4ade80;
    }

    .gql-ref.mutation {
      background: #fef3c7;
      border-color: #fcd34d;
      color: #92400e;
    }

    /* More button */
    .gql-more {
      cursor: pointer;
      padding: 2px 8px;
      background: #e2e8f0;
      border-radius: 4px;
      border: 1px solid #cbd5e1;
      color: #475569;
      font-weight: 500;
      transition: all 0.15s;
      display: inline-block;
      margin: 2px;
    }

    .gql-more:hover {
      background: #cbd5e1;
    }

    .gql-more.mutation {
      background: #fce7f3;
      border-color: #f9a8d4;
      color: #be185d;
    }

    /* Ops list container */
    .gql-ops-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin: 8px 0;
    }

    .mermaid-container {
      position: relative;
      background: var(--bg-secondary);
      border-radius: 8px;
      margin: 16px 0;
      overflow: hidden;
    }

    .mermaid-controls {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      gap: 4px;
      z-index: 10;
    }

    .mermaid-controls button {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
    }

    .mermaid-controls button:hover {
      background: var(--accent);
      color: white;
    }

    .mermaid-wrapper {
      overflow: hidden;
      padding: 24px;
      min-height: 200px;
      max-height: none; /* Removed height limit for better viewing */
      cursor: grab;
      position: relative;
    }

    .mermaid-wrapper.dragging {
      cursor: grabbing;
    }

    .mermaid-inner {
      transform-origin: 0 0;
      transition: none;
      display: inline-block;
    }

    .mermaid {
      display: inline-block;
    }

    .mermaid .node rect, .mermaid .node circle, .mermaid .node ellipse, .mermaid .node polygon {
      cursor: pointer;
      transition: all 0.2s;
    }

    .mermaid .node:hover rect, .mermaid .node:hover circle {
      filter: brightness(1.1);
      stroke-width: 3px;
    }

    /* Detail modal */
    .detail-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }

    .detail-modal.open {
      display: flex;
    }

    .detail-modal-content {
      background: var(--bg-primary);
      border-radius: 12px;
      padding: 24px;
      max-width: 600px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    }

    .detail-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .detail-modal-close {
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: var(--text-secondary);
    }

    .detail-section {
      margin-bottom: 16px;
    }

    .detail-section h4 {
      font-size: 12px;
      text-transform: uppercase;
      color: var(--text-secondary);
      margin-bottom: 6px;
    }

    .detail-section p {
      margin: 0;
      padding: 8px 12px;
      background: var(--bg-secondary);
      border-radius: 4px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 13px;
    }

    .detail-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      margin-right: 6px;
    }

    .detail-badge.query { background: #dbeafe; color: #1d4ed8; }
    .detail-badge.mutation { background: #fce7f3; color: #be185d; }
    .detail-badge.context { background: #d1fae5; color: #047857; }
    .detail-badge.fragment { background: #e0e7ff; color: #4338ca; }
    .detail-badge.component { background: #f0fdf4; color: #166534; }
    .detail-badge.operation { background: #f1f5f9; color: #475569; }

    .live-indicator {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #22c55e;
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .live-indicator::before {
      content: '';
      width: 8px;
      height: 8px;
      background: white;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .regenerate-btn {
      background: var(--accent);
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      margin-top: 24px;
    }

    .regenerate-btn:hover {
      background: #0052a3;
    }
    
    /* Top header - matching page-map style */
    .top-header {
      background: #1e293b;
      padding: 12px 20px;
      border-bottom: 1px solid #334155;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 200;
    }
    .top-header h1 { 
      font-size: 18px; 
      color: #f1f5f9;
      cursor: pointer;
    }
    .top-header-left {
      display: flex;
      align-items: center;
      gap: 24px;
    }
    .top-nav {
      display: flex;
      gap: 4px;
    }
    .top-nav-link {
      padding: 6px 12px;
      color: #94a3b8;
      text-decoration: none;
      font-size: 13px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .top-nav-link:hover { background: #334155; color: #f1f5f9; }
    .top-nav-link.active { background: #3b82f6; color: white; }
    
    .container {
      display: flex;
      min-height: calc(100vh - 54px);
    }
    
    .sidebar {
      width: 280px;
      background: var(--bg-primary);
      border-right: 1px solid var(--border);
      padding: 24px;
      position: sticky;
      top: 54px;
      height: calc(100vh - 54px);
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <header class="top-header">
    <div class="top-header-left">
      <h1 onclick="location.href='/'">📊 ${this.config.repositories[0]?.displayName || this.config.repositories[0]?.name || 'Repository'}</h1>
      <nav class="top-nav">
        <a href="/page-map" class="top-nav-link">Page Map</a>
        <a href="/docs" class="top-nav-link active">Docs</a>
        <a href="/api/report" class="top-nav-link" target="_blank">API</a>
      </nav>
    </div>
  </header>
  <div class="container">
    <aside class="sidebar">
      <nav>
        <div class="nav-group">
          <span class="nav-group-title">Documentation</span>
          <div class="nav-subitems">
            ${this.config.repositories
              .map(
                (repo) => `
              <a href="/docs/repos/${repo.name}/pages">Pages</a>
              <a href="/docs/repos/${repo.name}/components">Components</a>
              <a href="/docs/repos/${repo.name}/graphql">GraphQL</a>
              <a href="/docs/repos/${repo.name}/dataflow">Data Flow</a>
            `
              )
              .join('')}
          </div>
        </div>
        <div class="nav-group">
          <span class="nav-group-title">Analysis</span>
          <div class="nav-subitems">
            <a href="/docs/cross-repo">Cross Repository</a>
            <a href="/docs/diagrams">Diagrams</a>
          </div>
        </div>
      </nav>
      <button class="regenerate-btn" onclick="regenerate()">Regenerate</button>
    </aside>
    <main class="main">
      <div class="content">
        ${content}
      </div>
    </main>
  </div>
  <div class="live-indicator">Live</div>
  
  <!-- Detail Modal -->
  <div class="detail-modal" id="detailModal">
    <div class="detail-modal-content">
      <div class="detail-modal-header">
        <div style="display:flex;align-items:center;gap:8px">
          <button id="modalBackBtn" onclick="modalBack()" style="display:none;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:14px">← Back</button>
          <h3 id="modalTitle">Details</h3>
        </div>
        <button class="detail-modal-close" onclick="closeModal()">×</button>
      </div>
      <div id="modalBody"></div>
    </div>
  </div>

  <script>
    // Initialize Mermaid
    mermaid.initialize({ 
      startOnLoad: false, 
      theme: 'neutral',
      securityLevel: 'loose',
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' }
    });
    
    // Diagram state per diagram
    const diagramStates = new Map();
    
    // Render all mermaid diagrams on page load
    document.addEventListener('DOMContentLoaded', async () => {
      // Wrap mermaid divs with container and controls
      document.querySelectorAll('.mermaid').forEach((el, idx) => {
        const container = document.createElement('div');
        container.className = 'mermaid-container';
        container.innerHTML = \`
          <div class="mermaid-controls">
            <button onclick="zoomDiagram(\${idx}, 0.8)" title="縮小">➖</button>
            <button onclick="zoomDiagram(\${idx}, 1.25)" title="拡大">➕</button>
            <button onclick="zoomDiagram(\${idx}, 'reset')" title="リセット">🔄</button>
            <button onclick="toggleFullscreen(\${idx})" title="全画面">⛶</button>
          </div>
          <div class="mermaid-wrapper" id="wrapper-\${idx}">
            <div class="mermaid-inner" id="inner-\${idx}"></div>
          </div>
        \`;
        el.parentNode.insertBefore(container, el);
        container.querySelector('.mermaid-inner').appendChild(el);
        el.dataset.idx = idx;
        diagramStates.set(idx, { zoom: 1, panX: 0, panY: 0 });
        
        // Setup drag handlers
        setupDragHandlers(idx);
      });

      try {
        await mermaid.run({ querySelector: '.mermaid' });
        
        // Add click handlers to nodes
        document.querySelectorAll('.mermaid .node').forEach(node => {
          node.addEventListener('click', (e) => {
            e.stopPropagation();
            const text = node.querySelector('span, text, .nodeLabel')?.textContent || '';
            showNodeDetail(text, node);
          });
        });
      } catch (e) {
        console.error('Mermaid rendering error:', e);
      }
    });

    function setupDragHandlers(idx) {
      const wrapper = document.getElementById(\`wrapper-\${idx}\`);
      const inner = document.getElementById(\`inner-\${idx}\`);
      if (!wrapper || !inner) return;

      let isDragging = false;
      let startX, startY, startPanX, startPanY;

      wrapper.addEventListener('mousedown', (e) => {
        if (e.target.closest('.node')) return; // Don't drag when clicking nodes
        isDragging = true;
        wrapper.classList.add('dragging');
        startX = e.clientX;
        startY = e.clientY;
        const state = diagramStates.get(idx);
        startPanX = state.panX;
        startPanY = state.panY;
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const state = diagramStates.get(idx);
        state.panX = startPanX + (e.clientX - startX);
        state.panY = startPanY + (e.clientY - startY);
        updateTransform(idx);
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
        wrapper.classList.remove('dragging');
      });

      // Mouse wheel zoom - increased max zoom to 20 for detailed viewing
      wrapper.addEventListener('wheel', (e) => {
        e.preventDefault();
        const state = diagramStates.get(idx);
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        state.zoom = Math.max(0.05, Math.min(20, state.zoom * delta));
        updateTransform(idx);
      });
    }

    function updateTransform(idx) {
      const inner = document.getElementById(\`inner-\${idx}\`);
      const state = diagramStates.get(idx);
      if (inner && state) {
        inner.style.transform = \`translate(\${state.panX}px, \${state.panY}px) scale(\${state.zoom})\`;
      }
    }

    function zoomDiagram(idx, factor) {
      const state = diagramStates.get(idx);
      if (!state) return;
      
      if (factor === 'reset') {
        state.zoom = 1;
        state.panX = 0;
        state.panY = 0;
      } else {
        // Increased max zoom to 20 for detailed viewing of large diagrams
        state.zoom = Math.max(0.05, Math.min(20, state.zoom * factor));
      }
      updateTransform(idx);
    }

    function toggleFullscreen(idx) {
      const container = document.getElementById(\`wrapper-\${idx}\`)?.closest('.mermaid-container');
      if (!container) return;
      const wrapper = container.querySelector('.mermaid-wrapper');

      if (container.classList.contains('fullscreen-mode')) {
        container.classList.remove('fullscreen-mode');
        container.style.cssText = '';
        if (wrapper) {
          wrapper.style.height = '';
          wrapper.style.maxHeight = '';
        }
      } else {
        container.classList.add('fullscreen-mode');
        container.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999;background:white;border-radius:0;margin:0;padding:10px;box-sizing:border-box;';
        if (wrapper) {
          wrapper.style.height = 'calc(100vh - 60px)';
          wrapper.style.maxHeight = 'calc(100vh - 60px)';
        }
      }
    }

    function showNodeDetail(text, node) {
      const modal = document.getElementById('detailModal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');

      // Reset history for new modal opening
      modalHistory = [];

      // Clean name: remove icons and extract operation name from patterns like "GraphQL: OPERATION_NAME"
      let cleanName = text.replace(/[\u{1F512}\u{1F4E1}\u{270F}\u{FE0F}\u{1F504}]/gu, '').trim();
      // Handle "GraphQL: OPERATION_NAME" pattern
      if (cleanName.includes('GraphQL:')) {
        cleanName = cleanName.replace(/^.*GraphQL:\s*/, '').trim();
      }
      // Handle "API: OPERATION_NAME" pattern
      if (cleanName.includes('API:')) {
        cleanName = cleanName.replace(/^.*API:\s*/, '').trim();
      }
      // Remove any remaining prefixes like "Query:", "Mutation:"
      cleanName = cleanName.replace(/^(Query|Mutation|Fragment):\s*/i, '').trim();

      const op = window.findGraphQLOp?.(cleanName);

      let titleText, html;

      if (op) {
        titleText = op.name;
        html = \`<div class="detail-section">
          <h4>Type</h4>
          <p><span class="detail-badge \${op.type}">\${op.type.toUpperCase()}</span></p>
        </div>\`;

        if (op.returnType) {
          html += \`<div class="detail-section"><h4>Return</h4><p><code>\${op.returnType}</code></p></div>\`;
        }

        if (op.fields?.length) {
          // Show full GraphQL operation structure
          const opKeyword = op.type === 'mutation' ? 'mutation' : (op.type === 'fragment' ? 'fragment' : 'query');
          const varStr = op.variables?.length ? '(' + op.variables.map(v => '$' + v.name + ': ' + v.type).join(', ') + ')' : '';
          const fragmentOn = op.type === 'fragment' && op.returnType ? ' on ' + op.returnType : '';

          let gqlCode = opKeyword + ' ' + op.name + varStr + fragmentOn + ' {\\n';
          gqlCode += formatGqlFields(op.fields, 1);
          gqlCode += '\\n}';

          html += '<div class="detail-section"><h4>GraphQL</h4><pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;white-space:pre;">' + gqlCode + '</pre></div>';
        }

        if (op.usedIn?.length) {
          html += '<div class="detail-section"><h4>Used In</h4><div style="max-height:100px;overflow-y:auto">';
          op.usedIn.forEach(f => { html += \`<p style="font-size:12px;color:#666;margin:2px 0">\${f}</p>\`; });
          html += '</div></div>';
        }
      } else {
        // Try partial matching for operations
        let partialMatch = null;
        if (window.graphqlOps && cleanName) {
          const searchTerm = cleanName.toLowerCase().replace(/_/g, '');
          partialMatch = window.graphqlOps.find(o => {
            const opName = o.name.toLowerCase().replace(/_/g, '');
            return opName.includes(searchTerm) || searchTerm.includes(opName);
          });
        }

        if (partialMatch) {
          titleText = partialMatch.name;
          html = \`<div class="detail-section">
            <h4>Type</h4>
            <p><span class="detail-badge \${partialMatch.type}">\${partialMatch.type.toUpperCase()}</span></p>
          </div>\`;

          if (partialMatch.returnType) {
            html += \`<div class="detail-section"><h4>Return</h4><p><code>\${partialMatch.returnType}</code></p></div>\`;
          }

          if (partialMatch.fields?.length) {
            const opKeyword = partialMatch.type === 'mutation' ? 'mutation' : (partialMatch.type === 'fragment' ? 'fragment' : 'query');
            const varStr = partialMatch.variables?.length ? '(' + partialMatch.variables.map(v => '$' + v.name + ': ' + v.type).join(', ') + ')' : '';
            const fragmentOn = partialMatch.type === 'fragment' && partialMatch.returnType ? ' on ' + partialMatch.returnType : '';

            let gqlCode = opKeyword + ' ' + partialMatch.name + varStr + fragmentOn + ' {\\n';
            gqlCode += formatGqlFields(partialMatch.fields, 1);
            gqlCode += '\\n}';

            html += '<div class="detail-section"><h4>GraphQL</h4><pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;white-space:pre;">' + gqlCode + '</pre></div>';
          }

          if (partialMatch.usedIn?.length) {
            html += '<div class="detail-section"><h4>Used In</h4><div style="max-height:100px;overflow-y:auto">';
            partialMatch.usedIn.forEach(f => { html += \`<p style="font-size:12px;color:#666;margin:2px 0">\${f}</p>\`; });
            html += '</div></div>';
          }
        } else {
          const info = parseNodeInfo(text);
          titleText = cleanName || info.name || text;
          html = \`
            <div class="detail-section">
              <h4>Type</h4>
              <p><span class="detail-badge \${info.type}">\${getTypeBadge(info.type)}</span></p>
            </div>
            <div class="detail-section">
              <h4>Operation Name</h4>
              <p><code>\${cleanName}</code></p>
            </div>
            <div class="detail-section" style="color:#666;font-size:12px">
              <p>This operation is referenced in the diagram but detailed information is not available in the parsed data.</p>
            </div>
          \`;
        }
      }

      pushModalHistory(titleText, html);
      title.textContent = titleText;
      body.innerHTML = html;
      updateBackButton();
      modal.classList.add('open');
    }
    
    function formatGqlFields(fields, indent) {
      if (!fields?.length) return '';
      const lines = [];
      for (const f of fields) {
        const prefix = '  '.repeat(indent);
        if (f.fields?.length) {
          lines.push(prefix + f.name + ' {');
          lines.push(formatGqlFields(f.fields, indent + 1));
          lines.push(prefix + '}');
        } else {
          lines.push(prefix + f.name);
        }
      }
      return lines.join('\\n');
    }

    function parseNodeInfo(text) {
      const info = { type: 'unknown', name: text };
      
      // Detect type from text patterns
      if (text.includes('Query') || text.includes('QUERY') || text.toLowerCase().includes('usequery')) {
        info.type = 'query';
        info.operation = text.replace(/^use/, '').replace(/Query$/, '');
      } else if (text.includes('Mutation') || text.includes('MUTATION') || text.toLowerCase().includes('usemutation')) {
        info.type = 'mutation';
        info.operation = text.replace(/^use/, '').replace(/Mutation$/, '');
      } else if (text.includes('Context') || text.includes('Provider')) {
        info.type = 'context';
        info.context = text;
      } else if (text.includes('Fragment') || text.includes('FRAGMENT')) {
        info.type = 'fragment';
      }
      
      // Extract name from common patterns
      const nameMatch = text.match(/^([A-Z][a-zA-Z]+)/);
      if (nameMatch) {
        info.name = nameMatch[1];
      }
      
      return info;
    }

    function getTypeBadge(type) {
      const badges = {
        query: '[QUERY]',
        mutation: '[MUTATION]',
        context: '[CONTEXT]',
        fragment: '[FRAGMENT]',
        unknown: '[COMPONENT]'
      };
      return badges[type] || badges.unknown;
    }

    function closeModal() {
      document.getElementById('detailModal').classList.remove('open');
      modalHistory = [];
      updateBackButton();
    }

    // Close modal on backdrop click - go back if history exists
    document.getElementById('detailModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'detailModal') {
        if (modalHistory.length > 1) {
          modalBack();
        } else {
          closeModal();
        }
      }
    });

    // Make GraphQL operations clickable
    document.addEventListener('DOMContentLoaded', () => {
      // Find h4 elements with Query/Mutation names (code blocks following h4)
      document.querySelectorAll('h4 code, h3 + p + h4 code').forEach(el => {
        const text = el.textContent || '';
        if (text && !text.includes(' ')) {
          el.style.cursor = 'pointer';
          el.style.textDecoration = 'underline';
          el.style.textDecorationStyle = 'dotted';
          el.addEventListener('click', () => showGraphQLDetail(text, el));
        }
      });

      // Also make inline code in tables clickable if it looks like an operation name
      document.querySelectorAll('td code').forEach(el => {
        const text = el.textContent || '';
        if (text && /^[A-Z][a-zA-Z]+$/.test(text)) {
          el.style.cursor = 'pointer';
          el.addEventListener('click', () => showGraphQLDetail(text, el));
        }
      });

      // Make gql-op spans clickable
      document.querySelectorAll('.gql-op').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const opName = el.dataset.op || el.textContent?.replace(/^[QM]:\\s*/, '') || '';
          if (opName) showGraphQLDetail(opName, el);
        });
      });

      // Make gql-ref (component references) clickable
      document.querySelectorAll('.gql-ref').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const refName = el.dataset.ref || '';
          const queriesData = el.dataset.queries;
          const mutationsData = el.dataset.mutations;

          if (queriesData || mutationsData) {
            // Use stored data for accurate display
            const queries = queriesData ? JSON.parse(queriesData) : [];
            const mutations = mutationsData ? JSON.parse(mutationsData) : [];
            showComponentOps(refName, queries, mutations);
          } else if (refName) {
            showComponentDetail(refName);
          }
        });
      });

      // Make gql-more (show more) clickable
      document.querySelectorAll('.gql-more').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const pagePath = el.dataset.page;
          const type = el.dataset.type;
          if (pagePath) showAllOperations(pagePath, type);
        });
      });
    });

    function showGraphQLDetail(name, el) {
      const modal = document.getElementById('detailModal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');

      // Reset history if modal is not open (first level)
      if (!modal.classList.contains('open')) {
        modalHistory = [];
      }

      // Use enhanced lookup function
      const op = window.findGraphQLOp?.(name);

      let titleText, html;

      if (op) {
        titleText = op.name;
        html = \`<div class="detail-section">
          <h4>Type</h4>
          <p><span class="detail-badge \${op.type}">\${op.type.toUpperCase()}</span></p>
        </div>\`;

        if (op.returnType) {
          html += \`<div class="detail-section"><h4>Return Type</h4><p><code>\${op.returnType}</code></p></div>\`;
        }

        if (op.variables?.length) {
          html += '<div class="detail-section"><h4>Variables</h4><div style="background:#f1f5f9;padding:10px;border-radius:6px">';
          op.variables.forEach(v => {
            html += \`<div style="margin:4px 0"><code style="color:#0369a1">\${v.name}</code>: <code>\${v.type}</code></div>\`;
          });
          html += '</div></div>';
        }

        if (op.fields?.length) {
          // Show full GraphQL operation structure
          const opKeyword = op.type === 'mutation' ? 'mutation' : (op.type === 'fragment' ? 'fragment' : 'query');
          const varStr = op.variables?.length ? '(' + op.variables.map(v => '$' + v.name + ': ' + v.type).join(', ') + ')' : '';
          const fragmentOn = op.type === 'fragment' && op.returnType ? ' on ' + op.returnType : '';

          let gqlCode = opKeyword + ' ' + op.name + varStr + fragmentOn + ' {\\n';
          gqlCode += formatGqlFieldsStatic(op.fields, 1);
          gqlCode += '\\n}';

          html += '<div class="detail-section"><h4>GraphQL</h4><pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;white-space:pre;">' + gqlCode + '</pre></div>';
        }

        if (op.usedIn?.length) {
          html += '<div class="detail-section"><h4>Used In</h4><div style="font-size:12px;color:#666;max-height:100px;overflow-y:auto">';
          op.usedIn.forEach(f => { html += \`<div style="margin:2px 0">\${f}</div>\`; });
          html += '</div></div>';
        }
      } else {
        // Fallback for unknown operations
        let type = 'operation';
        if (name.toLowerCase().includes('query') || name.endsWith('Query')) type = 'query';
        else if (name.toLowerCase().includes('mutation') || name.endsWith('Mutation')) type = 'mutation';

        titleText = name;
        html = \`
          <div class="detail-section">
            <h4>Type</h4>
            <p><span class="detail-badge \${type}">\${type.toUpperCase()}</span></p>
          </div>
          <div class="detail-section">
            <h4>Operation Name</h4>
            <p><code>\${name}</code></p>
          </div>
          <div class="detail-section" style="color:#666;font-size:13px">
            <p>Detailed field information not available for this operation.</p>
          </div>
        \`;
      }

      pushModalHistory(titleText, html);
      title.textContent = titleText;
      body.innerHTML = html;
      updateBackButton();
      modal.classList.add('open');
    }

    // Modal history for back navigation (moved earlier in the code)
    // let modalHistory = [];

    function pushModalHistory(title, html) {
      modalHistory.push({ title, html });
    }

    function modalBack() {
      if (modalHistory.length > 1) {
        modalHistory.pop(); // Remove current
        const prev = modalHistory[modalHistory.length - 1];
        document.getElementById('modalTitle').textContent = prev.title;
        document.getElementById('modalBody').innerHTML = prev.html;
        updateBackButton();
      }
    }

    function updateBackButton() {
      const backBtn = document.getElementById('modalBackBtn');
      if (backBtn) {
        backBtn.style.display = modalHistory.length > 1 ? 'inline-block' : 'none';
      }
    }

    function renderOpsSection(type, ops, initialCount = 8) {
      if (ops.length === 0) return '';

      const typeClass = type === 'Mutations' ? 'mutation' : (type === 'Fragments' ? 'fragment' : '');
      const badgeStyle = type === 'Fragments' ? 'background:#e0e7ff;border-color:#a5b4fc;color:#4338ca;' : '';
      const visibleOps = ops.slice(0, initialCount);
      const hiddenOps = ops.slice(initialCount);
      const sectionId = 'ops-' + type.toLowerCase() + '-' + Date.now();

      let html = '<div class="detail-section"><h4>' + type + ' (' + ops.length + ')</h4>';
      html += '<div id="' + sectionId + '" style="display:flex;flex-wrap:wrap;gap:6px">';

      for (const op of visibleOps) {
        html += \`<span class="gql-op \${typeClass}" style="\${badgeStyle}cursor:pointer" onclick="showGraphQLDetailWithHistory('\${op.name}')">\${op.name}</span>\`;
      }

      if (hiddenOps.length > 0) {
        const hiddenData = JSON.stringify(hiddenOps.map(o => o.name)).replace(/"/g, '&quot;');
        html += \`<span class="gql-more" onclick="expandOpsSection('\${sectionId}', \${hiddenData}, '\${typeClass}', '\${badgeStyle.replace(/'/g, "\\\\'")}')">+\${hiddenOps.length} more</span>\`;
      }

      html += '</div></div>';
      return html;
    }

    window.expandOpsSection = function(sectionId, names, typeClass, badgeStyle) {
      const section = document.getElementById(sectionId);
      if (!section) return;

      // Remove the "more" button
      const moreBtn = section.querySelector('.gql-more');
      if (moreBtn) moreBtn.remove();

      // Add hidden items
      for (const name of names) {
        const span = document.createElement('span');
        span.className = 'gql-op ' + typeClass;
        span.style.cssText = badgeStyle + 'cursor:pointer';
        span.textContent = name;
        span.onclick = () => showGraphQLDetailWithHistory(name);
        section.appendChild(span);
      }
    };

    function showGraphQLDetailWithHistory(name) {
      const op = window.findGraphQLOp?.(name);
      if (!op) {
        showGraphQLDetail(name);
        return;
      }

      const title = op.name;
      let html = \`<div class="detail-section">
        <h4>Type</h4>
        <p><span class="detail-badge \${op.type}">\${op.type.toUpperCase()}</span></p>
      </div>\`;

      if (op.returnType) {
        html += \`<div class="detail-section"><h4>Return Type</h4><p><code>\${op.returnType}</code></p></div>\`;
      }

      if (op.variables?.length) {
        html += '<div class="detail-section"><h4>Variables</h4><div style="background:#f1f5f9;padding:10px;border-radius:6px">';
        op.variables.forEach(v => {
          html += \`<div style="margin:4px 0"><code style="color:#0369a1">\${v.name}</code>: <code>\${v.type}</code></div>\`;
        });
        html += '</div></div>';
      }

      if (op.fields?.length) {
        // Show full GraphQL operation structure
        const opKeyword = op.type === 'mutation' ? 'mutation' : (op.type === 'fragment' ? 'fragment' : 'query');
        const varStr = op.variables?.length ? '(' + op.variables.map(v => '$' + v.name + ': ' + v.type).join(', ') + ')' : '';
        const fragmentOn = op.type === 'fragment' && op.returnType ? ' on ' + op.returnType : '';

        let gqlCode = opKeyword + ' ' + op.name + varStr + fragmentOn + ' {\\n';
        gqlCode += formatGqlFieldsStatic(op.fields, 1);
        gqlCode += '\\n}';

        html += '<div class="detail-section"><h4>GraphQL</h4><pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;white-space:pre;">' + gqlCode + '</pre></div>';
      }

      if (op.usedIn?.length) {
        html += '<div class="detail-section"><h4>Used In</h4><div style="font-size:12px;color:#666;max-height:100px;overflow-y:auto">';
        op.usedIn.forEach(f => { html += \`<div style="margin:2px 0">\${f}</div>\`; });
        html += '</div></div>';
      }

      pushModalHistory(title, html);
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalBody').innerHTML = html;
      updateBackButton();
    }

    function showComponentOps(componentName, queryNames, mutationNames) {
      const modal = document.getElementById('detailModal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');

      // Reset history
      modalHistory = [];

      // Find operations by exact names
      const queries = [];
      const mutations = [];

      if (window.graphqlOps) {
        for (const name of queryNames) {
          const op = window.findGraphQLOp?.(name);
          if (op) queries.push(op);
        }
        for (const name of mutationNames) {
          const op = window.findGraphQLOp?.(name);
          if (op) mutations.push(op);
        }
      }

      let html = \`<div class="detail-section">
        <h4>Component</h4>
        <p><span class="detail-badge component">\${componentName}</span></p>
      </div>\`;

      html += \`<div class="detail-section">
        <h4>Operations</h4>
        <p style="color:#666;font-size:13px">\${queryNames.length} queries, \${mutationNames.length} mutations</p>
      </div>\`;

      if (queries.length > 0) {
        html += renderOpsSection('Queries', queries, 5);
      }

      if (mutations.length > 0) {
        html += renderOpsSection('Mutations', mutations, 5);
      }

      pushModalHistory(componentName, html);
      title.textContent = componentName;
      body.innerHTML = html;
      updateBackButton();
      modal.classList.add('open');
    }

    function showComponentDetail(componentName) {
      const modal = document.getElementById('detailModal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');

      // Reset history
      modalHistory = [];

      // Find related GraphQL operations
      const queries = [];
      const mutations = [];
      const fragments = [];

      if (window.graphqlOps) {
        const keywords = componentName
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
          .split(/\\s+/)
          .filter(k => k.length > 3 && !['Page', 'Container', 'Wrapper', 'Form', 'Component', 'Provider'].includes(k));

        const added = new Set();

        for (const op of window.graphqlOps) {
          if (added.has(op.name)) continue;

          const matchesUsedIn = op.usedIn?.some(path => {
            const pathLower = path.toLowerCase();
            const compLower = componentName.toLowerCase();
            return pathLower.includes('/' + compLower) ||
                   pathLower.includes(compLower + '.') ||
                   keywords.some(kw => pathLower.includes(kw.toLowerCase()));
          });

          if (matchesUsedIn) {
            added.add(op.name);
            if (op.type === 'query') queries.push(op);
            else if (op.type === 'mutation') mutations.push(op);
            else if (op.type === 'fragment') fragments.push(op);
          }
        }
      }

      let html = \`<div class="detail-section">
        <h4>Type</h4>
        <p><span class="detail-badge component">COMPONENT</span></p>
      </div>\`;

      const hasOps = queries.length > 0 || mutations.length > 0 || fragments.length > 0;

      if (hasOps) {
        html += renderOpsSection('Queries', queries);
        html += renderOpsSection('Mutations', mutations);
        html += renderOpsSection('Fragments', fragments, 5);
      } else {
        html += \`<div class="detail-section" style="color:#666;font-size:13px">
          <p>No directly related GraphQL operations found for this component.</p>
        </div>\`;
      }

      pushModalHistory(componentName, html);
      title.textContent = componentName;
      body.innerHTML = html;
      updateBackButton();
      modal.classList.add('open');
    }

    function showAllOperations(pagePath, filterType) {
      const modal = document.getElementById('detailModal');
      const title = document.getElementById('modalTitle');
      const body = document.getElementById('modalBody');

      // Reset history
      modalHistory = [];

      // Find all operations for this page
      const queries = [];
      const mutations = [];
      const added = new Set();

      if (window.graphqlOps) {
        const pathKeywords = pagePath.split('/').filter(s => s && s.length > 2 && !s.startsWith(':') && !s.startsWith('['));

        for (const op of window.graphqlOps) {
          if (added.has(op.name)) continue;

          const matchesType = !filterType ||
            (filterType === 'query' ? op.type === 'query' : op.type === 'mutation');

          const matchesPath = op.usedIn?.some(path =>
            pathKeywords.some(kw => path.toLowerCase().includes(kw.toLowerCase()))
          );

          if (matchesType && matchesPath) {
            added.add(op.name);
            if (op.type === 'query') queries.push(op);
            else if (op.type === 'mutation') mutations.push(op);
          }
        }
      }

      const titleText = \`\${pagePath} - \${filterType ? (filterType === 'query' ? 'Queries' : 'Mutations') : 'All Operations'}\`;

      let html = '';

      if (queries.length > 0 && (!filterType || filterType === 'query')) {
        html += renderOpsSection('Queries', queries);
      }

      if (mutations.length > 0 && (!filterType || filterType === 'mutation')) {
        html += renderOpsSection('Mutations', mutations);
      }

      if (queries.length === 0 && mutations.length === 0) {
        html = '<div class="detail-section"><p style="color:#666">No operations found for this page.</p></div>';
      }

      pushModalHistory(titleText, html);
      title.textContent = titleText;
      body.innerHTML = html;
      updateBackButton();
      modal.classList.add('open');
    }

    function formatGqlFieldsStatic(fields, indent) {
      if (!fields?.length) return '';
      const lines = [];
      for (const f of fields) {
        const prefix = '  '.repeat(indent);
        if (f.fields?.length) {
          lines.push(prefix + f.name + ' {');
          lines.push(formatGqlFieldsStatic(f.fields, indent + 1));
          lines.push(prefix + '}');
        } else {
          lines.push(prefix + f.name);
        }
      }
      return lines.join('\\n');
    }

    // Socket.IO for live reload
    const socket = io();
    socket.on('reload', () => {
      window.location.reload();
    });

    // Regenerate function
    async function regenerate() {
      try {
        const btn = document.querySelector('.regenerate-btn');
        btn.textContent = '⏳ 生成中...';
        btn.disabled = true;
        
        const res = await fetch('/api/regenerate', { method: 'POST' });
        const data = await res.json();
        
        if (data.success) {
          window.location.reload();
        } else {
          alert('生成に失敗しました: ' + data.error);
        }
      } catch (e) {
        alert('エラー: ' + e.message);
      } finally {
        const btn = document.querySelector('.regenerate-btn');
        btn.textContent = '🔄 再生成';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
  }

  async start(openBrowser: boolean = true): Promise<void> {
    // Generate initial documentation
    console.log('Generating initial documentation...');
    this.currentReport = await this.engine.generate();

    // Start server
    this.server.listen(this.port, () => {
      console.log(`\n🌐 Documentation server running at http://localhost:${this.port}`);
      console.log('   Press Ctrl+C to stop\n');
    });

    // Open browser
    if (openBrowser) {
      const open = (await import('open')).default;
      await open(`http://localhost:${this.port}`);
    }

    // Watch for changes
    if (this.config.watch.enabled) {
      this.watchForChanges();
    }
  }

  private async regenerate(): Promise<void> {
    console.log('\n🔄 Regenerating documentation...');
    this.currentReport = await this.engine.generate();
    this.io.emit('reload');
    console.log('✅ Documentation regenerated');
  }

  private async watchForChanges(): Promise<void> {
    const watchDirs = this.config.repositories.map((r) => r.path);
    let timeout: NodeJS.Timeout | null = null;

    for (const dir of watchDirs) {
      try {
        const watcher = fs.watch(dir, { recursive: true });
        (async () => {
          for await (const event of watcher) {
            if (
              event.filename &&
              (event.filename.endsWith('.ts') || event.filename.endsWith('.tsx'))
            ) {
              if (timeout) clearTimeout(timeout);

              timeout = setTimeout(async () => {
                await this.regenerate();
              }, this.config.watch.debounce);
            }
          }
        })();
      } catch (error) {
        console.warn(`Warning: Could not watch directory ${dir}:`, (error as Error).message);
      }
    }
  }

  stop(): void {
    this.server.close();
    console.log('\n👋 Server stopped');
  }
}
