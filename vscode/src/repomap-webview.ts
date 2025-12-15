import * as vscode from 'vscode';
import type { AnalysisResult } from './repomap-types';

export type WebviewInit = {
  report: AnalysisResult | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getWebviewHtml(webview: vscode.Webview, init: WebviewInit): string {
  const nonce = String(Date.now());
  const data = escapeHtml(JSON.stringify(init.report ?? null));

  // Note: this UI is intentionally simple and self-contained.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Repomap</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; padding: 12px; }
      .row { display: flex; gap: 8px; align-items: center; }
      input { flex: 1; padding: 8px; }
      button { padding: 8px 10px; }
      .tabs { display: flex; gap: 8px; margin-top: 10px; }
      .tab { cursor: pointer; padding: 6px 10px; border-radius: 6px; background: #2a2a2a; color: #fff; }
      .tab.active { background: #5b5bd6; }
      .list { margin-top: 10px; }
      .item { padding: 8px; border: 1px solid #333; border-radius: 8px; margin-bottom: 8px; }
      .item .title { font-weight: 600; }
      .item .meta { opacity: 0.8; font-size: 12px; margin-top: 4px; }
      .click { color: #8ab4f8; cursor: pointer; text-decoration: underline; }
      .empty { opacity: 0.7; padding: 12px; }
    </style>
  </head>
  <body>
    <div class="row">
      <input id="q" placeholder="Search pages / components / operations" />
      <button id="refresh">Refresh</button>
    </div>
    <div class="tabs">
      <div class="tab active" data-tab="pages">Pages</div>
      <div class="tab" data-tab="components">Components</div>
      <div class="tab" data-tab="graphql">GraphQL</div>
    </div>
    <div id="list" class="list"></div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const report = JSON.parse(${JSON.stringify(data)});

      const state = { tab: 'pages', q: '' };

      const elQ = document.getElementById('q');
      const elList = document.getElementById('list');

      function norm(s) { return String(s || '').toLowerCase(); }

      function openFile(filePath, line) {
        vscode.postMessage({ type: 'openFile', filePath, line });
      }

      function renderEmpty(msg) {
        elList.innerHTML = '<div class="empty">' + msg + '</div>';
      }

      function render() {
        if (!report) {
          renderEmpty('No report loaded yet. Click Refresh.');
          return;
        }

        const q = norm(state.q);
        const pages = (report.pages || []).map(p => ({
          title: p.path,
          filePath: p.filePath,
          meta: p.filePath,
        }));

        const components = (report.components || []).map(c => ({
          title: c.name,
          filePath: c.filePath,
          meta: (c.type || 'component') + ' · deps ' + (c.dependencies || []).length + ' · used-by ' + (c.dependents || []).length,
        }));

        const graphql = (report.graphqlOperations || []).map(o => ({
          title: o.type + ': ' + o.name,
          filePath: o.filePath,
          meta: o.filePath + ' · used-in ' + (o.usedIn || []).length,
        }));

        const map = { pages, components, graphql };
        const items = (map[state.tab] || []).filter(it => {
          if (!q) return true;
          return norm(it.title).includes(q) || norm(it.meta).includes(q);
        });

        if (items.length === 0) {
          renderEmpty('No results.');
          return;
        }

        elList.innerHTML = items.map(it => {
          const safeTitle = it.title.replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const safeMeta = it.meta.replace(/</g,'&lt;').replace(/>/g,'&gt;');
          return (
            '<div class=\"item\">' +
              '<div class=\"title\">' + safeTitle + '</div>' +
              '<div class=\"meta\">' +
                '<span class=\"click\" data-open=\"' + encodeURIComponent(it.filePath) + '\">Open file</span>' +
                ' · ' + safeMeta +
              '</div>' +
            '</div>'
          );
        }).join('');

        for (const a of elList.querySelectorAll('[data-open]')) {
          a.addEventListener('click', () => {
            const fp = decodeURIComponent(a.getAttribute('data-open'));
            openFile(fp);
          });
        }
      }

      document.getElementById('refresh').addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
      });

      elQ.addEventListener('input', () => {
        state.q = elQ.value;
        render();
      });

      for (const t of document.querySelectorAll('.tab')) {
        t.addEventListener('click', () => {
          for (const x of document.querySelectorAll('.tab')) x.classList.remove('active');
          t.classList.add('active');
          state.tab = t.getAttribute('data-tab');
          render();
        });
      }

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'setReport') {
          // Replace in-place.
          location.reload();
        }
      });

      render();
    </script>
  </body>
</html>`;
}
