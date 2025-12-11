import type {
  AnalysisResult,
  MermaidDiagram,
  PageInfo,
  DataFlow,
  ComponentInfo,
  CrossRepoLink,
} from '../types.js';

/**
 * Mermaid diagram generator
 * Mermaidダイアグラム生成器
 */
export class MermaidGenerator {
  /**
   * Generate all diagrams from analysis result
   */
  generateAll(results: AnalysisResult[], crossRepoLinks: CrossRepoLink[]): MermaidDiagram[] {
    const diagrams: MermaidDiagram[] = [];

    for (const result of results) {
      // Page navigation flowchart
      diagrams.push(this.generateNavigationDiagram(result));

      // Data flow diagram
      diagrams.push(this.generateDataFlowDiagram(result));

      // Component hierarchy
      diagrams.push(this.generateComponentDiagram(result));

      // GraphQL operations
      diagrams.push(this.generateGraphQLDiagram(result));
    }

    // Cross-repository diagram
    if (results.length > 1) {
      diagrams.push(this.generateCrossRepoDiagram(results, crossRepoLinks));
    }

    return diagrams;
  }

  /**
   * Generate navigation flowchart - grouped by URL category
   */
  generateNavigationDiagram(result: AnalysisResult): MermaidDiagram {
    const lines: string[] = ['flowchart TB', '  %% Page Navigation Flow - Grouped by Category'];

    const nodeIds = new Map<string, string>();
    let nodeCounter = 0;

    // Group pages by URL category
    const byCategory = new Map<string, PageInfo[]>();
    for (const page of result.pages) {
      const parts = page.path.split('/').filter(Boolean);
      const category = parts[0] || 'root';
      const existing = byCategory.get(category) || [];
      existing.push(page);
      byCategory.set(category, existing);
    }

    // Create subgraphs for each category
    for (const [category, pages] of byCategory) {
      const categoryId = category.replace(/[^a-zA-Z0-9]/g, '_');
      const categoryLabel = category === 'root' ? 'Root Pages' : `/${category}`;
      lines.push('');
      lines.push(`  subgraph ${categoryId}["${categoryLabel}"]`);
      lines.push('    direction TB');

      for (const page of pages) {
        const nodeId = `P${nodeCounter++}`;
        nodeIds.set(page.path, nodeId);

        // Shorter label - just the last part of the path
        const pathParts = page.path.split('/').filter(Boolean);
        const shortLabel = pathParts.length > 1 ? pathParts.slice(1).join('/') : page.path;
        const authTag = page.authentication.required ? ' AUTH' : '';
        lines.push(`    ${nodeId}["${shortLabel}${authTag}"]`);
      }
      lines.push('  end');
    }

    // Add edges for linked pages (limit to prevent clutter)
    let edgeCount = 0;
    const maxEdges = 30;
    lines.push('');
    lines.push('  %% Navigation Links');
    for (const page of result.pages) {
      if (edgeCount >= maxEdges) break;
      const sourceId = nodeIds.get(page.path);
      for (const linkedPath of page.linkedPages.slice(0, 2)) {
        if (edgeCount >= maxEdges) break;
        const targetId = nodeIds.get(linkedPath);
        if (sourceId && targetId && sourceId !== targetId) {
          lines.push(`  ${sourceId} --> ${targetId}`);
          edgeCount++;
        }
      }
    }

    // Add styling
    lines.push('');
    lines.push('  %% Styling');
    lines.push('  classDef authRequired fill:#fee2e2,stroke:#ef4444,color:#991b1b');
    lines.push('  classDef public fill:#dcfce7,stroke:#22c55e,color:#166534');

    for (const page of result.pages) {
      const nodeId = nodeIds.get(page.path);
      if (nodeId) {
        if (page.authentication.required) {
          lines.push(`  class ${nodeId} authRequired`);
        } else {
          lines.push(`  class ${nodeId} public`);
        }
      }
    }

    return {
      type: 'flowchart',
      title: `${result.repository} - Page Navigation`,
      content: lines.join('\n'),
      relatedFiles: result.pages.map((p) => p.filePath),
    };
  }

