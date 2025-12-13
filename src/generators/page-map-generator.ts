import type { PageInfo, DocumentationReport, GraphQLOperation, APICall } from '../types.js';
import type { EnvironmentDetectionResult } from '../utils/env-detector.js';
import type { RailsAnalysisResult } from '../analyzers/rails/index.js';

interface PageNode extends PageInfo {
  repo: string;
  children: string[];
  parent: string | null;
  depth: number;
}

interface PageRelation {
  from: string;
  to: string;
  type: 'parent-child' | 'sibling' | 'same-layout';
  description: string;
}

interface ComponentData {
  name: string;
  filePath: string;
  type: string;
  dependencies: string[];
  hooks: string[];
}

export interface PageMapOptions {
  envResult?: EnvironmentDetectionResult | null;
  railsAnalysis?: RailsAnalysisResult | null;
  activeTab?: 'pages' | 'rails' | 'api';
  staticMode?: boolean; // For GitHub Pages deployment (inline CSS, no server)
}

/**
 * Interactive page map generator
 */
export class PageMapGenerator {
  private graphqlOps: GraphQLOperation[] = [];
  private apiCalls: APICall[] = [];
  private components: ComponentData[] = [];

  generatePageMapHtml(report: DocumentationReport, options?: PageMapOptions): string {
    const allPages: PageNode[] = [];
    const envResult = options?.envResult;
    const railsAnalysis = options?.railsAnalysis;
    const activeTab = options?.activeTab || 'pages';

    // Get repository name for display
    const repoName =
      report.repositories[0]?.displayName || report.repositories[0]?.name || 'Repository';

    for (const repoResult of report.repositories) {
      this.graphqlOps.push(...(repoResult.analysis?.graphqlOperations || []));
      this.apiCalls.push(...(repoResult.analysis?.apiCalls || []));
      // Collect component information
      const comps = repoResult.analysis?.components || [];
      for (const comp of comps) {
        this.components.push({
          name: comp.name,
          filePath: comp.filePath,
          type: comp.type,
          dependencies: comp.dependencies || [],
          hooks: comp.hooks || [],
        });
      }
    }

    for (const repoResult of report.repositories) {
      const pages = repoResult.analysis?.pages || [];
      for (const page of pages) {
        allPages.push({
          ...page,
          repo: repoResult.name,
          children: [],
          parent: null,
          depth: 0,
        });
      }
    }

    const { rootPages, relations } = this.buildHierarchy(allPages);

    return this.renderPageMapHtml(allPages, rootPages, relations, repoName, {
      envResult,
      railsAnalysis,
      activeTab,
    });
  }

  private buildHierarchy(pages: PageNode[]): { rootPages: PageNode[]; relations: PageRelation[] } {
    const pathMap = new Map<string, PageNode>();
    const relations: PageRelation[] = [];

    for (const page of pages) {
      pathMap.set(page.path, page);
    }

    for (const page of pages) {
      const segments = page.path.split('/').filter(Boolean);

      for (let i = segments.length - 1; i >= 1; i--) {
        const parentPath = '/' + segments.slice(0, i).join('/');
        const parent = pathMap.get(parentPath);
        if (parent) {
          page.parent = parentPath;
          page.depth = parent.depth + 1;
          if (!parent.children.includes(page.path)) {
            parent.children.push(page.path);
          }
          relations.push({
            from: parentPath,
            to: page.path,
            type: 'parent-child',
            description: `Sub-page of ${parentPath}`,
          });
          break;
        }
      }

      if (!page.parent) {
        // Use segment count for depth when no parent page exists
        // This ensures proper indentation based on URL structure
        page.depth = Math.max(0, segments.length - 1);
      }

      if (page.layout) {
        for (const other of pages) {
          if (other.path !== page.path && other.layout === page.layout) {
            const existing = relations.find(
              (r) =>
                r.type === 'same-layout' &&
                ((r.from === page.path && r.to === other.path) ||
                  (r.from === other.path && r.to === page.path))
            );
            if (!existing) {
              relations.push({
                from: page.path,
                to: other.path,
                type: 'same-layout',
                description: `Both use ${page.layout}`,
              });
            }
          }
        }
      }
    }

    const rootPages = pages.filter((p) => !p.parent).sort((a, b) => a.path.localeCompare(b.path));
    return { rootPages, relations };
  }

  private renderPageMapHtml(
    allPages: PageNode[],
    rootPages: PageNode[],
    relations: PageRelation[],
    repoName: string,
    options?: {
      envResult?: EnvironmentDetectionResult | null;
      railsAnalysis?: RailsAnalysisResult | null;
      activeTab?: 'pages' | 'rails' | 'api';
    }
  ): string {
    const envResult = options?.envResult;
    const railsAnalysis = options?.railsAnalysis;
    const activeTab = options?.activeTab || 'pages';

    const graphqlOpsJson = JSON.stringify(
      this.graphqlOps.map((op) => ({
        name: op.name,
        type: op.type,
        variables: op.variables,
        fields: op.fields,
        returnType: op.returnType,
        usedIn: op.usedIn,
      }))
    );

    const componentsJson = JSON.stringify(this.components);

    // Rails data for integrated view
    const railsRoutesJson = railsAnalysis ? JSON.stringify(railsAnalysis.routes.routes) : '[]';
    const railsControllersJson = railsAnalysis
      ? JSON.stringify(railsAnalysis.controllers.controllers)
      : '[]';
    const railsModelsJson = railsAnalysis ? JSON.stringify(railsAnalysis.models.models) : '[]';
    const railsViewsJson = railsAnalysis
      ? JSON.stringify(railsAnalysis.views)
      : '{ "views": [], "pages": [], "summary": {} }';
    const railsReactJson = railsAnalysis
      ? JSON.stringify(railsAnalysis.react)
      : '{ "components": [], "entryPoints": [], "summary": {} }';
    const railsGrpcJson = railsAnalysis ? JSON.stringify(railsAnalysis.grpc) : '{ "services": [] }';
    const railsSummaryJson = railsAnalysis ? JSON.stringify(railsAnalysis.summary) : 'null';

    // Environment info
    const hasRails = envResult?.hasRails || false;
    const hasNextjs = envResult?.hasNextjs || false;
    const hasReact = envResult?.hasReact || false;

    // Group by first path segment
    const groups = new Map<string, PageNode[]>();
    for (const page of allPages) {
      const seg = page.path.split('/').filter(Boolean)[0] || 'root';
      if (!groups.has(seg)) groups.set(seg, []);
      groups.get(seg)?.push(page);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page Map - Repomap</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
  <link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
  <link rel="manifest" href="/favicon/site.webmanifest">
  <link rel="stylesheet" href="/page-map.css">
</head>
<body>
  <header class="header">
    <div style="display:flex;align-items:center;gap:24px">
      <h1 style="cursor:pointer" onclick="location.href='/'">📊 ${repoName}</h1>
      <nav style="display:flex;gap:4px">
        <a href="/page-map" class="nav-link ${activeTab === 'pages' ? 'active' : ''}">Page Map</a>
        ${hasRails ? `<a href="/rails-map" class="nav-link ${activeTab === 'rails' ? 'active' : ''}">Rails Map</a>` : ''}
        <a href="/docs" class="nav-link">Docs</a>
        <a href="/api/report" class="nav-link" target="_blank">API</a>
      </nav>
    </div>
    <div style="display:flex;gap:12px;align-items:center">
      <!-- Environment filter badges -->
      ${
        hasRails && hasNextjs
          ? `<div class="env-filters" style="display:flex;gap:4px;margin-right:8px">
          <button class="env-badge env-badge-active" data-env="all" onclick="filterByEnv('all')">All</button>
          <button class="env-badge" data-env="nextjs" onclick="filterByEnv('nextjs')">⚛️ Next.js</button>
          <button class="env-badge" data-env="rails" onclick="filterByEnv('rails')">🛤️ Rails</button>
        </div>`
          : ''
      }
      <input class="search" type="text" placeholder="Search pages, queries..." oninput="filter(this.value)">
      <div class="tabs">
        <button class="tab active" onclick="setView('tree')">List</button>
        <button class="tab" onclick="setView('graph')">Graph</button>
      </div>
    </div>
  </header>

  <div class="main">
    <aside class="sidebar">
      <h3>Page Types</h3>
      <div class="legend">
        <div class="legend-item"><div class="legend-color" style="background:#22c55e"></div>CREATE</div>
        <div class="legend-item"><div class="legend-color" style="background:#f59e0b"></div>EDIT</div>
        <div class="legend-item"><div class="legend-color" style="background:#3b82f6"></div>DETAIL</div>
        <div class="legend-item"><div class="legend-color" style="background:#06b6d4"></div>LIST</div>
      </div>

      <h3>Relationships</h3>
      <div class="legend">
        <div class="legend-item"><div class="legend-color" style="background:#3b82f6"></div>PARENT</div>
        <div class="legend-item"><div class="legend-color" style="background:#22c55e"></div>CHILD</div>
        <div class="legend-item"><div class="legend-color" style="background:#8b5cf6"></div>SAME LAYOUT</div>
      </div>

      <h3>Data</h3>
      <div class="legend">
        <div class="legend-item"><span class="tag tag-query">QUERY</span> fetch data</div>
        <div class="legend-item"><span class="tag tag-mutation">MUTATION</span> update</div>
      </div>

      <!-- Frontend Stats -->
      <h3 style="margin-top:16px;font-size:10px;text-transform:uppercase;color:var(--text2);letter-spacing:1px">Frontend</h3>
      <div class="stats" id="stats-container">
        <div class="stat" data-filter="pages"><div class="stat-val">${allPages.length}</div><div class="stat-label">Pages</div></div>
        <div class="stat" data-filter="hierarchies"><div class="stat-val">${
          relations.filter((r) => r.type === 'parent-child').length
        }</div><div class="stat-label">Hierarchies</div></div>
        <div class="stat" data-filter="graphql"><div class="stat-val">${
          this.graphqlOps.length
        }</div><div class="stat-label">GraphQL</div></div>
        <div class="stat" data-filter="restapi"><div class="stat-val">${
          this.apiCalls.length
        }</div><div class="stat-label">REST API</div></div>
      </div>

      ${
        hasRails && railsAnalysis
          ? `
      <!-- Rails Stats -->
      <h3 style="margin-top:16px;font-size:10px;text-transform:uppercase;color:var(--text2);letter-spacing:1px;cursor:pointer" onclick="switchToRailsTab()">Rails Backend</h3>
      <div class="stats" id="rails-stats">
        <div class="stat" data-filter="rails-routes" onclick="switchToRailsTab()"><div class="stat-val">${railsAnalysis.summary.totalRoutes}</div><div class="stat-label">Routes</div></div>
        <div class="stat" data-filter="rails-controllers" onclick="showRailsControllers(); this.blur();"><div class="stat-val">${railsAnalysis.summary.totalControllers}</div><div class="stat-label">Controllers</div></div>
        <div class="stat" data-filter="rails-models" onclick="showRailsModels(); this.blur();"><div class="stat-val">${railsAnalysis.summary.totalModels}</div><div class="stat-label">Models</div></div>
        <div class="stat" data-filter="rails-grpc" onclick="showRailsGrpc(); this.blur();"><div class="stat-val">${railsAnalysis.summary.totalGrpcServices}</div><div class="stat-label">gRPC</div></div>
        <div class="stat" data-filter="rails-react" onclick="showReactComponents(); this.blur();"><div class="stat-val">${railsAnalysis.summary.totalReactComponents}</div><div class="stat-label">⚛ React</div></div>
      </div>
      `
          : ''
      }
    </aside>

    <div class="content">
      <!-- Pages Tree View (for all screens - Next.js/React/Rails) -->
      <div class="tree-view ${activeTab === 'pages' ? 'active' : ''}" id="tree-view" data-tab="pages">
        ${allPages.length > 0 ? this.buildTreeHtml(groups, allPages) : ''}
        <div id="page-map-react-components-section" style="${hasRails ? 'margin-top:20px;border-top:1px solid var(--bg3);padding-top:20px' : ''}">
        </div>
        <div id="page-map-rails-section" style="${allPages.length > 0 && hasRails ? 'margin-top:20px;border-top:1px solid var(--bg3);padding-top:20px' : ''}">
          ${hasRails && allPages.length === 0 ? '<div class="empty-state-sm">Loading screens...</div>' : ''}
        </div>
      </div>

      <!-- Rails Routes View (dedicated) -->
      <div class="tree-view ${activeTab === 'rails' ? 'active' : ''}" id="rails-tree-view" data-tab="rails">
        <div id="rails-routes-container">
          ${hasRails ? '<div class="empty-state-sm">Loading Rails routes...</div>' : '<div class="empty-state">No Rails environment detected</div>'}
        </div>
      </div>

      <div class="graph-view" id="graph-view">
        <div class="graph-container">
          <div class="graph-controls">
            <button class="graph-btn" onclick="resetGraph()">Reset</button>
            <button class="graph-btn" onclick="zoomGraph(1.3)">+</button>
            <button class="graph-btn" onclick="zoomGraph(0.7)">-</button>
          </div>
          <div class="graph-info">Drag to pan, scroll to zoom, click node to select</div>
          <canvas id="graph-canvas"></canvas>
        </div>
      </div>
    </div>
  </div>

  <div class="detail" id="detail">
    <div class="detail-header">
      <div class="detail-title" id="detail-title"></div>
      <button class="detail-close" onclick="closeDetail()">×</button>
    </div>
    <div class="detail-body" id="detail-body"></div>
  </div>

  <div class="modal" id="modal" onclick="if(event.target===this)handleModalOutsideClick()">
    <div class="modal-box">
      <div class="modal-head">
        <div style="display:flex;align-items:center;gap:8px">
          <button id="modal-back" class="modal-back" onclick="modalBack()" style="display:none">←</button>
          <h3 id="modal-title"></h3>
        </div>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>

  <script>
    // Environment detection results
    const envInfo = {
      hasRails: ${hasRails},
      hasNextjs: ${hasNextjs},
      hasReact: ${hasReact}
    };

    // Frontend data
    const pages = ${JSON.stringify(allPages)};
    const relations = ${JSON.stringify(relations)};
    const graphqlOps = ${graphqlOpsJson};
    const components = ${componentsJson};
    const apiCallsData = ${JSON.stringify(this.apiCalls)};
    window.apiCalls = apiCallsData;
    const pageMap = new Map(pages.map(p => [p.path, p]));
    const gqlMap = new Map(graphqlOps.map(op => [op.name, op]));
    const compMap = new Map(components.map(c => [c.name, c]));

    // Rails data (if available)
    const railsRoutes = ${railsRoutesJson};
    const railsControllers = ${railsControllersJson};
    const railsModels = ${railsModelsJson};
    const railsViews = ${railsViewsJson};
    const railsReact = ${railsReactJson};
    const railsGrpc = ${railsGrpcJson};
    const railsSummary = ${railsSummaryJson};

    // Current active tab state
    let currentMainTab = '${activeTab}';

    // Modal history stack for back navigation
    const modalHistory = [];

    // Current environment filter
    let currentEnvFilter = 'all';

    function setView(v) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');

      // Hide all tree views
      document.querySelectorAll('.tree-view').forEach(el => el.classList.remove('active'));
      document.getElementById('graph-view').classList.remove('active');

      if (v === 'tree') {
        // Show appropriate tree view based on current main tab
        if (currentMainTab === 'rails') {
          document.getElementById('rails-tree-view').classList.add('active');
        } else {
          document.getElementById('tree-view').classList.add('active');
        }
      } else if (v === 'graph') {
        document.getElementById('graph-view').classList.add('active');
        setTimeout(initGraph, 100);
      }
    }

    // Environment filtering
    function filterByEnv(env) {
      currentEnvFilter = env;

      // Update badge styles
      document.querySelectorAll('.env-badge').forEach(b => {
        b.classList.remove('active', 'env-badge-active');
        if (b.dataset.env === env) {
          b.classList.add('active', 'env-badge-active');
        }
      });

      // Apply filter to page list
      applyEnvFilter();
    }

    function applyEnvFilter() {
      // For now, this affects visibility of stats sections
      const frontendStats = document.getElementById('stats-container');
      const railsStats = document.getElementById('rails-stats');

      if (currentEnvFilter === 'all') {
        if (frontendStats) frontendStats.style.display = '';
        if (railsStats) railsStats.style.display = '';
      } else if (currentEnvFilter === 'nextjs') {
        if (frontendStats) frontendStats.style.display = '';
        if (railsStats) railsStats.style.display = 'none';
      } else if (currentEnvFilter === 'rails') {
        if (frontendStats) frontendStats.style.display = 'none';
        if (railsStats) railsStats.style.display = '';
      }
    }

    // Switch to Rails tab and render routes tree
    function switchToRailsTab() {
      currentMainTab = 'rails';
      // Hide all tree views
      document.querySelectorAll('.tree-view').forEach(el => el.classList.remove('active'));
      // Show Rails tree view
      const railsTreeView = document.getElementById('rails-tree-view');
      if (railsTreeView) {
        railsTreeView.classList.add('active');
      }
      // Hide graph view
      document.getElementById('graph-view')?.classList.remove('active');
      // Ensure list view mode
      setView('tree');
      // Render Rails routes tree
      renderRailsRoutesTree();
    }

    // Rails related functions
    function showRailsRoutes() {
      if (!railsRoutes || railsRoutes.length === 0) {
        showModal('Rails Routes', '<div style="color:var(--text2)">No routes found</div>');
        return;
      }

      const routesByNamespace = new Map();
      railsRoutes.forEach(r => {
        const ns = r.namespace || 'root';
        if (!routesByNamespace.has(ns)) routesByNamespace.set(ns, []);
        routesByNamespace.get(ns).push(r);
      });

      let html = '<div class="max-h-60vh overflow-y-auto">';
      for (const [ns, routes] of routesByNamespace) {
        html += '<div style="margin-bottom:16px">';
        html += '<div style="font-weight:600;margin-bottom:8px;color:var(--accent)">📂 ' + ns + ' (' + routes.length + ')</div>';
        html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
        html += '<tr class="bg-surface"><th class="cell">Method</th><th class="cell">Path</th><th class="cell">Controller#Action</th></tr>';
        routes.slice(0, 20).forEach(r => {
          const methodColor = {GET:'#22c55e',POST:'#3b82f6',PUT:'#f59e0b',PATCH:'#f59e0b',DELETE:'#ef4444'}[r.method] || '#888';
          html += '<tr style="border-bottom:1px solid var(--border)">';
          html += '<td style="padding:6px"><span style="background:' + methodColor + ';color:white;padding:2px 6px;border-radius:3px;font-size:10px">' + r.method + '</span></td>';
          html += '<td style="padding:6px;font-family:monospace">' + r.path.replace(/:([a-z_]+)/g, '<span class="text-warning">:$1</span>') + '</td>';
          html += '<td style="padding:6px;color:var(--text2)">' + r.controller + '#' + r.action + '</td>';
          html += '</tr>';
        });
        if (routes.length > 20) {
          html += '<tr><td colspan="3" style="padding:6px;color:var(--text2)">...and ' + (routes.length - 20) + ' more</td></tr>';
        }
        html += '</table></div>';
      }
      html += '</div>';

      showModal('🛤️ Rails Routes (' + railsRoutes.length + ')', html);
    }

    function showRailsControllers() {
      if (!railsControllers || railsControllers.length === 0) {
        showModal('Rails Controllers', '<div style="color:var(--text2)">No controllers found</div>');
        return;
      }

      let html = '<div class="max-h-60vh overflow-y-auto">';
      railsControllers.forEach(ctrl => {
        html += '<div class="info-box">';
        html += '<div class="section-title">' + ctrl.className + '</div>';
        html += '<div class="hint mb-3">extends ' + ctrl.parentClass + '</div>';
        if (ctrl.actions && ctrl.actions.length > 0) {
          html += '<div class="flex flex-wrap gap-1">';
          ctrl.actions.slice(0, 10).forEach(action => {
            const color = action.visibility === 'public' ? '#22c55e' : action.visibility === 'private' ? '#ef4444' : '#f59e0b';
            html += '<span style="background:rgba(255,255,255,0.1);padding:2px 8px;border-radius:4px;font-size:11px;border-left:2px solid ' + color + '">' + action.name + '</span>';
          });
          if (ctrl.actions.length > 10) html += '<span style="color:var(--text2);font-size:11px">+' + (ctrl.actions.length - 10) + ' more</span>';
          html += '</div>';
        }
        html += '</div>';
      });
      html += '</div>';

      showModal('🎮 Rails Controllers (' + railsControllers.length + ')', html);
    }

    function showRailsModels() {
      if (!railsModels || railsModels.length === 0) {
        showModal('Rails Models', '<div style="color:var(--text2)">No models found</div>');
        return;
      }

      let html = '<div class="max-h-60vh overflow-y-auto">';
      railsModels.forEach(model => {
        html += '<div class="info-box">';
        html += '<div class="section-title">📦 ' + model.className + '</div>';
        html += '<div class="flex gap-3 hint mb-3">';
        html += '<span>📎 ' + (model.associations?.length || 0) + ' associations</span>';
        html += '<span>✓ ' + (model.validations?.length || 0) + ' validations</span>';
        html += '</div>';
        if (model.associations && model.associations.length > 0) {
          html += '<div class="flex flex-wrap gap-1">';
          model.associations.slice(0, 8).forEach(assoc => {
            const typeColor = {belongs_to:'#3b82f6',has_many:'#22c55e',has_one:'#f59e0b'}[assoc.type] || '#888';
            html += '<span style="background:rgba(255,255,255,0.1);padding:2px 8px;border-radius:4px;font-size:10px"><span style="color:' + typeColor + '">' + assoc.type + '</span> :' + assoc.name + '</span>';
          });
          if (model.associations.length > 8) html += '<span style="color:var(--text2);font-size:10px">+' + (model.associations.length - 8) + '</span>';
          html += '</div>';
        }
        html += '</div>';
      });
      html += '</div>';

      showModal('📦 Rails Models (' + railsModels.length + ')', html);
    }

    function showReactComponents() {
      if (!railsReact || !railsReact.components || railsReact.components.length === 0) {
        showModal('React Components', '<div style="color:var(--text2)">No React components found</div>');
        return;
      }

      // Sort by usage count
      const sortedComponents = [...railsReact.components].sort((a, b) =>
        (b.usedIn?.length || 0) - (a.usedIn?.length || 0)
      );

      let html = '<div class="max-h-60vh overflow-y-auto">';

      // Stats
      html += '<div style="display:flex;gap:16px;margin-bottom:16px;padding:12px;background:var(--bg3);border-radius:8px">';
      html += '<div class="text-center"><div style="font-size:20px;font-weight:bold;color:var(--accent)">' + railsReact.summary.totalComponents + '</div><div style="font-size:10px;color:var(--text2)">Components</div></div>';
      html += '<div class="text-center"><div style="font-size:20px;font-weight:bold;color:#22c55e">' + railsReact.summary.ssrComponents + '</div><div style="font-size:10px;color:var(--text2)">SSR</div></div>';
      html += '<div class="text-center"><div style="font-size:20px;font-weight:bold;color:#3b82f6">' + railsReact.summary.clientComponents + '</div><div style="font-size:10px;color:var(--text2)">Client</div></div>';
      html += '<div class="text-center"><div style="font-size:20px;font-weight:bold;color:#f59e0b">' + railsReact.summary.totalEntryPoints + '</div><div style="font-size:10px;color:var(--text2)">Entry Points</div></div>';
      html += '</div>';

      sortedComponents.forEach(comp => {
        const usageCount = comp.usedIn?.length || 0;
        const ssrBadge = comp.ssr ? '<span class="badge-success">SSR</span>' : '';

        html += '<div style="background:var(--bg3);padding:12px;border-radius:6px;margin-bottom:8px;cursor:pointer" onclick="showReactComponentDetail(\\'' + encodeURIComponent(JSON.stringify(comp)) + '\\')">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between">';
        html += '<div style="font-weight:600;display:flex;align-items:center"><span class="text-react mr-2">⚛</span>' + comp.name + ssrBadge + '</div>';
        html += '<span class="hint">' + usageCount + ' usage' + (usageCount !== 1 ? 's' : '') + '</span>';
        html += '</div>';

        // Entry point info
        if (comp.entryFile) {
          html += '<div style="font-size:10px;color:var(--text2);margin-top:4px;font-family:monospace">📥 entries/' + comp.entryFile + '</div>';
        }

        // Source file info
        if (comp.sourceFile) {
          html += '<div style="font-size:10px;color:var(--accent);margin-top:2px;font-family:monospace">📄 ' + comp.sourceFile + '</div>';
        }

        // Usage preview
        if (comp.usedIn && comp.usedIn.length > 0) {
          html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px">';
          comp.usedIn.slice(0, 3).forEach(usage => {
            const patternColor = usage.pattern === 'render_react_component' ? '#22c55e' : '#3b82f6';
            html += '<span style="background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:3px;font-size:10px;border-left:2px solid ' + patternColor + '">' + usage.controller + '/' + usage.action + '</span>';
          });
          if (comp.usedIn.length > 3) {
            html += '<span class="hint-sm">+' + (comp.usedIn.length - 3) + ' more</span>';
          }
          html += '</div>';
        }

        html += '</div>';
      });

      html += '</div>';
      showModal('⚛ React Components (' + railsReact.components.length + ')', html);
    }

    function showReactComponentDetail(encodedData) {
      const comp = JSON.parse(decodeURIComponent(encodedData));

      let html = '';

      // Component Info
      html += '<div class="detail-section">';
      html += '<div class="detail-label">⚛ Component Name</div>';
      html += '<div style="display:flex;align-items:center;gap:8px">';
      html += '<span style="font-family:monospace;font-size:16px;font-weight:600">' + comp.name + '</span>';
      if (comp.ssr) {
        html += '<span style="font-size:10px;background:#22c55e;color:white;padding:2px 6px;border-radius:3px">SSR</span>';
      } else {
        html += '<span style="font-size:10px;background:#3b82f6;color:white;padding:2px 6px;border-radius:3px">Client</span>';
      }
      html += '</div></div>';

      // Entry Point
      if (comp.entryFile) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">📥 Entry Point</div>';
        html += '<div class="code-path">';
        html += comp.entryFile;
        html += '</div></div>';
      }

      // Source File
      if (comp.sourceFile || comp.importPath) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">📄 Source File</div>';
        html += '<div class="code-path" style="color:var(--accent)">';
        html += comp.sourceFile || comp.importPath;
        html += '</div></div>';
      }

