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

    return this.renderPageMapHtml(allPages, rootPages, relations, repoName);
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
    repoName: string
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
      padding: 0 20px;
      height: 54px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 100;
      line-height: 1;
    }
    .header h1 { font-size: 18px; height: 28px; display: flex; align-items: center; }
    
    .nav-link {
      padding: 6px 12px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      color: var(--text2);
      text-decoration: none;
      font-size: 13px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .nav-link:hover { background: var(--bg3); color: var(--text); }
    .nav-link.active { background: var(--accent); color: white; }
    
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
    .copy-btn { background: none; border: none; cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 4px; opacity: 0.7; transition: all 0.2s; }
    .copy-btn:hover { opacity: 1; background: var(--bg3); }
    .copy-btn.copied { background: #22c55e; opacity: 1; }
  </style>
</head>
<body>
  <header class="header">
    <div style="display:flex;align-items:center;gap:24px">
      <h1 style="cursor:pointer" onclick="location.href='/'">📊 ${repoName}</h1>
      <nav style="display:flex;gap:4px">
        <a href="/page-map" class="nav-link active">Page Map</a>
        <a href="/docs" class="nav-link">Docs</a>
        <a href="/api/report" class="nav-link" target="_blank">API</a>
      </nav>
    </div>
    <div style="display:flex;gap:12px;align-items:center">
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
      
      // Data operations - show component name info (deduplicated)
      let dataHtml = '';
      if (page.dataFetching && page.dataFetching.length > 0) {
        // Separate actual GraphQL operations from component references FIRST
        const graphqlOps = page.dataFetching.filter(df => df.type !== 'component');
        const componentRefs = page.dataFetching.filter(df => df.type === 'component');
        
        // Deduplicate GraphQL ops by operationName
        const seenGraphQL = new Set();
        const uniqueGraphQLOps = graphqlOps.filter(df => {
          const name = (df.operationName || '').replace(/^[→\\->\\s]+/,'').replace(/^\\u2192\\s*/,'');
          if (seenGraphQL.has(name)) return false;
          seenGraphQL.add(name);
          return true;
        });
        
        // Deduplicate component refs by operationName
        const seenComponents = new Set();
        const uniqueComponentRefs = componentRefs.filter(df => {
          const name = df.operationName || '';
          if (seenComponents.has(name)) return false;
          seenComponents.add(name);
          return true;
        });
        
        dataHtml = '';
        
        // Show actual GraphQL operations
        if (uniqueGraphQLOps.length > 0) {
          dataHtml += '<div class="detail-section"><h4>Data Operations</h4>';
          uniqueGraphQLOps.forEach(df => {
            const rawName = df.operationName || '';
            const cleanName = rawName.replace(/^[→\\->\\s]+/,'').replace(/^\\u2192\\s*/,'');
            const isQ = !df.type?.includes('Mutation');
            
            dataHtml += '<div class="detail-item data-op" onclick="showDataDetail(\\''+cleanName.replace(/'/g, "\\\\'")+'\\')">' +
              '<span class="tag '+(isQ?'tag-query':'tag-mutation')+'">'+(isQ?'QUERY':'MUTATION')+'</span> '+cleanName+'</div>';
          });
          dataHtml += '</div>';
        }
        
        // Show component references separately
        if (uniqueComponentRefs.length > 0) {
          dataHtml += '<div class="detail-section"><h4>Used Components</h4>';
          uniqueComponentRefs.forEach(df => {
            const name = df.operationName || '';
            dataHtml += '<div class="detail-item" style="cursor:default"><span class="tag" style="background:var(--text2);color:var(--bg)">COMPONENT</span> '+name+'</div>';
          });
          dataHtml += '</div>';
        }
      }
      
      const totalRels = (parent ? 1 : 0) + children.length + navLinks.length + sameLayout.length;
      
      document.getElementById('detail-title').textContent = path;
      document.getElementById('detail-body').innerHTML = 
        '<div class="detail-section"><h4>Info</h4>' +
        '<div class="detail-item"><div class="detail-label">FILE</div>'+page.filePath+'</div>' +
        '<div class="detail-item"><div class="detail-label">AUTH</div>'+(page.authentication?.required?'<span class="tag tag-auth">LOGIN REQUIRED</span>':'No auth required')+'</div>' +
        (page.layout?'<div class="detail-item"><div class="detail-label">LAYOUT</div>'+page.layout+'</div>':'') +
        (page.params?.length?'<div class="detail-item"><div class="detail-label">PARAMS</div>'+page.params.map(p=>':'+p).join(', ')+'</div>':'') +
        '</div>' + stepsHtml + dataHtml +
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
    const pagesWithGraphQL = new Set(pages.filter(p => 
      p.dataFetching && p.dataFetching.some(df => 
        df.type === 'useQuery' || df.type === 'useMutation' || df.type === 'useLazyQuery'
      )
    ).map(p => p.path));
    
    const pagesWithRestApi = new Set(pages.filter(p => {
      // Check if any API call is in this page's file
      return apiCalls.some(api => api.filePath && api.filePath.includes(p.filePath?.replace(/\\/[^/]+$/, '')));
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
        html += '<span style="color:var(--accent)">'+groupPages.length+' pages</span></div>';
        html += '<div class="group-page-list" style="display:none;margin-left:16px;margin-top:4px">';
        groupPages.sort((a,b) => a.path.localeCompare(b.path)).forEach(p => {
          const isAuth = p.authentication?.required;
          const isDynamic = p.path.includes('[');
          html += '<div class="detail-item rel-item" style="cursor:pointer;padding:6px 8px" onclick="event.stopPropagation(); selectPage(\\''+p.path+'\\')">'+
            '<span style="font-family:monospace;font-size:11px;color:var(--text)">'+p.path+'</span>'+
            (isAuth ? '<span class="tag tag-auth" style="margin-left:6px;font-size:9px">AUTH</span>' : '')+
            (isDynamic ? '<span class="tag" style="margin-left:6px;font-size:9px;background:#6366f1">DYNAMIC</span>' : '')+
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
      });
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
    
    function showDataDetail(rawName) {
      // Clean up name: remove "→ " prefix and " (ComponentName)" suffix
      const name = rawName
        .replace(/^[→\\->\\s]+/, '')
        .replace(/\\s*\\([^)]+\\)\\s*$/, '');
      
      // Try to find GraphQL operation with various name patterns
      let op = gqlMap.get(name);
      
      // If not found, try removing common suffixes (Query, Mutation, Document)
      if (!op) {
        const baseName = name.replace(/Query$|Mutation$|Document$/, '');
        op = gqlMap.get(baseName);
      }
      
      // Also try with suffix if original didn't have one
      if (!op && !name.match(/Query$|Mutation$/)) {
        op = gqlMap.get(name + 'Query') || gqlMap.get(name + 'Mutation');
      }
      
      let html = '';
      
      // Check if this is a known component
      const comp = compMap.get(rawName) || compMap.get(name);
      
      if (op) {
        // Found GraphQL operation
        html = '<div class="detail-section"><h4>Type</h4><span class="tag '+(op.type==='mutation'?'tag-mutation':'tag-query')+'">'+op.type.toUpperCase()+'</span></div>';
        
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
            html += '<div class="expand-more" onclick="expandMore(\\'usedIn\\', '+JSON.stringify(remaining).replace(/"/g, '&quot;')+', this)" style="color:var(--accent);font-size:11px;cursor:pointer;padding:4px 0">▸ Show '+(op.usedIn.length-8)+' more files</div>';
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
      
      // Build nodes - initial placement by category
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
          const label = p.path.split('/').filter(Boolean).pop() || '/';
          
          graphState.nodes.push({
            path: p.path,
            x, y,
            vx: 0, vy: 0, // velocity for force simulation
            radius: 8,
            color: p.authentication?.required ? '#dc2626' : '#22c55e',
            label: label.length > 12 ? label.substring(0,10)+'...' : label,
            category: cat,
            catColor: color
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