  /**
   * Generate data flow diagram
   */
  generateDataFlowDiagram(result: AnalysisResult): MermaidDiagram {
    const lines: string[] = ['flowchart LR', '  %% Data Flow Diagram'];

    const nodeIds = new Map<string, string>();
    let nodeCounter = 0;

    const getNodeId = (node: { type: string; name: string }): string => {
      const key = `${node.type}:${node.name}`;
      if (!nodeIds.has(key)) {
        const prefix = node.type.charAt(0).toUpperCase();
        nodeIds.set(key, `${prefix}${nodeCounter++}`);
      }
      return nodeIds.get(key) ?? `N${nodeCounter++}`;
    };

    const _getNodeShape = (type: string, name: string): [string, string] => {
      // Different shapes based on type and content
      if (name.includes('GraphQL') || name.includes('API')) {
        return ['((', '))'];
      }
      switch (type) {
        case 'api':
          return ['((', '))'];
        case 'cache':
          return ['[(', ')]'];
        case 'context':
          return ['{{', '}}'];
        case 'store':
          return ['[/', '/]'];
        default:
          return ['[', ']'];
      }
    };

    const cleanLabel = (name: string): string => {
      // Remove emojis for mermaid compatibility, keep meaningful text
      return name
        .replace(/[\u{1F4E1}\u{270F}\u{FE0F}\u{1F504}\u{1F4E6}]/gu, '')
        .trim()
        .substring(0, 40); // Limit length
    };

    // Group flows by type for better organization
    const queryFlows = result.dataFlows.filter(
      (f) => f.name.includes('📡') || f.operations.some((o) => o.includes('Query'))
    );
    const mutationFlows = result.dataFlows.filter(
      (f) => f.name.includes('✏️') || f.operations.some((o) => o.includes('Mutation'))
    );
    const contextFlows = result.dataFlows.filter(
      (f) =>
        f.name.includes('🔄') ||
        f.source.type === 'context' ||
        f.operations.some((o) => o.includes('Context'))
    );

    // Create nodes and edges for queries
    if (queryFlows.length > 0) {
      lines.push('');
      lines.push('  subgraph Queries[📡 Queries]');
      lines.push('    direction TB');
      for (const flow of queryFlows.slice(0, 20)) {
        const sourceId = getNodeId(flow.source);
        const targetId = getNodeId(flow.target);
        const sourceName = cleanLabel(flow.source.name);
        const targetName = cleanLabel(flow.target.name);
        lines.push(`    ${sourceId}(("${sourceName}"))`);
        lines.push(`    ${targetId}["${targetName}"]`);
        lines.push(`    ${sourceId} --> ${targetId}`);
      }
      lines.push('  end');
    }

    // Create nodes and edges for mutations
    if (mutationFlows.length > 0) {
      lines.push('');
      lines.push('  subgraph Mutations[✏️ Mutations]');
      lines.push('    direction TB');
      for (const flow of mutationFlows.slice(0, 20)) {
        const sourceId = getNodeId(flow.source);
        const targetId = getNodeId(flow.target);
        const sourceName = cleanLabel(flow.source.name);
        const targetName = cleanLabel(flow.target.name);
        lines.push(`    ${sourceId}["${sourceName}"]`);
        lines.push(`    ${targetId}(("${targetName}"))`);
        lines.push(`    ${sourceId} --> ${targetId}`);
      }
      lines.push('  end');
    }

    // Create nodes and edges for context
    if (contextFlows.length > 0) {
      lines.push('');
      lines.push('  subgraph Context[🔄 Context]');
      lines.push('    direction TB');
      for (const flow of contextFlows.slice(0, 15)) {
        const sourceId = getNodeId(flow.source);
        const targetId = getNodeId(flow.target);
        const sourceName = cleanLabel(flow.source.name);
        const targetName = cleanLabel(flow.target.name);
        lines.push(`    ${sourceId}{{"${sourceName}"}}`);
        lines.push(`    ${targetId}["${targetName}"]`);
        lines.push(`    ${sourceId} -.-> ${targetId}`);
      }
      lines.push('  end');
    }

    // Style definitions
    lines.push('');
    lines.push('  %% Styling');
    lines.push('  classDef query fill:#dbeafe,stroke:#3b82f6,color:#1e40af');
    lines.push('  classDef mutation fill:#fce7f3,stroke:#ec4899,color:#9d174d');
    lines.push('  classDef context fill:#d1fae5,stroke:#10b981,color:#065f46');

    return {
      type: 'flowchart',
      title: `${result.repository} - Data Flow`,
      content: lines.join('\n'),
      relatedFiles: result.dataFlows.map((f) => f.source.name),
    };
  }