      // Usage in Views
      if (comp.usedIn && comp.usedIn.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">📍 Used in Views (' + comp.usedIn.length + ')</div>';
        html += '<div class="detail-items">';

        comp.usedIn.forEach(usage => {
          const patternColor = usage.pattern === 'render_react_component' ? '#22c55e' : '#3b82f6';
          const patternLabel = usage.pattern === 'render_react_component' ? 'render' : 'data';

          html += '<div class="detail-item" style="flex-direction:column;align-items:flex-start;gap:4px">';
          html += '<div style="display:flex;align-items:center;gap:8px;width:100%">';
          html += '<span class="tag" style="background:' + patternColor + ';font-size:9px;flex-shrink:0">' + patternLabel + '</span>';
          html += '<span class="usage-name">' + usage.controller + '#' + usage.action + '</span>';
          if (usage.line) {
            html += '<span class="line-num">L' + usage.line + '</span>';
          }
          html += '</div>';
          html += '<div style="font-size:10px;color:var(--text2);font-family:monospace">app/views/' + usage.viewPath + '</div>';
          if (usage.propsVar) {
            html += '<div style="font-size:10px;color:var(--accent)">props: ' + usage.propsVar + '</div>';
          }
          html += '</div>';
        });

        html += '</div></div>';
      }

