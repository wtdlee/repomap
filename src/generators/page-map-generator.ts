import type { PageInfo, DocumentationReport, GraphQLOperation, APICall } from '../types.js';

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
}

/**
 * Interactive page map generator
 */
export class PageMapGenerator {
  private graphqlOps: GraphQLOperation[] = [];
  private apiCalls: APICall[] = [];
  private components: ComponentData[] = [];

  generatePageMapHtml(report: DocumentationReport): string {
    const allPages: PageNode[] = [];

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

    return this.renderPageMapHtml(allPages, rootPages, relations);
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
    relations: PageRelation[]
  ): string {
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
  <title>Page Map</title>
  <style>
    :root {
      --bg: #0f172a;
      --bg2: #1e293b;
      --bg3: #334155;
      --text: #f8fafc;
      --text2: #94a3b8;
      --border: #475569;
      --accent: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); }
    
    .header {
      background: var(--bg2);
      padding: 12px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header h1 { font-size: 18px; }
    .tabs { display: flex; gap: 4px; }
    .tab {
      padding: 6px 16px;
      background: var(--bg3);
      border: none;
      border-radius: 4px;
      color: var(--text2);
      cursor: pointer;
      font-size: 13px;
    }
    .tab.active { background: var(--accent); color: white; }
    
    .search {
      padding: 6px 12px;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      width: 200px;
    }
    
    .main { display: flex; height: calc(100vh - 54px); }
    
    .sidebar {
      width: 280px;
      background: var(--bg2);
      border-right: 1px solid var(--border);
      padding: 16px;
      overflow-y: auto;
    }
    .sidebar h3 { font-size: 10px; text-transform: uppercase; color: var(--text2); margin: 16px 0 8px; letter-spacing: 1px; }
    .sidebar h3:first-child { margin-top: 0; }
    
    .legend { font-size: 12px; color: var(--text2); }
    .legend-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
    .legend-color { width: 12px; height: 12px; border-radius: 2px; }
    
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px; }
    .stat { background: var(--bg3); padding: 10px; border-radius: 6px; text-align: center; cursor: pointer; transition: all 0.2s; border: 2px solid transparent; }
    .stat:hover { background: #475569; }
    .stat.active { border-color: var(--accent); background: #1e3a5f; }
    .stat-val { font-size: 20px; font-weight: 600; }
    .stat-label { font-size: 10px; color: var(--text2); }
    
    .content { flex: 1; overflow: hidden; position: relative; }
    
    /* Tree View */
    .tree-view { padding: 20px; overflow: auto; height: 100%; display: none; }
    .tree-view.active { display: block; }
    
    .group { background: var(--bg2); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
    .group-header {
      padding: 10px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      border-left: 3px solid var(--group-color, var(--accent));
    }
    .group-header:hover { background: var(--bg3); }
    .group-name { font-family: monospace; font-weight: 600; flex: 1; }
    .group-count { font-size: 11px; color: var(--text2); background: var(--bg3); padding: 2px 8px; border-radius: 10px; }
    .group.collapsed .group-content { display: none; }
    .group.collapsed .group-arrow { transform: rotate(-90deg); }
    .group-arrow { font-size: 10px; color: var(--text2); transition: transform 0.2s; }
    
    .page-item {
      display: flex;
      align-items: center;
      padding: 8px 14px;
      padding-left: calc(14px + var(--depth, 0) * 16px);
      border-top: 1px solid var(--border);
      cursor: pointer;
      gap: 8px;
    }
    .page-item:hover { background: var(--bg3); }
    .page-item.selected { background: var(--bg3); border-left: 2px solid var(--accent); }
    
    .page-type {
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
      background: var(--type-color, #64748b);
      color: white;
      min-width: 52px;
      text-align: center;
      flex-shrink: 0;
    }
    .page-path { font-family: monospace; font-size: 12px; color: var(--accent); flex: 1; }
    .page-tags { display: flex; gap: 4px; }
    .tag { font-size: 9px; padding: 2px 5px; border-radius: 3px; background: var(--bg); color: var(--text2); }
    .tag-repo { background: #1e293b; color: #94a3b8; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
    .tag-auth { background: #7f1d1d; color: #fca5a5; }
    .tag-query { background: #1e3a5f; color: #93c5fd; }
    .tag-mutation { background: #5f1e3a; color: #fda4af; }
    
    /* Graph View - Improved */
    .graph-view { width: 100%; height: 100%; display: none; background: var(--bg2); }
    .graph-view.active { display: block; }
    
    .graph-container {
      width: 100%;
      height: 100%;
      overflow: hidden;
      position: relative;
    }
    
    .graph-controls {
      position: absolute;
      top: 10px;
      right: 10px;
      display: flex;
      gap: 4px;
      z-index: 10;
    }
    .graph-btn {
      padding: 6px 10px;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      cursor: pointer;
      font-size: 12px;
    }
    .graph-btn:hover { background: var(--accent); }
    
    .graph-info {
      position: absolute;
      bottom: 10px;
      left: 10px;
      background: var(--bg3);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 11px;
      color: var(--text2);
    }
    
    #graph-canvas {
      width: 100%;
      height: 100%;
      cursor: grab;
    }
    #graph-canvas:active { cursor: grabbing; }
    
    /* Detail Panel */
    .detail {
      position: fixed;
      right: -400px;
      top: 54px;
      width: 400px;
      height: calc(100vh - 54px);
      background: var(--bg2);
      border-left: 1px solid var(--border);
      transition: right 0.2s;
      overflow-y: auto;
      z-index: 200;
    }
    .detail.open { right: 0; }
    .detail-header {
      padding: 14px;
      background: var(--bg3);
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
    }
    .detail-title { font-family: monospace; font-size: 13px; word-break: break-all; }
    .detail-close { background: none; border: none; color: var(--text2); font-size: 18px; cursor: pointer; }
    .detail-body { padding: 14px; }
    .detail-section { margin-bottom: 16px; }
    .detail-section h4 { font-size: 10px; text-transform: uppercase; color: var(--text2); margin-bottom: 8px; }
    .detail-item { background: var(--bg3); padding: 8px 10px; border-radius: 4px; margin-bottom: 4px; font-size: 12px; }
    .detail-label { font-size: 9px; color: var(--text2); margin-bottom: 2px; }
    
    .rel-item {
      background: var(--bg3);
      padding: 8px 10px;
      border-radius: 4px;
      margin-bottom: 4px;
      cursor: pointer;
    }
    .rel-item:hover { background: #475569; }
    .rel-header { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
    .rel-type { font-size: 8px; padding: 2px 5px; border-radius: 2px; font-weight: 600; }
    .rel-type-parent { background: #3b82f6; color: white; }
    .rel-type-child { background: #22c55e; color: white; }
    .rel-type-layout { background: #8b5cf6; color: white; }
    .rel-path { font-family: monospace; font-size: 11px; color: var(--accent); }
    .rel-desc { font-size: 10px; color: var(--text2); }
    
    .data-op { cursor: pointer; }
    .data-op:hover { background: #475569 !important; }
    
    /* Modal */
    .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 1000; justify-content: center; align-items: center; }
    .modal.open { display: flex; }
    .modal-box { background: var(--bg2); border-radius: 8px; width: 90%; max-width: 500px; max-height: 80vh; overflow: auto; }
    .modal-head { padding: 12px 16px; background: var(--bg3); display: flex; justify-content: space-between; align-items: center; }
    .modal-head h3 { font-size: 14px; margin: 0; }
    .modal-close { background: none; border: none; color: var(--text2); font-size: 20px; cursor: pointer; }
    .modal-back { background: var(--accent); color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .modal-back:hover { opacity: 0.9; }
    .modal-body { padding: 16px; }
    .field-tree { font-family: monospace; font-size: 11px; background: var(--bg3); padding: 10px; border-radius: 4px; white-space: pre; overflow-x: auto; }
  </style>
</head>
<body>
  <header class="header">
    <h1>Page Map</h1>
    <div style="display:flex;gap:12px;align-items:center">
      <input class="search" type="text" placeholder="Search..." oninput="filter(this.value)">
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
    </aside>
    
    <div class="content">
      <div class="tree-view active" id="tree-view">
        ${this.buildTreeHtml(groups, allPages)}
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
  
  <div class="modal" id="modal" onclick="if(event.target===this)closeModal()">
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
    const pages = ${JSON.stringify(allPages)};
    const relations = ${JSON.stringify(relations)};
    const graphqlOps = ${graphqlOpsJson};
    const components = ${componentsJson};
    const apiCallsData = ${JSON.stringify(this.apiCalls)};
    window.apiCalls = apiCallsData;
    const pageMap = new Map(pages.map(p => [p.path, p]));
    const gqlMap = new Map(graphqlOps.map(op => [op.name, op]));
    const compMap = new Map(components.map(c => [c.name, c]));
    
    // Modal history stack for back navigation
    const modalHistory = [];
    
    function setView(v) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById('tree-view').classList.toggle('active', v === 'tree');
      document.getElementById('graph-view').classList.toggle('active', v === 'graph');
      if (v === 'graph') setTimeout(initGraph, 100);
    }
    
    function toggleGroup(el) {
      el.closest('.group').classList.toggle('collapsed');
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
      sameLayout.forEach(p => {
        relsHtml += '<div class="rel-item" onclick="event.stopPropagation(); selectPage(\\''+p+'\\')">' +
          '<div class="rel-header"><span class="rel-type rel-type-layout">LAYOUT</span><span class="rel-path">'+p+'</span></div>' +
          '<div class="rel-desc">Uses same layout: '+(page.layout||'')+'</div></div>';
      });
      
      // Data operations - show component name info
      let dataHtml = '';
      if (page.dataFetching && page.dataFetching.length > 0) {
        dataHtml = '<div class="detail-section"><h4>Data Operations</h4>';
        page.dataFetching.forEach(df => {
          const rawName = df.operationName || '';
          // Check if it's a component reference (contains → or starts with special marker)
          const isComponent = rawName.includes('→') || rawName.includes('\\u2192') || rawName.startsWith('->');
          const cleanName = rawName.replace(/^[→\\->\\s]+/,'').replace(/^\\u2192\\s*/,'');
          const isQ = !df.type?.includes('Mutation');
          const displayName = isComponent ? cleanName + ' (Component)' : cleanName;
          
          dataHtml += '<div class="detail-item data-op" onclick="showDataDetail(\\''+cleanName.replace(/'/g, "\\\\'")+'\\')">' +
            '<span class="tag '+(isQ?'tag-query':'tag-mutation')+'">'+(isQ?'QUERY':'MUTATION')+'</span> '+displayName+'</div>';
        });
        dataHtml += '</div>';
      }
      
      document.getElementById('detail-title').textContent = path;
      document.getElementById('detail-body').innerHTML = 
        '<div class="detail-section"><h4>Info</h4>' +
        '<div class="detail-item"><div class="detail-label">FILE</div>'+page.filePath+'</div>' +
        '<div class="detail-item"><div class="detail-label">AUTH</div>'+(page.authentication?.required?'<span class="tag tag-auth">LOGIN REQUIRED</span>':'No auth required')+'</div>' +
        (page.layout?'<div class="detail-item"><div class="detail-label">LAYOUT</div>'+page.layout+'</div>':'') +
        (page.params?.length?'<div class="detail-item"><div class="detail-label">PARAMS</div>'+page.params.map(p=>':'+p).join(', ')+'</div>':'') +
        '</div>' + dataHtml +
        '<div class="detail-section"><h4>Related Pages ('+rels.length+')</h4>' +
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
    
    function handleStatClick(type, el) {
      console.log('handleStatClick called with:', type);
      // Toggle filter
      if (currentFilter === type) {
        currentFilter = null;
        document.querySelectorAll('.stat').forEach(s => s.classList.remove('active'));
        showAllPages();
        closeDetail();
        return;
      }
      
      currentFilter = type;
      document.querySelectorAll('.stat').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
      
      if (type === 'graphql') {
        showGraphQLList();
      } else if (type === 'restapi') {
        showRestApiList();
      } else if (type === 'pages') {
        showAllPages();
        closeDetail();
      } else if (type === 'hierarchies') {
        showAllPages();
        closeDetail();
      }
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
      document.querySelectorAll('.group').forEach(g => g.style.display = '');
      document.querySelectorAll('.page-item').forEach(p => p.style.display = '');
    }
    
    function showGraphQLList() {
      // Show GraphQL operations in detail panel
      let html = '<div class="detail-section"><h4>All GraphQL Operations ('+Object.keys(Object.fromEntries(gqlMap)).length+')</h4>';
      
      const queries = Array.from(gqlMap.values()).filter(o => o.type === 'query');
      const mutations = Array.from(gqlMap.values()).filter(o => o.type === 'mutation');
      const fragments = Array.from(gqlMap.values()).filter(o => o.type === 'fragment');
      
      if (queries.length > 0) {
        html += '<div style="margin:8px 0;font-size:11px;color:var(--accent)">Queries ('+queries.length+')</div>';
        queries.slice(0, 20).forEach(op => {
          html += '<div class="detail-item data-op" onclick="event.stopPropagation(); showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
            '<span class="tag tag-query">QUERY</span> '+op.name+'</div>';
        });
        if (queries.length > 20) {
          html += '<div style="color:var(--text2);font-size:10px;padding:4px">... and '+(queries.length-20)+' more queries</div>';
        }
      }
      
      if (mutations.length > 0) {
        html += '<div style="margin:8px 0;font-size:11px;color:var(--accent)">Mutations ('+mutations.length+')</div>';
        mutations.slice(0, 10).forEach(op => {
          html += '<div class="detail-item data-op" onclick="event.stopPropagation(); showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
            '<span class="tag tag-mutation">MUTATION</span> '+op.name+'</div>';
        });
        if (mutations.length > 10) {
          html += '<div style="color:var(--text2);font-size:10px;padding:4px">... and '+(mutations.length-10)+' more mutations</div>';
        }
      }
      
      if (fragments.length > 0) {
        html += '<div style="margin:8px 0;font-size:11px;color:var(--accent)">Fragments ('+fragments.length+')</div>';
        fragments.slice(0, 5).forEach(op => {
          html += '<div class="detail-item data-op" onclick="event.stopPropagation(); showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
            '<span class="tag" style="background:#6b7280">FRAGMENT</span> '+op.name+'</div>';
        });
        if (fragments.length > 5) {
          html += '<div style="color:var(--text2);font-size:10px;padding:4px">... and '+(fragments.length-5)+' more fragments</div>';
        }
      }
      
      html += '</div>';
      
      document.getElementById('detail-title').textContent = 'GraphQL Operations';
      document.getElementById('detail-body').innerHTML = html;
      document.getElementById('detail').classList.add('open');
    }
    
    function showRestApiList() {
      const apis = window.apiCalls || [];
      let html = '<div class="detail-section"><h4>REST API Calls ('+apis.length+')</h4>';
      
      if (apis.length === 0) {
        html += '<div style="color:var(--text2);font-size:12px">No REST API calls detected</div>';
      } else {
        apis.forEach(api => {
          const methodColors = {GET:'#22c55e',POST:'#3b82f6',PUT:'#f59e0b',DELETE:'#ef4444',PATCH:'#8b5cf6'};
          const color = methodColors[api.method] || '#6b7280';
          html += '<div class="detail-item" style="cursor:pointer" onclick="event.stopPropagation(); showApiDetail(\\''+api.id.replace(/'/g, "\\\\'")+'\\')">' +
            '<span class="tag" style="background:'+color+';color:white">'+api.method+'</span> ' +
            '<span style="font-family:monospace;font-size:11px">'+api.url+'</span>' +
            '<div style="font-size:9px;color:var(--text2);margin-top:2px">'+api.callType+' in '+api.filePath+'</div>' +
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
      
      let html = '<div class="detail-section"><h4>API Call Details</h4>' +
        '<div class="detail-item"><div class="detail-label">METHOD</div>' +
        '<span class="tag" style="background:'+color+';color:white">'+api.method+'</span></div>' +
        '<div class="detail-item"><div class="detail-label">URL</div>' +
        '<span style="font-family:monospace;word-break:break-all">'+api.url+'</span></div>' +
        '<div class="detail-item"><div class="detail-label">TYPE</div>'+api.callType+'</div>' +
        '<div class="detail-item"><div class="detail-label">FILE</div>'+api.filePath+'</div>' +
        (api.line ? '<div class="detail-item"><div class="detail-label">LINE</div>'+api.line+'</div>' : '') +
        (api.containingFunction ? '<div class="detail-item"><div class="detail-label">FUNCTION</div>'+api.containingFunction+'</div>' : '') +
        '</div>';
      
      document.getElementById('detail-title').textContent = api.method + ' ' + api.url;
      document.getElementById('detail-body').innerHTML = html;
      document.getElementById('detail').classList.add('open');
    }
    
    // Close detail when clicking outside
    document.addEventListener('click', (e) => {
      const detail = document.getElementById('detail');
      const isDetailOpen = detail.classList.contains('open');
      if (!isDetailOpen) return;
      
      // Check if click is inside detail panel or on page items
      if (detail.contains(e.target)) return;
      if (e.target.closest('.page-item')) return;
      if (e.target.closest('.node-circle')) return;
      if (e.target.closest('.modal')) return;
      
      closeDetail();
    });
    
    // Expand "more" items
    window.expandMore = function(type, items, btn) {
      const container = btn.parentElement;
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
      container.innerHTML = html;
    };
    
    function showDataDetail(name) {
      const op = gqlMap.get(name);
      let html = '';
      
      // Check if this is a known component
      const comp = compMap.get(name);
      
      if (op) {
        // Found GraphQL operation
        html = '<div class="detail-section"><h4>Type</h4><span class="tag '+(op.type==='mutation'?'tag-mutation':'tag-query')+'">'+op.type.toUpperCase()+'</span></div>';
        if (op.returnType) {
          html += '<div class="detail-section"><h4>Return Type</h4><code style="background:#f1f5f9;padding:4px 8px;border-radius:4px">'+op.returnType+'</code></div>';
        }
        if (op.fields?.length) {
          // Show full GraphQL operation structure
          const opKeyword = op.type === 'mutation' ? 'mutation' : (op.type === 'fragment' ? 'fragment' : 'query');
          const varStr = op.variables?.length ? '(' + op.variables.map(v => '$' + v.name + ': ' + v.type).join(', ') + ')' : '';
          const fragmentOn = op.type === 'fragment' && op.returnType ? ' on ' + op.returnType : '';

          let gqlCode = opKeyword + ' ' + op.name + varStr + fragmentOn + ' {\\n';
          gqlCode += formatFields(op.fields, 1);
          gqlCode += '\\n}';

          html += '<div class="detail-section"><h4>GraphQL</h4><pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:11px;overflow-x:auto;white-space:pre;max-height:300px;overflow-y:auto">' + gqlCode + '</pre></div>';
        } else if (op.variables?.length) {
          html += '<div class="detail-section"><h4>Variables</h4>';
          op.variables.forEach(v => { html += '<div class="detail-item">'+v.name+': <code>'+v.type+'</code>'+(v.required?' (required)':'')+'</div>'; });
          html += '</div>';
        }
        if (op.usedIn?.length) {
          html += '<div class="detail-section"><h4>Used In ('+op.usedIn.length+' files)</h4>';
          op.usedIn.slice(0,8).forEach(f => { html += '<div class="detail-item">'+f+'</div>'; });
          if (op.usedIn.length > 8) {
            const remaining = op.usedIn.slice(8);
            html += '<div class="expand-more" onclick="expandMore(\\'usedIn\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" style="color:var(--accent);font-size:11px;cursor:pointer;padding:4px 0">▸ Show '+(op.usedIn.length-8)+' more files</div>';
          }
          html += '</div>';
        }
      } else if (comp) {
        // Found component - find GraphQL operations used in this component's file/feature
        const featureDir = comp.filePath.split('/').slice(0, -1).join('/');
        
        // Find all GraphQL operations used in this feature directory
        const featureOps = graphqlOps.filter(op => 
          op.usedIn?.some(f => f.startsWith(featureDir) || f.includes(featureDir))
        );
        
        html = '<div class="detail-section"><h4>Component</h4>' +
          '<div class="detail-item"><div class="detail-label">NAME</div><strong>'+comp.name+'</strong></div>' +
          '<div class="detail-item"><div class="detail-label">FILE</div><code>'+comp.filePath+'</code></div>' +
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
              html += '<div class="expand-more" onclick="expandMore(\\'query\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" style="color:var(--accent);font-size:10px;cursor:pointer;padding:4px 0">▸ Show ' + (queries.length - 5) + ' more queries</div>';
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
              html += '<div class="expand-more" onclick="expandMore(\\'mutation\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" style="color:var(--accent);font-size:10px;cursor:pointer;padding:4px 0">▸ Show ' + (mutations.length - 5) + ' more mutations</div>';
            }
          }
          
          if (fragments.length > 0) {
            html += '<div style="margin:8px 0;font-size:10px;color:var(--text2)">Fragments ('+fragments.length+')</div>';
            fragments.slice(0,3).forEach(op => {
              html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
                '<span class="tag" style="background:#6b7280">FRAGMENT</span> '+op.name+'</div>';
            });
            if (fragments.length > 3) {
              const remaining = fragments.slice(3).map(o => ({name: o.name}));
              html += '<div class="expand-more" onclick="expandMore(\\'fragment\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" style="color:var(--accent);font-size:10px;cursor:pointer;padding:4px 0">▸ Show ' + (fragments.length - 3) + ' more fragments</div>';
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
        // Extract keywords from component name for better search
        // e.g., "Pulse1on1Page" -> ["Pulse", "1on1", "Page"]
        // Split on: uppercase followed by lowercase, or before digits
        const rawKeywords = name
          .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase split
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // consecutive caps
          .replace(/([a-zA-Z])(\d)/g, '$1 $2')  // letter to digit
          .replace(/(\d)([a-zA-Z])/g, '$1 $2')  // digit to letter
          .split(/\s+/)
          .filter(k => k.length > 0);
        
        const searchTerms = rawKeywords.filter(k => !['Page', 'Container', 'Wrapper', 'Form', 'Component'].includes(k));

        // Find operations matching any keyword (case-insensitive)
        let relatedOps = [];
        if (searchTerms.length > 0) {
          relatedOps = graphqlOps.filter(op => {
            const opLower = op.name.toLowerCase();
            // Check if op name contains any search term
            const matchesKeyword = searchTerms.some(term => {
              const termLower = term.toLowerCase();
              return opLower.includes(termLower) || termLower.includes(opLower.replace(/query|mutation|fragment/gi,''));
            });
            // Check if any usedIn path contains the search term
            const matchesInUsedIn = op.usedIn?.some(f => {
              const fLower = f.toLowerCase();
              return searchTerms.some(term => fLower.includes(term.toLowerCase()));
            });
            return matchesKeyword || matchesInUsedIn;
          });
        }

        // Also try searching by the full component name or partial matches
        if (relatedOps.length === 0) {
          const nameLower = name.toLowerCase();
          relatedOps = graphqlOps.filter(op => {
            const opLower = op.name.toLowerCase();
            return opLower.includes(nameLower) || nameLower.includes(opLower.replace(/query|mutation|fragment/gi,'')) ||
              op.usedIn?.some(f => f.toLowerCase().includes(nameLower));
          });
        }
        
        // Deduplicate and limit
        const uniqueOps = [...new Map(relatedOps.map(op => [op.name, op])).values()].slice(0, 15);
        
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
              html += '<div class="expand-more" onclick="expandMore(\\'query\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" style="color:var(--accent);font-size:10px;cursor:pointer;padding:4px 0">▸ Show ' + (queries.length - 8) + ' more</div>';
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
              html += '<div class="expand-more" onclick="expandMore(\\'mutation\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" style="color:var(--accent);font-size:10px;cursor:pointer;padding:4px 0">▸ Show ' + (mutations.length - 5) + ' more</div>';
            }
          }
          
          if (fragments.length > 0) {
            html += '<div style="margin:8px 0 6px;font-size:10px;color:var(--text2)">Fragments ('+fragments.length+')</div>';
            fragments.slice(0, 3).forEach(op => {
              html += '<div class="detail-item data-op" onclick="showDataDetail(\\''+op.name.replace(/'/g, "\\\\'")+'\\')">' +
                '<span class="tag" style="background:#6b7280">FRAGMENT</span> '+op.name+'</div>';
            });
            if (fragments.length > 3) {
              const remaining = fragments.slice(3).map(o => ({name: o.name}));
              html += '<div class="expand-more" onclick="expandMore(\\'fragment\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" style="color:var(--accent);font-size:10px;cursor:pointer;padding:4px 0">▸ Show ' + (fragments.length - 3) + ' more</div>';
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
    
    function closeModal() {
      document.getElementById('modal').classList.remove('open');
      modalHistory.length = 0; // Clear history when closing
      document.getElementById('modal-back').style.display = 'none';
    }
    
    function modalBack() {
      if (modalHistory.length > 1) {
        modalHistory.pop(); // Remove current
        const prevName = modalHistory.pop(); // Get previous (will be re-added by showDataDetail)
        showDataDetail(prevName);
      }
    }
    
    function updateBackButton() {
      document.getElementById('modal-back').style.display = modalHistory.length > 1 ? 'block' : 'none';
    }
    
    function filter(q) {
      q = q.toLowerCase();
      // Filter page items
      document.querySelectorAll('.page-item').forEach(el => {
        el.style.display = el.dataset.path.toLowerCase().includes(q) || !q ? '' : 'none';
      });
      // Show/hide groups based on whether they have visible items
      document.querySelectorAll('.group').forEach(group => {
        const visibleItems = group.querySelectorAll('.page-item[style=""], .page-item:not([style])');
        const hasVisible = Array.from(group.querySelectorAll('.page-item')).some(el => el.style.display !== 'none');
        group.style.display = hasVisible || !q ? '' : 'none';
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
      
      // Build nodes with better layout - group by category
      const groups = new Map();
      pages.forEach(p => {
        const cat = p.path.split('/').filter(Boolean)[0] || 'root';
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(p);
      });
      
      graphState.nodes = [];
      const catColors = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899'];
      let catIdx = 0;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const catRadius = Math.min(rect.width, rect.height) * 0.35;
      
      Array.from(groups.entries()).forEach(([cat, catPages], gIdx) => {
        const catAngle = (gIdx / groups.size) * Math.PI * 2 - Math.PI / 2;
        const catX = centerX + Math.cos(catAngle) * catRadius;
        const catY = centerY + Math.sin(catAngle) * catRadius;
        const color = catColors[catIdx++ % catColors.length];
        
        // Arrange pages in this category in a cluster
        const clusterRadius = 30 + catPages.length * 8;
        catPages.forEach((p, pIdx) => {
          const pageAngle = (pIdx / catPages.length) * Math.PI * 2;
          const x = catX + Math.cos(pageAngle) * clusterRadius;
          const y = catY + Math.sin(pageAngle) * clusterRadius;
          const label = p.path.split('/').filter(Boolean).pop() || '/';
          
          graphState.nodes.push({
            path: p.path,
            x, y,
            radius: 8,
            color: p.authentication?.required ? '#dc2626' : '#22c55e',
            label: label.length > 12 ? label.substring(0,10)+'...' : label,
            category: cat,
            catColor: color
          });
        });
      });
      
      // Build edges
      graphState.edges = relations.filter(r => r.type === 'parent-child').map(r => ({
        from: r.from,
        to: r.to,
        color: '#475569'
      }));
      
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
        } else {
          dragging = true;
          lastX = e.clientX;
          lastY = e.clientY;
        }
      };
      
      canvas.onmousemove = e => {
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
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
          
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
            const queries = (p.dataFetching || []).filter(
              (d) => !d.type?.includes('Mutation')
            ).length;
            const mutations = (p.dataFetching || []).filter((d) =>
              d.type?.includes('Mutation')
            ).length;
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

            return `<div class="page-item" data-path="${p.path}" data-repo="${repoName}" onclick="selectPage('${
              p.path
            }')" style="--depth:${depth}">
              <span class="page-type" style="--type-color:${type.color}">${type.label}</span>
              <span class="page-path">${p.path}</span>
              <div class="page-tags">
                ${repoTag}
                ${p.authentication?.required ? '<span class="tag tag-auth">AUTH</span>' : ''}
                ${queries > 0 ? `<span class="tag tag-query">Q:${queries}</span>` : ''}
                ${mutations > 0 ? `<span class="tag tag-mutation">M:${mutations}</span>` : ''}
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