  /**
   * Generate component hierarchy diagram
   */
  generateComponentDiagram(result: AnalysisResult): MermaidDiagram {
    const lines: string[] = ['flowchart TB', '  %% Component Hierarchy'];

    // Group by type
    const byType = new Map<string, ComponentInfo[]>();
    for (const comp of result.components) {
      const existing = byType.get(comp.type) || [];
      existing.push(comp);
      byType.set(comp.type, existing);
    }

    // Create subgraphs for each type
    for (const [type, components] of byType) {
      lines.push(`  subgraph ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
      for (const comp of components.slice(0, 20)) {
        // Limit to 20 per type
        const nodeId = comp.name.replace(/[^a-zA-Z0-9]/g, '_');
        lines.push(`    ${nodeId}["${comp.name}"]`);
      }
      lines.push('  end');
    }

    // Add dependency edges (limited to prevent clutter)
    let edgeCount = 0;
    const maxEdges = 50;
    for (const comp of result.components) {
      if (edgeCount >= maxEdges) break;
      const sourceId = comp.name.replace(/[^a-zA-Z0-9]/g, '_');
      for (const dep of comp.dependencies.slice(0, 3)) {
        if (edgeCount >= maxEdges) break;
        const targetId = dep.replace(/[^a-zA-Z0-9]/g, '_');
        lines.push(`  ${sourceId} --> ${targetId}`);
        edgeCount++;
      }
    }

    return {
      type: 'flowchart',
      title: `${result.repository} - Component Hierarchy`,
      content: lines.join('\n'),
      relatedFiles: result.components.map((c) => c.filePath),
    };
  }

  /**
   * Generate GraphQL operations diagram
   */
  generateGraphQLDiagram(result: AnalysisResult): MermaidDiagram {
    const lines: string[] = ['flowchart LR', '  %% GraphQL Operations'];

    // Group by type
    const queries = result.graphqlOperations.filter((op) => op.type === 'query');
    const mutations = result.graphqlOperations.filter((op) => op.type === 'mutation');
    const fragments = result.graphqlOperations.filter((op) => op.type === 'fragment');

    // Add API node
    lines.push('  API[("GraphQL API")]');

    // Add queries
    if (queries.length > 0) {
      lines.push('  subgraph Queries');
      for (const query of queries.slice(0, 15)) {
        const nodeId = `Q_${query.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        lines.push(`    ${nodeId}["${query.name}"]`);
        lines.push(`    ${nodeId} --> API`);
      }
      lines.push('  end');
    }

    // Add mutations
    if (mutations.length > 0) {
      lines.push('  subgraph Mutations');
      for (const mutation of mutations.slice(0, 15)) {
        const nodeId = `M_${mutation.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        lines.push(`    ${nodeId}["${mutation.name}"]`);
        lines.push(`    ${nodeId} --> API`);
      }
      lines.push('  end');
    }

    // Add fragments
    if (fragments.length > 0) {
      lines.push('  subgraph Fragments');
      for (const fragment of fragments.slice(0, 10)) {
        const nodeId = `F_${fragment.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        lines.push(`    ${nodeId}[/"${fragment.name}"/]`);
      }
      lines.push('  end');
    }

    return {
      type: 'flowchart',
      title: `${result.repository} - GraphQL Operations`,
      content: lines.join('\n'),
      relatedFiles: result.graphqlOperations.map((op) => op.filePath),
    };
  }

  /**
   * Generate cross-repository diagram
   */
  generateCrossRepoDiagram(
    results: AnalysisResult[],
    crossRepoLinks: CrossRepoLink[]
  ): MermaidDiagram {
    const lines: string[] = ['flowchart TB', '  %% Cross-Repository Architecture'];

    // Add repository subgraphs
    for (const result of results) {
      const repoId = result.repository.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(`  subgraph ${repoId}["${result.repository}"]`);

      // Add summary nodes
      lines.push(`    ${repoId}_pages["📄 ${result.pages.length} Pages"]`);
      lines.push(`    ${repoId}_gql["🔷 ${result.graphqlOperations.length} GraphQL Ops"]`);
      lines.push(`    ${repoId}_comp["🧩 ${result.components.length} Components"]`);

      lines.push('  end');
    }

    // Add cross-repo links
    for (const link of crossRepoLinks) {
      const sourceRepo = link.sourceRepo.replace(/[^a-zA-Z0-9]/g, '_');
      const targetRepo = link.targetRepo.replace(/[^a-zA-Z0-9]/g, '_');

      let linkStyle = '-->';
      if (link.linkType === 'api-call') {
        linkStyle = '==>';
      } else if (link.linkType === 'graphql-operation') {
        linkStyle = '-..->';
      }

      lines.push(`  ${sourceRepo}_gql ${linkStyle}|"${link.linkType}"| ${targetRepo}_gql`);
    }

    return {
      type: 'flowchart',
      title: 'Cross-Repository Architecture',
      content: lines.join('\n'),
      relatedFiles: results.map((r) => r.repository),
    };
  }

  /**
   * Generate sequence diagram for a specific flow
   */
  generateSequenceDiagram(flow: DataFlow): MermaidDiagram {
    const lines: string[] = ['sequenceDiagram', `  %% ${flow.name}`];

    // Add participants
    const participants = [flow.source, ...flow.via, flow.target];
    for (const p of participants) {
      lines.push(`  participant ${p.name}`);
    }

    // Add interactions
    let current = flow.source;
    for (let i = 0; i < flow.via.length; i++) {
      const next = flow.via[i];
      const op = flow.operations[i] || 'data';
      lines.push(`  ${current.name}->>+${next.name}: ${op}`);
      current = next;
    }

    const lastOp = flow.operations[flow.operations.length - 1] || 'data';
    lines.push(`  ${current.name}->>+${flow.target.name}: ${lastOp}`);
    lines.push(`  ${flow.target.name}-->>-${flow.source.name}: response`);

    return {
      type: 'sequence',
      title: flow.name,
      content: lines.join('\n'),
      relatedFiles: [],
    };
  }
}
