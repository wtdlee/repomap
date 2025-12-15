import * as vscode from 'vscode';
import type { GraphqlTreeNode } from './graphql-structure';

export type GraphqlStructureWebviewInit = {
  title: string;
  tree: GraphqlTreeNode;
};

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatRootLabel(label: string): string {
  // label examples:
  // - "query: GetMessageSidebar"
  // - "mutation: Foo"
  // - "fragment Foo on Bar"
  const m = label.match(/^(query|mutation|subscription)\s*:\s*(.+)$/i);
  if (m) return `${m[1].toLowerCase()} ${m[2]}`;
  return label;
}

function renderAsGraphql(node: GraphqlTreeNode, indent: number): string {
  const pad = '  '.repeat(Math.max(0, indent));
  const id = encodeURIComponent(node.id);

  if (node.kind === 'root') {
    const root = escapeHtml(formatRootLabel(node.label));
    const open = `${pad}${root} {`;
    const body = (node.children ?? []).map((c) => renderAsGraphql(c, indent + 1)).join('');
    const close = `${pad}}\n`;
    return `${open}\n${body}${close}`;
  }

  if (node.kind === 'note') {
    return `${pad}# ${escapeHtml(node.label)}\n`;
  }

  const clickable = `<span class="node" data-id="${id}">${escapeHtml(node.label)}</span>`;

  if (!node.children || node.children.length === 0) {
    return `${pad}${clickable}\n`;
  }

  const open = `${pad}${clickable} {`;
  const body = node.children.map((c) => renderAsGraphql(c, indent + 1)).join('');
  const close = `${pad}}\n`;
  return `${open}\n${body}${close}`;
}

export function getGraphqlStructureWebviewHtml(
  webview: vscode.Webview,
  init: GraphqlStructureWebviewInit
): string {
  const nonce = String(Date.now());
  const title = escapeHtml(init.title);
  const code = renderAsGraphql(init.tree, 0);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif; padding: 12px; }
      .header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
      .title { font-weight: 700; }
      .toolbar { display: flex; gap: 6px; align-items: center; }
      .iconbtn { width: 32px; height: 28px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--vscode-foreground); cursor: pointer; display:flex; align-items:center; justify-content:center; }
      .iconbtn:hover { background: rgba(127,127,127,0.18); }
      .iconbtn.on { background: rgba(91, 91, 214, 0.22); border-color: rgba(91, 91, 214, 0.35); }
      .hint { opacity: 0.75; font-size: 12px; margin-top: 4px; }
      pre { margin: 0; padding: 10px 12px; border: 1px solid #333; border-radius: 10px; background: rgba(0,0,0,0.08); overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12.5px; line-height: 1.55; }
      .node { cursor: pointer; border-radius: 4px; padding: 0 2px; }
      .selected { outline: 1px solid #5b5bd6; background: rgba(91, 91, 214, 0.18); }
    </style>
  </head>
  <body>
    <div class="header">
      <div>
        <div class="title">${title}</div>
        <div class="hint">Click a field / fragment to jump to it in the editor</div>
      </div>
      <div class="toolbar">
        <button class="iconbtn on" id="follow" title="Follow cursor (sync selection)" aria-pressed="true">◎</button>
        <button class="iconbtn" id="clear" title="Clear selection">✕</button>
      </div>
    </div>
    <pre id="code">${code}</pre>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const code = document.getElementById('code');
      let selectedEl = null;
      let follow = true;

      function setSelected(el) {
        if (selectedEl) selectedEl.classList.remove('selected');
        selectedEl = el;
        if (selectedEl) selectedEl.classList.add('selected');
      }

      code.addEventListener('click', (e) => {
        const el = e.target.closest('[data-id]');
        if (!el) return;
        const id = decodeURIComponent(el.getAttribute('data-id'));
        setSelected(el);
        vscode.postMessage({ type: 'focusNode', id });
      });

      document.getElementById('clear').addEventListener('click', () => {
        setSelected(null);
        vscode.postMessage({ type: 'clearHighlight' });
      });

      document.getElementById('follow').addEventListener('click', () => {
        follow = !follow;
        document.getElementById('follow').classList.toggle('on', follow);
        document.getElementById('follow').setAttribute('aria-pressed', follow ? 'true' : 'false');
        vscode.postMessage({ type: 'setFollowCursor', enabled: follow });
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'selectNode' && typeof msg.id === 'string') {
          const idEnc = encodeURIComponent(msg.id);
          const el = code.querySelector('[data-id="' + idEnc + '"]');
          if (el) setSelected(el);
        }
        if (msg.type === 'setFollowCursor' && typeof msg.enabled === 'boolean') {
          follow = msg.enabled;
          document.getElementById('follow').classList.toggle('on', follow);
          document.getElementById('follow').setAttribute('aria-pressed', follow ? 'true' : 'false');
        }
      });
    </script>
  </body>
</html>`;
}