      showModal('⚛ ' + comp.name, html, true);
    }

    function showRailsGrpc() {
      if (!railsGrpc || !railsGrpc.services || railsGrpc.services.length === 0) {
        showModal('gRPC Services', '<div style="color:var(--text2)">No gRPC services found</div>');
        return;
      }

      let html = '<div class="max-h-60vh overflow-y-auto">';
      railsGrpc.services.forEach(svc => {
        html += '<div class="info-box">';
        html += '<div class="section-title">🔌 ' + svc.className + '</div>';
        if (svc.namespace) {
          html += '<div class="hint mb-3">namespace: ' + svc.namespace + '</div>';
        }
        if (svc.rpcs && svc.rpcs.length > 0) {
          html += '<div class="flex flex-wrap gap-1">';
          svc.rpcs.slice(0, 15).forEach(rpc => {
            html += '<span class="tag tag-rpc tag-sm">' + rpc.name + '</span>';
          });
          if (svc.rpcs.length > 15) html += '<span style="color:var(--text2);font-size:11px">+' + (svc.rpcs.length - 15) + ' more</span>';
          html += '</div>';
        }
        html += '</div>';
      });
      html += '</div>';

      showModal('🔌 gRPC Services (' + railsGrpc.services.length + ')', html);
    }

    // Render Rails routes in tree view
    function renderRailsRoutesTree() {
      const container = document.getElementById('rails-routes-container');
      if (!container) return;

      // Use pages if available, otherwise fall back to routes
      const pages = (railsViews && railsViews.pages) || [];
      const routes = railsRoutes || [];

      if (pages.length === 0 && routes.length === 0) {
        container.innerHTML = '<div class="empty-state">No Rails pages or routes found</div>';
        return;
      }

      // Build combined data from routes with page info
      const combinedData = [];

      // Map routes to include API info from pages and controller action details
      routes.forEach(route => {
        // Skip redirect routes and complex patterns
        if (route.path.includes('=>') || route.path.includes('redirect{') || route.path.includes('redirect {')) {
          return;
        }
        // Skip routes with unmatched parentheses (malformed patterns)
        if (route.path.includes('(') && !route.path.includes(')')) {
          return;
        }

        const pageInfo = pages.find(p => p.route === route.path && p.method === route.method);

        // Find controller and action details from railsControllers
        let actionDetails = null;
        let controllerInfo = null;
        if (railsControllers && railsControllers.length > 0) {
          // Multiple matching strategies for better accuracy
          const routeCtrl = route.controller; // e.g., "api/v1/users" or "users"
          const routeCtrlParts = routeCtrl.split('/');
          const routeCtrlName = routeCtrlParts.pop().replace(/_/g, ''); // "users"
          const routeNamespace = routeCtrlParts.join('/'); // "api/v1" or ""

          controllerInfo = railsControllers.find(c => {
            // Strategy 1: Match by filePath (most accurate)
            // filePath: "api/v1/users_controller.rb" or "users_controller.rb"
            const filePathNormalized = c.filePath.replace(/_controller\.rb$/, '').replace(/_/g, '');
            if (filePathNormalized === routeCtrl.replace(/_/g, '')) return true;

            // Strategy 2: Match by controller name (without namespace)
            if (c.name === routeCtrlName || c.name.replace(/_/g, '') === routeCtrlName) return true;

            // Strategy 3: Match by className
            const className = c.className.toLowerCase().replace('controller', '').replace(/::/g, '/');
            if (className === routeCtrl.toLowerCase() || className.endsWith('/' + routeCtrlName)) return true;

            // Strategy 4: Partial match as fallback
            const classNameSimple = c.className.toLowerCase().replace('controller', '').split('::').pop();
            return classNameSimple === routeCtrlName.toLowerCase();
          });

          if (controllerInfo) {
            actionDetails = controllerInfo.actions.find(a => a.name === route.action);
          }
        }

        combinedData.push({
          ...route,
          hasView: !!pageInfo?.view,
          view: pageInfo?.view,
          services: pageInfo?.services || actionDetails?.servicesCalled || [],
          grpcCalls: pageInfo?.grpcCalls || [],
          modelAccess: pageInfo?.modelAccess || actionDetails?.modelsCalled || [],
          apis: pageInfo?.apis || [],
          // Enhanced controller action details
          actionDetails: actionDetails ? {
            rendersJson: actionDetails.rendersJson,
            rendersHtml: actionDetails.rendersHtml,
            redirectsTo: actionDetails.redirectsTo,
            respondsTo: actionDetails.respondsTo,
            servicesCalled: actionDetails.servicesCalled || [],
            modelsCalled: actionDetails.modelsCalled || [],
            methodCalls: actionDetails.methodCalls || [],
            visibility: actionDetails.visibility,
            line: actionDetails.line
          } : null,
          controllerInfo: controllerInfo ? {
            className: controllerInfo.className,
            filePath: controllerInfo.filePath,
            parentClass: controllerInfo.parentClass,
            beforeActions: controllerInfo.beforeActions || [],
            afterActions: controllerInfo.afterActions || [],
            concerns: controllerInfo.concerns || [],
            line: controllerInfo.line
          } : null
        });
      });

      // Group by namespace (first path segment)
      const routesByNamespace = new Map();
      combinedData.forEach(r => {
        // Extract clean first segment
        let firstSegment = r.path.split('/').filter(s => s && !s.startsWith(':') && !s.includes('('))[0] || '';
        const ns = r.namespace || (r.path.startsWith('/api/') ? 'api' : firstSegment || 'root');
        if (!routesByNamespace.has(ns)) routesByNamespace.set(ns, []);
        routesByNamespace.get(ns).push(r);
      });

      // Sort namespaces
      const sortedNamespaces = [...routesByNamespace.keys()].sort((a, b) => {
        if (a === 'root') return -1;
        if (b === 'root') return 1;
        return a.localeCompare(b);
      });

      let html = '';
      const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

      // Stats summary - enhanced with response type breakdown
      const totalWithView = combinedData.filter(r => r.hasView).length;
      const totalWithServices = combinedData.filter(r => r.services.length > 0).length;
      const totalWithGrpc = combinedData.filter(r => r.grpcCalls.length > 0).length;
      const totalWithModels = combinedData.filter(r => r.modelAccess.length > 0).length;
      const totalJsonApi = combinedData.filter(r => r.actionDetails?.rendersJson).length;
      const totalHtmlPage = combinedData.filter(r => r.actionDetails?.rendersHtml && !r.actionDetails?.rendersJson).length;
      const totalRedirect = combinedData.filter(r => r.actionDetails?.redirectsTo).length;
      const totalWithActionInfo = combinedData.filter(r => r.actionDetails).length;

      html += '<div class="route-stats-box">';
      // Main stats row - clickable for filtering
      html += '<div class="route-stats-row">';
      html += '<div class="route-stat" data-filter="all"><div class="route-stat-val">' + combinedData.length + '</div><div class="route-stat-label">Total Routes</div></div>';
      html += '<div class="route-stat" data-filter="views"><div class="route-stat-val green">' + totalWithView + '</div><div class="route-stat-label">With Views</div></div>';
      html += '<div class="route-stat" data-filter="json"><div class="route-stat-val blue">' + totalJsonApi + '</div><div class="route-stat-label">JSON APIs</div></div>';
      html += '<div class="route-stat" data-filter="services"><div class="route-stat-val purple">' + totalWithServices + '</div><div class="route-stat-label">With Services</div></div>';
      html += '<div class="route-stat" data-filter="grpc"><div class="route-stat-val cyan">' + totalWithGrpc + '</div><div class="route-stat-label">gRPC</div></div>';
      html += '</div>';
      // Analysis coverage indicator
      if (totalWithActionInfo > 0) {
        const coverage = Math.round((totalWithActionInfo / combinedData.length) * 100);
        const coverageTooltip = 'Percentage of routes successfully matched with controller actions to extract details (JSON/HTML rendering, redirects, etc). This is a tool analysis metric, not a code quality indicator.';
        const coverageClass = coverage > 70 ? 'coverage-high' : coverage > 40 ? 'coverage-mid' : 'coverage-low';
        html += '<div class="coverage-info">';
        html += '<div class="coverage-text" title="' + coverageTooltip + '">Action Details Coverage: <span class="' + coverageClass + '">' + coverage + '%</span> (' + totalWithActionInfo + '/' + combinedData.length + ' routes analyzed) ℹ️</div>';
        html += '</div>';
      }
      html += '</div>';

      sortedNamespaces.forEach((ns, idx) => {
        const routes = routesByNamespace.get(ns);
        const color = colors[idx % colors.length];

        html += '<div class="group">';
        html += '<div class="group-header" onclick="toggleGroup(this)" style="border-left-color:' + color + '">';
        html += '<span class="group-toggle">▼</span>';
        html += '<span class="group-name">📂 ' + ns + '</span>';
        html += '<span class="group-count">' + routes.length + '</span>';
        html += '</div>';
        const routeListId = 'routes-' + ns.replace(/[^a-zA-Z0-9]/g, '-');
        const routeLimit = 50;
        const hasMoreRoutes = routes.length > routeLimit;

        html += '<div class="group-items" id="' + routeListId + '">';

        // Sort by path, then by method
        routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

        routes.forEach((route, idx) => {
          const methodColor = {GET:'#22c55e',POST:'#3b82f6',PUT:'#f59e0b',PATCH:'#f59e0b',DELETE:'#ef4444'}[route.method] || '#888';

          // Clean up path - truncate redirect blocks and long paths
          let displayPath = route.path;
          if (displayPath.includes('=>') || displayPath.includes('redirect')) {
            // Extract just the route pattern before any redirect logic
            const match = displayPath.match(/^([^"]+)"/);
            displayPath = match ? match[1].trim() + ' → redirect' : displayPath.slice(0, 60) + '...';
          }
          if (displayPath.length > 80) {
            displayPath = displayPath.slice(0, 77) + '...';
          }
          const pathHighlighted = displayPath.replace(/:([a-z_]+)/g, '<span class="text-warning">:$1</span>');

          // Indicators for view, API, and response types
          let indicators = '';
          const action = route.actionDetails;
          // Response type indicators
          if (action) {
            if (action.rendersJson) indicators += '<span class="route-tag route-tag-json" title="Returns JSON">JSON</span>';
            if (action.rendersHtml && !action.rendersJson) indicators += '<span class="route-tag route-tag-html" title="Returns HTML">HTML</span>';
            if (action.redirectsTo) indicators += '<span class="route-tag route-tag-redirect" title="Redirects">→</span>';
          }
          if (route.hasView) indicators += '<span class="route-tag route-tag-view" title="Has View Template">View</span>';
          if (route.services.length > 0) indicators += '<span class="route-tag route-tag-svc" title="Uses Services: ' + route.services.join(', ') + '">Svc</span>';
          if (route.grpcCalls.length > 0) indicators += '<span class="route-tag route-tag-grpc" title="gRPC Calls: ' + route.grpcCalls.join(', ') + '">gRPC</span>';
          if (route.modelAccess.length > 0) indicators += '<span class="route-tag route-tag-db" title="Model Access: ' + route.modelAccess.join(', ') + '">DB</span>';

          // Search-friendly data-path and filter attributes
          const searchPath = [route.path || '', route.controller || '', route.action || '', route.method || ''].join(' ').toLowerCase();
          const hiddenAttr = idx >= routeLimit ? ' data-hidden="true"' : '';
          const hiddenStyle = idx >= routeLimit ? 'display:none;' : '';

          // Filter data attributes
          const filterAttrs = [];
          if (route.hasView) filterAttrs.push('data-has-view="true"');
          if (action && action.rendersJson) filterAttrs.push('data-json="true"');
          if (route.services.length > 0) filterAttrs.push('data-services="true"');
          if (route.grpcCalls.length > 0) filterAttrs.push('data-grpc="true"');

          html += '<div class="page-item rails-route-item" data-path="' + searchPath + '"' + hiddenAttr + ' ' + filterAttrs.join(' ') + ' onclick="showRailsRouteDetail(\\''+encodeURIComponent(JSON.stringify(route))+'\\', true)" style="cursor:pointer;' + hiddenStyle + '">';
          html += '<span class="page-type" style="background:' + methodColor + ';min-width:50px;text-align:center">' + route.method + '</span>';
          html += '<span class="page-path">' + pathHighlighted + '</span>';
          html += indicators;
          html += '</div>';
        });

        html += '</div>';

        if (hasMoreRoutes) {
          html += '<div id="' + routeListId + '-more" style="padding:8px 12px;cursor:pointer;color:var(--accent);font-size:11px" onclick="toggleMoreItems(\\'' + routeListId + '\\', ' + routes.length + ')">▼ Show ' + (routes.length - routeLimit) + ' more routes</div>';
        }

        html += '</div>';
      });

      container.innerHTML = html;

      // Attach route stat filter click handlers
      container.querySelectorAll('.route-stat').forEach(stat => {
        stat.addEventListener('click', function() {
          const filterType = this.dataset.filter;
          applyRouteFilter(filterType);

          // Update active state
          container.querySelectorAll('.route-stat').forEach(s => s.style.background = 'transparent');
          if (filterType !== 'all') this.style.background = 'var(--bg2)';
        });
      });
    }

    // Apply route filter
    let currentRouteFilter = 'all';
    function applyRouteFilter(filterType) {
      currentRouteFilter = filterType;
      const routeItems = document.querySelectorAll('.rails-route-item');

      routeItems.forEach(item => {
        let shouldShow = true;

        if (filterType === 'views') {
          shouldShow = item.dataset.hasView === 'true';
        } else if (filterType === 'json') {
          shouldShow = item.dataset.json === 'true';
        } else if (filterType === 'services') {
          shouldShow = item.dataset.services === 'true';
        } else if (filterType === 'grpc') {
          shouldShow = item.dataset.grpc === 'true';
        }
        // 'all' shows everything

        if (shouldShow) {
          item.style.display = '';
          item.removeAttribute('data-filtered');
        } else {
          item.style.display = 'none';
          item.dataset.filtered = 'true';
        }
      });

      // Update group visibility (hide empty groups)
      document.querySelectorAll('#rails-routes-container .group').forEach(group => {
        const visibleItems = group.querySelectorAll('.rails-route-item:not([data-filtered="true"])');
        group.style.display = visibleItems.length > 0 ? '' : 'none';
      });
    }

    // Show Rails route detail
    function showRailsRouteDetail(dataOrPath, isFullData) {
      let route;
      if (isFullData) {
        route = JSON.parse(decodeURIComponent(dataOrPath));
      } else {
        // Legacy support
        route = { path: dataOrPath, method: arguments[1], controller: arguments[2], action: arguments[3], line: arguments[4] };
      }

      const methodColor = {GET:'#22c55e',POST:'#3b82f6',PUT:'#f59e0b',PATCH:'#f59e0b',DELETE:'#ef4444'}[route.method] || '#888';
      const action = route.actionDetails;
      const ctrl = route.controllerInfo;

      let html = '<div class="detail-section">';
      html += '<div class="detail-label">Method</div>';
      html += '<div class="detail-value"><span style="background:' + methodColor + ';color:white;padding:4px 12px;border-radius:4px;font-weight:600">' + route.method + '</span></div>';
      html += '</div>';

      html += '<div class="detail-section">';
      html += '<div class="detail-label">Path</div>';
      html += '<div class="detail-value" style="font-family:monospace">' + route.path.replace(/:([a-z_]+)/g, '<span class="text-warning">:$1</span>') + '</div>';
      html += '</div>';

      html += '<div class="detail-section">';
      html += '<div class="detail-label">Controller#Action</div>';
      html += '<div class="detail-value">' + route.controller + '#' + route.action + '</div>';
      html += '</div>';

      // Response Type - NEW
      if (action) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">📡 Response Type</div>';
        html += '<div class="detail-value">';
        const responseTypes = [];
        if (action.rendersJson) responseTypes.push('<span style="background:#3b82f6;color:white;padding:2px 8px;border-radius:4px;font-size:11px;margin-right:4px">JSON</span>');
        if (action.rendersHtml) responseTypes.push('<span style="background:#22c55e;color:white;padding:2px 8px;border-radius:4px;font-size:11px;margin-right:4px">HTML</span>');
        if (action.redirectsTo) responseTypes.push('<span style="background:#f59e0b;color:white;padding:2px 8px;border-radius:4px;font-size:11px;margin-right:4px">Redirect</span>');
        if (action.respondsTo && action.respondsTo.length > 0) {
          action.respondsTo.forEach(f => {
            responseTypes.push('<span style="background:#8b5cf6;color:white;padding:2px 8px;border-radius:4px;font-size:11px;margin-right:4px">' + f.toUpperCase() + '</span>');
          });
        }
        html += responseTypes.length > 0 ? responseTypes.join('') : '<span class="text-muted">Unknown</span>';
        html += '</div></div>';

        // Redirect destination if exists
        if (action.redirectsTo) {
          html += '<div class="detail-section">';
          html += '<div class="detail-label">↪️ Redirects To</div>';
          html += '<div class="detail-value-block">' + action.redirectsTo + '</div>';
          html += '</div>';
        }
      }

      // View info
      if (route.hasView && route.view) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">📄 View Template</div>';
        html += '<div class="detail-value">app/views/' + route.view.path + '</div>';
        if (route.view.partials && route.view.partials.length > 0) {
          html += '<div class="subtext">Partials: ' + route.view.partials.slice(0, 5).join(', ') + (route.view.partials.length > 5 ? '...' : '') + '</div>';
        }
        if (route.view.instanceVars && route.view.instanceVars.length > 0) {
          html += '<div style="margin-top:4px;font-size:11px;color:var(--text2)">Instance vars: @' + route.view.instanceVars.slice(0, 5).join(', @') + (route.view.instanceVars.length > 5 ? '...' : '') + '</div>';
        }
        html += '</div>';
      }

      // Before/After Filters - NEW
      if (ctrl && (ctrl.beforeActions.length > 0 || ctrl.afterActions.length > 0)) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">🔒 Filters Applied to This Action</div>';
        html += '<div class="code-block">';

        // Filter before_actions that apply to this action
        const applicableBeforeFilters = ctrl.beforeActions.filter(f => {
          if (f.only && f.only.length > 0) return f.only.includes(route.action);
          if (f.except && f.except.length > 0) return !f.except.includes(route.action);
          return true;
        });

        if (applicableBeforeFilters.length > 0) {
          html += '<div style="font-size:11px;margin-bottom:6px"><span style="color:#22c55e;font-weight:600">Before:</span></div>';
          html += '<div class="detail-items" style="margin-left:8px">';
          applicableBeforeFilters.forEach(f => {
            let filterInfo = '<span class="tag tag-before tag-sm">before</span><span class="name">' + f.name + '</span>';
            if (f.if) filterInfo += '<span style="font-size:10px;color:var(--text2);margin-left:4px">if: ' + f.if + '</span>';
            if (f.unless) filterInfo += '<span style="font-size:10px;color:var(--text2);margin-left:4px">unless: ' + f.unless + '</span>';
            html += '<div class="detail-item">' + filterInfo + '</div>';
          });
          html += '</div>';
        }

        const applicableAfterFilters = ctrl.afterActions.filter(f => {
          if (f.only && f.only.length > 0) return f.only.includes(route.action);
          if (f.except && f.except.length > 0) return !f.except.includes(route.action);
          return true;
        });

        if (applicableAfterFilters.length > 0) {
          html += '<div style="font-size:11px;margin-top:8px;margin-bottom:6px"><span style="color:#f59e0b;font-weight:600">After:</span></div>';
          html += '<div class="detail-items" style="margin-left:8px">';
          applicableAfterFilters.forEach(f => {
            let filterInfo = '<span class="tag tag-after tag-sm">after</span><span class="name">' + f.name + '</span>';
            html += '<div class="detail-item">' + filterInfo + '</div>';
          });
          html += '</div>';
        }

        if (applicableBeforeFilters.length === 0 && applicableAfterFilters.length === 0) {
          html += '<div style="font-size:11px;color:var(--text2)">No filters applied to this action</div>';
        }
        html += '</div></div>';
      }

      // Services Used - Enhanced
      const services = route.services && route.services.length > 0 ? route.services : (action?.servicesCalled || []);
      if (services.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">⚙️ Services Called</div>';
        html += '<div class="detail-items">';
        services.forEach(s => {
          html += '<div class="detail-item"><span class="tag tag-service">Service</span><span class="name">' + s + '</span></div>';
        });
        html += '</div></div>';
      }

      // gRPC Calls
      if (route.grpcCalls && route.grpcCalls.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">🔌 gRPC Calls</div>';
        html += '<div class="detail-items">';
        route.grpcCalls.forEach(g => {
          html += '<div class="detail-item"><span class="tag tag-grpc">gRPC</span><span class="name">' + g + '</span></div>';
        });
        html += '</div></div>';
      }

      // Model Access - Enhanced
      const models = route.modelAccess && route.modelAccess.length > 0 ? route.modelAccess : (action?.modelsCalled || []);
      if (models.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">💾 Models Accessed</div>';
        html += '<div class="detail-items">';
        models.forEach(m => {
          html += '<div class="detail-item"><span class="tag tag-model">Model</span><span class="name">' + m + '</span></div>';
        });
        html += '</div></div>';
      }

      // Method Calls Chain - NEW
      if (action && action.methodCalls && action.methodCalls.length > 0) {
        // Filter out common Rails internals and show meaningful calls
        const meaningfulCalls = action.methodCalls.filter(c => {
          const skip = ['params', 'respond_to', 'render', 'redirect_to', 'head', 'flash', 'session', 'cookies'];
          return !skip.some(s => c.startsWith(s + '.') || c === s);
        }).slice(0, 15);

        if (meaningfulCalls.length > 0) {
          html += '<div class="detail-section">';
          html += '<div class="detail-label">🔗 Method Calls in Action</div>';
          html += '<div style="background:var(--bg3);padding:10px;border-radius:6px;margin-top:6px;max-height:150px;overflow-y:auto">';
          html += '<div style="font-family:monospace;font-size:11px;line-height:1.6">';
          meaningfulCalls.forEach((call, i) => {
            html += '<div class="accordion-item">';
            html += '<span style="color:var(--text2);margin-right:8px">' + (i+1) + '.</span>';
            html += '<span class="text-accent">' + call + '</span>';
            html += '</div>';
          });
          if (action.methodCalls.length > 15) {
            html += '<div class="note">...and ' + (action.methodCalls.length - 15) + ' more calls</div>';
          }
          html += '</div></div></div>';
        }
      }

      // Source Files - NEW
      html += '<div class="detail-section">';
      html += '<div class="detail-label">📁 Source Files</div>';
      html += '<div style="background:var(--bg3);padding:10px;border-radius:6px;margin-top:6px;font-family:monospace;font-size:11px">';

      if (route.line > 0) {
        html += '<div class="detail-item flex items-center py-1">';
        html += '<span class="text-muted w-20">Route:</span>';
        html += '<span>config/routes.rb:<span class="text-success">' + route.line + '</span></span>';
        html += '</div>';
      }

      if (ctrl) {
        html += '<div class="detail-item flex items-center py-1">';
        html += '<span class="text-muted w-20">Controller:</span>';
        html += '<span>app/controllers/' + ctrl.filePath;
        if (action && action.line) html += ':<span class="text-success">' + action.line + '</span>';
        html += '</span></div>';
      }

      if (route.hasView && route.view) {
        html += '<div class="detail-item flex items-center py-1">';
        html += '<span class="text-muted w-20">View:</span>';
        html += '<span>app/views/' + route.view.path + '</span>';
        html += '</div>';
      }
      html += '</div></div>';

      // Controller Info Summary
      if (ctrl) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">📋 Controller Info</div>';
        html += '<div class="code-block">';
        html += '<div class="section-title">' + ctrl.className + '</div>';
        html += '<div style="font-size:11px;color:var(--text2)">extends ' + ctrl.parentClass + '</div>';
        if (ctrl.concerns && ctrl.concerns.length > 0) {
          html += '<div style="margin-top:6px;font-size:11px">';
          html += '<span class="text-muted">Concerns:</span> ' + ctrl.concerns.join(', ');
          html += '</div>';
        }
        html += '</div></div>';
      }

      showModal(route.method + ' ' + route.path, html);
    }

    // Initialize Rails view on page load
    if (currentMainTab === 'rails') {
      setTimeout(renderRailsRoutesTree, 100);
    }

    // For page-map: show Rails views/pages when no Next.js pages
    if (currentMainTab === 'pages' && envInfo.hasRails) {
      setTimeout(renderRailsPagesInPageMap, 100);
      setTimeout(renderReactComponentsInPageMap, 150);
    }

    // Render React components used in Rails views as a list
    function renderReactComponentsInPageMap() {
      const container = document.getElementById('page-map-react-components-section');
      if (!container) return;

      const components = (railsReact && railsReact.components) || [];
      if (components.length === 0) {
        container.innerHTML = '';
        return;
      }

      // Sort by usage count
      const sortedComponents = [...components].sort((a, b) =>
        (b.usedIn?.length || 0) - (a.usedIn?.length || 0)
      );

      const ssrCount = components.filter(c => c.ssr).length;
      const withUsageCount = components.filter(c => c.usedIn && c.usedIn.length > 0).length;

      let html = '';
      html += '<div class="info-box mb-3">';
      html += '<div style="font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px"><span style="color:#61dafb">⚛</span> React Components (from Rails)</div>';
      html += '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text2)">';
      html += '<span>' + components.length + ' components</span>';
      html += '<span>•</span>';
      html += '<span class="text-success">' + ssrCount + ' SSR</span>';
      html += '<span>•</span>';
      html += '<span style="color:#3b82f6">' + (components.length - ssrCount) + ' client</span>';
      html += '<span>•</span>';
      html += '<span style="color:#8b5cf6">' + withUsageCount + ' with usage</span>';
      html += '</div></div>';

      // Group by entry point presence (filter out components without name)
      const validComponents = sortedComponents.filter(c => c.name && typeof c.name === 'string');
      const withEntry = validComponents.filter(c => c.entryFile);
      const withoutEntry = validComponents.filter(c => !c.entryFile);

      // Render components with entry points
      if (withEntry.length > 0) {
        html += '<div class="group" data-group="react-with-entry">';
        html += '<div class="group-header" onclick="toggleGroup(this)">';
        html += '<span class="group-toggle">▼</span>';
        html += '<span style="color:#61dafb;margin-right:4px">📥</span>';
        html += '<span class="group-name">With Entry Points (' + withEntry.length + ')</span>';
        html += '</div>';
        html += '<div class="group-items">';

        withEntry.forEach(comp => {
          const usageCount = comp.usedIn?.length || 0;
          const tags = [];
          if (comp.ssr) tags.push('<span class="tag tag-ssr" title="Server-Side Rendering">SSR</span>');
          if (usageCount > 0) tags.push('<span class="tag tag-view" title="Used in ' + usageCount + ' view(s)">View:' + usageCount + '</span>');
          if (comp.sourceFile) tags.push('<span class="tag tag-src" title="Has source file">SRC</span>');

          // Find URL from routes based on controller/action OR infer from entry file
          let urlInfo = '';
          if (comp.usedIn && comp.usedIn.length > 0) {
            const usage = comp.usedIn[0];
            // Construct proper Rails URL: /controller for index, /controller/action for others
            if (usage.action === 'index') {
              urlInfo = '/' + usage.controller.replace(/_/g, '/');
            } else if (usage.action === 'show') {
              urlInfo = '/' + usage.controller.replace(/_/g, '/') + '/:id';
            } else {
              urlInfo = '/' + usage.controller.replace(/_/g, '/') + '/' + usage.action;
            }
          } else if (comp.entryFile) {
            // Infer URL from entry file name (e.g., tickets.tsx → /tickets)
            const fileName = comp.entryFile.split('/').pop().replace(/\\.(tsx?|jsx?)$/, '');
            urlInfo = '/' + fileName.replace(/_/g, '-');
          }

          html += '<div class="page-item" data-path="' + comp.name.toLowerCase() + '" onclick="showReactComponentDetail(\\'' + encodeURIComponent(JSON.stringify(comp)) + '\\')">';
          html += '<div class="page-info">';
          html += '<span class="page-name" style="display:flex;align-items:center"><span class="text-react mr-2">⚛</span>' + comp.name + '</span>';
          html += '<span class="page-path" style="font-size:10px;color:var(--accent)">' + urlInfo + '</span>';
          html += '</div>';
          html += '<div class="page-tags">' + tags.join('') + '</div>';
          html += '</div>';
        });

        html += '</div></div>';
      }

      // Render components without entry points (found only in views)
      if (withoutEntry.length > 0) {
        html += '<div class="group" data-group="react-view-only">';
        html += '<div class="group-header" onclick="toggleGroup(this)">';
        html += '<span class="group-toggle">▼</span>';
        html += '<span style="color:#f59e0b;margin-right:4px">👁️</span>';
        html += '<span class="group-name">View-only Components (' + withoutEntry.length + ')</span>';
        html += '</div>';
        html += '<div class="group-items">';

        withoutEntry.forEach(comp => {
          const usageCount = comp.usedIn?.length || 0;
          const tags = [];
          if (comp.ssr) tags.push('<span class="tag tag-ssr" title="Server-Side Rendering">SSR</span>');
          if (usageCount > 0) tags.push('<span class="tag tag-view" title="Used in ' + usageCount + ' view(s)">View:' + usageCount + '</span>');

          // Find URL from routes based on controller/action
          let urlInfo = '';
          if (comp.usedIn && comp.usedIn.length > 0) {
            const usage = comp.usedIn[0];
            // Construct proper Rails URL
            if (usage.action === 'index') {
              urlInfo = '/' + usage.controller.replace(/_/g, '/');
            } else if (usage.action === 'show') {
              urlInfo = '/' + usage.controller.replace(/_/g, '/') + '/:id';
            } else {
              urlInfo = '/' + usage.controller.replace(/_/g, '/') + '/' + usage.action;
            }
          }

          html += '<div class="page-item" data-path="' + comp.name.toLowerCase() + '" onclick="showReactComponentDetail(\\'' + encodeURIComponent(JSON.stringify(comp)) + '\\')">';
          html += '<div class="page-info">';
          html += '<span class="page-name" style="display:flex;align-items:center"><span class="text-react mr-2">⚛</span>' + comp.name + '</span>';
          html += '<span class="page-path" style="font-size:10px;color:var(--accent)">' + (urlInfo || 'View-only') + '</span>';
          html += '</div>';
          html += '<div class="page-tags">' + tags.join('') + '</div>';
          html += '</div>';
        });

        html += '</div></div>';
      }

      container.innerHTML = html;
    }

    // Render Rails pages in page-map view - based on actual VIEW TEMPLATES (real screens)
    function renderRailsPagesInPageMap() {
      const container = document.getElementById('page-map-rails-section');
      if (!container) return;

      // Use VIEWS as the source of truth for actual screens (not routes)
      const views = (railsViews && railsViews.views) || [];
      const routes = railsRoutes || [];

      // Filter to only HTML views (actual screens users see)
      const htmlViews = views.filter(v => {
        // Only HTML format views are actual pages
        if (v.format !== 'html') return false;
        // Skip partials (they start with _)
        if (v.name.startsWith('_')) return false;
        // Skip mailer views
        if (v.controller.includes('mailer')) return false;
        return true;
      });

      if (htmlViews.length === 0) {
        container.innerHTML = '';
        return;
      }

      // Enrich views with route and controller info
      const enrichedViews = htmlViews.map(view => {
        // Find matching route for URL path
        const matchingRoute = routes.find(r =>
          r.controller === view.controller && r.action === view.action && r.method === 'GET'
        );

        // Find controller info
        const ctrlName = view.controller.split('/').pop().replace(/_/g, '');
        const ctrl = railsControllers?.find(c => {
          if (c.name === view.controller || c.name === ctrlName) return true;
          const filePathNormalized = c.filePath.replace(/_controller\.rb$/, '').replace(/_/g, '');
          return filePathNormalized === view.controller.replace(/_/g, '');
        });
        const action = ctrl?.actions?.find(a => a.name === view.action);

        // Find page info from railsViews.pages
        const pageInfo = (railsViews.pages || []).find(p =>
          p.controller === view.controller && p.action === view.action
        );

        return {
          // View info
          viewPath: view.path,
          viewName: view.name,
          template: view.template,
          partials: view.partials || [],
          instanceVars: view.instanceVars || [],
          helpers: view.helpers || [],
          reactComponents: view.reactComponents || [],
          // Route info
          path: matchingRoute?.path || '/' + view.controller + '/' + view.action,
          method: matchingRoute?.method || 'GET',
          controller: view.controller,
          action: view.action,
          hasRoute: !!matchingRoute,
          // Controller action info
          services: pageInfo?.services || action?.servicesCalled || [],
          grpcCalls: pageInfo?.grpcCalls || [],
          modelAccess: pageInfo?.modelAccess || action?.modelsCalled || [],
          apis: pageInfo?.apis || [],
          methodCalls: action?.methodCalls || [],
          redirectsTo: action?.redirectsTo,
          // Instance variable assignments from controller
          instanceVarAssignments: action?.instanceVarAssignments || [],
          // Controller info for detail view
          controllerInfo: ctrl ? {
            className: ctrl.className,
            filePath: ctrl.filePath,
            beforeActions: ctrl.beforeActions || [],
            afterActions: ctrl.afterActions || []
          } : null,
          actionLine: action?.line
        };
      });

      // Group by controller (representing different sections/features)
      const viewsByController = new Map();
      enrichedViews.forEach(v => {
        const ctrl = v.controller.split('/')[0]; // First part of controller path
        if (!viewsByController.has(ctrl)) viewsByController.set(ctrl, []);
        viewsByController.get(ctrl).push(v);
      });

      const sortedControllers = [...viewsByController.keys()].sort();
      const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

      // Stats
      const totalWithServices = enrichedViews.filter(v => v.services.length > 0 || v.grpcCalls.length > 0).length;
      const totalWithPartials = enrichedViews.filter(v => v.partials.length > 0).length;

      let html = '';
      html += '<div class="info-box mb-3">';
      html += '<div style="font-weight:600;margin-bottom:8px">🖼️ Rails Screens (View Templates)</div>';
      html += '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text2)">';
      html += '<span>' + enrichedViews.length + ' screens</span>';
      html += '<span>•</span>';
      html += '<span>' + sortedControllers.length + ' sections</span>';
      html += '<span>•</span>';
      html += '<span style="color:#8b5cf6">' + totalWithServices + ' with services</span>';
      html += '<span>•</span>';
      html += '<span style="color:#06b6d4">' + totalWithPartials + ' with partials</span>';
      html += '</div></div>';

      sortedControllers.forEach((ctrl, idx) => {
        const controllerViews = viewsByController.get(ctrl) || [];
        const color = colors[idx % colors.length];

        const screenListId = 'screens-' + ctrl.replace(/[^a-zA-Z0-9]/g, '-');
        const screenLimit = 30;
        const hasMoreScreens = controllerViews.length > screenLimit;

        html += '<div class="group">';
        html += '<div class="group-header" onclick="toggleGroup(this)" style="border-left-color:' + color + '">';
        html += '<span class="group-toggle">▼</span>';
        html += '<span class="group-name">📁 ' + ctrl + '</span>';
        html += '<span class="group-count">' + controllerViews.length + ' screens</span>';
        html += '</div>';
        html += '<div class="group-items" id="' + screenListId + '">';

        // Sort by action name
        controllerViews.sort((a, b) => a.action.localeCompare(b.action));

        controllerViews.forEach((view, idx) => {
          // Build indicators
          let indicators = '';
          indicators += '<span class="route-tag route-tag-template" title="' + view.template.toUpperCase() + ' template">' + view.template.toUpperCase() + '</span>';
          if (view.reactComponents && view.reactComponents.length > 0) {
            const rcNames = view.reactComponents.map(rc => rc.name).slice(0, 2).join(', ') + (view.reactComponents.length > 2 ? '...' : '');
            indicators += '<span class="route-tag route-tag-react" title="React: ' + rcNames + '">⚛ ' + view.reactComponents.length + '</span>';
          }
          if (view.partials.length > 0) indicators += '<span class="route-tag route-tag-partials" title="Uses partials: ' + view.partials.slice(0,3).join(', ') + (view.partials.length > 3 ? '...' : '') + '">🧩 ' + view.partials.length + '</span>';
          if (view.instanceVars.length > 0) indicators += '<span class="route-tag route-tag-vars" title="Instance vars: @' + view.instanceVars.slice(0,5).join(', @') + '">📦 ' + view.instanceVars.length + '</span>';
          if (view.services.length > 0) indicators += '<span class="route-tag route-tag-svc" title="Services: ' + view.services.join(', ') + '">Svc</span>';
          if (view.grpcCalls.length > 0) indicators += '<span class="route-tag route-tag-grpc" title="gRPC: ' + view.grpcCalls.join(', ') + '">gRPC</span>';
          if (view.modelAccess.length > 0) indicators += '<span class="route-tag route-tag-db" title="Models: ' + view.modelAccess.join(', ') + '">DB</span>';
          if (!view.hasRoute) indicators += '<span class="route-tag route-tag-warn" title="No matching route found">⚠️</span>';

          // Display: URL path (if route exists) or controller/action
          const displayName = view.hasRoute ? view.path.replace(/:([a-z_]+)/g, '<span class="text-warning">:$1</span>') : view.controller + '#' + view.action;

          // Search-friendly data-path includes path, controller, action
          const searchPath = [view.path || '', view.controller || '', view.action || '', view.viewPath || ''].join(' ').toLowerCase();

          const hiddenAttr = idx >= screenLimit ? ' data-hidden="true"' : '';
          const hiddenStyle = idx >= screenLimit ? 'display:none;' : '';
          html += '<div class="page-item" data-path="' + searchPath + '"' + hiddenAttr + ' onclick="showRailsScreenDetail(\\'' + encodeURIComponent(JSON.stringify(view)) + '\\')" style="cursor:pointer;' + hiddenStyle + '">';
          html += '<span class="page-type" style="background:#22c55e;min-width:50px;text-align:center">SCREEN</span>';
          html += '<span class="page-path" style="font-family:monospace;font-size:12px;flex:1">' + displayName + '</span>';
          html += indicators;
          html += '</div>';
        });

        html += '</div>';

        if (hasMoreScreens) {
          html += '<div id="' + screenListId + '-more" style="padding:8px 12px;cursor:pointer;color:var(--accent);font-size:11px" onclick="toggleMoreItems(\\'' + screenListId + '\\', ' + controllerViews.length + ')">';
          html += '▼ Show ' + (controllerViews.length - screenLimit) + ' more screens';
          html += '</div>';
        }

        html += '</div>';
      });

      container.innerHTML = html;
    }

    // Show Rails screen detail (view-centric)
    function showRailsScreenDetail(encodedData) {
      const screen = JSON.parse(decodeURIComponent(encodedData));

      let html = '';

      // URL/Route info
      html += '<div class="detail-section">';
      html += '<div class="detail-label">🌐 URL Path</div>';
      if (screen.hasRoute) {
        html += '<div class="detail-value" style="font-family:monospace">' + screen.path.replace(/:([a-z_]+)/g, '<span class="text-warning">:$1</span>') + '</div>';
      } else {
        html += '<div class="detail-value" style="color:var(--text2)">No route defined (orphan view)</div>';
      }
      html += '</div>';

      // View Template info
      html += '<div class="detail-section">';
      html += '<div class="detail-label">📄 View Template</div>';
      html += '<div style="background:var(--bg3);padding:10px;border-radius:6px;margin-top:6px;font-family:monospace;font-size:12px">';
      html += '<div style="color:var(--accent)">app/views/' + screen.viewPath + '</div>';
      html += '<div style="margin-top:6px;display:flex;gap:8px">';
      html += '<span style="background:#6b7280;color:white;padding:2px 6px;border-radius:3px;font-size:10px">' + screen.template.toUpperCase() + '</span>';
      html += '</div></div></div>';

      // Instance Variables (data passed to view) with type info
      if (screen.instanceVars && screen.instanceVars.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">📦 Data Available in View (@variables)</div>';

        // Build assignment map from controller analysis
        const assignmentMap = {};
        if (screen.instanceVarAssignments) {
          screen.instanceVarAssignments.forEach(a => {
            assignmentMap[a.name] = a;
          });
        }

        // Initial display limit
        const initialLimit = 15;
        const hasMore = screen.instanceVars.length > initialLimit;
        const listId = 'ivars-' + Math.random().toString(36).substr(2, 9);

        // Build model name lookup from railsModels
        const modelNames = new Set((railsModels || []).map(m => m.className));
        const modelNameLower = new Map((railsModels || []).map(m => [m.className.toLowerCase(), m.className]));

        // Function to find matching model for a variable name
        function findModelForVar(varName) {
          // Direct match: @company → Company
          const pascalCase = varName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
          if (modelNames.has(pascalCase)) return { model: pascalCase, confidence: 'exact' };

          // Singular form: @companies → Company
          const singular = varName.replace(/ies$/, 'y').replace(/s$/, '');
          const singularPascal = singular.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
          if (modelNames.has(singularPascal)) return { model: singularPascal, confidence: 'plural' };

          // current_X pattern: @current_user → User
          if (varName.startsWith('current_')) {
            const rest = varName.replace('current_', '');
            const restPascal = rest.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
            if (modelNames.has(restPascal)) return { model: restPascal, confidence: 'current' };
          }

          // Fuzzy match
          const lowered = singularPascal.toLowerCase();
          if (modelNameLower.has(lowered)) return { model: modelNameLower.get(lowered), confidence: 'fuzzy' };

          return null;
        }

        html += '<div class="detail-items" id="' + listId + '">';
        screen.instanceVars.forEach((v, idx) => {
          const assignment = assignmentMap[v];
          const hiddenClass = idx >= initialLimit ? ' style="display:none" data-hidden="true"' : '';

          // First try assignment from controller analysis, then infer from model list
          let linkedModel = null;
          let linkedType = null;
          let confidence = '';

          if (assignment && assignment.assignedType) {
            linkedType = assignment.assignedType;
            if (linkedType.startsWith('Service:')) {
              linkedModel = { type: 'service', name: linkedType.replace('Service:', '') };
            } else if (linkedType.includes('.')) {
              linkedModel = { type: 'assoc', name: linkedType };
            } else {
              linkedModel = { type: 'model', name: linkedType };
            }
            confidence = 'analyzed';
          } else {
            // Infer from variable name using model list
            const inferred = findModelForVar(v);
            if (inferred) {
              linkedModel = { type: 'model', name: inferred.model };
              confidence = inferred.confidence;
            }
          }

          const tooltip = assignment && assignment.assignedValue ? assignment.assignedValue.replace(/"/g, '&quot;') : '';
          html += '<div class="detail-item"' + hiddenClass + ' title="' + tooltip + '">';
          html += '<span class="tag tag-var tag-sm">@</span>';
          html += '<span class="name" style="font-family:monospace;font-weight:500">' + v + '</span>';

          if (linkedModel) {
            let typeColor, typeLabel;
            if (linkedModel.type === 'service') {
              typeColor = '#8b5cf6'; typeLabel = 'Service';
            } else if (linkedModel.type === 'assoc') {
              typeColor = '#3b82f6'; typeLabel = 'Assoc';
            } else {
              typeColor = '#f59e0b'; typeLabel = 'Model';
            }

            // Show confidence indicator for inferred types
            const opacityStyle = confidence !== 'analyzed' && confidence !== 'exact' ? 'opacity:0.8;' : '';
            const confidenceIcon = confidence === 'analyzed' ? '' : (confidence === 'exact' ? '' : ' ?');

            html += '<span style="margin-left:auto;display:flex;align-items:center;gap:4px">';
            html += '<span style="font-size:9px;color:var(--text2)">' + typeLabel + ':</span>';
            html += '<span style="font-size:11px;background:' + typeColor + ';color:white;padding:2px 8px;border-radius:4px;font-weight:500;' + opacityStyle + '">' + linkedModel.name + confidenceIcon + '</span>';
            html += '</span>';
          }

          html += '</div>';
        });
        html += '</div>';

        // "Show more" button
        if (hasMore) {
          html += '<div id="' + listId + '-more" style="margin-top:8px;cursor:pointer;color:var(--accent);font-size:11px" onclick="toggleMoreItems(\\'' + listId + '\\', ' + screen.instanceVars.length + ')">';
          html += '▼ Show ' + (screen.instanceVars.length - initialLimit) + ' more variables';
          html += '</div>';
        }

        html += '</div>';
      }

      // React Components loaded in this view
      if (screen.reactComponents && screen.reactComponents.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">⚛️ React Components</div>';
        html += '<div class="detail-items">';
        screen.reactComponents.forEach(rc => {
          html += '<div class="detail-item">';
          html += '<span class="tag tag-react tag-sm" style="font-weight:600">React</span>';
          html += '<span class="name" style="font-family:monospace;font-weight:500">' + rc.name + '</span>';
          if (rc.ssr) {
            html += '<span class="badge-success">SSR</span>';
          }
          if (rc.propsVar) {
            html += '<span style="margin-left:auto;font-size:10px;color:var(--text2);font-family:monospace">props: ' + rc.propsVar + '</span>';
          }
          html += '</div>';
        });
        html += '</div></div>';
      }

      // Partials used
      if (screen.partials && screen.partials.length > 0) {
        const partialLimit = 10;
        const hasMorePartials = screen.partials.length > partialLimit;
        const partialListId = 'partials-' + Math.random().toString(36).substr(2, 9);

        html += '<div class="detail-section">';
        html += '<div class="detail-label">🧩 Partials Used (' + screen.partials.length + ')</div>';
        html += '<div class="detail-items" id="' + partialListId + '">';
        screen.partials.forEach((p, idx) => {
          const hiddenClass = idx >= partialLimit ? ' style="display:none" data-hidden="true"' : '';
          html += '<div class="detail-item"' + hiddenClass + '><span class="tag tag-partial tag-sm">PARTIAL</span><span class="name" style="font-family:monospace;font-size:11px">' + p + '</span></div>';
        });
        html += '</div>';
        if (hasMorePartials) {
          html += '<div id="' + partialListId + '-more" style="margin-top:6px;cursor:pointer;color:var(--accent);font-size:11px" onclick="toggleMoreItems(\\'' + partialListId + '\\', ' + screen.partials.length + ')">▼ Show ' + (screen.partials.length - partialLimit) + ' more</div>';
        }
        html += '</div>';
      }

      // Services Called
      if (screen.services && screen.services.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">⚙️ Services Called</div>';
        html += '<div class="detail-items">';
        screen.services.forEach(s => {
          html += '<div class="detail-item"><span class="tag tag-service">Service</span><span class="name">' + s + '</span></div>';
        });
        html += '</div></div>';
      }

      // gRPC Calls
      if (screen.grpcCalls && screen.grpcCalls.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">🔌 gRPC Calls</div>';
        html += '<div class="detail-items">';
        screen.grpcCalls.forEach(g => {
          html += '<div class="detail-item"><span class="tag tag-grpc">gRPC</span><span class="name">' + g + '</span></div>';
        });
        html += '</div></div>';
      }

      // Model Access
      if (screen.modelAccess && screen.modelAccess.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">💾 Models Used</div>';
        html += '<div class="detail-items">';
        screen.modelAccess.forEach(m => {
          html += '<div class="detail-item"><span class="tag tag-model">Model</span><span class="name">' + m + '</span></div>';
        });
        html += '</div></div>';
      }

      // Controller Action info
      html += '<div class="detail-section">';
      html += '<div class="detail-label">🎮 Controller Action</div>';
      html += '<div class="code-block">';
      html += '<div style="font-family:monospace;font-size:12px">' + screen.controller + '#' + screen.action + '</div>';
      if (screen.controllerInfo) {
        html += '<div class="subtext">app/controllers/' + screen.controllerInfo.filePath;
        if (screen.actionLine) html += ':' + screen.actionLine;
        html += '</div>';

        // Before filters
        if (screen.controllerInfo.beforeActions && screen.controllerInfo.beforeActions.length > 0) {
          const applicableFilters = screen.controllerInfo.beforeActions.filter(f => {
            if (f.only && f.only.length > 0) return f.only.includes(screen.action);
            if (f.except && f.except.length > 0) return !f.except.includes(screen.action);
            return true;
          });
          if (applicableFilters.length > 0) {
            html += '<div style="margin-top:8px;font-size:11px">';
            html += '<span class="text-success">Before filters:</span> ' + applicableFilters.map(f => f.name).join(', ');
            html += '</div>';
          }
        }
      }
      html += '</div></div>';

      // Method calls in action
      if (screen.methodCalls && screen.methodCalls.length > 0) {
        const meaningfulCalls = screen.methodCalls.filter(c => {
          const skip = ['params', 'respond_to', 'render', 'redirect_to', 'head', 'flash', 'session', 'cookies'];
          return !skip.some(s => c.startsWith(s + '.') || c === s);
        }).slice(0, 10);

        if (meaningfulCalls.length > 0) {
          html += '<div class="detail-section">';
          html += '<div class="detail-label">🔗 Method Calls</div>';
          html += '<div style="background:var(--bg3);padding:10px;border-radius:6px;margin-top:6px;font-family:monospace;font-size:11px;max-height:120px;overflow-y:auto">';
          meaningfulCalls.forEach((call, i) => {
            html += '<div style="padding:2px 0;color:var(--accent)">' + (i+1) + '. ' + call + '</div>';
          });
          html += '</div></div>';
        }
      }

      showModal('🖼️ ' + screen.controller + '/' + screen.action, html);
    }

    // Show Rails page detail with API info
    function showRailsPageDetail(encodedData) {
      const route = JSON.parse(decodeURIComponent(encodedData));

      // Find controller and action details (improved matching)
      let actionDetails = null;
      let controllerInfo = null;
      if (railsControllers && railsControllers.length > 0) {
        const routeCtrl = route.controller;
        const routeCtrlParts = routeCtrl.split('/');
        const routeCtrlName = routeCtrlParts.pop().replace(/_/g, '');

        controllerInfo = railsControllers.find(c => {
          const filePathNormalized = c.filePath.replace(/_controller\.rb$/, '').replace(/_/g, '');
          if (filePathNormalized === routeCtrl.replace(/_/g, '')) return true;
          if (c.name === routeCtrlName || c.name.replace(/_/g, '') === routeCtrlName) return true;
          const className = c.className.toLowerCase().replace('controller', '').replace(/::/g, '/');
          if (className === routeCtrl.toLowerCase() || className.endsWith('/' + routeCtrlName)) return true;
          const classNameSimple = c.className.toLowerCase().replace('controller', '').split('::').pop();
          return classNameSimple === routeCtrlName.toLowerCase();
        });
        if (controllerInfo) {
          actionDetails = controllerInfo.actions.find(a => a.name === route.action);
        }
      }

      // Find page info from railsViews.pages
      const pageInfo = (railsViews && railsViews.pages || []).find(p =>
        p.controller === route.controller && p.action === route.action
      );

      const methodColor = {GET:'#22c55e',POST:'#3b82f6',PUT:'#f59e0b',PATCH:'#f59e0b',DELETE:'#ef4444'}[route.method] || '#888';

      let html = '<div class="detail-section">';
      html += '<div class="detail-label">Method & Path</div>';
      html += '<div class="detail-value">';
      html += '<span style="background:' + methodColor + ';color:white;padding:2px 8px;border-radius:4px;font-weight:600;margin-right:8px">' + (route.method || 'GET') + '</span>';
      html += '<span class="mono">' + route.path.replace(/:([a-z_]+)/g, '<span class="text-warning">:$1</span>') + '</span>';
      html += '</div></div>';

      html += '<div class="detail-section">';
      html += '<div class="detail-label">Controller#Action</div>';
      html += '<div class="detail-value">' + route.controller + '#' + route.action + '</div>';
      html += '</div>';

      // Response Type
      if (actionDetails) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">📡 Response Type</div>';
        html += '<div class="detail-value">';
        const responseTypes = [];
        if (actionDetails.rendersJson) responseTypes.push('<span style="background:#3b82f6;color:white;padding:2px 8px;border-radius:4px;font-size:11px;margin-right:4px">JSON</span>');
        if (actionDetails.rendersHtml) responseTypes.push('<span style="background:#22c55e;color:white;padding:2px 8px;border-radius:4px;font-size:11px;margin-right:4px">HTML</span>');
        if (actionDetails.redirectsTo) responseTypes.push('<span style="background:#f59e0b;color:white;padding:2px 8px;border-radius:4px;font-size:11px;margin-right:4px">Redirect</span>');
        if (actionDetails.respondsTo && actionDetails.respondsTo.length > 0) {
          actionDetails.respondsTo.forEach(f => {
            responseTypes.push('<span style="background:#8b5cf6;color:white;padding:2px 8px;border-radius:4px;font-size:11px;margin-right:4px">' + f.toUpperCase() + '</span>');
          });
        }
        html += responseTypes.length > 0 ? responseTypes.join('') : '<span class="text-muted">Unknown</span>';
        html += '</div></div>';

        if (actionDetails.redirectsTo) {
          html += '<div class="detail-section">';
          html += '<div class="detail-label">↪️ Redirects To</div>';
          html += '<div class="detail-value" style="font-family:monospace;font-size:12px;background:var(--bg3);padding:8px;border-radius:4px">' + actionDetails.redirectsTo + '</div>';
          html += '</div>';
        }
      }

      // View Template
      const view = pageInfo?.view || route.view;
      if (view) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">📄 View Template</div>';
        html += '<div class="detail-value" style="font-family:monospace;font-size:12px">app/views/' + view.path + '</div>';
        if (view.partials && view.partials.length > 0) {
          html += '<div class="subtext">Partials: ' + view.partials.slice(0, 5).join(', ') + '</div>';
        }
        if (view.instanceVars && view.instanceVars.length > 0) {
          html += '<div style="margin-top:4px;font-size:11px;color:var(--text2)">Instance vars: @' + view.instanceVars.slice(0, 5).join(', @') + '</div>';
        }
        html += '</div>';
      }

      // Before/After Filters
      if (controllerInfo && (controllerInfo.beforeActions.length > 0 || controllerInfo.afterActions.length > 0)) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">🔒 Filters Applied</div>';
        html += '<div class="code-block">';

        const applicableBeforeFilters = controllerInfo.beforeActions.filter(f => {
          if (f.only && f.only.length > 0) return f.only.includes(route.action);
          if (f.except && f.except.length > 0) return !f.except.includes(route.action);
          return true;
        });

        if (applicableBeforeFilters.length > 0) {
          html += '<div style="font-size:11px;margin-bottom:4px"><span style="color:#22c55e;font-weight:600">Before:</span> ';
          html += applicableBeforeFilters.map(f => {
            let info = f.name;
            if (f.if) info += ' <span class="text-muted">(if: ' + f.if + ')</span>';
            return info;
          }).join(', ');
          html += '</div>';
        }

        const applicableAfterFilters = controllerInfo.afterActions.filter(f => {
          if (f.only && f.only.length > 0) return f.only.includes(route.action);
          if (f.except && f.except.length > 0) return !f.except.includes(route.action);
          return true;
        });

        if (applicableAfterFilters.length > 0) {
          html += '<div style="font-size:11px"><span style="color:#f59e0b;font-weight:600">After:</span> ';
          html += applicableAfterFilters.map(f => f.name).join(', ');
          html += '</div>';
        }

        if (applicableBeforeFilters.length === 0 && applicableAfterFilters.length === 0) {
          html += '<div style="font-size:11px;color:var(--text2)">No filters for this action</div>';
        }
        html += '</div></div>';
      }

      // Services
      const services = pageInfo?.services || actionDetails?.servicesCalled || [];
      if (services.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">⚙️ Services Called</div>';
        html += '<div class="detail-items">';
        services.forEach(s => {
          html += '<div class="detail-item"><span class="tag tag-service">Service</span><span class="name">' + s + '</span></div>';
        });
        html += '</div></div>';
      }

      // gRPC Calls
      const grpcCalls = pageInfo?.grpcCalls || [];
      if (grpcCalls.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">🔌 gRPC Calls</div>';
        html += '<div class="detail-items">';
        grpcCalls.forEach(g => {
          html += '<div class="detail-item"><span class="tag tag-grpc">gRPC</span><span class="name">' + g + '</span></div>';
        });
        html += '</div></div>';
      }

      // Model Access
      const models = pageInfo?.modelAccess || actionDetails?.modelsCalled || [];
      if (models.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">💾 Models Accessed</div>';
        html += '<div class="detail-items">';
        models.forEach(m => {
          html += '<div class="detail-item"><span class="tag tag-model">Model</span><span class="name">' + m + '</span></div>';
        });
        html += '</div></div>';
      }

      // Method Calls
      if (actionDetails && actionDetails.methodCalls && actionDetails.methodCalls.length > 0) {
        const meaningfulCalls = actionDetails.methodCalls.filter(c => {
          const skip = ['params', 'respond_to', 'render', 'redirect_to', 'head', 'flash', 'session', 'cookies'];
          return !skip.some(s => c.startsWith(s + '.') || c === s);
        }).slice(0, 15);

        if (meaningfulCalls.length > 0) {
          html += '<div class="detail-section">';
          html += '<div class="detail-label">🔗 Method Calls in Action</div>';
          html += '<div style="background:var(--bg3);padding:10px;border-radius:6px;margin-top:6px;max-height:150px;overflow-y:auto">';
          html += '<div style="font-family:monospace;font-size:11px;line-height:1.6">';
          meaningfulCalls.forEach((call, i) => {
            html += '<div class="accordion-item">';
            html += '<span style="color:var(--text2);margin-right:8px">' + (i+1) + '.</span>';
            html += '<span class="text-accent">' + call + '</span>';
            html += '</div>';
          });
          if (actionDetails.methodCalls.length > 15) {
            html += '<div class="note">...and ' + (actionDetails.methodCalls.length - 15) + ' more</div>';
          }
          html += '</div></div></div>';
        }
      }

      // Source Files
      html += '<div class="detail-section">';
      html += '<div class="detail-label">📁 Source Files</div>';
      html += '<div style="background:var(--bg3);padding:10px;border-radius:6px;margin-top:6px;font-family:monospace;font-size:11px">';

      if (controllerInfo) {
        html += '<div class="detail-item flex items-center py-1">';
        html += '<span class="text-muted w-20">Controller:</span>';
        html += '<span>app/controllers/' + controllerInfo.filePath;
        if (actionDetails && actionDetails.line) html += ':<span class="text-success">' + actionDetails.line + '</span>';
        html += '</span></div>';
      }

      if (view) {
        html += '<div class="detail-item flex items-center py-1">';
        html += '<span class="text-muted w-20">View:</span>';
        html += '<span>app/views/' + view.path + '</span>';
        html += '</div>';
      }
      html += '</div></div>';

      // Controller Info
      if (controllerInfo) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">📋 Controller Info</div>';
        html += '<div class="code-block">';
        html += '<div class="section-title">' + controllerInfo.className + '</div>';
        html += '<div style="font-size:11px;color:var(--text2)">extends ' + controllerInfo.parentClass + '</div>';
        if (controllerInfo.concerns && controllerInfo.concerns.length > 0) {
          html += '<div style="margin-top:6px;font-size:11px">';
          html += '<span class="text-muted">Concerns:</span> ' + controllerInfo.concerns.join(', ');
          html += '</div>';
        }
        html += '</div></div>';
      }

      if (!pageInfo && !actionDetails) {
        html += '<div style="padding:12px;color:var(--text2);font-size:12px;background:var(--bg3);border-radius:6px;margin-top:8px">';
        html += '⚠️ No detailed action information found. The controller or action may not be analyzed yet.';
        html += '</div>';
      }

      showModal(route.path, html);
    }

    // Show Rails view detail
    function showRailsViewDetail(encodedData) {
      const view = JSON.parse(decodeURIComponent(encodedData));

      let html = '<div class="detail-section">';
      html += '<div class="detail-label">View</div>';
      html += '<div class="detail-value" style="font-family:monospace">app/views/' + view.path + '</div>';
      html += '</div>';

      html += '<div class="detail-section">';
      html += '<div class="detail-label">Controller#Action</div>';
      html += '<div class="detail-value">' + view.controller + '#' + view.action + '</div>';
      html += '</div>';

      html += '<div class="detail-section">';
      html += '<div class="detail-label">Template</div>';
      html += '<div class="detail-value">' + view.template.toUpperCase() + ' (' + view.format + ')</div>';
      html += '</div>';

      if (view.partials && view.partials.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">Partials Used</div>';
        html += '<div class="detail-items">';
        view.partials.forEach(p => {
          html += '<div class="detail-item"><span class="tag tag-partial">PARTIAL</span><span class="name">' + p + '</span></div>';
        });
        html += '</div></div>';
      }

      if (view.instanceVars && view.instanceVars.length > 0) {
        html += '<div class="detail-section">';
        html += '<div class="detail-label">Instance Variables</div>';
        html += '<div class="detail-items">';
        view.instanceVars.slice(0, 10).forEach(v => {
          html += '<div class="detail-item"><span class="tag tag-var">@</span><span class="name">' + v + '</span></div>';
        });
        if (view.instanceVars.length > 10) {
          html += '<div style="padding:4px 8px;color:var(--text2);font-size:11px">...and ' + (view.instanceVars.length - 10) + ' more</div>';
        }
        html += '</div></div>';
      }

      showModal('📄 ' + view.controller + '/' + view.action, html);
    }

    function toggleGroup(el) {
      el.closest('.group').classList.toggle('collapsed');
    }

    function toggleMoreItems(listId, totalCount) {
      const list = document.getElementById(listId);
      const moreBtn = document.getElementById(listId + '-more');
      if (!list || !moreBtn) return;

      const hiddenItems = list.querySelectorAll('[data-hidden="true"]');
      const isExpanded = moreBtn.getAttribute('data-expanded') === 'true';

      if (isExpanded) {
        // Collapse: hide items again
        hiddenItems.forEach(item => {
          item.style.display = 'none';
        });
        moreBtn.innerHTML = '▼ Show ' + hiddenItems.length + ' more variables';
        moreBtn.setAttribute('data-expanded', 'false');
      } else {
        // Expand: show all items
        hiddenItems.forEach(item => {
          item.style.display = '';
        });
        moreBtn.innerHTML = '▲ Show less';
        moreBtn.setAttribute('data-expanded', 'true');
      }
    }

    function selectPage(path) {
      document.querySelectorAll('.page-item').forEach(p => p.classList.remove('selected'));
      document.querySelector('[data-path="'+path+'"]')?.classList.add('selected');
      showDetail(path);
    }

    function showDetail(path) {
      const page = pageMap.get(path);
      if (!page) return;

      const rels = relations.filter(r => r.from === path || r.to === path);
      const parent = page.parent ? pageMap.get(page.parent) : null;
      const children = (page.children || []).map(c => pageMap.get(c)).filter(Boolean);
      const sameLayout = rels.filter(r => r.type === 'same-layout').map(r => r.from === path ? r.to : r.from).slice(0, 5);

      // Navigation links (from linkedPages)
      const navLinks = (page.linkedPages || []).filter(lp => {
        const normalizedPath = lp.startsWith('/') ? lp : '/' + lp;
        return pageMap.has(normalizedPath) || pageMap.has(normalizedPath.split('?')[0]);
      }).slice(0, 10);

      let relsHtml = '';
      if (parent) {
        relsHtml += '<div class="rel-item" onclick="event.stopPropagation(); selectPage(\\''+parent.path+'\\')">' +
          '<div class="rel-header"><span class="rel-type rel-type-parent">PARENT</span><span class="rel-path">'+parent.path+'</span></div>' +
          '<div class="rel-desc">This page is inside '+parent.path+'</div></div>';
      }
      children.forEach(c => {
        relsHtml += '<div class="rel-item" onclick="event.stopPropagation(); selectPage(\\''+c.path+'\\')">' +
          '<div class="rel-header"><span class="rel-type rel-type-child">CHILD</span><span class="rel-path">'+c.path+'</span></div>' +
          '<div class="rel-desc">Sub-page of current page</div></div>';
      });

      // Navigation links
      navLinks.forEach(link => {
        const targetPath = link.startsWith('/') ? link.split('?')[0] : '/' + link.split('?')[0];
        relsHtml += '<div class="rel-item" onclick="event.stopPropagation(); selectPage(\\''+targetPath+'\\')">' +
          '<div class="rel-header"><span class="rel-type" style="background:#3b82f6;color:white">LINK</span><span class="rel-path">'+link+'</span></div>' +
          '<div class="rel-desc">Navigation link from this page</div></div>';
      });

      sameLayout.forEach(p => {
        relsHtml += '<div class="rel-item" onclick="event.stopPropagation(); selectPage(\\''+p+'\\')">' +
          '<div class="rel-header"><span class="rel-type rel-type-layout">LAYOUT</span><span class="rel-path">'+p+'</span></div>' +
          '<div class="rel-desc">Uses same layout: '+(page.layout||'')+'</div></div>';
      });

      // Steps section
      let stepsHtml = '';
      if (page.steps && page.steps.length > 0) {
        stepsHtml = '<div class="detail-section"><h4>Multi-Step Flow ('+page.steps.length+' steps)</h4>';
        stepsHtml += '<div style="display:flex;flex-direction:column;gap:6px">';
        page.steps.forEach((step, idx) => {
          const stepName = step.name || 'Step ' + step.id;
          const stepComp = step.component ? '<code style="background:#0f172a;color:#93c5fd;padding:2px 6px;border-radius:3px;font-size:10px;margin-left:8px">'+step.component+'</code>' : '';
          stepsHtml += '<div style="display:flex;align-items:center;padding:8px;background:#1e293b;border-radius:6px;border-left:3px solid '+(idx===0?'#22c55e':'#3b82f6')+'">' +
            '<span style="background:#475569;color:white;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;margin-right:8px">'+(idx+1)+'</span>' +
            '<span style="font-size:12px;color:var(--text)">'+stepName+'</span>' +
            stepComp +
            '</div>';
        });
        stepsHtml += '</div></div>';
      }

      // Data operations - use page.dataFetching from engine.ts only
      // (engine.ts already enriches pages with GraphQL from components via enrichPagesWithHookGraphQL)
      let dataHtml = '';
      
      // Use dataFetching directly from engine.ts analysis
      const allDataFetching = [...(page.dataFetching || [])];
      
      if (allDataFetching.length > 0) {
        // Separate actual GraphQL operations from component references
        const graphqlOps = allDataFetching.filter(df => df.type !== 'component');
        const componentRefs = allDataFetching.filter(df => df.type === 'component');

        // Parse operations to extract source path from df.source field or operationName pattern
        const parsedOps = graphqlOps.map(df => {
          const rawName = df.operationName || '';
          const source = df.source || '';

          // Count leading arrows for depth (from extractComponentGraphQL)
          const arrowCount = (rawName.match(/→/g) || []).length;

          // Extract query name - remove arrows and (via xxx) pattern
          let queryName = rawName.replace(/^[→\\s]+/, '').trim();
          let sourcePath = 'Direct';
          let sourceDetail = '';
          let depth = 0;

          // Method 1: Extract from (via xxx) pattern in operationName (from extractComponentGraphQL)
          const viaMatch = queryName.match(/\\s*\\(via\\s+([^)]+)\\)/);
          if (viaMatch) {
            sourcePath = viaMatch[1];
            queryName = queryName.replace(viaMatch[0], '').trim();
            depth = arrowCount || 1;
          }
          // Method 2: Use df.source field
          else if (source.startsWith('component:')) {
            sourcePath = source.replace('component:', '');
            depth = 1;
          } else if (source.startsWith('hook:')) {
            sourcePath = source.replace('hook:', '');
            depth = 1;
          } else if (source.startsWith('usedIn:')) {
            // Evidence-based source (file where the operation reference was found)
            sourcePath = 'Indirect';
            // Keep detail for modal
            sourceDetail = source.replace('usedIn:', '');
            depth = 1;
          } else if (source.startsWith('import:')) {
            sourcePath = 'Import';
            sourceDetail = source.replace('import:', '');
            depth = 1;
          } else if (source.startsWith('common:')) {
            sourcePath = 'Common (shared)';
            sourceDetail = source.replace('common:', '');
            depth = 1;
          } else if (source.startsWith('close:')) {
            sourcePath = 'Close (related)';
            sourceDetail = source.replace('close:', '');
            depth = 1;
          } else if (source.startsWith('indirect:')) {
            sourcePath = 'Indirect';
            sourceDetail = source.replace('indirect:', '');
            depth = 1;
          }
          // "import:xxx" or no source stays as Direct

          return {
            ...df,
            queryName,
            sourcePath,
            sourceDetail: sourceDetail || undefined,
            depth,
          };
        });

        // Sort by depth (lower first) then by source category priority
        const sourcePriority = (src) => {
          if (src === 'Direct') return 0;
          if (src === 'Close (related)') return 1;
          if (src === 'Import') return 2;
          if (src === 'Indirect') return 3;
          if (src === 'Common (shared)') return 4;
          return 5;
        };
        parsedOps.sort((a, b) => {
          if (a.depth !== b.depth) return a.depth - b.depth;
          if (a.sourcePath === 'Direct') return -1;
          if (b.sourcePath === 'Direct') return 1;
          const ap = sourcePriority(a.sourcePath);
          const bp = sourcePriority(b.sourcePath);
          if (ap !== bp) return ap - bp;
          return a.sourcePath.localeCompare(b.sourcePath);
        });

        // Deduplicate by queryName + sourcePath
        const seen = new Set();
        const uniqueOps = parsedOps.filter(op => {
          const key = op.queryName + ':' + op.sourcePath;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Group by source path
        const groupedByPath = new Map();
        uniqueOps.forEach(op => {
          const path = op.sourcePath;
          if (!groupedByPath.has(path)) {
            groupedByPath.set(path, []);
          }
          groupedByPath.get(path).push(op);
        });

        // Sort groups: Direct first, then by depth
        const sortedPaths = Array.from(groupedByPath.keys()).sort((a, b) => {
          if (a === 'Direct') return -1;
          if (b === 'Direct') return 1;
          const aDepth = groupedByPath.get(a)[0]?.depth || 0;
          const bDepth = groupedByPath.get(b)[0]?.depth || 0;
          return aDepth - bDepth;
        });

        // Deduplicate component refs
        const seenComponents = new Set();
        const uniqueComponentRefs = componentRefs.filter(df => {
          const name = df.operationName || '';
          if (seenComponents.has(name)) return false;
          seenComponents.add(name);
          return true;
        });

        dataHtml = '';

        // Count direct vs component queries for header
        const directOps = groupedByPath.get('Direct') || [];
        const componentOpCount = uniqueOps.length - directOps.length;

        // Show grouped GraphQL operations
        if (sortedPaths.length > 0) {
          const countLabel = componentOpCount > 0 
            ? directOps.length + ' direct, +' + componentOpCount + ' from components' 
            : directOps.length + ' total';
          dataHtml += '<div class="detail-section"><h4>Data Operations <span style="font-weight:normal;font-size:11px;color:var(--text2)">(' + countLabel + ')</span></h4>';

          // Calculate continuous UI indent levels (depth gaps become 1 step)
          let prevDepth = -1;
          let uiLevel = -1;
          const pathToUiLevel = new Map();
          sortedPaths.forEach(pathName => {
            const ops = groupedByPath.get(pathName);
            const depth = pathName === 'Direct' ? 0 : (ops[0]?.depth || 1);
            if (depth > prevDepth) {
              uiLevel++;
            }
            pathToUiLevel.set(pathName, uiLevel);
            prevDepth = depth;
          });

          sortedPaths.forEach(pathName => {
            const ops = groupedByPath.get(pathName);
            const isDirect = pathName === 'Direct';
            // Remove the "↳" prefix (UI becomes cleaner with <details>/<summary>)
            const pathLabel = isDirect ? 'Direct (this page)' : pathName;
            // UI indent: 4px per level added to base padding (10px)
            const uiLevel = pathToUiLevel.get(pathName) || 0;
            const uiIndent = uiLevel * 4;
            const totalPadding = 10 + uiIndent;

            // Group container, header aligned with detail-item content
            // Non-direct groups are collapsed by default to reduce noise from shared/common operations.
            const isClose = pathName === 'Close (related)';
            const isCollapsedByDefault = !(isDirect || isClose);
            const detailsOpenAttr = isCollapsedByDefault ? '' : ' open';

            dataHtml += '<details class="data-path-group" style="margin:8px 0"' + detailsOpenAttr + '>' +
              '<summary class="data-path-header" style="--pad-left:'+totalPadding+'px">' +
              '<span class="text-accent">' + pathLabel + '</span> (' + ops.length + ')' +
              '</summary>';

            // Secondary grouping inside the group by concrete source file (sourceDetail).
            // This reduces noise when a group contains operations from many files.
            const bySource = new Map();
            ops.forEach(op => {
              const key = op.sourceDetail || '';
              if (!bySource.has(key)) bySource.set(key, []);
              bySource.get(key).push(op);
            });

            const sourceKeys = Array.from(bySource.keys()).sort((a, b) => {
              // Put "unknown/empty" at the end
              if (!a && b) return 1;
              if (a && !b) return -1;
              return String(a).localeCompare(String(b));
            });

            sourceKeys.forEach(sourceKey => {
              const sourceOps = bySource.get(sourceKey) || [];
              const hasSourceHeader = !!sourceKey && sourceKeys.length > 1;

              if (hasSourceHeader) {
                const sourceFileName = String(sourceKey).split(/[\\/]/).pop() || String(sourceKey);
                dataHtml += '<div class="data-source-group" style="margin:6px 0">' +
                  '<div class="data-source-header" style="padding-left:'+totalPadding+'px">' +
                  '<span style="opacity:0.9">' + sourceFileName + '</span> (' + sourceOps.length + ')' +
                  '</div>';
              }

              sourceOps.forEach(op => {
                const isQ = !op.type?.includes('Mutation');
                const sourceForModal = op.sourceDetail || op.sourcePath;
                const srcArg = op.sourcePath !== 'Direct' && sourceForModal
                  ? ",\\'"+sourceForModal.replace(/'/g, "\\\\'")+"\\'"
                  : '';
                // detail-item keeps base padding, adds indent
                dataHtml += '<div class="detail-item data-op" style="padding:8px 10px 8px '+totalPadding+'px" onclick="showDataDetail(\\''+op.queryName.replace(/'/g, "\\\\'")+"\\'"+srcArg+')">' +
                  '<span class="tag '+(isQ?'tag-query':'tag-mutation')+'" style="font-size:10px">'+(isQ?'Q':'M')+'</span> '+op.queryName+'</div>';
              });

              if (hasSourceHeader) {
                dataHtml += '</div>';
              }
            });

            dataHtml += '</details>';
          });

          dataHtml += '</div>';
        }

        // Show component references separately
        if (uniqueComponentRefs.length > 0) {
          dataHtml += '<div class="detail-section"><h4>Used Components</h4>';
          uniqueComponentRefs.forEach(df => {
            const name = df.operationName || '';
            dataHtml += '<div class="detail-item" style="cursor:default"><span class="tag tag-default">COMPONENT</span> '+name+'</div>';
          });
          dataHtml += '</div>';
        }
      }

      // REST API calls for this page
      let restApiHtml = '';
      const pageFileName = page.filePath?.split('/').pop() || '';
      const pageBaseName = pageFileName.replace(/\\.(tsx?|jsx?)$/, '');
      const pageApis = apiCallsData.filter(api => {
        if (!api.filePath || !page.filePath) return false;
        // Match by exact file path or by containing the page file name
        return api.filePath.includes(page.filePath) ||
               page.filePath.includes(api.filePath) ||
               api.filePath.endsWith(pageFileName) ||
               api.filePath.includes('/' + pageBaseName + '/');
      });

      if (pageApis.length > 0) {
        restApiHtml = '<div class="detail-section"><h4>REST API Calls ('+pageApis.length+')</h4>';
        pageApis.forEach(api => {
          const methodColors = {GET:'#22c55e',POST:'#3b82f6',PUT:'#f59e0b',DELETE:'#ef4444',PATCH:'#8b5cf6'};
          const color = methodColors[api.method] || '#6b7280';
          restApiHtml += '<div class="detail-item api-item" onclick="event.stopPropagation(); showApiDetail(\\''+api.id.replace(/'/g, "\\\\'")+'\\')">' +
            '<div class="api-row"><span class="tag" style="background:'+color+';color:white">'+api.method+'</span><span class="api-url">'+api.url+'</span></div>' +
            (api.filePath ? '<div class="api-route">'+api.callType+' in '+api.filePath+'</div>' : '') +
            '</div>';
        });
        restApiHtml += '</div>';
      }

      const totalRels = (parent ? 1 : 0) + children.length + navLinks.length + sameLayout.length;

      document.getElementById('detail-title').textContent = path;
      document.getElementById('detail-body').innerHTML =
        '<div class="detail-section"><h4>Info</h4>' +
        '<div class="detail-item"><div class="detail-label">FILE</div>'+page.filePath+'</div>' +
        '<div class="detail-item"><div class="detail-label">AUTH</div>'+(page.authentication?.required?'<span class="tag tag-auth">LOGIN REQUIRED</span>':'No auth required')+'</div>' +
        (page.layout?'<div class="detail-item"><div class="detail-label">LAYOUT</div>'+page.layout+'</div>':'') +
        (page.params?.length?'<div class="detail-item"><div class="detail-label">PARAMS</div>'+page.params.map(p=>':'+p).join(', ')+'</div>':'') +
        '</div>' + stepsHtml + dataHtml + restApiHtml +
        '<div class="detail-section"><h4>Related Pages ('+totalRels+')</h4>' +
        (relsHtml || '<div style="color:var(--text2);font-size:12px">No related pages</div>') +
        '</div>';

      document.getElementById('detail').classList.add('open');
    }

    function closeDetail() {
      document.getElementById('detail').classList.remove('open');
      document.querySelectorAll('.page-item').forEach(p => p.classList.remove('selected'));
    }

    // Filter by stat type
    let currentFilter = null;

    // Build sets for filtering
    // Build component lookup maps for dependency tracking
    const componentByFile = new Map();
    const componentByName = new Map();
    components.forEach(c => {
      if (c.filePath) componentByFile.set(c.filePath, c);
      if (c.name) componentByName.set(c.name, c);
    });

    // Include pages with direct GraphQL usage (from engine.ts enrichPagesWithHookGraphQL)
    const pagesWithGraphQL = new Set([
      // Pages with direct dataFetching
      ...pages.filter(p =>
        p.dataFetching && p.dataFetching.some(df =>
          df.type === 'useQuery' || df.type === 'useMutation' || df.type === 'useLazyQuery' ||
          df.type === 'getServerSideProps' || df.type === 'getStaticProps'
        )
      ).map(p => p.path),
      // Pages whose files are referenced in GraphQL operation usedIn
      ...pages.filter(p => {
        if (!p.filePath) return false;
        return Object.values(gqlMap).some(op =>
          op.usedIn && op.usedIn.some(u => u === p.filePath || u.endsWith('/' + p.filePath))
        );
      }).map(p => p.path)
    ]);

    // Debug: log pagesWithGraphQL count
    console.log('📊 GraphQL Stats: totalComponents=' + components.length + 
      ', componentsWithGraphQL=' + components.filter(c => c.hooks && c.hooks.some(h => h.startsWith('Query: ') || h.startsWith('Mutation: '))).length +
      ', pagesWithGraphQL=' + pagesWithGraphQL.size + 
      ', totalPages=' + pages.length);

    const pagesWithRestApi = new Set(pages.filter(p => {
      // Check if any API call is in this page's file or related feature directory
      if (!p.filePath) return false;
      const pageFileName = p.filePath.split('/').pop() || '';
      const pageBaseName = pageFileName.replace(/\\.(tsx?|jsx?)$/, '');
      return apiCallsData.some(api => {
        if (!api.filePath) return false;
        return api.filePath.includes(p.filePath) ||
               p.filePath.includes(api.filePath) ||
               api.filePath.endsWith(pageFileName) ||
               api.filePath.includes('/' + pageBaseName + '/');
      });
    }).map(p => p.path));

    const pagesWithHierarchy = new Set(pages.filter(p => p.parent || (p.children && p.children.length > 0)).map(p => p.path));

    function handleStatClick(type, el) {
      // Always reset filter first
      showAllPages();

      // Toggle filter - if same type clicked, just deactivate
      if (currentFilter === type) {
        currentFilter = null;
        document.querySelectorAll('.stat').forEach(s => s.classList.remove('active'));
        closeDetail();
        return;
      }

      currentFilter = type;
      document.querySelectorAll('.stat').forEach(s => s.classList.remove('active'));
      el.classList.add('active');

      // Apply filter to page list
      filterPageList(type);

      // Show detail panel
      if (type === 'graphql') {
        showGraphQLList();
      } else if (type === 'restapi') {
        showRestApiList();
      } else if (type === 'pages') {
        showPagesSummary();
      } else if (type === 'hierarchies') {
        showHierarchiesList();
      }
    }

    function filterPageList(type) {
      let visiblePaths;

      if (type === 'graphql') {
        visiblePaths = pagesWithGraphQL;
      } else if (type === 'restapi') {
        visiblePaths = pagesWithRestApi;
      } else if (type === 'hierarchies') {
        visiblePaths = pagesWithHierarchy;
      } else {
        // 'pages' - show all
        return;
      }

      // Filter page items
      document.querySelectorAll('.page-item').forEach(el => {
        const path = el.getAttribute('data-path');
        if (visiblePaths.has(path)) {
          el.style.removeProperty('display');
          el.style.display = 'flex';
        } else {
          el.style.display = 'none';
        }
      });

      // Hide empty groups
      document.querySelectorAll('.group').forEach(g => {
        const hasVisibleItems = Array.from(g.querySelectorAll('.page-item')).some(item => item.style.display !== 'none');
        if (hasVisibleItems) {
          g.style.removeProperty('display');
          g.style.display = 'block';
        } else {
          g.style.display = 'none';
        }
      });
    }

    function showPagesSummary() {
      // Group pages by first segment
      const groups = {};
      pages.forEach(p => {
        const seg = p.path.split('/').filter(Boolean)[0] || 'root';
        if (!groups[seg]) groups[seg] = [];
        groups[seg].push(p);
      });

      const authPages = pages.filter(p => p.authentication?.required);
      const dynamicPages = pages.filter(p => p.path.includes('[') && p.path.includes(']'));

      let html = '<div class="detail-section"><h4>Pages Summary</h4>';
      html += '<div class="detail-item"><div class="detail-label">TOTAL</div>'+pages.length+' pages</div>';
      html += '<div class="detail-item"><div class="detail-label">AUTH REQUIRED</div>'+authPages.length+' pages</div>';
      html += '<div class="detail-item"><div class="detail-label">DYNAMIC ROUTES</div>'+dynamicPages.length+' pages</div>';
      html += '</div>';

      html += '<div class="detail-section"><h4>By Route Group</h4>';
      Object.keys(groups).sort().forEach(g => {
        const groupPages = groups[g];
        html += '<div style="margin-bottom:12px">';
        html += '<div class="detail-item" style="cursor:pointer;background:var(--bg3);border-radius:4px" onclick="toggleGroupList(this)">';
        html += '<div class="detail-label" style="display:flex;align-items:center;gap:6px"><span class="group-toggle">▸</span>/'+g+'</div>';
        html += '<span class="text-accent">'+groupPages.length+' pages</span></div>';
        html += '<div class="group-page-list" style="display:none;margin-left:16px;margin-top:4px">';
        groupPages.sort((a,b) => a.path.localeCompare(b.path)).forEach(p => {
          const isAuth = p.authentication?.required;
          const isDynamic = p.path.includes('[');
          html += '<div class="detail-item rel-item" style="cursor:pointer;padding:6px 8px" onclick="event.stopPropagation(); selectPage(\\''+p.path+'\\')">'+
            '<span style="font-family:monospace;font-size:11px;color:var(--text)">'+p.path+'</span>'+
            (isAuth ? '<span class="tag tag-auth" style="margin-left:6px;font-size:9px">AUTH</span>' : '')+
            (isDynamic ? '<span class="tag tag-info" style="margin-left:6px" title="Dynamic Route">DYNAMIC</span>' : '')+
            '</div>';
        });
        html += '</div></div>';
      });
      html += '</div>';

      document.getElementById('detail-title').textContent = 'Pages Overview';
      document.getElementById('detail-body').innerHTML = html;
      document.getElementById('detail').classList.add('open');
    }

    window.toggleGroupList = function(el) {
      const list = el.nextElementSibling;
      const toggle = el.querySelector('.group-toggle');
      if (list.style.display === 'none') {
        list.style.display = 'block';
        toggle.textContent = '▾';
      } else {
        list.style.display = 'none';
        toggle.textContent = '▸';
      }
    };

    window.filterByGroup = function(group) {
      document.querySelectorAll('.group').forEach(g => {
        const name = g.querySelector('.group-name')?.textContent || '';
        g.style.display = name.includes('/'+group) ? '' : 'none';
      });
    };

    function showHierarchiesList() {
      const hierarchyRels = relations.filter(r => r.type === 'parent-child');

      // Build tree structure
      const roots = pages.filter(p => !p.parent && p.children && p.children.length > 0);

      let html = '<div class="detail-section"><h4>Page Hierarchies ('+hierarchyRels.length+' relationships)</h4>';

      if (roots.length === 0) {
        html += '<div style="color:var(--text2);font-size:12px">No hierarchical pages found</div>';
      } else {
        roots.forEach(root => {
          html += renderHierarchyTree(root, 0);
        });
      }
      html += '</div>';

      document.getElementById('detail-title').textContent = 'Page Hierarchies';
      document.getElementById('detail-body').innerHTML = html;
      document.getElementById('detail').classList.add('open');

      // Highlight hierarchical pages in the list
      document.querySelectorAll('.page-item').forEach(item => {
        const path = item.dataset.path;
        const page = pageMap.get(path);
        const hasHierarchy = page && (page.parent || (page.children && page.children.length > 0));
        item.style.opacity = hasHierarchy ? '1' : '0.4';
      });
    }

    function renderHierarchyTree(page, depth) {
      const indent = depth * 12;
      let html = '<div class="rel-item" style="padding-left:'+(10+indent)+'px" onclick="event.stopPropagation(); selectPage(\\''+page.path+'\\')">';
      html += '<div class="rel-header">';
      html += '<span style="color:var(--text2);font-size:10px">'+'─'.repeat(depth > 0 ? 1 : 0)+(depth > 0 ? ' ' : '')+'</span>';
      html += '<span class="rel-path">'+page.path+'</span>';
      if (page.children && page.children.length > 0) {
        html += '<span style="color:var(--text2);font-size:9px;margin-left:auto">'+page.children.length+' children</span>';
      }
      html += '</div></div>';

      if (page.children) {
        page.children.forEach(childPath => {
          const child = pageMap.get(childPath);
          if (child) {
            html += renderHierarchyTree(child, depth + 1);
          }
        });
      }
      return html;
    }

    // Register stat click handlers
    document.querySelectorAll('.stat[data-filter]').forEach(stat => {
      stat.addEventListener('click', function(e) {
        e.stopPropagation();
        const filterType = this.getAttribute('data-filter');
        handleStatClick(filterType, this);
      });
    });

    function showAllPages() {
      // Reset all groups and page items to visible
      document.querySelectorAll('.group').forEach(g => {
        g.style.removeProperty('display');
        g.style.display = 'block';
      });
      document.querySelectorAll('.page-item').forEach(p => {
        p.style.removeProperty('display');
        p.style.display = 'flex';
        // Reset opacity (set by hierarchies filter)
        p.style.removeProperty('opacity');
      });
    }

    // Track expanded state for GraphQL list
    let gqlListExpanded = { queries: false, mutations: false, fragments: false };

    function showGraphQLList() {
      renderGraphQLList();
    }

    function renderGraphQLList() {
      // Show GraphQL operations in detail panel
      let html = '<div class="detail-section"><h4>All GraphQL Operations ('+Object.keys(Object.fromEntries(gqlMap)).length+')</h4>';

      const queries = Array.from(gqlMap.values()).filter(o => o.type === 'query');
      const mutations = Array.from(gqlMap.values()).filter(o => o.type === 'mutation');
      const fragments = Array.from(gqlMap.values()).filter(o => o.type === 'fragment');

      const initialLimit = 20;
      const mutationLimit = 10;
      const fragmentLimit = 5;

      if (queries.length > 0) {
        html += '<div class="subtext-accent">Queries ('+queries.length+')</div>';
        const showCount = gqlListExpanded.queries ? queries.length : Math.min(initialLimit, queries.length);
        queries.slice(0, showCount).forEach(op => {
          html += '<div class="detail-item data-op" onclick="event.stopPropagation(); showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
            '<span class="tag tag-query">QUERY</span> '+op.name+'</div>';
        });
        if (queries.length > initialLimit) {
          if (gqlListExpanded.queries) {
            html += '<div class="more-link" onclick="event.stopPropagation(); toggleGqlSection(\\'queries\\', false)">▲ Show less</div>';
          } else {
            html += '<div class="more-link" onclick="event.stopPropagation(); toggleGqlSection(\\'queries\\', true)">... and '+(queries.length-initialLimit)+' more queries ▼</div>';
          }
        }
      }

      if (mutations.length > 0) {
        html += '<div class="subtext-accent" style="margin-top:12px">Mutations ('+mutations.length+')</div>';
        const showCount = gqlListExpanded.mutations ? mutations.length : Math.min(mutationLimit, mutations.length);
        mutations.slice(0, showCount).forEach(op => {
          html += '<div class="detail-item data-op" onclick="event.stopPropagation(); showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
            '<span class="tag tag-mutation">MUTATION</span> '+op.name+'</div>';
        });
        if (mutations.length > mutationLimit) {
          if (gqlListExpanded.mutations) {
            html += '<div class="more-link" onclick="event.stopPropagation(); toggleGqlSection(\\'mutations\\', false)">▲ Show less</div>';
          } else {
            html += '<div class="more-link" onclick="event.stopPropagation(); toggleGqlSection(\\'mutations\\', true)">... and '+(mutations.length-mutationLimit)+' more mutations ▼</div>';
          }
        }
      }

      if (fragments.length > 0) {
        html += '<div class="subtext-accent" style="margin-top:12px">Fragments ('+fragments.length+')</div>';
        const showCount = gqlListExpanded.fragments ? fragments.length : Math.min(fragmentLimit, fragments.length);
        fragments.slice(0, showCount).forEach(op => {
          html += '<div class="detail-item data-op" onclick="event.stopPropagation(); showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
            '<span class="tag tag-default">FRAGMENT</span> '+op.name+'</div>';
        });
        if (fragments.length > fragmentLimit) {
          if (gqlListExpanded.fragments) {
            html += '<div class="more-link" onclick="event.stopPropagation(); toggleGqlSection(\\'fragments\\', false)">▲ Show less</div>';
          } else {
            html += '<div class="more-link" onclick="event.stopPropagation(); toggleGqlSection(\\'fragments\\', true)">... and '+(fragments.length-fragmentLimit)+' more fragments ▼</div>';
          }
        }
      }

      html += '</div>';

      document.getElementById('detail-title').textContent = 'GraphQL Operations';
      document.getElementById('detail-body').innerHTML = html;
      document.getElementById('detail').classList.add('open');
    }

    window.toggleGqlSection = function(section, expand) {
      gqlListExpanded[section] = expand;
      renderGraphQLList();
    };

    function showRestApiList() {
      const apis = window.apiCalls || [];
      let html = '<div class="detail-section"><h4>REST API Calls ('+apis.length+')</h4>';

      if (apis.length === 0) {
        html += '<div style="color:var(--text2);font-size:12px">No REST API calls detected</div>';
      } else {
        apis.forEach(api => {
          const methodColors = {GET:'#22c55e',POST:'#3b82f6',PUT:'#f59e0b',DELETE:'#ef4444',PATCH:'#8b5cf6'};
          const color = methodColors[api.method] || '#6b7280';
          html += '<div class="detail-item api-item" onclick="event.stopPropagation(); showApiDetail(\\''+api.id.replace(/'/g, "\\\\'")+'\\')">' +
            '<div class="api-row"><span class="tag" style="background:'+color+';color:white">'+api.method+'</span><span class="api-url">'+api.url+'</span></div>' +
            '<div class="api-route">'+api.callType+' in '+api.filePath+'</div>' +
            '</div>';
        });
      }

      html += '</div>';

      document.getElementById('detail-title').textContent = 'REST API Calls';
      document.getElementById('detail-body').innerHTML = html;
      document.getElementById('detail').classList.add('open');
    }

    function showApiDetail(id) {
      const api = (window.apiCalls || []).find(a => a.id === id);
      if (!api) return;

      const methodColors = {GET:'#22c55e',POST:'#3b82f6',PUT:'#f59e0b',DELETE:'#ef4444',PATCH:'#8b5cf6'};
      const color = methodColors[api.method] || '#6b7280';

      let html = '<div class="detail-section"><h4>Method</h4>' +
        '<span class="tag" style="background:'+color+';color:white;font-size:14px;padding:4px 12px">'+api.method+'</span></div>';

      html += '<div class="detail-section"><h4>URL</h4>' +
        '<code style="background:#0f172a;color:#93c5fd;padding:8px 12px;border-radius:4px;font-family:monospace;display:block;word-break:break-all">'+api.url+'</code></div>';

      html += '<div class="detail-section"><h4>Details</h4>' +
        '<div class="detail-item"><div class="detail-label">TYPE</div>'+api.callType+'</div>' +
        '<div class="detail-item"><div class="detail-label">FILE</div><code style="background:#0f172a;color:#93c5fd;padding:2px 6px;border-radius:3px;font-family:monospace;font-size:11px">'+api.filePath+'</code></div>' +
        (api.line ? '<div class="detail-item"><div class="detail-label">LINE</div>'+api.line+'</div>' : '') +
        (api.containingFunction ? '<div class="detail-item"><div class="detail-label">FUNCTION</div><code style="background:#0f172a;color:#93c5fd;padding:2px 6px;border-radius:3px;font-family:monospace">'+api.containingFunction+'</code></div>' : '') +
        '</div>';

      if (api.category && api.category !== 'internal') {
        html += '<div class="detail-section"><h4>Category</h4>' +
          '<span class="tag tag-accent">'+api.category.toUpperCase()+'</span></div>';
      }

      // Show in modal
      modalHistory.push({ type: 'api', data: api });
      updateBackButton();

      document.getElementById('modal-title').textContent = api.method + ' ' + (api.url.length > 40 ? api.url.substring(0, 40) + '...' : api.url);
      document.getElementById('modal-body').innerHTML = html;
      document.getElementById('modal').classList.add('open');
    }

    // Close detail when clicking outside
    document.addEventListener('click', (e) => {
      const detail = document.getElementById('detail');
      const isDetailOpen = detail.classList.contains('open');
      if (!isDetailOpen) return;

      // Check if click is inside detail panel or on interactive elements
      if (detail.contains(e.target)) return;
      if (e.target.closest('.page-item')) return;
      if (e.target.closest('.node-circle')) return;
      if (e.target.closest('.modal')) return;
      if (e.target.closest('.stat')) return;
      if (e.target.closest('.data-op')) return;
      if (e.target.closest('#graph-canvas')) return; // Handled by canvas.onmousedown

      closeDetail();
    });

    // Expand "more" items - inserts items before the button and removes the button
    window.expandMore = function(type, items, btn) {
      let html = '';
      items.forEach(item => {
        if (type === 'usedIn') {
          html += '<div class="detail-item">'+item+'</div>';
        } else if (type === 'query' || type === 'mutation') {
          html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+item.name.replace(/'/g, "\\\\'")+'\\')">' +
            '<span class="tag '+(type==='mutation'?'tag-mutation':'tag-query')+'">'+type.toUpperCase()+'</span> '+item.name+'</div>';
        } else if (type === 'fragment') {
          html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+item.name.replace(/'/g, "\\\\'")+'\\')">' +
            '<span class="tag" style="background:#6b7280">FRAGMENT</span> '+item.name+'</div>';
        }
      });
      // Insert new items before the button, then remove the button
      btn.insertAdjacentHTML('beforebegin', html);
      btn.remove();
    };

    function showDataDetail(rawName, sourcePath) {
      // Clean up name: remove "→ " prefix and " (ComponentName)" suffix
      const name = rawName
        .replace(/^[→\\->\\s]+/, '')
        .replace(/\\s*\\([^)]+\\)\\s*$/, '');

      // Convert SCREAMING_CASE to PascalCase (e.g., COMPANY_QUERY → CompanyQuery)
      const toPascalCase = (str) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(str)) return str;
        return str.toLowerCase().split('_').map(word =>
          word.charAt(0).toUpperCase() + word.slice(1)
        ).join('');
      };

      // Try to find GraphQL operation with various name patterns
      let op = gqlMap.get(name);

      // Try PascalCase conversion for SCREAMING_CASE constants
      if (!op) {
        const pascalName = toPascalCase(name);
        if (pascalName !== name) {
          op = gqlMap.get(pascalName);
        }
      }

      // If not found, try removing common suffixes (Query, Mutation, Document)
      if (!op) {
        const baseName = name.replace(/Query$|Mutation$|Document$/, '');
        if (baseName) {
          op = gqlMap.get(baseName);
        }
      }

      // Try with "Get" prefix (common GraphQL naming convention)
      if (!op) {
        const pascalName = toPascalCase(name);
        op = gqlMap.get('Get' + pascalName) || gqlMap.get('Get' + pascalName + 'Query');
      }

      // Try removing Fragment suffix or adding it
      if (!op) {
        const pascalName = toPascalCase(name);
        const withoutFragment = pascalName.replace(/Fragment$/, '');
        op = gqlMap.get(withoutFragment) || gqlMap.get('Get' + withoutFragment) || gqlMap.get('Get' + withoutFragment + 'Fragment');
      }

      // Also try with suffix if original didn't have one
      if (!op && !name.match(/Query$|Mutation$/)) {
        op = gqlMap.get(name + 'Query') || gqlMap.get(name + 'Mutation');
      }

      // Try PascalCase with suffix
      if (!op) {
        const pascalBase = toPascalCase(name.replace(/_QUERY$|_MUTATION$|_DOCUMENT$/i, ''));
        if (pascalBase !== name) {
          op = gqlMap.get(pascalBase + 'Query') || gqlMap.get(pascalBase + 'Mutation') || gqlMap.get(pascalBase);
        }
      }

      // Fuzzy search: find operation whose name contains the search term
      if (!op) {
        const searchLower = toPascalCase(name).toLowerCase();
        for (const [opName, opData] of gqlMap.entries()) {
          if (opName.toLowerCase().includes(searchLower) || searchLower.includes(opName.toLowerCase().replace(/^get/, ''))) {
            op = opData;
            break;
          }
        }
      }

      let html = '';

      // Check if this is a known component
      const comp = compMap.get(rawName) || compMap.get(name);

      if (op) {
        // Found GraphQL operation
        html = '<div class="detail-section"><h4>Type</h4><span class="tag '+(op.type==='mutation'?'tag-mutation':'tag-query')+'">'+op.type.toUpperCase()+'</span></div>';

        // Source info
        if (sourcePath) {
          const looksLikeFile =
            sourcePath.includes('/') ||
            sourcePath.endsWith('.ts') ||
            sourcePath.endsWith('.tsx') ||
            sourcePath.endsWith('.js') ||
            sourcePath.endsWith('.jsx');
          const isHook = !looksLikeFile && sourcePath.startsWith('use');
          const label = looksLikeFile ? 'File' : isHook ? 'Hook' : 'Component';
          html += '<div class="detail-section"><h4>Source</h4><div class="detail-item" style="font-size:12px">via '+label+': <span class="text-accent">'+sourcePath+'</span></div></div>';
        }

        // Operation Name with copy button
        html += '<div class="detail-section"><h4 style="display:flex;justify-content:space-between;align-items:center">Operation Name<button class="copy-btn" onclick="copyToClipboard(\\''+op.name+'\\', this)" title="Copy operation name">📋</button></h4>';
        html += '<code style="background:#0f172a;color:#93c5fd;padding:4px 8px;border-radius:4px;font-family:monospace">'+op.name+'</code></div>';

        if (op.returnType) {
          html += '<div class="detail-section"><h4>Return Type</h4><code style="background:#0f172a;color:#93c5fd;padding:4px 8px;border-radius:4px;font-family:monospace">'+op.returnType+'</code></div>';
        }
        if (op.fields?.length) {
          // Show full GraphQL operation structure
          const opKeyword = op.type === 'mutation' ? 'mutation' : (op.type === 'fragment' ? 'fragment' : 'query');
          const varStr = op.variables?.length ? '(' + op.variables.map(v => '$' + v.name + ': ' + v.type).join(', ') + ')' : '';
          const fragmentOn = op.type === 'fragment' && op.returnType ? ' on ' + op.returnType : '';

          let gqlCode = opKeyword + ' ' + op.name + varStr + fragmentOn + ' {\\n';
          gqlCode += formatFields(op.fields, 1);
          gqlCode += '\\n}';

          // Escape for data attribute
          const gqlCodeEscaped = gqlCode.replace(/'/g, "\\\\'").replace(/"/g, '&quot;');

          html += '<div class="detail-section"><h4 style="display:flex;justify-content:space-between;align-items:center">GraphQL<button class="copy-btn" onclick="copyGqlCode(this)" data-code="'+gqlCodeEscaped+'" title="Copy GraphQL">📋</button></h4>';
          html += '<pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:11px;overflow-x:auto;white-space:pre;max-height:300px;overflow-y:auto">' + gqlCode + '</pre></div>';
        } else if (op.variables?.length) {
          html += '<div class="detail-section"><h4>Variables</h4>';
          op.variables.forEach(v => { html += '<div class="detail-item">'+v.name+': <code style="background:#0f172a;color:#93c5fd;padding:2px 6px;border-radius:3px;font-family:monospace">'+v.type+'</code>'+(v.required?' (required)':'')+'</div>'; });
          html += '</div>';
        }
        if (op.usedIn?.length) {
          html += '<div class="detail-section"><h4>Used In ('+op.usedIn.length+' files)</h4>';
          op.usedIn.slice(0,8).forEach(f => { html += '<div class="detail-item">'+f+'</div>'; });
          if (op.usedIn.length > 8) {
            const remaining = op.usedIn.slice(8);
            html += '<div class="expand-more" onclick="event.stopPropagation(); expandMore(\\'usedIn\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" style="color:var(--accent);font-size:11px;cursor:pointer;padding:4px 0">▸ Show '+(op.usedIn.length-8)+' more files</div>';
          }
          html += '</div>';
        }
      } else if (comp) {
        // Found component - find GraphQL operations DIRECTLY used in this component's file
        const compFile = comp.filePath;

        // Priority 1: Operations directly used in this file
        const directOps = graphqlOps.filter(op =>
          op.usedIn?.some(f => f === compFile || f.endsWith('/' + compFile))
        );

        // Priority 2: Operations with name matching component name pattern
        const compNameBase = comp.name.replace(/Container$|Page$|Component$|View$/, '');
        const matchingOps = directOps.length === 0 ? graphqlOps.filter(op =>
          op.name.includes(compNameBase) || compNameBase.includes(op.name.replace(/Query$|Mutation$/, ''))
        ) : [];

        const featureOps = directOps.length > 0 ? directOps : matchingOps;

        html = '<div class="detail-section"><h4>Component</h4>' +
          '<div class="detail-item"><div class="detail-label">NAME</div><strong>'+comp.name+'</strong></div>' +
          '<div class="detail-item"><div class="detail-label">FILE</div><code style="background:#0f172a;color:#93c5fd;padding:2px 6px;border-radius:3px;font-family:monospace;font-size:11px">'+comp.filePath+'</code></div>' +
          '<div class="detail-item"><div class="detail-label">TYPE</div>'+comp.type+'</div>' +
          '</div>';

        if (featureOps.length > 0) {
          // Group by type
          const queries = featureOps.filter(o => o.type === 'query');
          const mutations = featureOps.filter(o => o.type === 'mutation');
          const fragments = featureOps.filter(o => o.type === 'fragment');

          html += '<div class="detail-section"><h4>GraphQL Operations in Feature ('+featureOps.length+')</h4>';

          if (queries.length > 0) {
            html += '<div style="margin-bottom:8px;font-size:10px;color:var(--text2)">Queries ('+queries.length+')</div>';
            queries.slice(0,5).forEach(op => {
              html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
                '<span class="tag tag-query">QUERY</span> '+op.name+'</div>';
            });
            if (queries.length > 5) {
              const remaining = queries.slice(5).map(o => ({name: o.name}));
              html += '<div class="expand-more" onclick="event.stopPropagation(); expandMore(\\'query\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" class="expand-more">▸ Show ' + (queries.length - 5) + ' more queries</div>';
            }
          }

          if (mutations.length > 0) {
            html += '<div style="margin:8px 0;font-size:10px;color:var(--text2)">Mutations ('+mutations.length+')</div>';
            mutations.slice(0,5).forEach(op => {
              html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
                '<span class="tag tag-mutation">MUTATION</span> '+op.name+'</div>';
            });
            if (mutations.length > 5) {
              const remaining = mutations.slice(5).map(o => ({name: o.name}));
              html += '<div class="expand-more" onclick="event.stopPropagation(); expandMore(\\'mutation\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" class="expand-more">▸ Show ' + (mutations.length - 5) + ' more mutations</div>';
            }
          }

          if (fragments.length > 0) {
            html += '<div style="margin:8px 0;font-size:10px;color:var(--text2)">Fragments ('+fragments.length+')</div>';
            fragments.slice(0,3).forEach(op => {
              html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
                '<span class="tag tag-default">FRAGMENT</span> '+op.name+'</div>';
            });
            if (fragments.length > 3) {
              const remaining = fragments.slice(3).map(o => ({name: o.name}));
              html += '<div class="expand-more" onclick="event.stopPropagation(); expandMore(\\'fragment\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" class="expand-more">▸ Show ' + (fragments.length - 3) + ' more fragments</div>';
            }
          }

          html += '</div>';
        }

        // Show dependencies if any contain Query/Mutation
        const gqlDeps = comp.dependencies?.filter(d => /Query|Mutation|Document|Fragment/.test(d)) || [];
        if (gqlDeps.length > 0) {
          html += '<div class="detail-section"><h4>Direct Dependencies</h4>';
          gqlDeps.forEach(d => {
            const depOp = gqlMap.get(d.replace(/Document$/,''));
            if (depOp) {
              html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+depOp.name.replace(/'/g, "\\\\'")+'\\')">' +
                '<span class="tag '+(depOp.type==='mutation'?'tag-mutation':'tag-query')+'">'+depOp.type.toUpperCase()+'</span> '+depOp.name+'</div>';
            } else {
              html += '<div class="detail-item">'+d+'</div>';
            }
          });
          html += '</div>';
        }
      } else {
        // Clean up the name: remove "→ " prefix and " (ComponentName)" suffix
        let cleanName = name
          .replace(/^[→\\->\\s]+/, '')  // Remove arrow prefix
          .replace(/\\s*\\([^)]+\\)\\s*$/, '');  // Remove parenthetical component reference

        // Extract the core component name - remove ALL common suffixes iteratively
        const suffixes = ['Container', 'Page', 'Wrapper', 'Form', 'Component', 'View', 'Modal', 'Dialog', 'Body', 'Content', 'Section', 'Header', 'Footer', 'Root', 'Screen', 'Panel'];
        let coreName = cleanName;
        let changed = true;
        while (changed) {
          changed = false;
          for (const suffix of suffixes) {
            if (coreName.endsWith(suffix) && coreName.length > suffix.length) {
              coreName = coreName.slice(0, -suffix.length);
              changed = true;
              break;
            }
          }
        }

        // Split core name into keywords
        const rawKeywords = coreName
          .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase split
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // consecutive caps
          .split(/\\s+/)
          .filter(k => k.length > 1);  // Minimum 2 chars

        // Build search patterns
        const strictPattern = coreName.toLowerCase();
        const kebabPattern = rawKeywords.join('-').toLowerCase();
        // All keywords >= 4 chars for broader matching
        const significantKeywords = rawKeywords.filter(k => k.length >= 4).map(k => k.toLowerCase());
        const primaryKeyword = significantKeywords[0] || '';

        // Priority 1: Exact match in operation name
        let relatedOps = graphqlOps.filter(op => {
          const opNameLower = op.name.toLowerCase().replace(/query$|mutation$|fragment$/i, '');
          return opNameLower === strictPattern ||
                 opNameLower === kebabPattern ||
                 opNameLower.includes(strictPattern) ||
                 strictPattern.includes(opNameLower);
        });

        // Priority 2: Match in usedIn file path
        if (relatedOps.length === 0) {
          relatedOps = graphqlOps.filter(op =>
            op.usedIn?.some(f => {
              const fLower = f.toLowerCase();
              return fLower.includes(kebabPattern) || fLower.includes(strictPattern) ||
                     significantKeywords.some(k => fLower.includes(k));
            })
          );
        }

        // Priority 3: Any significant keyword in operation name
        if (relatedOps.length === 0 && significantKeywords.length > 0) {
          relatedOps = graphqlOps.filter(op => {
            const opLower = op.name.toLowerCase();
            return significantKeywords.some(k => opLower.includes(k));
          });
        }

        // Priority 4: Single keyword match in usedIn paths (most flexible)
        if (relatedOps.length === 0 && primaryKeyword) {
          relatedOps = graphqlOps.filter(op =>
            op.usedIn?.some(f => f.toLowerCase().includes(primaryKeyword))
          );
        }

        // Deduplicate and limit
        const uniqueOps = [...new Map(relatedOps.map(op => [op.name, op])).values()].slice(0, 15);
        const searchTerms = rawKeywords;

        html = '<div class="detail-section"><h4>Component</h4>' +
          '<div class="detail-item"><strong>'+name+'</strong></div>' +
          (searchTerms.length > 0 ? '<div class="detail-item" style="font-size:11px;color:var(--text2)">Keywords: '+searchTerms.join(', ')+'</div>' : '') +
          '</div>';

        if (uniqueOps.length > 0) {
          const queries = uniqueOps.filter(o => o.type === 'query');
          const mutations = uniqueOps.filter(o => o.type === 'mutation');
          const fragments = uniqueOps.filter(o => o.type === 'fragment');

          html += '<div class="detail-section"><h4>Related GraphQL ('+uniqueOps.length+')</h4>';

          if (queries.length > 0) {
            html += '<div style="margin-bottom:6px;font-size:10px;color:var(--text2)">Queries ('+queries.length+')</div>';
            queries.slice(0, 8).forEach(op => {
              html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
                '<span class="tag tag-query">QUERY</span> '+op.name+'</div>';
            });
            if (queries.length > 8) {
              const remaining = queries.slice(8).map(o => ({name: o.name}));
              html += '<div class="expand-more" onclick="event.stopPropagation(); expandMore(\\'query\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" class="expand-more">▸ Show ' + (queries.length - 8) + ' more</div>';
            }
          }

          if (mutations.length > 0) {
            html += '<div style="margin:8px 0 6px;font-size:10px;color:var(--text2)">Mutations ('+mutations.length+')</div>';
            mutations.slice(0, 5).forEach(op => {
              html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
                '<span class="tag tag-mutation">MUTATION</span> '+op.name+'</div>';
            });
            if (mutations.length > 5) {
              const remaining = mutations.slice(5).map(o => ({name: o.name}));
              html += '<div class="expand-more" onclick="event.stopPropagation(); expandMore(\\'mutation\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" class="expand-more">▸ Show ' + (mutations.length - 5) + ' more</div>';
            }
          }

          if (fragments.length > 0) {
            html += '<div style="margin:8px 0 6px;font-size:10px;color:var(--text2)">Fragments ('+fragments.length+')</div>';
            fragments.slice(0, 3).forEach(op => {
              html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
                '<span class="tag tag-default">FRAGMENT</span> '+op.name+'</div>';
            });
            if (fragments.length > 3) {
              const remaining = fragments.slice(3).map(o => ({name: o.name}));
              html += '<div class="expand-more" onclick="event.stopPropagation(); expandMore(\\'fragment\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" class="expand-more">▸ Show ' + (fragments.length - 3) + ' more</div>';
            }
          }

          html += '</div>';
        } else {
          html += '<div class="detail-section" style="color:var(--text2);font-size:12px">' +
            'No directly related GraphQL operations found.<br>' +
            'The component may use operations defined elsewhere or use inline queries.' +
            '</div>';
        }
      }

      // Add to history for back navigation
      modalHistory.push(name);
      updateBackButton();

      document.getElementById('modal-title').textContent = name;
      document.getElementById('modal-body').innerHTML = html;
      document.getElementById('modal').classList.add('open');
    }

    // Keep old function for compatibility
    function showGQL(name) { showDataDetail(name, false); }

    function formatFields(fields, indent) {
      if (!fields?.length) return '';
      const lines = [];
      fields.forEach(f => {
        const prefix = '  '.repeat(indent);
        if (f.fields?.length) {
          lines.push(prefix + f.name + ' {');
          lines.push(formatFields(f.fields, indent + 1));
          lines.push(prefix + '}');
        } else {
          lines.push(prefix + f.name);
        }
      });
      return lines.join('\\n');
    }

    function showModal(title, html) {
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-body').innerHTML = html;
      document.getElementById('modal').classList.add('open');
    }

    function closeModal() {
      document.getElementById('modal').classList.remove('open');
      modalHistory.length = 0; // Clear history when closing
      document.getElementById('modal-back').style.display = 'none';
    }

    // Copy functions
    window.copyToClipboard = function(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const originalText = btn.textContent;
        btn.textContent = '✓';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = originalText;
          btn.classList.remove('copied');
        }, 1500);
      }).catch(err => {
        console.error('Failed to copy:', err);
      });
    };

    window.copyGqlCode = function(btn) {
      const code = btn.getAttribute('data-code')
        .replace(/&quot;/g, '"')
        .replace(/\\\\'/g, "'")
        .replace(/\\\\n/g, '\\n');
      copyToClipboard(code, btn);
    };

    function handleModalOutsideClick() {
      // If there's history, go back instead of closing
      if (modalHistory.length > 1) {
        modalBack();
      } else {
        closeModal();
      }
    }

    function modalBack() {
      if (modalHistory.length > 1) {
        modalHistory.pop(); // Remove current
        const prevName = modalHistory.pop(); // Get previous (will be re-added by showDataDetail)
        showDataDetail(prevName);
      } else {
        closeModal();
      }
    }

    function updateBackButton() {
      document.getElementById('modal-back').style.display = modalHistory.length > 1 ? 'block' : 'none';
    }

    function filter(q) {
      q = q.toLowerCase().trim();

      // Filter ALL page items (including hidden "load more" items)
      document.querySelectorAll('.page-item').forEach(el => {
        const path = (el.dataset.path || '').toLowerCase();
        const text = el.textContent.toLowerCase();
        const matches = !q || path.includes(q) || text.includes(q);

        if (matches) {
          // Show matching items (even if they were hidden by "load more")
          el.style.display = '';
          el.removeAttribute('data-hidden');
        } else {
          el.style.display = 'none';
        }
      });

      // Show/hide groups based on whether they have visible items
      document.querySelectorAll('.group').forEach(group => {
        const hasVisible = Array.from(group.querySelectorAll('.page-item')).some(el => el.style.display !== 'none');
        group.style.display = hasVisible || !q ? '' : 'none';

        // If searching, expand collapsed groups that have matches
        if (q && hasVisible) {
          group.classList.remove('collapsed');
        }
      });

      // Hide/show "load more" buttons based on search state
      document.querySelectorAll('[id$="-more"]').forEach(btn => {
        btn.style.display = q ? 'none' : ''; // Hide load more buttons when searching
      });

      // If search is cleared, restore hidden items state
      if (!q) {
        restoreLoadMoreState();
      }
    }

    // Restore the "load more" hidden state when search is cleared
    function restoreLoadMoreState() {
      document.querySelectorAll('.group-items, .detail-items').forEach(list => {
        const moreBtn = document.getElementById(list.id + '-more');
        if (moreBtn && moreBtn.getAttribute('data-expanded') !== 'true') {
          // Find items that should be hidden (based on initial limit)
          const items = list.querySelectorAll('.page-item, .detail-item');
          const limit = list.classList.contains('detail-items') ? 15 : 30;
          items.forEach((item, idx) => {
            if (idx >= limit) {
              item.style.display = 'none';
              item.setAttribute('data-hidden', 'true');
            }
          });
          // Show the "load more" button again
          moreBtn.style.display = '';
        }
      });
    }

    // Improved Graph View with proper layout
    let canvas, ctx;
    let graphState = { zoom: 1, panX: 0, panY: 0, nodes: [], edges: [] };
    let dragging = false, lastX = 0, lastY = 0;
    let selectedNode = null;

    function initGraph() {
      canvas = document.getElementById('graph-canvas');
      ctx = canvas.getContext('2d');

      // Set canvas size
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * 2;
      canvas.height = rect.height * 2;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      ctx.scale(2, 2);

      // Combine Frontend pages and Rails routes for graph
      const allGraphPages = [...pages];

      // Add Rails routes as graph nodes (limit to GET routes with views for better visualization)
      if (typeof railsRoutes !== 'undefined' && railsRoutes.length > 0) {
        const viewRoutes = railsRoutes.filter(r => r.method === 'GET' && r.path && !r.path.includes('.:format'));
        const uniqueRoutes = new Map();
        viewRoutes.forEach(r => {
          const key = r.path.replace(/:[^/]+/g, ':param');
          if (!uniqueRoutes.has(key)) {
            uniqueRoutes.set(key, r);
          }
        });
        Array.from(uniqueRoutes.values()).slice(0, 200).forEach(r => {
          allGraphPages.push({
            path: 'rails:' + r.path,
            isRails: true,
            controller: r.controller,
            action: r.action,
            authentication: { required: false }
          });
        });
      }

      // Build nodes - initial placement by category
      const groups = new Map();
      allGraphPages.forEach(p => {
        const pathStr = p.path || '';
        const cat = pathStr.startsWith('rails:')
          ? 'rails/' + (p.controller?.split('/')[0] || 'other')
          : pathStr.split('/').filter(Boolean)[0] || 'root';
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(p);
      });

      graphState.nodes = [];
      const catColors = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899'];
      let catIdx = 0;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const catRadius = Math.min(rect.width, rect.height) * 0.3;

      Array.from(groups.entries()).forEach(([cat, catPages], gIdx) => {
        const catAngle = (gIdx / groups.size) * Math.PI * 2 - Math.PI / 2;
        const catX = centerX + Math.cos(catAngle) * catRadius;
        const catY = centerY + Math.sin(catAngle) * catRadius;
        const color = catColors[catIdx++ % catColors.length];

        // Initial spread with some randomness
        catPages.forEach((p, pIdx) => {
          const pageAngle = (pIdx / catPages.length) * Math.PI * 2;
          const spread = 50 + catPages.length * 5;
          const x = catX + Math.cos(pageAngle) * spread + (Math.random() - 0.5) * 30;
          const y = catY + Math.sin(pageAngle) * spread + (Math.random() - 0.5) * 30;
          const pathStr = p.path || '';
          const isRails = p.isRails || pathStr.startsWith('rails:');
          const displayPath = isRails ? pathStr.replace('rails:', '') : pathStr;
          const label = displayPath.split('/').filter(Boolean).pop() || '/';

          graphState.nodes.push({
            path: p.path,
            x, y,
            vx: 0, vy: 0, // velocity for force simulation
            radius: isRails ? 6 : 8,
            color: isRails ? '#f59e0b' : (p.authentication?.required ? '#dc2626' : '#22c55e'),
            label: label.length > 12 ? label.substring(0,10)+'...' : label,
            category: cat,
            catColor: color,
            isRails: isRails
          });
        });
      });

      // Build edges - parent-child hierarchy
      graphState.edges = relations.filter(r => r.type === 'parent-child').map(r => ({
        from: r.from,
        to: r.to,
        color: '#475569',
        type: 'hierarchy'
      }));

      // Add linkedPages edges (actual navigation links)
      const nodePathSet = new Set(graphState.nodes.map(n => n.path));
      pages.forEach(p => {
        if (p.linkedPages && p.linkedPages.length > 0) {
          p.linkedPages.forEach(linked => {
            // Normalize linked path
            const normalizedLinked = linked.startsWith('/') ? linked : '/' + linked;
            // Check if target exists in our pages (exact match or prefix match for dynamic routes)
            const targetExists = nodePathSet.has(normalizedLinked) ||
              Array.from(nodePathSet).some(path => {
                // Handle dynamic routes: /user/[id] matches /user/123
                const pathPattern = path.replace(/\\[\\w+\\]/g, '[^/]+');
                return new RegExp('^' + pathPattern + '$').test(normalizedLinked);
              });

            if (targetExists || nodePathSet.has(normalizedLinked.split('?')[0])) {
              const targetPath = normalizedLinked.split('?')[0];
              // Avoid duplicate edges
              const existingEdge = graphState.edges.find(e =>
                (e.from === p.path && e.to === targetPath) ||
                (e.from === targetPath && e.to === p.path && e.type === 'link')
              );
              if (!existingEdge && p.path !== targetPath) {
                graphState.edges.push({
                  from: p.path,
                  to: targetPath,
                  color: '#3b82f6', // Blue for navigation links
                  type: 'link'
                });
              }
            }
          });
        }
      });

      // Build connection map for force simulation
      const connections = new Map();
      graphState.nodes.forEach(n => connections.set(n.path, new Set()));
      graphState.edges.forEach(e => {
        connections.get(e.from)?.add(e.to);
        connections.get(e.to)?.add(e.from);
      });

      // Calculate category centers for strong grouping
      const categoryCenters = new Map();
      Array.from(groups.entries()).forEach(([cat], gIdx) => {
        const catAngle = (gIdx / groups.size) * Math.PI * 2 - Math.PI / 2;
        categoryCenters.set(cat, {
          x: centerX + Math.cos(catAngle) * catRadius,
          y: centerY + Math.sin(catAngle) * catRadius
        });
      });

      // Force-directed layout simulation
      const minDistance = 40; // Minimum distance between nodes
      const iterations = 80;

      for (let iter = 0; iter < iterations; iter++) {
        const alpha = 1 - iter / iterations; // Cooling factor

        // Apply forces
        for (let i = 0; i < graphState.nodes.length; i++) {
          const nodeA = graphState.nodes[i];
          let fx = 0, fy = 0;

          // Strong attraction to category center (keeps nodes in their group)
          const catCenter = categoryCenters.get(nodeA.category);
          if (catCenter) {
            const toCatX = catCenter.x - nodeA.x;
            const toCatY = catCenter.y - nodeA.y;
            const catDist = Math.sqrt(toCatX * toCatX + toCatY * toCatY);
            // Always pull toward category center
            fx += toCatX * 0.08 * alpha;
            fy += toCatY * 0.08 * alpha;
          }

          for (let j = 0; j < graphState.nodes.length; j++) {
            if (i === j) continue;
            const nodeB = graphState.nodes[j];

            const dx = nodeA.x - nodeB.x;
            const dy = nodeA.y - nodeB.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;

            // Repulsion force (only very close nodes)
            if (dist < minDistance * 2) {
              const repulsion = (minDistance * 2 - dist) / dist * 0.8;
              fx += dx * repulsion * alpha;
              fy += dy * repulsion * alpha;
            }

            // Attraction force (connected nodes pull each other)
            const isConnected = connections.get(nodeA.path)?.has(nodeB.path);
            if (isConnected && dist > minDistance) {
              const attraction = (dist - minDistance) / dist * 0.2;
              fx -= dx * attraction * alpha;
              fy -= dy * attraction * alpha;
            }
          }

          // Apply velocity with damping
          nodeA.vx = (nodeA.vx + fx) * 0.7;
          nodeA.vy = (nodeA.vy + fy) * 0.7;
        }

        // Update positions
        graphState.nodes.forEach(n => {
          n.x += n.vx;
          n.y += n.vy;
          // Keep within bounds
          n.x = Math.max(50, Math.min(rect.width - 50, n.x));
          n.y = Math.max(50, Math.min(rect.height - 50, n.y));
        });
      }

      // Setup event handlers
      canvas.onmousedown = e => {
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left - graphState.panX) / graphState.zoom;
        const y = (e.clientY - rect.top - graphState.panY) / graphState.zoom;

        // Check if clicked on a node
        const clicked = graphState.nodes.find(n => {
          const dx = n.x - x, dy = n.y - y;
          return Math.sqrt(dx*dx + dy*dy) < n.radius + 5;
        });

        if (clicked) {
          selectPage(clicked.path);
          selectedNode = clicked;
          drawGraph(); // Immediately reflect selection
        } else {
          // Clicked on empty space - close detail panel and start dragging
          closeDetail();
          selectedNode = null;
          drawGraph();
          dragging = true;
          lastX = e.clientX;
          lastY = e.clientY;
        }
      };

      canvas.onmousemove = e => {
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left - graphState.panX) / graphState.zoom;
        const y = (e.clientY - rect.top - graphState.panY) / graphState.zoom;

        // Check if hovering over a node
        const hovered = graphState.nodes.find(n => {
          const dx = n.x - x, dy = n.y - y;
          return Math.sqrt(dx*dx + dy*dy) < n.radius + 5;
        });

        // Update cursor style
        canvas.style.cursor = hovered ? 'pointer' : (dragging ? 'grabbing' : 'grab');

        if (!dragging) return;
        graphState.panX += e.clientX - lastX;
        graphState.panY += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        drawGraph();
      };

      canvas.onmouseup = () => dragging = false;
      canvas.onmouseleave = () => dragging = false;

      canvas.onwheel = e => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        graphState.zoom = Math.max(0.3, Math.min(3, graphState.zoom * delta));
        drawGraph();
      };

      graphState.panX = 0;
      graphState.panY = 0;
      graphState.zoom = 1;

      drawGraph();
    }

    function drawGraph() {
      if (!ctx) return;
      const w = canvas.width / 2;
      const h = canvas.height / 2;

      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(graphState.panX, graphState.panY);
      ctx.scale(graphState.zoom, graphState.zoom);

      // Draw category labels
      const drawnCats = new Set();
      graphState.nodes.forEach(n => {
        if (!drawnCats.has(n.category)) {
          drawnCats.add(n.category);
          // Find center of category
          const catNodes = graphState.nodes.filter(x => x.category === n.category);
          const avgX = catNodes.reduce((s,x) => s+x.x, 0) / catNodes.length;
          const avgY = catNodes.reduce((s,x) => s+x.y, 0) / catNodes.length;

          ctx.fillStyle = n.catColor + '40';
          ctx.beginPath();
          ctx.arc(avgX, avgY, 60 + catNodes.length * 10, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = n.catColor;
          ctx.font = 'bold 12px system-ui';
          ctx.textAlign = 'center';
          ctx.fillText('/' + n.category, avgX, avgY - 50 - catNodes.length * 5);
        }
      });

      // Draw edges
      graphState.edges.forEach(e => {
        const from = graphState.nodes.find(n => n.path === e.from);
        const to = graphState.nodes.find(n => n.path === e.to);
        if (from && to) {
          ctx.strokeStyle = e.color;
          ctx.lineWidth = e.type === 'link' ? 1.5 : 1;

          // Dashed line for navigation links, solid for hierarchy
          if (e.type === 'link') {
            ctx.setLineDash([4, 4]);
          } else {
            ctx.setLineDash([]);
          }

          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
          ctx.setLineDash([]); // Reset

          // Arrow
          const angle = Math.atan2(to.y - from.y, to.x - from.x);
          const arrowX = to.x - Math.cos(angle) * (to.radius + 3);
          const arrowY = to.y - Math.sin(angle) * (to.radius + 3);
          ctx.fillStyle = e.color;
          ctx.beginPath();
          ctx.moveTo(arrowX, arrowY);
          ctx.lineTo(arrowX - 6 * Math.cos(angle - 0.4), arrowY - 6 * Math.sin(angle - 0.4));
          ctx.lineTo(arrowX - 6 * Math.cos(angle + 0.4), arrowY - 6 * Math.sin(angle + 0.4));
          ctx.closePath();
          ctx.fill();
        }
      });

      // Draw nodes
      graphState.nodes.forEach(n => {
        const isSelected = selectedNode?.path === n.path;

        // Node circle
        ctx.fillStyle = n.color;
        ctx.strokeStyle = isSelected ? '#fff' : n.catColor;
        ctx.lineWidth = isSelected ? 3 : 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Label
        ctx.fillStyle = '#f8fafc';
        ctx.font = '9px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y + n.radius + 12);
      });

      ctx.restore();
    }

    function zoomGraph(f) {
      graphState.zoom = Math.max(0.3, Math.min(3, graphState.zoom * f));
      drawGraph();
    }

    function resetGraph() {
      graphState.zoom = 1;
      graphState.panX = 0;
      graphState.panY = 0;
      selectedNode = null;
      drawGraph();
    }

    // Calculate and display Q/M counts for each page in list
    function updatePageGqlCounts() {
      document.querySelectorAll('.page-item').forEach(item => {
        const pagePath = item.getAttribute('data-path');
        const page = pageMap.get(pagePath);
        if (!page) return;

        // Count GraphQL from dataFetching only (already enriched by engine.ts)
        let queries = 0;
        let mutations = 0;

        (page.dataFetching || []).forEach(df => {
          if (df.type?.includes('Mutation')) {
            mutations++;
          } else if (df.type && !df.type.includes('component')) {
            queries++;
          }
        });

        // Update Q tag
        const qTag = item.querySelector('.tag-query');
        if (qTag) {
          if (queries > 0) {
            qTag.textContent = 'Q:' + queries;
            qTag.style.display = '';
          } else {
            qTag.style.display = 'none';
          }
        }

        // Update M tag
        const mTag = item.querySelector('.tag-mutation');
        if (mTag) {
          if (mutations > 0) {
            mTag.textContent = 'M:' + mutations;
            mTag.style.display = '';
          } else {
            mTag.style.display = 'none';
          }
        }
      });
    }

    // Initialize Q/M counts on page load
    setTimeout(updatePageGqlCounts, 100);
  </script>
</body>
</html>`;
  }

  private buildTreeHtml(groups: Map<string, PageNode[]>, allPages: PageNode[]): string {
    const colors = [
      '#ef4444',
      '#f97316',
      '#eab308',
      '#22c55e',
      '#14b8a6',
      '#3b82f6',
      '#8b5cf6',
      '#ec4899',
    ];
    let idx = 0;

    return Array.from(groups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, pages]) => {
        const color = colors[idx++ % colors.length];
        const sorted = pages.sort((a, b) => a.path.localeCompare(b.path));

        // Build depth map based on actual parent-child relationships
        const pathSet = new Set(sorted.map((p) => p.path));
        const depthMap = new Map<string, number>();

        // Calculate depth for each page based on closest existing ancestor
        for (const p of sorted) {
          const segments = p.path.split('/').filter(Boolean);
          let depth = 0;

          // Find closest existing ancestor
          for (let i = segments.length - 1; i >= 1; i--) {
            const ancestorPath = '/' + segments.slice(0, i).join('/');
            if (pathSet.has(ancestorPath)) {
              depth = (depthMap.get(ancestorPath) ?? 0) + 1;
              break;
            }
          }

          depthMap.set(p.path, depth);
        }

        const pagesHtml = sorted
          .map((p) => {
            const type = this.getPageType(p.path);
            const depth = depthMap.get(p.path) ?? 0;

            const pageNode = p as PageNode;
            const repoName = pageNode.repo || '';
            // Only show repo tag if there are multiple repositories
            const showRepoTag = allPages.some(
              (pg) => (pg as PageNode).repo && (pg as PageNode).repo !== repoName
            );
            // Create short name: take last part or abbreviate long names
            const shortRepoName =
              repoName
                .split('/')
                .pop()
                ?.split('-')
                .map((s: string) => s.substring(0, 4))
                .join('-') || repoName.substring(0, 8);
            const repoTag =
              showRepoTag && repoName
                ? `<span class="tag tag-repo" title="${repoName}">${shortRepoName}</span>`
                : '';

            // Detect SPA component pages (PascalCase path or in components/pages)
            const isSpaComponent =
              /^\/[A-Z]/.test(p.path) || (p.filePath && p.filePath.includes('components/pages'));
            const displayPath =
              isSpaComponent && p.filePath
                ? p.filePath.replace(/\.tsx?$/, '').replace(/^(frontend\/src\/|src\/)/, '')
                : p.path;
            const spaTag = isSpaComponent
              ? '<span class="tag tag-info" title="SPA Component Page">SPA</span>'
              : '';

            // Q/M counts will be calculated dynamically in JavaScript
            return `<div class="page-item" data-path="${p.path}" data-repo="${repoName}" onclick="selectPage('${
              p.path
            }')" style="--depth:${depth}">
              <span class="page-type" style="--type-color:${type.color}">${type.label}</span>
              <span class="page-path">${displayPath}</span>
              <div class="page-tags">
                ${repoTag}
                ${spaTag}
                ${p.authentication?.required ? '<span class="tag tag-auth">AUTH</span>' : ''}
                <span class="tag tag-query gql-count" data-page-path="${p.path}" style="display:none">Q:0</span>
                <span class="tag tag-mutation gql-count-m" data-page-path="${p.path}" style="display:none">M:0</span>
              </div>
            </div>`;
          })
          .join('');

        return `<div class="group">
          <div class="group-header" onclick="toggleGroup(this)" style="--group-color:${color}">
            <span class="group-arrow">▼</span>
            <span class="group-name">/${name}</span>
            <span class="group-count">${pages.length}</span>
          </div>
          <div class="group-content">${pagesHtml}</div>
        </div>`;
      })
      .join('');
  }

  private getPageType(path: string): { label: string; color: string } {
    const last = path.split('/').filter(Boolean).pop() || '';
    if (last === 'new' || path.endsWith('/new')) return { label: 'CREATE', color: '#22c55e' };
    if (last === 'edit' || path.includes('/edit')) return { label: 'EDIT', color: '#f59e0b' };
    if (last.startsWith('[') || last.startsWith(':')) return { label: 'DETAIL', color: '#3b82f6' };
    if (path.includes('setting')) return { label: 'SETTINGS', color: '#6b7280' };
    return { label: 'LIST', color: '#06b6d4' };
  }
}
