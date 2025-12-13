/**
 * Rails Map Generator
 * Generates interactive HTML pages from Rails analysis results
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  analyzeRailsApp,
  type RailsAnalysisResult,
  type RailsRoute,
} from '../analyzers/rails/index.js';

export interface RailsMapOptions {
  title?: string;
  outputPath?: string;
}

export class RailsMapGenerator {
  private result: RailsAnalysisResult | null = null;

  constructor(private rootPath?: string) {}

  async generate(options: RailsMapOptions = {}): Promise<string> {
    if (!this.rootPath) throw new Error('Root path required for analysis');
    const { title = 'Rails Application Map' } = options;

    // Run analysis
    this.result = await analyzeRailsApp(this.rootPath);

    // Generate HTML
    const html = this.generateHTML(title);

    // Save if output path specified
    if (options.outputPath) {
      fs.writeFileSync(options.outputPath, html);
      console.log(`\n📄 Generated: ${options.outputPath}`);
    }

    return html;
  }

  // Generate from existing analysis result (for doc-server)
  generateFromResult(analysisResult: RailsAnalysisResult, title = 'Rails Application Map'): string {
    this.result = analysisResult;
    return this.generateHTML(title);
  }

  private generateHTML(title: string): string {
    if (!this.result) throw new Error('Analysis not run');

    const { routes, controllers, models, grpc, summary } = this.result;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Repomap</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">
  <link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png">
  <link rel="manifest" href="/favicon/site.webmanifest">
  <link rel="stylesheet" href="/rails-map.css">
</head>
<body>
  <header>
    <h1>🛤️ ${title}</h1>
    <nav class="header-nav">
      <a href="/page-map" class="nav-link">Page Map</a>
      <a href="/rails-map" class="nav-link active">Rails Map</a>
      <a href="/docs" class="nav-link">Docs</a>
    </nav>
    <div class="stats-bar">
      <div class="stat active" data-view="routes">
        <div>
          <div class="stat-value">${summary.totalRoutes.toLocaleString()}</div>
          <div class="stat-label">Routes</div>
        </div>
      </div>
      <div class="stat" data-view="controllers">
        <div>
          <div class="stat-value">${summary.totalControllers}</div>
          <div class="stat-label">Controllers</div>
        </div>
      </div>
      <div class="stat" data-view="models">
        <div>
          <div class="stat-value">${summary.totalModels}</div>
          <div class="stat-label">Models</div>
        </div>
      </div>
      <div class="stat" data-view="grpc">
        <div>
          <div class="stat-value">${summary.totalGrpcServices}</div>
          <div class="stat-label">gRPC</div>
        </div>
      </div>
      <div class="stat" data-view="diagram">
        <div>
          <div class="stat-value">📊</div>
          <div class="stat-label">Diagram</div>
        </div>
      </div>
    </div>
  </header>

  <div class="container">
    <aside class="sidebar">
      <div class="sidebar-section">
        <div class="sidebar-title">Search</div>
        <input type="text" class="search-box" id="searchBox" placeholder="Search routes, controllers...">
      </div>

      <div class="sidebar-section namespaces" id="namespaceFilter">
        <div class="sidebar-title">Namespaces (${summary.namespaces.length})</div>
        <div class="namespace-list">
          <div class="namespace-item active" data-namespace="all">
            <span>All</span>
            <span class="namespace-count">${routes.routes.length}</span>
          </div>
          ${this.generateNamespaceList(routes.routes)}
        </div>
      </div>

      <div class="sidebar-section" id="methodFilter">
        <div class="sidebar-title">HTTP Methods</div>
        <div class="namespace-list methods-list">
          ${this.generateMethodFilters(routes.routes)}
        </div>
      </div>
    </aside>

    <main class="main-panel" id="mainPanel">
      ${this.generateRoutesView(routes.routes)}
    </main>

    <aside class="detail-panel" id="detailPanel">
      <div class="empty-state">
        <div class="empty-state-icon">👆</div>
        <div>Select an item to view details</div>
      </div>
    </aside>
  </div>

  <script>
    // Data
    const routes = ${JSON.stringify(routes.routes)};
    const controllers = ${JSON.stringify(controllers.controllers)};
    const models = ${JSON.stringify(models.models)};
    const grpcServices = ${JSON.stringify(grpc.services)};

    // State
    let currentView = 'routes';
    let selectedNamespaces = new Set(['all']);
    let selectedMethods = new Set(['all']);
    let selectedControllerFlags = new Set(['all']);
    let selectedModelNamespaces = new Set(['all']);
    let selectedModelFlags = new Set(['all']);
    let selectedGrpcNamespaces = new Set(['all']);
    let selectedGrpcFlags = new Set(['all']);
    let searchQuery = '';
    let routesDisplayCount = 200;
    let controllersDisplayCount = 50;
    let modelsDisplayCount = 50;

    // Filtered data cache for click handlers
    let filteredControllers = [];
    let filteredModels = [];

    // URL State Management
    function saveStateToUrl() {
      const params = new URLSearchParams();
      params.set('view', currentView);
      if (!selectedNamespaces.has('all')) {
        params.set('ns', [...selectedNamespaces].join(','));
      }
      if (!selectedMethods.has('all')) {
        params.set('method', [...selectedMethods].join(','));
      }
      if (searchQuery) {
        params.set('q', searchQuery);
      }
      const newUrl = window.location.pathname + '?' + params.toString();
      window.history.replaceState({}, '', newUrl);
    }

    function loadStateFromUrl() {
      const params = new URLSearchParams(window.location.search);

      if (params.has('view')) {
        currentView = params.get('view');
        document.querySelectorAll('.stat').forEach(s => {
          s.classList.toggle('active', s.dataset.view === currentView);
        });
      }

      if (params.has('ns')) {
        const ns = params.get('ns').split(',').filter(Boolean);
        if (ns.length > 0) {
          selectedNamespaces = new Set(ns);
        }
      }

      if (params.has('method')) {
        const methods = params.get('method').split(',').filter(Boolean);
        if (methods.length > 0) {
          selectedMethods = new Set(methods);
        }
      }

      if (params.has('q')) {
        searchQuery = params.get('q');
        searchBox.value = searchQuery;
      }

      updateFilterUI();
    }

    // DOM Elements
    const mainPanel = document.getElementById('mainPanel');
    const detailPanel = document.getElementById('detailPanel');
    const searchBox = document.getElementById('searchBox');

    // Event Listeners
    document.querySelectorAll('.stat').forEach(stat => {
      stat.addEventListener('click', () => {
        document.querySelectorAll('.stat').forEach(s => s.classList.remove('active'));
        stat.classList.add('active');
        currentView = stat.dataset.view;
        saveStateToUrl();
        renderMainPanel();
      });
    });

    // Sidebar filter click handler (works even after sidebar re-render)
    document.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : e.target?.parentElement;
      if (!target) return;
      const item = target.closest('.namespace-item');
      if (!item) return;

      const filterType = item.dataset.filterType;
      const value = item.dataset.filterValue;
      if (!filterType || value === undefined) return;

      const multi = e.ctrlKey || e.metaKey;

      function toggleMulti(setRef, v) {
        if (v === 'all') return new Set(['all']);
        const next = new Set(setRef);
        next.delete('all');
        if (next.has(v)) next.delete(v);
        else next.add(v);
        if (next.size === 0) next.add('all');
        return next;
      }

      function toggleSingle(v) {
        return new Set([v]);
      }

      if (filterType === 'routeNamespace') {
        selectedNamespaces = multi ? toggleMulti(selectedNamespaces, value) : toggleSingle(value);
        routesDisplayCount = 200;
        saveStateToUrl();
      } else if (filterType === 'routeMethod') {
        // Methods behave similarly to namespaces
        selectedMethods = multi ? toggleMulti(selectedMethods, value) : toggleSingle(value);
        routesDisplayCount = 200;
        saveStateToUrl();
      } else if (filterType === 'controllerFlag') {
        selectedControllerFlags = multi
          ? toggleMulti(selectedControllerFlags, value)
          : toggleSingle(value);
        controllersDisplayCount = 50;
      } else if (filterType === 'modelNamespace') {
        selectedModelNamespaces = multi
          ? toggleMulti(selectedModelNamespaces, value)
          : toggleSingle(value);
        modelsDisplayCount = 50;
      } else if (filterType === 'modelFlag') {
        selectedModelFlags = multi ? toggleMulti(selectedModelFlags, value) : toggleSingle(value);
        modelsDisplayCount = 50;
      } else if (filterType === 'grpcNamespace') {
        selectedGrpcNamespaces = multi ? toggleMulti(selectedGrpcNamespaces, value) : toggleSingle(value);
        grpcDisplayCount = 50;
      } else if (filterType === 'grpcFlag') {
        selectedGrpcFlags = multi ? toggleMulti(selectedGrpcFlags, value) : toggleSingle(value);
        grpcDisplayCount = 50;
      }

      updateFilterUI();
      renderMainPanel();
    });

    function updateFilterUI() {
      document.querySelectorAll('.namespace-item[data-filter-type][data-filter-value]').forEach(item => {
        const t = item.dataset.filterType;
        const v = item.dataset.filterValue;
        if (!t || v === undefined) return;

        let active = false;
        if (t === 'routeNamespace') active = selectedNamespaces.has(v);
        else if (t === 'routeMethod') active = selectedMethods.has(v);
        else if (t === 'controllerFlag') active = selectedControllerFlags.has(v);
        else if (t === 'modelNamespace') active = selectedModelNamespaces.has(v);
        else if (t === 'modelFlag') active = selectedModelFlags.has(v);
        else if (t === 'grpcNamespace') active = selectedGrpcNamespaces.has(v);
        else if (t === 'grpcFlag') active = selectedGrpcFlags.has(v);

        item.classList.toggle('active', active);
      });
    }

    searchBox.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      saveStateToUrl();
      renderMainPanel();
    });

    // Render Functions
    function renderMainPanel() {
      // Update sidebar filters per view (routes/controllers vs models vs grpc)
      const namespaceFilter = document.getElementById('namespaceFilter');
      const methodFilter = document.getElementById('methodFilter');
      renderSidebarFilters(namespaceFilter, methodFilter);

      switch (currentView) {
        case 'routes':
          mainPanel.innerHTML = renderRoutesView();
          break;
        case 'controllers':
          mainPanel.innerHTML = renderControllersView();
          break;
        case 'models':
          mainPanel.innerHTML = renderModelsView();
          break;
        case 'grpc':
          mainPanel.innerHTML = renderGrpcView();
          break;
        case 'diagram':
          mainPanel.innerHTML = renderDiagramView();
          setTimeout(loadMermaid, 100);
          break;
      }
      attachEventListeners();
    }

    function renderSidebarFilters(namespaceFilter, methodFilter) {
      if (!namespaceFilter || !methodFilter) return;

      function sectionHtml(title, listClass, inner) {
        return (
          '<div class="sidebar-title">' +
          title +
          '</div>' +
          '<div class="' +
          listClass +
          '">' +
          inner +
          '</div>'
        );
      }

      if (currentView === 'routes') {
        namespaceFilter.style.opacity = '1';
        namespaceFilter.style.pointerEvents = 'auto';
        methodFilter.style.opacity = '1';
        methodFilter.style.pointerEvents = 'auto';

        namespaceFilter.innerHTML = sectionHtml(
          'Namespaces',
          'namespace-list',
          renderRouteNamespaceFilters()
        );
        methodFilter.innerHTML = sectionHtml(
          'HTTP Methods',
          'namespace-list methods-list',
          renderRouteMethodFilters()
        );
        return;
      }

      if (currentView === 'controllers') {
        namespaceFilter.style.opacity = '1';
        namespaceFilter.style.pointerEvents = 'auto';
        methodFilter.style.opacity = '1';
        methodFilter.style.pointerEvents = 'auto';

        namespaceFilter.innerHTML = sectionHtml(
          'Controller Namespaces',
          'namespace-list',
          renderControllerNamespaceFilters()
        );
        methodFilter.innerHTML = sectionHtml(
          'Controller Filters',
          'namespace-list methods-list',
          renderControllerFlagFilters()
        );
        return;
      }

      if (currentView === 'models') {
        namespaceFilter.style.opacity = '1';
        namespaceFilter.style.pointerEvents = 'auto';
        methodFilter.style.opacity = '1';
        methodFilter.style.pointerEvents = 'auto';

        namespaceFilter.innerHTML = sectionHtml(
          'Model Namespaces',
          'namespace-list',
          renderModelNamespaceFilters()
        );
        methodFilter.innerHTML = sectionHtml(
          'Model Filters',
          'namespace-list methods-list',
          renderModelFlagFilters()
        );
        return;
      }

      if (currentView === 'grpc') {
        namespaceFilter.style.opacity = '1';
        namespaceFilter.style.pointerEvents = 'auto';
        methodFilter.style.opacity = '1';
        methodFilter.style.pointerEvents = 'auto';

        namespaceFilter.innerHTML = sectionHtml(
          'gRPC Namespaces',
          'namespace-list',
          renderGrpcNamespaceFilters()
        );
        methodFilter.innerHTML = sectionHtml(
          'gRPC Filters',
          'namespace-list methods-list',
          renderGrpcFlagFilters()
        );
        return;
      }

      // diagram: keep disabled (no meaningful sidebar filters)
      namespaceFilter.style.opacity = '0.4';
      namespaceFilter.style.pointerEvents = 'none';
      methodFilter.style.opacity = '0.4';
      methodFilter.style.pointerEvents = 'none';
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderFilterItem(label, count, filterType, filterValue, isActive) {
      const safeLabel = escapeHtml(label);
      const safeType = escapeHtml(filterType);
      const safeValue = escapeHtml(filterValue);
      return (
        '<div class="namespace-item ' +
        (isActive ? 'active' : '') +
        '" data-filter-type="' +
        safeType +
        '" data-filter-value="' +
        safeValue +
        '">' +
        '<span>' +
        safeLabel +
        '</span>' +
        '<span class="namespace-count">' +
        count +
        '</span>' +
        '</div>'
      );
    }

    function renderRouteNamespaceFilters() {
      const counts = new Map();
      routes.forEach(r => {
        const ns = r.namespace || '';
        counts.set(ns, (counts.get(ns) || 0) + 1);
      });
      const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const allCount = routes.length;
      return [
        renderFilterItem('All', allCount, 'routeNamespace', 'all', selectedNamespaces.has('all')),
        ...entries.map(([ns, count]) =>
          renderFilterItem(ns || 'root', count, 'routeNamespace', ns, selectedNamespaces.has(ns))
        ),
      ].join('');
    }

    function renderControllerNamespaceFilters() {
      const counts = new Map();
      controllers.forEach(c => {
        const ns = c.namespace || '';
        counts.set(ns, (counts.get(ns) || 0) + 1);
      });
      const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const allCount = controllers.length;
      return [
        renderFilterItem('All', allCount, 'routeNamespace', 'all', selectedNamespaces.has('all')),
        ...entries.map(([ns, count]) =>
          renderFilterItem(ns || 'root', count, 'routeNamespace', ns, selectedNamespaces.has(ns))
        ),
      ].join('');
    }

    function renderRouteMethodFilters() {
      const counts = new Map();
      routes.forEach(r => {
        const m = r.method || 'ALL';
        counts.set(m, (counts.get(m) || 0) + 1);
      });
      const methods = ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
      const allCount = routes.length;
      return methods.map(m => {
        const label = m === 'ALL' ? 'All' : m;
        const value = m === 'ALL' ? 'all' : m;
        const count = m === 'ALL' ? allCount : (counts.get(m) || 0);
        const active = selectedMethods.has(value);
        return renderFilterItem(label, count, 'routeMethod', value, active);
      }).join('');
    }

    function renderControllerFlagFilters() {
      const flags = [
        {
          key: 'json',
          label: 'Renders JSON',
          test: (c) => (c.actions || []).some((a) => a.rendersJson),
        },
        {
          key: 'redirect',
          label: 'Has Redirect',
          test: (c) => (c.actions || []).some((a) => a.redirectsTo),
        },
        {
          key: 'private',
          label: 'Has Private Actions',
          test: (c) => (c.actions || []).some((a) => a.visibility === 'private'),
        },
      ];
      const allCount = controllers.length;
      const items = [
        renderFilterItem('All', allCount, 'controllerFlag', 'all', selectedControllerFlags.has('all')),
      ];
      flags.forEach(f => {
        const count = controllers.filter(f.test).length;
        items.push(renderFilterItem(f.label, count, 'controllerFlag', f.key, selectedControllerFlags.has(f.key)));
      });
      return items.join('');
    }

    function getModelNamespace(model) {
      const p = (model.filePath || '').split('/');
      if (p.length <= 1) return '';
      return p.slice(0, -1).join('/');
    }

    function renderModelNamespaceFilters() {
      const counts = new Map();
      models.forEach(m => {
        const ns = getModelNamespace(m);
        counts.set(ns, (counts.get(ns) || 0) + 1);
      });
      const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const allCount = models.length;
      return [
        renderFilterItem('All', allCount, 'modelNamespace', 'all', selectedModelNamespaces.has('all')),
        ...entries.map(([ns, count]) =>
          renderFilterItem(ns || 'root', count, 'modelNamespace', ns, selectedModelNamespaces.has(ns))
        ),
      ].join('');
    }

    function renderModelFlagFilters() {
      const flags = [
        { key: 'assoc', label: 'Has associations', test: (m) => (m.associations || []).length > 0 },
        { key: 'valid', label: 'Has validations', test: (m) => (m.validations || []).length > 0 },
        { key: 'cb', label: 'Has callbacks', test: (m) => (m.callbacks || []).length > 0 },
        { key: 'concern', label: 'Includes concerns', test: (m) => (m.concerns || []).length > 0 },
        { key: 'enum', label: 'Has enums', test: (m) => (m.enums || []).length > 0 },
      ];
      const allCount = models.length;
      const items = [
        renderFilterItem('All', allCount, 'modelFlag', 'all', selectedModelFlags.has('all')),
      ];
      flags.forEach(f => {
        const count = models.filter(f.test).length;
        items.push(renderFilterItem(f.label, count, 'modelFlag', f.key, selectedModelFlags.has(f.key)));
      });
      return items.join('');
    }

    function renderGrpcNamespaceFilters() {
      const counts = new Map();
      grpcServices.forEach(s => {
        const ns = s.namespace || '';
        counts.set(ns, (counts.get(ns) || 0) + 1);
      });
      const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const allCount = grpcServices.length;
      return [
        renderFilterItem('All', allCount, 'grpcNamespace', 'all', selectedGrpcNamespaces.has('all')),
        ...entries.map(([ns, count]) =>
          renderFilterItem(ns || 'root', count, 'grpcNamespace', ns, selectedGrpcNamespaces.has(ns))
        ),
      ].join('');
    }

    function renderGrpcFlagFilters() {
      const flags = [
        { key: 'policies', label: 'Has policies', test: (s) => (s.policies || []).length > 0 },
        { key: 'serializers', label: 'Has serializers', test: (s) => (s.serializers || []).length > 0 },
        { key: 'concerns', label: 'Includes concerns', test: (s) => (s.concerns || []).length > 0 },
        { key: 'modelsUsed', label: 'RPC uses models', test: (s) => (s.rpcs || []).some(r => (r.modelsUsed || []).length > 0) },
        { key: 'servicesUsed', label: 'RPC uses services', test: (s) => (s.rpcs || []).some(r => (r.servicesUsed || []).length > 0) },
      ];
      const allCount = grpcServices.length;
      const items = [
        renderFilterItem('All', allCount, 'grpcFlag', 'all', selectedGrpcFlags.has('all')),
      ];
      flags.forEach(f => {
        const count = grpcServices.filter(f.test).length;
        items.push(renderFilterItem(f.label, count, 'grpcFlag', f.key, selectedGrpcFlags.has(f.key)));
      });
      return items.join('');
    }

    function filterRoutes() {
      return routes.filter(route => {
        // Namespace filter (multi-select)
        if (!selectedNamespaces.has('all')) {
          const routeNs = route.namespace || '';
          if (!selectedNamespaces.has(routeNs)) return false;
        }
        // Method filter (multi-select)
        if (!selectedMethods.has('all') && !selectedMethods.has(route.method)) return false;
        // Search filter
        if (searchQuery) {
          const searchStr = (route.path + route.controller + route.action + (route.namespace || '')).toLowerCase();
          if (!searchStr.includes(searchQuery)) return false;
        }
        return true;
      });
    }

    function renderRoutesView() {
      const filtered = filterRoutes();
      const displayed = filtered.slice(0, routesDisplayCount);
      const hasMore = filtered.length > routesDisplayCount;

      return \`
        <div class="panel-header">
          <div class="panel-title">Routes <span class="panel-count">(\${Math.min(routesDisplayCount, filtered.length)} / \${filtered.length})</span></div>
        </div>
        <table class="routes-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>Path</th>
              <th>Controller#Action</th>
            </tr>
          </thead>
          <tbody>
            \${displayed.map((route, idx) => \`
              <tr data-type="route" data-index="\${idx}">
                <td><span class="method-badge method-\${route.method}">\${route.method}</span></td>
                <td class="path-text">\${highlightParams(route.path)}</td>
                <td class="controller-text">\${route.controller}#\${route.action}</td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
        \${hasMore ? \`
          <div class="show-more-container">
            <button class="show-more-btn" onclick="loadMoreRoutes()">Show More (+200)</button>
            <span class="show-more-count">\${routesDisplayCount} / \${filtered.length}</span>
          </div>
        \` : ''}
      \`;
    }

    window.loadMoreRoutes = function() {
      routesDisplayCount += 200;
      renderMainPanel();
    };

    function renderControllersView() {
      filteredControllers = controllers;
      if (searchQuery) {
        filteredControllers = controllers.filter(c =>
          c.className.toLowerCase().includes(searchQuery) ||
          c.actions.some(a => a.name.toLowerCase().includes(searchQuery))
        );
      }
      if (!selectedNamespaces.has('all')) {
        filteredControllers = filteredControllers.filter(c => selectedNamespaces.has(c.namespace || ''));
      }
      if (!selectedControllerFlags.has('all')) {
        filteredControllers = filteredControllers.filter((c) => {
          const rendersJson = (c.actions || []).some((a) => a.rendersJson);
          const hasRedirect = (c.actions || []).some((a) => a.redirectsTo);
          const hasPrivate = (c.actions || []).some((a) => a.visibility === 'private');

          if (selectedControllerFlags.has('json') && !rendersJson) return false;
          if (selectedControllerFlags.has('redirect') && !hasRedirect) return false;
          if (selectedControllerFlags.has('private') && !hasPrivate) return false;
          return true;
        });
      }
      const displayed = filteredControllers.slice(0, controllersDisplayCount);
      const hasMore = filteredControllers.length > controllersDisplayCount;

      return \`
        <div class="panel-header">
          <div class="panel-title">Controllers <span class="panel-count">(\${Math.min(controllersDisplayCount, filteredControllers.length)} / \${filteredControllers.length})</span></div>
        </div>
        <div>
          \${displayed.map((ctrl, idx) => \`
            <div class="controller-card" data-type="controller" data-index="\${idx}">
              <div class="controller-header">
                <div>
                  <div class="controller-name">\${ctrl.className}</div>
                  <div class="controller-namespace">\${ctrl.namespace || 'root'} • \${ctrl.actions.length} actions</div>
                </div>
                <span>▶</span>
              </div>
              <div class="controller-actions">
                \${ctrl.actions.map(action => \`
                  <div class="action-item">
                    <div class="action-visibility visibility-\${action.visibility}"></div>
                    <span>\${action.name}</span>
                    \${action.rendersJson ? '<span class="tag tag-blue">JSON</span>' : ''}
                    \${action.redirectsTo ? '<span class="tag tag-purple">Redirect</span>' : ''}
                  </div>
                \`).join('')}
              </div>
            </div>
          \`).join('')}
        </div>
        \${hasMore ? \`
          <div class="show-more-container">
            <button class="show-more-btn" onclick="loadMoreControllers()">Show More (+50)</button>
            <span class="show-more-count">\${controllersDisplayCount} / \${filteredControllers.length}</span>
          </div>
        \` : ''}
      \`;
    }

    window.loadMoreControllers = function() {
      controllersDisplayCount += 50;
      renderMainPanel();
    };

    function renderModelsView() {
      filteredModels = models;
      if (searchQuery) {
        filteredModels = models.filter(m =>
          m.className.toLowerCase().includes(searchQuery)
        );
      }
      // Model namespace filter
      if (!selectedModelNamespaces.has('all')) {
        filteredModels = filteredModels.filter(m => selectedModelNamespaces.has(getModelNamespace(m)));
      }
      // Model flag filter
      if (!selectedModelFlags.has('all')) {
        filteredModels = filteredModels.filter(m => {
          const hasAssoc = (m.associations || []).length > 0;
          const hasValid = (m.validations || []).length > 0;
          const hasCb = (m.callbacks || []).length > 0;
          const hasConcern = (m.concerns || []).length > 0;
          const hasEnum = (m.enums || []).length > 0;

          if (selectedModelFlags.has('assoc') && !hasAssoc) return false;
          if (selectedModelFlags.has('valid') && !hasValid) return false;
          if (selectedModelFlags.has('cb') && !hasCb) return false;
          if (selectedModelFlags.has('concern') && !hasConcern) return false;
          if (selectedModelFlags.has('enum') && !hasEnum) return false;
          return true;
        });
      }
      const displayed = filteredModels.slice(0, modelsDisplayCount);
      const hasMore = filteredModels.length > modelsDisplayCount;

      return \`
        <div class="panel-header">
          <div class="panel-title">Models <span class="panel-count">(\${Math.min(modelsDisplayCount, filteredModels.length)} / \${filteredModels.length})</span></div>
        </div>
        <div>
          \${displayed.map((model, idx) => \`
            <div class="model-card" data-type="model" data-index="\${idx}">
              <div class="model-name">
                \${model.className}
                \${model.concerns.length > 0 ? \`<span class="tag tag-purple">\${model.concerns.length} concerns</span>\` : ''}
              </div>
              <div class="model-stats">
                <span>\${model.associations.length} assoc</span>
                <span>\${model.validations.length} valid</span>
                <span>\${model.callbacks.length} callbacks</span>
              </div>
            </div>
          \`).join('')}
        </div>
        \${hasMore ? \`
          <div class="show-more-container">
            <button class="show-more-btn" onclick="loadMoreModels()">Show More (+50)</button>
            <button class="show-more-btn" onclick="showAllModels()">Show All</button>
            <span class="show-more-count">\${modelsDisplayCount} / \${filteredModels.length}</span>
          </div>
        \` : ''}
      \`;
    }

    window.loadMoreModels = function() {
      modelsDisplayCount += 50;
      renderMainPanel();
    };

    window.showAllModels = function() {
      modelsDisplayCount = filteredModels.length;
      renderMainPanel();
    };

    let grpcDisplayCount = 50;
    let filteredGrpc = grpcServices;

    function renderGrpcView() {
      filteredGrpc = grpcServices;
      if (searchQuery) {
        filteredGrpc = grpcServices.filter(svc =>
          (svc.className && svc.className.toLowerCase().includes(searchQuery)) ||
          (svc.namespace && svc.namespace.toLowerCase().includes(searchQuery)) ||
          (svc.rpcs && svc.rpcs.some(rpc => rpc.name && rpc.name.toLowerCase().includes(searchQuery)))
        );
      }
      if (!selectedGrpcNamespaces.has('all')) {
        filteredGrpc = filteredGrpc.filter(svc => selectedGrpcNamespaces.has(svc.namespace || ''));
      }
      if (!selectedGrpcFlags.has('all')) {
        filteredGrpc = filteredGrpc.filter(svc => {
          const hasPolicies = (svc.policies || []).length > 0;
          const hasSerializers = (svc.serializers || []).length > 0;
          const hasConcerns = (svc.concerns || []).length > 0;
          const usesModels = (svc.rpcs || []).some(r => (r.modelsUsed || []).length > 0);
          const usesServices = (svc.rpcs || []).some(r => (r.servicesUsed || []).length > 0);

          if (selectedGrpcFlags.has('policies') && !hasPolicies) return false;
          if (selectedGrpcFlags.has('serializers') && !hasSerializers) return false;
          if (selectedGrpcFlags.has('concerns') && !hasConcerns) return false;
          if (selectedGrpcFlags.has('modelsUsed') && !usesModels) return false;
          if (selectedGrpcFlags.has('servicesUsed') && !usesServices) return false;
          return true;
        });
      }

      const displayedGrpc = filteredGrpc.slice(0, grpcDisplayCount);

      return \`
        <div class="panel-header">
          <div class="panel-title">gRPC Services <span class="panel-count">(\${Math.min(grpcDisplayCount, filteredGrpc.length)} / \${filteredGrpc.length})</span></div>
        </div>
        <div style="display:grid;gap:12px">
          \${displayedGrpc.map((svc, idx) => \`
            <div class="model-card" onclick="showGrpcDetail(\${idx})">
              <div class="model-name">
                🔌 \${svc.className || 'Unknown'}
              </div>
              <div class="model-stats">
                \${svc.namespace ? \`<span>📁 \${svc.namespace}</span>\` : ''}
                <span>⚡ \${svc.rpcs ? svc.rpcs.length : 0} RPCs</span>
              </div>
            </div>
          \`).join('')}
        </div>
        \${filteredGrpc.length > grpcDisplayCount ? \`
          <div class="show-more-container">
            <button class="show-more-btn" onclick="loadMoreGrpc()">Show More (+50)</button>
            <span class="show-more-count">\${grpcDisplayCount} / \${filteredGrpc.length}</span>
          </div>
        \` : ''}
      \`;
    }

    window.loadMoreGrpc = function() {
      grpcDisplayCount += 50;
      renderMainPanel();
    };

    window.showGrpcDetail = function(idx) {
      const svc = filteredGrpc[idx];
      if (!svc) return;

      let detail = \`
        <div class="detail-header">
          <div class="detail-title">🔌 \${svc.className || 'gRPC Service'}</div>
          <button class="close-btn" onclick="closeDetail()">×</button>
        </div>
        <div class="detail-content">
          <div class="detail-section">
            <div class="detail-section-title">Service Info</div>
            <div class="detail-item"><span class="tag tag-purple">class</span>\${svc.className || 'N/A'}</div>
            \${svc.namespace ? \`<div class="detail-item"><span class="tag tag-blue">namespace</span>\${svc.namespace}</div>\` : ''}
            \${svc.filePath ? \`<div class="detail-item"><span class="tag tag-green">file</span><span style="word-break:break-all">\${svc.filePath}</span></div>\` : ''}
          </div>

          \${svc.rpcs && svc.rpcs.length > 0 ? \`
            <div class="detail-section">
              <div class="detail-section-title">RPCs (\${svc.rpcs.length})</div>
              \${svc.rpcs.map(rpc => \`
                <div class="detail-item">
                  <span class="tag tag-orange">rpc</span>
                  <span>\${rpc.name || 'unknown'}</span>
                  \${rpc.request ? \`<span style="margin-left:auto;font-size:11px;color:var(--text-secondary)">(\${rpc.request})</span>\` : ''}
                </div>
              \`).join('')}
            </div>
          \` : ''}
        </div>
      \`;

      detailPanel.innerHTML = detail;
      detailPanel.classList.add('open');
    };

    // Diagram state
    let diagramModelCount = 15;
    let diagramNamespace = 'all';
    let diagramFocusModel = '';
    let diagramDepth = 2;

    function getNamespaces() {
      const ns = new Set();
      const prefixes = new Map(); // Count common prefixes

      models.forEach(m => {
        const name = m.name || m.className || '';
        // Check for Ruby namespace (::)
        if (name.includes('::')) {
          ns.add(name.split('::')[0]);
        }
        // Also try to find common prefixes (e.g., User, UserProfile, UserSetting -> User)
        const match = name.match(/^([A-Z][a-z]+)/);
        if (match) {
          const prefix = match[1];
          prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
        }
      });

      // Add prefixes that have 3+ models as pseudo-namespaces
      prefixes.forEach((count, prefix) => {
        if (count >= 3 && !ns.has(prefix)) {
          ns.add(prefix + '*'); // Mark as prefix-based filter
        }
      });

      return ['all', ...Array.from(ns).sort()];
    }

    function getModelNames() {
      return models.map(m => m.name || m.className).sort();
    }

    // Get related models up to specified depth
    function getRelatedModels(centerModel, depth) {
      const related = new Set([centerModel]);
      const modelMap = new Map();
      models.forEach(m => {
        const name = m.name || m.className;
        modelMap.set(name, m);
      });

      for (let d = 0; d < depth; d++) {
        const currentModels = [...related];
        currentModels.forEach(modelName => {
          const model = modelMap.get(modelName);
          if (!model) return;

          model.associations.forEach(assoc => {
            const targetName = assoc.className || capitalize(singularize(assoc.name));
            if (modelMap.has(targetName)) {
              related.add(targetName);
            }
          });

          // Also find models that reference this model
          models.forEach(m => {
            const mName = m.name || m.className;
            m.associations.forEach(assoc => {
              const targetName = assoc.className || capitalize(singularize(assoc.name));
              if (targetName === modelName) {
                related.add(mName);
              }
            });
          });
        });
      }

      return related;
    }

    function generateMermaidCode(modelCount, namespace, focusModel, depth) {
      let filteredModels = [...models];

      // Filter by focus model (takes priority)
      if (focusModel && focusModel !== '') {
        const relatedNames = getRelatedModels(focusModel, depth);
        filteredModels = filteredModels.filter(m => {
          const name = m.name || m.className;
          return relatedNames.has(name);
        });
      }
      // Filter by namespace
      else if (namespace !== 'all') {
        filteredModels = filteredModels.filter(m => {
          const name = m.name || m.className || '';
          // Handle prefix-based filter (ends with *)
          if (namespace.endsWith('*')) {
            const prefix = namespace.slice(0, -1);
            return name.startsWith(prefix);
          }
          // Handle Ruby namespace (::)
          return name.startsWith(namespace + '::') || name === namespace;
        });
      }

      // Sort and limit
      const count = modelCount === 'all' ? filteredModels.length : parseInt(modelCount) || 15;
      const topModels = filteredModels
        .sort((a, b) => b.associations.length - a.associations.length)
        .slice(0, count);

      const modelNames = new Set(topModels.map(m => m.name || m.className));
      let mermaidCode = 'erDiagram\\n';
      const addedRelations = new Set();

      topModels.forEach(model => {
        const modelName = (model.name || model.className).replace(/[^a-zA-Z0-9]/g, '_');
        model.associations.forEach(assoc => {
          let targetModel = assoc.className || capitalize(singularize(assoc.name));
          targetModel = targetModel.replace(/[^a-zA-Z0-9]/g, '_');

          if (modelNames.has(assoc.className) || modelNames.has(capitalize(singularize(assoc.name)))) {
            const relKey = [modelName, targetModel].sort().join('-') + assoc.type;
            if (!addedRelations.has(relKey)) {
              addedRelations.add(relKey);
              const rel =
                assoc.type === 'belongs_to' ? '||--o{' :
                assoc.type === 'has_one' ? '||--||' : '||--o{';
              mermaidCode += \`  \${modelName} \${rel} \${targetModel} : "\${assoc.type}"\\n\`;
            }
          }
        });
      });

      // Ensure there's content even if no relations found
      if (mermaidCode === 'erDiagram\\n') {
        topModels.slice(0, 5).forEach(model => {
          const modelName = (model.name || model.className).replace(/[^a-zA-Z0-9]/g, '_');
          mermaidCode += \`  \${modelName} {\\n    string id\\n  }\\n\`;
        });
      }

      return { mermaidCode, modelCount: topModels.length, totalModels: filteredModels.length };
    }

    window.toggleCustomInput = function() {
      const countSelect = document.getElementById('model-count-select');
      const customWrapper = document.getElementById('custom-input-wrapper');
      if (countSelect.value === 'custom') {
        customWrapper.style.display = 'flex';
        document.getElementById('model-count-input').focus();
      } else {
        customWrapper.style.display = 'none';
        document.getElementById('model-count-input').value = '';
        updateDiagram();
      }
    };

    window.clearFocusModel = function() {
      document.getElementById('focus-model-select').value = '';
      diagramFocusModel = '';
      updateDiagram();
    };

    window.updateDiagram = function() {
      const countInput = document.getElementById('model-count-input');
      const countSelect = document.getElementById('model-count-select');
      const nsSelect = document.getElementById('namespace-select');
      const focusSelect = document.getElementById('focus-model-select');
      const depthSelect = document.getElementById('depth-select');

      // Get count from input or select
      let count;
      if (countSelect && countSelect.value === 'custom') {
        count = countInput ? countInput.value.trim() || '15' : '15';
      } else {
        count = countSelect ? countSelect.value : '15';
      }
      diagramModelCount = count;
      diagramNamespace = nsSelect ? nsSelect.value : 'all';
      diagramFocusModel = focusSelect ? focusSelect.value : '';
      diagramDepth = depthSelect ? parseInt(depthSelect.value) || 2 : 2;

      // If focus model is set, disable namespace filter and enable depth
      if (nsSelect) {
        nsSelect.disabled = diagramFocusModel !== '';
        nsSelect.style.opacity = diagramFocusModel !== '' ? '0.5' : '1';
      }
      if (depthSelect) {
        depthSelect.disabled = diagramFocusModel === '';
        depthSelect.style.opacity = diagramFocusModel !== '' ? '1' : '0.5';
        const depthLabel = depthSelect.parentElement?.querySelector('span');
        if (depthLabel) {
          depthLabel.style.opacity = diagramFocusModel !== '' ? '1' : '0.5';
        }
      }

      const { mermaidCode, modelCount, totalModels } = generateMermaidCode(count, diagramNamespace, diagramFocusModel, diagramDepth);

      // Update diagram - need to recreate SVG
      const container = document.getElementById('mermaid-container');
      const diagram = document.getElementById('mermaid-diagram');
      if (diagram && window.mermaid) {
        // Remove old SVG
        const oldSvg = container.querySelector('svg');
        if (oldSvg) oldSvg.remove();

        // Update mermaid code
        diagram.textContent = mermaidCode;
        diagram.removeAttribute('data-processed');
        diagram.style.display = 'block';

        // Re-render
        window.mermaid.init(undefined, diagram);
        setTimeout(() => {
          initDiagramPanZoom();
        }, 200);
      }

      // Update title
      const title = document.querySelector('.diagram-title-text');
      if (title) {
        let filterText = '';
        if (diagramFocusModel) {
          filterText = \` around \${diagramFocusModel} (depth \${diagramDepth})\`;
        } else if (diagramNamespace !== 'all') {
          filterText = \` in \${diagramNamespace}\`;
        }
        title.textContent = \`Model Relationships (\${modelCount}/\${totalModels} models\${filterText})\`;
      }
    };

    function renderDiagramView() {
      const namespaces = getNamespaces();
      const modelNames = getModelNames();
      const { mermaidCode, modelCount, totalModels } = generateMermaidCode(diagramModelCount, diagramNamespace, diagramFocusModel, diagramDepth);

      let filterText = '';
      if (diagramFocusModel) {
        filterText = \` around \${diagramFocusModel} (depth \${diagramDepth})\`;
      } else if (diagramNamespace !== 'all') {
        filterText = \` in \${diagramNamespace}\`;
      }

      const isCustom = !['15', '30', '50', '100', 'all'].includes(String(diagramModelCount));

      return \`
        <div class="diagram-view-wrapper" style="display:flex;flex-direction:column;height:100%;min-height:0;">
          <div class="panel-header" style="flex-wrap:wrap;gap:8px;flex-shrink:0;">
            <div class="panel-title diagram-title-text">Model Relationships (\${modelCount}/\${totalModels} models\${filterText})</div>
            <div class="diagram-filters" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:12px;">
              <label style="display:flex;align-items:center;gap:6px;">
                <span>Limit:</span>
                <select id="model-count-select" onchange="toggleCustomInput()" style="padding:6px 10px;border-radius:4px;background:#2d2d2d;color:#fff;border:1px solid #444;min-width:80px;">
                  <option value="15" \${diagramModelCount == 15 ? 'selected' : ''}>15</option>
                  <option value="30" \${diagramModelCount == 30 ? 'selected' : ''}>30</option>
                  <option value="50" \${diagramModelCount == 50 ? 'selected' : ''}>50</option>
                  <option value="100" \${diagramModelCount == 100 ? 'selected' : ''}>100</option>
                  <option value="all" \${diagramModelCount === 'all' ? 'selected' : ''}>All (\${models.length})</option>
                  <option value="custom" \${isCustom ? 'selected' : ''}>Custom...</option>
                </select>
                <div id="custom-input-wrapper" style="display:\${isCustom ? 'flex' : 'none'};align-items:center;gap:4px;">
                  <input type="number" id="model-count-input" placeholder="Enter number" min="1" max="\${models.length}"
                    value="\${isCustom ? diagramModelCount : ''}"
                    style="width:100px;padding:6px 10px;border-radius:4px;background:#2d2d2d;color:#fff;border:1px solid #444;"
                    onchange="updateDiagram()" onkeyup="if(event.key==='Enter')updateDiagram()">
                  <button onclick="updateDiagram()" style="padding:6px 12px;border-radius:4px;background:#3b82f6;color:#fff;border:none;cursor:pointer;">Apply</button>
                </div>
              </label>
              <label style="display:flex;align-items:center;gap:6px;">
                <span>Namespace:</span>
                <select id="namespace-select" onchange="updateDiagram()" style="padding:6px 10px;border-radius:4px;background:#2d2d2d;color:#fff;border:1px solid #444;\${diagramFocusModel ? 'opacity:0.5;' : ''}" \${diagramFocusModel ? 'disabled' : ''}>
                  <option value="all" \${diagramNamespace === 'all' ? 'selected' : ''}>All</option>
                  \${namespaces.filter(ns => ns !== 'all').map(ns => \`<option value="\${ns}" \${diagramNamespace === ns ? 'selected' : ''}>\${ns}</option>\`).join('')}
                </select>
              </label>
              <label style="display:flex;align-items:center;gap:6px;">
                <span>Focus:</span>
                <select id="focus-model-select" onchange="updateDiagram()" style="padding:6px 10px;border-radius:4px;background:#2d2d2d;color:#fff;border:1px solid #444;max-width:150px;">
                  <option value="">None</option>
                  \${modelNames.map(name => \`<option value="\${name}" \${diagramFocusModel === name ? 'selected' : ''}>\${name}</option>\`).join('')}
                </select>
                \${diagramFocusModel ? \`<button onclick="clearFocusModel()" style="padding:4px 8px;border-radius:4px;background:#666;color:#fff;border:none;cursor:pointer;" title="Clear focus">✕</button>\` : ''}
              </label>
              <label style="display:flex;align-items:center;gap:6px;">
                <span style="opacity:\${diagramFocusModel ? 1 : 0.5}">Depth:</span>
                <select id="depth-select" onchange="updateDiagram()" \${diagramFocusModel ? '' : 'disabled'} style="padding:6px 10px;border-radius:4px;background:#2d2d2d;color:#fff;border:1px solid #444;opacity:\${diagramFocusModel ? 1 : 0.5}">
                  <option value="1" \${diagramDepth === 1 ? 'selected' : ''}>1</option>
                  <option value="2" \${diagramDepth === 2 ? 'selected' : ''}>2</option>
                  <option value="3" \${diagramDepth === 3 ? 'selected' : ''}>3</option>
                  <option value="4" \${diagramDepth === 4 ? 'selected' : ''}>4</option>
                  <option value="5" \${diagramDepth === 5 ? 'selected' : ''}>5</option>
                </select>
              </label>
            </div>
          </div>
          <div class="mermaid-container" id="mermaid-container" style="flex:1;min-height:0;">
            <pre class="mermaid" id="mermaid-diagram">\${mermaidCode}</pre>
          </div>
        </div>
      \`;
    }

    // Load mermaid dynamically
    function loadMermaid() {
      const container = document.getElementById('mermaid-diagram');
      if (!container) return;

      if (window.mermaid) {
        try {
          // Re-render mermaid diagram
          container.removeAttribute('data-processed');
          window.mermaid.init(undefined, container);
          setTimeout(initDiagramPanZoom, 100);
        } catch (e) {
          console.error('Mermaid error:', e);
        }
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js';
      script.onload = () => {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'loose'
        });
        const diagram = document.getElementById('mermaid-diagram');
        if (diagram) {
          window.mermaid.init(undefined, diagram);
          setTimeout(initDiagramPanZoom, 100);
        }
      };
      document.head.appendChild(script);
    }

    // Pan and zoom functionality for mermaid diagram
    function initDiagramPanZoom() {
      const container = document.getElementById('mermaid-container');
      const svg = container?.querySelector('svg');
      if (!svg) return;

      // Calculate dynamic max zoom based on SVG size
      const svgRect = svg.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const svgWidth = svgRect.width || 1000;
      const svgHeight = svgRect.height || 500;

      // Max zoom: allow reading small text clearly
      // For very wide diagrams (many models), need much higher zoom
      const minZoom = 0.01;
      const maxZoom = Math.max(100, Math.ceil(svgWidth / 20)); // Very aggressive zoom
      window.diagramMaxZoom = maxZoom;
      window.diagramMinZoom = minZoom;
      console.log('Diagram zoom range:', minZoom, '-', maxZoom, 'x (SVG width:', svgWidth, 'px)');

      let scale = 1;
      let translateX = 0;
      let translateY = 0;
      let isDragging = false;
      let startX = 0;
      let startY = 0;

      // Style the container
      container.style.overflow = 'hidden';
      container.style.cursor = 'grab';
      container.style.position = 'relative';
      svg.style.transformOrigin = 'center center';
      svg.style.transition = 'none';

      // Create fullscreen modal INSIDE the container (important for fullscreen mode)
      let fsModal = container.querySelector('#fs-detail-modal');
      if (!fsModal) {
        fsModal = document.createElement('div');
        fsModal.id = 'fs-detail-modal';
        fsModal.style.cssText = 'display:none;position:absolute;top:0;right:0;width:350px;height:100%;background:#161b22;z-index:100;overflow-y:auto;border-left:1px solid #30363d;';
        container.appendChild(fsModal);
      }

      // Make SVG and all children clickable
      svg.style.pointerEvents = 'all';
      
      // Direct click on SVG
      svg.addEventListener('click', (e) => {
        console.log('[Diagram] Click detected on:', e.target.tagName, e.target.textContent?.substring(0, 30));
        
        // Don't handle if it was dragging
        if (isDragging) return;
        
        // Find model name from clicked element or nearby
        let modelName = null;
        let searchEl = e.target;
        
        // First check if clicked element itself has model name
        if (searchEl.textContent) {
          const text = searchEl.textContent.trim();
          if (/^[A-Z][a-zA-Z0-9_]+$/.test(text) && text.length > 2) {
            modelName = text;
          }
        }
        
        // Search parent elements
        if (!modelName) {
          for (let i = 0; i < 10 && searchEl && searchEl !== svg; i++) {
            // Look for text elements in this group
            const texts = searchEl.querySelectorAll ? searchEl.querySelectorAll('text') : [];
            for (const t of texts) {
              const text = t.textContent?.trim();
              if (text && /^[A-Z][a-zA-Z0-9_]+$/.test(text) && text.length > 2) {
                modelName = text;
                break;
              }
            }
            if (modelName) break;
            searchEl = searchEl.parentElement;
          }
        }

        console.log('[Diagram] Found model:', modelName);
        
        if (modelName) {
          // Show in fullscreen modal if in fullscreen, otherwise normal panel
          if (document.fullscreenElement) {
            console.log('[Diagram] Showing in fullscreen modal');
            showModelDetailInModal(modelName);
          } else {
            console.log('[Diagram] Showing in detail panel');
            showModelDetail(modelName);
          }
        }
      });

      // Function to show detail in fullscreen modal
      window.showModelDetailInModal = (modelOrName) => {
        let model = modelOrName;
        if (typeof modelOrName === 'string') {
          const normalizedName = modelOrName.replace(/_/g, '');
          model = models.find(m => {
            const className = (m.className || m.name || '').replace(/[^a-zA-Z0-9]/g, '');
            return className.toLowerCase() === normalizedName.toLowerCase();
          });
        }
        
        // Find modal inside the container
        const modal = container.querySelector('#fs-detail-modal');
        if (!modal) {
          console.error('[Diagram] Modal not found in container');
          return;
        }
        
        if (!model) {
          modal.innerHTML = \`
            <div style="padding:16px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <strong>Model Not Found</strong>
                <button onclick="document.getElementById('fs-detail-modal').style.display='none'" style="background:none;border:none;color:var(--text-primary);font-size:20px;cursor:pointer;">×</button>
              </div>
              <p>Model "\${modelOrName}" not found.</p>
            </div>
          \`;
          modal.style.display = 'block';
          return;
        }
        
        modal.innerHTML = \`
          <div style="padding:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
              <strong>\${model.className}</strong>
              <button onclick="document.getElementById('fs-detail-modal').style.display='none'" style="background:none;border:none;color:var(--text-primary);font-size:20px;cursor:pointer;">×</button>
            </div>
            <div style="color:var(--text-secondary);margin-bottom:16px;">extends \${model.parentClass}</div>
            \${model.associations.length > 0 ? \`
              <div style="margin-bottom:16px;">
                <div style="font-weight:600;margin-bottom:8px;">Associations (\${model.associations.length})</div>
                \${model.associations.slice(0, 15).map(a => \`
                  <div style="padding:4px 0;font-size:13px;">
                    <span style="background:var(--accent-blue);padding:2px 6px;border-radius:3px;font-size:11px;margin-right:6px;">\${a.type}</span>
                    :\${a.name}
                    \${a.through ? \`<small style="color:var(--text-secondary);"> through: \${a.through}</small>\` : ''}
                  </div>
                \`).join('')}
              </div>
            \` : ''}
            \${model.validations.length > 0 ? \`
              <div style="margin-bottom:16px;">
                <div style="font-weight:600;margin-bottom:8px;">Validations (\${model.validations.length})</div>
                \${model.validations.slice(0, 10).map(v => \`
                  <div style="padding:4px 0;font-size:13px;">
                    <span style="background:var(--accent-green);padding:2px 6px;border-radius:3px;font-size:11px;margin-right:6px;">\${v.type}</span>
                    \${v.attributes.join(', ')}
                  </div>
                \`).join('')}
              </div>
            \` : ''}
            \${model.scopes.length > 0 ? \`
              <div style="margin-bottom:16px;">
                <div style="font-weight:600;margin-bottom:8px;">Scopes (\${model.scopes.length})</div>
                \${model.scopes.map(s => \`<div style="padding:4px 0;font-size:13px;"><span style="background:var(--accent-orange);padding:2px 6px;border-radius:3px;font-size:11px;margin-right:6px;">scope</span>\${s.name}</div>\`).join('')}
              </div>
            \` : ''}
          </div>
        \`;
        modal.style.display = 'block';
      };

      // Close modal on ESC
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          const modal = container.querySelector('#fs-detail-modal');
          if (modal) modal.style.display = 'none';
        }
      });

      // Add zoom controls
      const controls = document.createElement('div');
      controls.className = 'diagram-controls';
      controls.innerHTML = \`
        <button onclick="diagramZoom(0.2)" title="Zoom In">+</button>
        <button onclick="diagramZoom(-0.2)" title="Zoom Out">−</button>
        <button onclick="diagramReset()" title="Reset">⟲</button>
        <button onclick="diagramFullscreen()" title="Fullscreen" id="fullscreen-btn">⛶</button>
      \`;
      controls.style.cssText = 'position:absolute;top:8px;right:8px;display:flex;gap:4px;z-index:10';
      container.appendChild(controls);

      // Fullscreen change handler
      document.addEventListener('fullscreenchange', () => {
        const btn = document.getElementById('fullscreen-btn');
        if (document.fullscreenElement) {
          if (btn) {
            btn.textContent = '⛶';
            btn.title = 'Exit Fullscreen';
          }
          container.style.background = '#1e1e1e';
        } else {
          if (btn) {
            btn.textContent = '⛶';
            btn.title = 'Fullscreen';
          }
          container.style.background = '';
          // Hide fullscreen modal when exiting
          const modal = container.querySelector('#fs-detail-modal');
          if (modal) modal.style.display = 'none';
        }
      });

      function updateTransform() {
        svg.style.transform = \`translate(\${translateX}px, \${translateY}px) scale(\${scale})\`;
      }

      // Mouse wheel zoom (extended range: 0.3x to 10x)
      container.addEventListener('wheel', (e) => {
        e.preventDefault();
        // Dynamic step: larger steps at higher zoom levels for faster navigation
        const step = Math.max(0.1, scale * 0.15);
        const delta = e.deltaY > 0 ? -step : step;
        scale = Math.max(minZoom, Math.min(maxZoom, scale + delta));
        updateTransform();
      }, { passive: false });

      // Touch pinch zoom
      let lastTouchDist = 0;
      container.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          lastTouchDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
        } else if (e.touches.length === 1) {
          isDragging = true;
          startX = e.touches[0].clientX - translateX;
          startY = e.touches[0].clientY - translateY;
        }
      });

      container.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
          );
          const delta = (dist - lastTouchDist) * 0.01;
          scale = Math.max(minZoom, Math.min(maxZoom, scale + delta));
          lastTouchDist = dist;
          updateTransform();
        } else if (e.touches.length === 1 && isDragging) {
          translateX = e.touches[0].clientX - startX;
          translateY = e.touches[0].clientY - startY;
          updateTransform();
        }
      }, { passive: false });

      container.addEventListener('touchend', () => { isDragging = false; });

      // Mouse drag pan
      container.addEventListener('mousedown', (e) => {
        isDragging = true;
        container.style.cursor = 'grabbing';
        startX = e.clientX - translateX;
        startY = e.clientY - translateY;
      });

      container.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        translateX = e.clientX - startX;
        translateY = e.clientY - startY;
        updateTransform();
      });

      container.addEventListener('mouseup', () => {
        isDragging = false;
        container.style.cursor = 'grab';
      });

      container.addEventListener('mouseleave', () => {
        isDragging = false;
        container.style.cursor = 'grab';
      });

      // Global functions for controls
      window.diagramZoom = (delta) => {
        // Dynamic step based on current scale
        const step = Math.max(0.2, scale * 0.2);
        const actualDelta = delta > 0 ? step : -step;
        scale = Math.max(minZoom, Math.min(maxZoom, scale + actualDelta));
        updateTransform();
      };

      window.diagramReset = () => {
        scale = 1;
        translateX = 0;
        translateY = 0;
        updateTransform();
      };

      window.diagramFullscreen = () => {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          container.requestFullscreen().catch(err => {
            console.error('Fullscreen error:', err);
          });
        }
      };
    }

    function highlightParams(path) {
      return path.replace(/:([a-zA-Z_]+)/g, '<span class="param">:$1</span>');
    }

    function capitalize(str) {
      return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function singularize(str) {
      if (str.endsWith('ies')) return str.slice(0, -3) + 'y';
      if (str.endsWith('s')) return str.slice(0, -1);
      return str;
    }

    function attachEventListeners() {
      document.querySelectorAll('[data-type="route"]').forEach(row => {
        row.addEventListener('click', () => {
          const idx = parseInt(row.dataset.index);
          const route = filterRoutes()[idx];
          showRouteDetail(route);
        });
      });

      document.querySelectorAll('[data-type="controller"]').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.controller-header')) {
            card.classList.toggle('expanded');
          }
          const idx = parseInt(card.dataset.index);
          // Use filtered array to get correct item
          if (filteredControllers[idx]) {
            showControllerDetail(filteredControllers[idx]);
          }
        });
      });

      document.querySelectorAll('[data-type="model"]').forEach(card => {
        card.addEventListener('click', () => {
          const idx = parseInt(card.dataset.index);
          // Use filtered array to get correct item
          if (filteredModels[idx]) {
            showModelDetail(filteredModels[idx]);
          }
        });
      });
    }

    function showRouteDetail(route) {
      detailPanel.innerHTML = \`
        <div class="detail-header">
          <div class="detail-title">Route Details</div>
          <button class="close-btn" onclick="clearDetail()">×</button>
        </div>
        <div class="detail-content">
          <div class="detail-section">
            <div class="detail-section-title">Method & Path</div>
            <div class="detail-item">
              <span class="method-badge method-\${route.method}">\${route.method}</span>
              <code>\${route.path}</code>
            </div>
          </div>
          <div class="detail-section">
            <div class="detail-section-title">Controller</div>
            <div class="detail-item">\${route.controller}#\${route.action}</div>
          </div>
          \${route.namespace ? \`
          <div class="detail-section">
            <div class="detail-section-title">Namespace</div>
            <div class="detail-item">\${route.namespace}</div>
          </div>
          \` : ''}
          <div class="detail-section">
            <div class="detail-section-title">Line</div>
            <div class="detail-item">routes.rb:\${route.line}</div>
          </div>
        </div>
      \`;
    }

    function showControllerDetail(ctrl) {
      detailPanel.innerHTML = \`
        <div class="detail-header">
          <div class="detail-title">Controller Details</div>
          <button class="close-btn" onclick="clearDetail()">×</button>
        </div>
        <div class="detail-content">
          <div class="detail-section">
            <div class="detail-section-title">Class</div>
            <div class="detail-item">\${ctrl.className}</div>
            <div class="detail-item" style="color: var(--text-secondary)">extends \${ctrl.parentClass}</div>
          </div>
          \${ctrl.beforeActions.length > 0 ? \`
          <div class="detail-section">
            <div class="detail-section-title">Before Actions</div>
            \${ctrl.beforeActions.map(f => \`
              <div class="detail-item">
                <span class="tag tag-orange">before</span>
                \${f.name}
                \${f.only ? \`<br><small style="color: var(--text-secondary)">only: \${f.only.join(', ')}</small>\` : ''}
              </div>
            \`).join('')}
          </div>
          \` : ''}
          \${ctrl.concerns.length > 0 ? \`
          <div class="detail-section">
            <div class="detail-section-title">Concerns</div>
            \${ctrl.concerns.map(c => \`<div class="detail-item"><span class="tag tag-purple">include</span>\${c}</div>\`).join('')}
          </div>
          \` : ''}
          <div class="detail-section">
            <div class="detail-section-title">Actions (\${ctrl.actions.length})</div>
            \${ctrl.actions.slice(0, 20).map(a => \`
              <div class="detail-item">
                <span class="tag tag-\${a.visibility === 'public' ? 'green' : a.visibility === 'private' ? 'pink' : 'orange'}">\${a.visibility}</span>
                \${a.name}
              </div>
            \`).join('')}
            \${ctrl.actions.length > 20 ? '<div class="detail-item" style="color: var(--text-secondary)">...</div>' : ''}
          </div>
        </div>
      \`;
    }

    function showModelDetail(modelOrName) {
      // Support both model object and model name string
      let model = modelOrName;
      if (typeof modelOrName === 'string') {
        const normalizedName = modelOrName.replace(/_/g, '');
        model = models.find(m => {
          const className = (m.className || m.name || '').replace(/[^a-zA-Z0-9]/g, '');
          return className.toLowerCase() === normalizedName.toLowerCase();
        });
        if (!model) {
          detailPanel.innerHTML = \`
            <div class="detail-header">
              <div class="detail-title">Model Not Found</div>
              <button class="close-btn" onclick="clearDetail()">×</button>
            </div>
            <div class="detail-content">
              <div class="empty-state">
                <div>Model "\${modelOrName}" not found in analysis data.</div>
              </div>
            </div>
          \`;
          detailPanel.classList.add('open');
          return;
        }
      }
      detailPanel.classList.add('open');
      detailPanel.innerHTML = \`
        <div class="detail-header">
          <div class="detail-title">Model Details</div>
          <button class="close-btn" onclick="clearDetail()">×</button>
        </div>
        <div class="detail-content">
          <div class="detail-section">
            <div class="detail-section-title">Class</div>
            <div class="detail-item">\${model.className}</div>
            <div class="detail-item" style="color: var(--text-secondary)">extends \${model.parentClass}</div>
          </div>
          \${model.associations.length > 0 ? \`
          <div class="detail-section">
            <div class="detail-section-title">Associations (\${model.associations.length})</div>
            \${model.associations.slice(0, 15).map(a => \`
              <div class="detail-item">
                <span class="tag tag-blue">\${a.type}</span>
                :\${a.name}
                \${a.through ? \`<small style="color: var(--text-secondary)"> through: \${a.through}</small>\` : ''}
                \${a.polymorphic ? '<span class="tag tag-purple">poly</span>' : ''}
              </div>
            \`).join('')}
            \${model.associations.length > 15 ? '<div class="detail-item" style="color: var(--text-secondary)">...</div>' : ''}
          </div>
          \` : ''}
          \${model.validations.length > 0 ? \`
          <div class="detail-section">
            <div class="detail-section-title">Validations (\${model.validations.length})</div>
            \${model.validations.slice(0, 10).map(v => \`
              <div class="detail-item">
                <span class="tag tag-green">\${v.type}</span>
                \${v.attributes.join(', ')}
              </div>
            \`).join('')}
          </div>
          \` : ''}
          \${model.scopes.length > 0 ? \`
          <div class="detail-section">
            <div class="detail-section-title">Scopes (\${model.scopes.length})</div>
            \${model.scopes.map(s => \`<div class="detail-item"><span class="tag tag-orange">scope</span>\${s.name}</div>\`).join('')}
          </div>
          \` : ''}
          \${model.enums.length > 0 ? \`
          <div class="detail-section">
            <div class="detail-section-title">Enums</div>
            \${model.enums.map(e => \`
              <div class="detail-item">
                <span class="tag tag-pink">enum</span>
                \${e.name}: \${e.values.slice(0, 5).join(', ')}\${e.values.length > 5 ? '...' : ''}
              </div>
            \`).join('')}
          </div>
          \` : ''}
        </div>
      \`;
    }

    function clearDetail() {
      detailPanel.innerHTML = \`
        <div class="empty-state">
          <div class="empty-state-icon">👆</div>
          <div>Select an item to view details</div>
        </div>
      \`;
    }

    // Initialize
    loadStateFromUrl();
    renderMainPanel();
  </script>
</body>
</html>`;
  }

  private generateNamespaceList(routes: RailsRoute[]): string {
    const namespaces = new Map<string, number>();

    for (const route of routes) {
      const ns = route.namespace || 'root';
      namespaces.set(ns, (namespaces.get(ns) || 0) + 1);
    }

    const sorted = [...namespaces.entries()].sort((a, b) => b[1] - a[1]);

    return sorted
      .map(
        ([ns, count]) => `
      <div class="namespace-item" data-namespace="${ns === 'root' ? '' : ns}">
        <span>${ns}</span>
        <span class="namespace-count">${count}</span>
      </div>
    `
      )
      .join('');
  }

  private generateMethodFilters(routes: RailsRoute[]): string {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const counts = new Map<string, number>();

    for (const route of routes) {
      counts.set(route.method, (counts.get(route.method) || 0) + 1);
    }

    return methods
      .map(
        (method) => `
      <div class="namespace-item" data-method="${method}">
        <span class="method-badge method-${method}">${method}</span>
        <span class="namespace-count">${counts.get(method) || 0}</span>
      </div>
    `
      )
      .join('');
  }

  private generateRoutesView(routes: RailsRoute[]): string {
    return `
      <div class="panel-header">
        <div class="panel-title">Routes (${routes.length})</div>
      </div>
      <table class="routes-table">
        <thead>
          <tr>
            <th>Method</th>
            <th>Path</th>
            <th>Controller#Action</th>
          </tr>
        </thead>
        <tbody>
          ${routes
            .slice(0, 200)
            .map(
              (route, idx) => `
            <tr data-type="route" data-index="${idx}">
              <td><span class="method-badge method-${route.method}">${route.method}</span></td>
              <td class="path-text">${this.highlightParams(route.path)}</td>
              <td class="controller-text">${route.controller}#${route.action}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  private highlightParams(path: string): string {
    return path.replace(/:([a-zA-Z_]+)/g, '<span class="param">:$1</span>');
  }
}

// Standalone execution
async function main() {
  const targetPath = process.argv[2] || process.cwd();
  const outputPath = process.argv[3] || path.join(targetPath, 'rails-map.html');

  const generator = new RailsMapGenerator(targetPath);
  await generator.generate({
    title: 'Rails Application Map',
    outputPath,
  });
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(console.error);
}
