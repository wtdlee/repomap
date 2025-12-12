/**
 * Rails Map Generator
 * Rails分析結果をインタラクティブなHTMLページとして生成する
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  analyzeRailsApp,
  type RailsAnalysisResult,
  type RailsRoute,
  type ControllerInfo,
  type ModelInfo,
  type AssociationInfo,
} from '../analyzers/rails/index.js';

export interface RailsMapOptions {
  title?: string;
  outputPath?: string;
}

export class RailsMapGenerator {
  private result: RailsAnalysisResult | null = null;

  constructor(private rootPath: string) {}

  async generate(options: RailsMapOptions = {}): Promise<string> {
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

  private generateHTML(title: string): string {
    if (!this.result) throw new Error('Analysis not run');

    const { routes, controllers, models, summary } = this.result;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="/rails-map.css">
</head>
<body>
  <header>
    <h1>🛤️ ${title}</h1>
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
      
      <div class="sidebar-section">
        <div class="sidebar-title">Namespaces (${summary.namespaces.length})</div>
        <div class="namespace-list">
          <div class="namespace-item active" data-namespace="all">
            <span>📁 All</span>
            <span class="namespace-count">${routes.routes.length}</span>
          </div>
          ${this.generateNamespaceList(routes.routes)}
        </div>
      </div>

      <div class="sidebar-section">
        <div class="sidebar-title">HTTP Methods</div>
        <div class="namespace-list">
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

    // State
    let currentView = 'routes';
    let selectedNamespace = 'all';
    let selectedMethod = 'all';
    let searchQuery = '';

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
        renderMainPanel();
      });
    });

    document.querySelectorAll('.namespace-item').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.namespace-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        selectedNamespace = item.dataset.namespace;
        renderMainPanel();
      });
    });

    searchBox.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      renderMainPanel();
    });

    // Render Functions
    function renderMainPanel() {
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
        case 'diagram':
          mainPanel.innerHTML = renderDiagramView();
          break;
      }
      attachEventListeners();
    }

    function filterRoutes() {
      return routes.filter(route => {
        if (selectedNamespace !== 'all' && route.namespace !== selectedNamespace) return false;
        if (selectedMethod !== 'all' && route.method !== selectedMethod) return false;
        if (searchQuery) {
          const searchStr = (route.path + route.controller + route.action).toLowerCase();
          if (!searchStr.includes(searchQuery)) return false;
        }
        return true;
      });
    }

    function renderRoutesView() {
      const filtered = filterRoutes();
      return \`
        <div class="panel-header">
          <div class="panel-title">Routes (\${filtered.length})</div>
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
            \${filtered.slice(0, 200).map((route, idx) => \`
              <tr data-type="route" data-index="\${idx}">
                <td><span class="method-badge method-\${route.method}">\${route.method}</span></td>
                <td class="path-text">\${highlightParams(route.path)}</td>
                <td class="controller-text">\${route.controller}#\${route.action}</td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
        \${filtered.length > 200 ? '<p style="padding: 20px; color: var(--text-secondary);">Showing first 200 routes...</p>' : ''}
      \`;
    }

    function renderControllersView() {
      let filtered = controllers;
      if (searchQuery) {
        filtered = controllers.filter(c => 
          c.className.toLowerCase().includes(searchQuery) ||
          c.actions.some(a => a.name.toLowerCase().includes(searchQuery))
        );
      }
      if (selectedNamespace !== 'all') {
        filtered = filtered.filter(c => c.namespace === selectedNamespace);
      }

      return \`
        <div class="panel-header">
          <div class="panel-title">Controllers (\${filtered.length})</div>
        </div>
        <div>
          \${filtered.slice(0, 50).map((ctrl, idx) => \`
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
      \`;
    }

    function renderModelsView() {
      let filtered = models;
      if (searchQuery) {
        filtered = models.filter(m => 
          m.className.toLowerCase().includes(searchQuery)
        );
      }

      return \`
        <div class="panel-header">
          <div class="panel-title">Models (\${filtered.length})</div>
        </div>
        <div>
          \${filtered.slice(0, 50).map((model, idx) => \`
            <div class="model-card" data-type="model" data-index="\${idx}">
              <div class="model-name">
                📦 \${model.className}
                \${model.concerns.length > 0 ? \`<span class="tag tag-purple">\${model.concerns.length} concerns</span>\` : ''}
              </div>
              <div class="model-stats">
                <span>📎 \${model.associations.length} associations</span>
                <span>✓ \${model.validations.length} validations</span>
                <span>🔄 \${model.callbacks.length} callbacks</span>
              </div>
            </div>
          \`).join('')}
        </div>
      \`;
    }

    function renderDiagramView() {
      const topModels = models
        .sort((a, b) => b.associations.length - a.associations.length)
        .slice(0, 15);

      let mermaidCode = 'erDiagram\\n';
      
      topModels.forEach(model => {
        model.associations.forEach(assoc => {
          const targetModel = assoc.className || capitalize(singularize(assoc.name));
          if (topModels.some(m => m.name === targetModel || m.className === targetModel)) {
            const rel = assoc.type === 'belongs_to' ? '||--o{' : 
                       assoc.type === 'has_one' ? '||--||' : 
                       '||--o{';
            mermaidCode += \`  \${model.name} \${rel} \${targetModel} : "\${assoc.type}"\\n\`;
          }
        });
      });

      return \`
        <div class="panel-header">
          <div class="panel-title">Model Relationships (Top 15 by associations)</div>
        </div>
        <div class="mermaid-container">
          <pre class="mermaid">\${mermaidCode}</pre>
        </div>
        <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"><\\/script>
        <script>mermaid.initialize({startOnLoad: true, theme: 'dark'});<\\/script>
      \`;
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
          showControllerDetail(controllers[idx]);
        });
      });

      document.querySelectorAll('[data-type="model"]').forEach(card => {
        card.addEventListener('click', () => {
          const idx = parseInt(card.dataset.index);
          showModelDetail(models[idx]);
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

    function showModelDetail(model) {
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
    attachEventListeners();
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
      .slice(0, 20)
      .map(
        ([ns, count]) => `
      <div class="namespace-item" data-namespace="${ns === 'root' ? '' : ns}">
        <span>📂 ${ns}</span>
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
