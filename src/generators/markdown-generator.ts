import type {
  DocumentationReport,
  RepositoryReport,
  MermaidDiagram,
  PageInfo,
  ComponentInfo,
  GraphQLOperation,
  DataFlow,
  GraphQLField,
} from '../types.js';

type PageOpGroupKey = 'direct' | 'close' | 'indirect' | 'common';

type PageOpGroups = Record<PageOpGroupKey, { queries: string[]; mutations: string[] }>;

type PageOpGroupSets = Record<PageOpGroupKey, { queries: Set<string>; mutations: Set<string> }>;

/**
 * Markdown documentation generator
 */
export class MarkdownGenerator {
  /**
   * Generate complete documentation
   */
  generateDocumentation(report: DocumentationReport): Map<string, string> {
    const docs = new Map<string, string>();

    // Index page
    docs.set('index.md', this.generateIndex(report));

    // Repository pages
    for (const repo of report.repositories) {
      docs.set(`repos/${repo.name}/index.md`, this.generateRepoIndex(repo));
      docs.set(`repos/${repo.name}/pages.md`, this.generatePagesDoc(repo));
      docs.set(`repos/${repo.name}/components.md`, this.generateComponentsDoc(repo));
      docs.set(`repos/${repo.name}/graphql.md`, this.generateGraphQLDoc(repo));
      docs.set(`repos/${repo.name}/dataflow.md`, this.generateDataFlowDoc(repo));
    }

    // Cross-repo analysis (only if multiple repositories)
    if (report.repositories.length > 1) {
      docs.set('cross-repo.md', this.generateCrossRepoDoc(report));
    }

    // Diagrams
    docs.set('diagrams.md', this.generateDiagramsDoc(report.diagrams));

    return docs;
  }

  private generateIndex(report: DocumentationReport): string {
    // Use first repository name or generic title
    const title =
      report.repositories.length === 1
        ? `${report.repositories[0].displayName} Documentation`
        : 'Project Documentation';

    const lines: string[] = [
      `# ${title}`,
      '',
      `Generated: ${report.generatedAt}`,
      '',
      report.repositories.length > 1 ? '## Repositories' : '## Overview',
      '',
    ];

    for (const repo of report.repositories) {
      lines.push(`### [${repo.displayName}](/docs/repos/${repo.name}/index)`);
      lines.push('');
      lines.push(`- **Version**: ${repo.version}`);
      lines.push(`- **Commit**: \`${repo.commitHash.substring(0, 7)}\``);
      lines.push(`- **Pages**: ${repo.summary.totalPages}`);
      lines.push(`- **Components**: ${repo.summary.totalComponents}`);
      lines.push(`- **GraphQL Ops**: ${repo.summary.totalGraphQLOperations}`);
      lines.push('');
    }

    lines.push('## Quick Links');
    lines.push('');
    if (report.repositories.length > 1) {
      lines.push('- [Cross Repository](/docs/cross-repo)');
    }
    lines.push('- [Diagrams](/docs/diagrams)');
    lines.push('- [Page Map (Interactive)](/page-map)');
    lines.push('');

    return lines.join('\n');
  }

  private generateRepoIndex(repo: RepositoryReport): string {
    const lines: string[] = [
      `# ${repo.displayName}`,
      '',
      `Version: ${repo.version} | Commit: \`${repo.commitHash.substring(0, 7)}\``,
      '',
      '## Overview',
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Pages | ${repo.summary.totalPages} |`,
      `| Components | ${repo.summary.totalComponents} |`,
      `| GraphQL Operations | ${repo.summary.totalGraphQLOperations} |`,
      `| Data Flows | ${repo.summary.totalDataFlows} |`,
      `| Auth Required | ${repo.summary.authRequiredPages} |`,
      `| Public | ${repo.summary.publicPages} |`,
      '',
      '## Coverage',
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| TS/JS Files Scanned | ${repo.analysis.coverage?.tsFilesScanned ?? 0} |`,
      `| TS Parse Failures | ${repo.analysis.coverage?.tsParseFailures ?? 0} |`,
      `| GraphQL Parse Failures | ${repo.analysis.coverage?.graphqlParseFailures ?? 0} |`,
      `| Codegen Files Detected | ${repo.analysis.coverage?.codegenFilesDetected ?? 0} |`,
      `| Codegen Files Parsed | ${repo.analysis.coverage?.codegenFilesParsed ?? 0} |`,
      `| Codegen Exports Found | ${repo.analysis.coverage?.codegenExportsFound ?? 0} |`,
      '',
      '## Documentation',
      '',
      `- [Pages](/docs/repos/${repo.name}/pages)`,
      `- [Components](/docs/repos/${repo.name}/components)`,
      `- [GraphQL](/docs/repos/${repo.name}/graphql)`,
      `- [Data Flow](/docs/repos/${repo.name}/dataflow)`,
      '',
      '## Quick Access',
      '',
      `- [Page Map](/page-map)`,
      `- [Diagrams](/docs/diagrams)`,
      '',
    ];

    return lines.join('\n');
  }

  private generatePagesDoc(repo: RepositoryReport): string {
    const lines: string[] = [`# ${repo.displayName} - Pages`, ''];

    // Overview statistics
    const authRequired = repo.analysis.pages.filter((p) => p.authentication.required).length;
    const withQueries = repo.analysis.pages.filter((p) =>
      p.dataFetching.some((df) => !df.type.includes('Mutation'))
    ).length;
    const withMutations = repo.analysis.pages.filter((p) =>
      p.dataFetching.some((df) => df.type.includes('Mutation'))
    ).length;

    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Total | **${repo.analysis.pages.length}** |`);
    lines.push(`| Auth Required | ${authRequired} |`);
    lines.push(`| With Queries | ${withQueries} |`);
    lines.push(`| With Mutations | ${withMutations} |`);
    lines.push('');

    // Group by URL category
    const byCategory = new Map<string, PageInfo[]>();
    for (const page of repo.analysis.pages) {
      const category = page.path.split('/')[1] || 'root';
      const existing = byCategory.get(category) || [];
      existing.push(page);
      byCategory.set(category, existing);
    }

    for (const [category, pages] of byCategory) {
      lines.push(`## /${category}`);
      lines.push('');
      lines.push('| Page | Auth | Layout |');
      lines.push('|------|------|--------|');

      for (const page of pages) {
        const pathDisplay = page.path.replace(`/${category}`, '') || '/';
        const auth = page.authentication.required ? 'Required' : 'Public';
        const layout = page.layout || '-';
        lines.push(`| \`${pathDisplay}\` | ${auth} | ${layout} |`);
      }
      lines.push('');

      // Details for each page with GraphQL operations
      for (const page of pages) {
        const allDf = page.dataFetching || [];
        if (allDf.length === 0) continue;

        // Group data operations by relationship (similar to page-map)
        const groups = new Map<
          string,
          { label: string; open: boolean; queries: Set<string>; mutations: Set<string> }
        >();

        const ensureGroup = (key: string, label: string, open: boolean) => {
          if (!groups.has(key)) {
            groups.set(key, { label, open, queries: new Set(), mutations: new Set() });
          }
          const g = groups.get(key);
          if (!g) {
            // Should be unreachable, but keep it safe
            const fallback = {
              label,
              open,
              queries: new Set<string>(),
              mutations: new Set<string>(),
            };
            groups.set(key, fallback);
            return fallback;
          }
          return g;
        };

        for (const df of allDf) {
          const rawName = df.operationName || '';
          const cleanName = rawName.replace(/^[→\->\s]+/, '').trim();
          if (!cleanName || cleanName.length < 2) continue;

          const isMutation = df.type.includes('Mutation');
          const src = df.source || '';

          let key = 'direct';
          let label = 'Direct (this page)';
          let open = true;

          if (src.startsWith('close:')) {
            key = 'close';
            label = 'Close (related)';
            open = true;
          } else if (
            src.startsWith('indirect:') ||
            src.startsWith('usedIn:') ||
            src.startsWith('import:')
          ) {
            key = 'indirect';
            label = 'Indirect';
            open = false;
          } else if (src.startsWith('common:')) {
            key = 'common';
            label = 'Common (shared)';
            open = false;
          } else if (src.startsWith('hook:')) {
            key = 'hook';
            label = 'Hook';
            open = false;
          } else if (src.startsWith('component:')) {
            key = 'component';
            label = 'Component';
            open = false;
          }

          const g = ensureGroup(key, label, open);
          // Store confidence in data attributes (modal), not in visible text.
          // Keep display text clean (no "[likely]" suffix).
          if (isMutation) g.mutations.add(cleanName);
          else g.queries.add(cleanName);
        }

        const totalOps = Array.from(groups.values()).reduce(
          (acc, g) => acc + g.queries.size + g.mutations.size,
          0
        );
        if (totalOps === 0) continue;

        const orderedKeys = ['direct', 'close', 'component', 'hook', 'indirect', 'common'];

        lines.push(`### ${page.path}`);
        lines.push('');
        lines.push(`> ${page.filePath}`);
        lines.push('');

        lines.push(`**Data Operations (${totalOps})**`);
        lines.push('');

        for (const k of orderedKeys) {
          const g = groups.get(k);
          if (!g) continue;
          const count = g.queries.size + g.mutations.size;
          if (count === 0) continue;

          lines.push(
            `<details class="ops-group${g.open ? ' is-open' : ''}"${g.open ? ' open' : ''}>`
          );
          lines.push(
            `<summary class="ops-group__summary"><span class="ops-group__title">${g.label}</span><span class="ops-group__count">${count}</span></summary>`
          );
          lines.push('');

          if (g.queries.size > 0) {
            lines.push(`**Queries (${g.queries.size})**`);
            lines.push('');
            lines.push('<div class="gql-ops-list">');
            for (const name of Array.from(g.queries).sort()) {
              const isLikely = allDf.some(
                (df) =>
                  (df.operationName || '').replace(/^[→\->\s]+/, '').trim() === name &&
                  df.confidence === 'likely'
              );
              const confAttr = isLikely ? ` data-confidence="likely"` : '';
              lines.push(`<span class="gql-op" data-op="${name}"${confAttr}>${name}</span>`);
            }
            lines.push('</div>');
            lines.push('');
          }

          if (g.mutations.size > 0) {
            lines.push(`**Mutations (${g.mutations.size})**`);
            lines.push('');
            lines.push('<div class="gql-ops-list">');
            for (const name of Array.from(g.mutations).sort()) {
              const isLikely = allDf.some(
                (df) =>
                  (df.operationName || '').replace(/^[→\->\s]+/, '').trim() === name &&
                  df.confidence === 'likely'
              );
              const confAttr = isLikely ? ` data-confidence="likely"` : '';
              lines.push(
                `<span class="gql-op mutation" data-op="${name}"${confAttr}>${name}</span>`
              );
            }
            lines.push('</div>');
            lines.push('');
          }

          lines.push('</details>');
          lines.push('');
        }

        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private generateComponentsDoc(repo: RepositoryReport): string {
    const lines: string[] = [`# ${repo.displayName} - Components`, ''];

    // Statistics
    const byType = new Map<string, ComponentInfo[]>();
    for (const comp of repo.analysis.components) {
      const existing = byType.get(comp.type) || [];
      existing.push(comp);
      byType.set(comp.type, existing);
    }

    lines.push('| Type | Count |');
    lines.push('|------|-------|');
    lines.push(`| Container | ${byType.get('container')?.length || 0} |`);
    lines.push(`| Presentational | ${byType.get('presentational')?.length || 0} |`);
    lines.push(`| Layout | ${byType.get('layout')?.length || 0} |`);
    lines.push(`| Hook | ${byType.get('hook')?.length || 0} |`);
    lines.push(`| **Total** | **${repo.analysis.components.length}** |`);
    lines.push('');

    // Build page -> component mapping
    const pageComponents = new Map<string, ComponentInfo[]>();

    for (const page of repo.analysis.pages) {
      pageComponents.set(page.path, []);
    }

    for (const comp of repo.analysis.components) {
      for (const page of repo.analysis.pages) {
        const pageFeature = this.extractFeatureFromPage(page.filePath);
        const compFeature = this.extractFeatureFromComponent(comp.filePath);

        if (pageFeature && compFeature && pageFeature === compFeature) {
          pageComponents.get(page.path)?.push(comp);
        }
      }
    }

    // Page-based component structure
    lines.push('## By Page');
    lines.push('');

    for (const [pagePath, components] of pageComponents) {
      if (components.length === 0) continue;

      const containers = components.filter((c) => c.type === 'container');
      const presentationals = components.filter((c) => c.type === 'presentational');
      const hooks = components.filter((c) => c.type === 'hook');

      lines.push(`### ${pagePath}`);
      lines.push('');
      lines.push('| Component | Type | Data |');
      lines.push('|-----------|------|------|');

      // Container components
      for (const comp of containers) {
        const dataOps = this.formatComponentDataOps(comp, repo.analysis.graphqlOperations);
        lines.push(`| ${comp.name} | Container | ${dataOps || '-'} |`);
      }

      // Presentational components (show all with data)
      for (const comp of presentationals.slice(0, 10)) {
        const dataOps = this.formatComponentDataOps(comp, repo.analysis.graphqlOperations);
        lines.push(`| ${comp.name} | UI | ${dataOps || '-'} |`);
      }

      // Hook components (show all with data)
      for (const comp of hooks) {
        const dataOps = this.formatComponentDataOps(comp, repo.analysis.graphqlOperations);
        lines.push(`| ${comp.name} | Hook | ${dataOps || '-'} |`);
      }
      lines.push('');

      // Collapsible section for remaining UI components
      if (presentationals.length > 10) {
        const remainingComps = presentationals.slice(10);
        const sectionId = `more-ui-${pagePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
        lines.push(`<details id="${sectionId}">`);
        lines.push(
          `<summary style="cursor:pointer;color:var(--accent);padding:8px 0">Show ${remainingComps.length} more UI components</summary>`
        );
        lines.push('');
        lines.push('| Component | Type | Data |');
        lines.push('|-----------|------|------|');
        for (const comp of remainingComps) {
          const dataOps = this.formatComponentDataOps(comp, repo.analysis.graphqlOperations);
          lines.push(`| ${comp.name} | UI | ${dataOps || '-'} |`);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    }

    // Type summary tables
    lines.push('## By Type');
    lines.push('');

    for (const [type, components] of byType) {
      lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)} (${components.length})`);
      lines.push('');
      lines.push('| Name | File | Data |');
      lines.push('|------|------|------|');

      for (const comp of components.slice(0, 25)) {
        const shortPath = comp.filePath.replace('src/features/', '').replace('src/', '');
        const dataOps = this.formatComponentDataOps(comp, repo.analysis.graphqlOperations);
        lines.push(`| ${comp.name} | ${shortPath} | ${dataOps || '-'} |`);
      }
      lines.push('');

      // Collapsible section for remaining components
      if (components.length > 25) {
        const remainingComps = components.slice(25);
        const sectionId = `more-${type}-components`;
        lines.push(`<details id="${sectionId}">`);
        lines.push(
          `<summary style="cursor:pointer;color:var(--accent);padding:8px 0">Show ${remainingComps.length} more ${type} components</summary>`
        );
        lines.push('');
        lines.push('| Name | File | Data |');
        lines.push('|------|------|------|');
        for (const comp of remainingComps) {
          const shortPath = comp.filePath.replace('src/features/', '').replace('src/', '');
          const dataOps = this.formatComponentDataOps(comp, repo.analysis.graphqlOperations);
          lines.push(`| ${comp.name} | ${shortPath} | ${dataOps || '-'} |`);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private extractFeatureFromPage(filePath: string): string | null {
    // Extract feature name from page file like "contract/billing_information.tsx" -> "contract"
    const parts = filePath.split('/');
    if (parts.length > 1) {
      return parts[0];
    }
    return null;
  }

  private extractFeatureFromComponent(filePath: string): string | null {
    // Extract feature name from component file like "src/features/contract/..." -> "contract"
    const match = filePath.match(/src\/features\/([^/]+)/);
    if (match) {
      return match[1];
    }
    return null;
  }

  private formatComponentDataOps(
    comp: ComponentInfo,
    graphqlOperations?: GraphQLOperation[]
  ): string {
    const queries: string[] = [];
    const mutations: string[] = [];

    // Prefer GraphQL analyzer results by file path (more complete than hook regex)
    if (graphqlOperations && comp.filePath) {
      for (const op of graphqlOperations) {
        if (op.type !== 'query' && op.type !== 'mutation') continue;
        const referenced =
          op.filePath === comp.filePath || (op.usedIn && op.usedIn.includes(comp.filePath));
        if (!referenced) continue;
        if (op.type === 'mutation') mutations.push(op.name);
        else queries.push(op.name);
      }
    }

    for (const hook of comp.hooks) {
      const queryMatch = hook.match(/(?:useQuery|Query):\s*(\w+)/);
      const mutationMatch = hook.match(/(?:useMutation|Mutation):\s*(\w+)/);

      if (queryMatch && queryMatch[1] && queryMatch[1].trim().length >= 2) {
        queries.push(queryMatch[1]);
      } else if (mutationMatch && mutationMatch[1] && mutationMatch[1].trim().length >= 2) {
        mutations.push(mutationMatch[1]);
      }
    }

    // Filter out empty or invalid names + dedupe
    const validQueries = Array.from(new Set(queries.filter((q) => q && q.trim().length >= 2)));
    const validMutations = Array.from(new Set(mutations.filter((m) => m && m.trim().length >= 2)));

    if (validQueries.length === 0 && validMutations.length === 0) {
      return '';
    }

    const ops: string[] = [];

    // Show all queries
    for (const name of validQueries.sort()) {
      ops.push(`<span class="gql-op" data-op="${name}">${name}</span>`);
    }

    // Show all mutations
    for (const name of validMutations.sort()) {
      ops.push(`<span class="gql-op mutation" data-op="${name}">${name}</span>`);
    }

    return `<div class="gql-ops-inline">${ops.join(' ')}</div>`;
  }

  private generateGraphQLDoc(repo: RepositoryReport): string {
    const lines: string[] = [`# ${repo.displayName} - GraphQL`, ''];

    const queries = repo.analysis.graphqlOperations.filter((op) => op.type === 'query');
    const mutations = repo.analysis.graphqlOperations.filter((op) => op.type === 'mutation');
    const fragments = repo.analysis.graphqlOperations.filter((op) => op.type === 'fragment');

    lines.push('| Type | Count |');
    lines.push('|------|-------|');
    lines.push(`| Query | ${queries.length} |`);
    lines.push(`| Mutation | ${mutations.length} |`);
    lines.push(`| Fragment | ${fragments.length} |`);
    lines.push(`| **Total** | **${repo.analysis.graphqlOperations.length}** |`);
    lines.push('');

    // Queries
    if (queries.length > 0) {
      lines.push(`## Queries`);
      lines.push('');

      for (const query of queries.slice(0, 80)) {
        lines.push(`### ${query.name}`);
        lines.push('');

        const returnType = query.returnType || 'unknown';
        const varsCount = query.variables.length;
        const usedCount = query.usedIn.length;
        lines.push(
          `> Return: \`${returnType}\` | Variables: ${varsCount} | Used: ${usedCount} files`
        );
        lines.push('');

        if (query.variables.length > 0) {
          lines.push('| Variable | Type |');
          lines.push('|----------|------|');
          for (const v of query.variables) {
            lines.push(`| ${v.name} | \`${v.type}\` |`);
          }
          lines.push('');
        }

        if (query.fields && query.fields.length > 0) {
          lines.push('```graphql');
          lines.push(this.formatGraphQLFields(query.fields, 0));
          lines.push('```');
          lines.push('');
        }
      }
      if (queries.length > 80) lines.push(`*+${queries.length - 80} more queries*\n`);
    }

    // Mutations
    if (mutations.length > 0) {
      lines.push(`## Mutations`);
      lines.push('');

      for (const mutation of mutations.slice(0, 80)) {
        lines.push(`### ${mutation.name}`);
        lines.push('');

        const varsCount = mutation.variables.length;
        const usedCount = mutation.usedIn.length;
        lines.push(`> Variables: ${varsCount} | Used: ${usedCount} files`);
        lines.push('');

        if (mutation.variables.length > 0) {
          lines.push('| Variable | Type |');
          lines.push('|----------|------|');
          for (const v of mutation.variables) {
            lines.push(`| ${v.name} | \`${v.type}\` |`);
          }
          lines.push('');
        }

        if (mutation.fields && mutation.fields.length > 0) {
          lines.push('```graphql');
          lines.push(this.formatGraphQLFields(mutation.fields, 0));
          lines.push('```');
          lines.push('');
        }
      }
      if (mutations.length > 80) lines.push(`*+${mutations.length - 80} more mutations*\n`);
    }

    // Fragments
    if (fragments.length > 0) {
      lines.push(`## Fragments`);
      lines.push('');
      lines.push('| Name | Type | Fields |');
      lines.push('|------|------|--------|');
      for (const fragment of fragments.slice(0, 50)) {
        const fieldCount = fragment.fields?.length || 0;
        lines.push(`| ${fragment.name} | ${fragment.returnType || '-'} | ${fieldCount} |`);
      }
      if (fragments.length > 50) lines.push(`| *+${fragments.length - 50} more* | | |`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatGraphQLFields(fields: GraphQLField[], indent: number): string {
    if (!fields || fields.length === 0) return '';
    const lines: string[] = [];
    for (const field of fields) {
      const prefix = '  '.repeat(indent);
      if (field.fields && field.fields.length > 0) {
        lines.push(`${prefix}${field.name} {`);
        lines.push(this.formatGraphQLFields(field.fields, indent + 1));
        lines.push(`${prefix}}`);
      } else {
        lines.push(`${prefix}${field.name}`);
      }
    }
    return lines.join('\n');
  }

  private generateDataFlowDoc(repo: RepositoryReport): string {
    const lines: string[] = [`# ${repo.displayName} - Data Flow`, ''];

    // Overview
    const queryFlows = repo.analysis.dataFlows.filter(
      (f) => f.name.includes('📡') || f.operations.some((o) => o.includes('Query'))
    );
    const mutationFlows = repo.analysis.dataFlows.filter(
      (f) => f.name.includes('✏️') || f.operations.some((o) => o.includes('Mutation'))
    );
    const contextFlows = repo.analysis.dataFlows.filter((f) => f.source.type === 'context');

    lines.push('## Overview');
    lines.push('');
    lines.push('| Type | Count | Direction |');
    lines.push('|------|-------|-----------|');
    lines.push(`| \`QUERY\` | ${queryFlows.length} | Server → Component |`);
    lines.push(`| \`MUTATION\` | ${mutationFlows.length} | Component → Server |`);
    lines.push(`| \`CONTEXT\` | ${contextFlows.length} | Provider → Consumer |`);
    lines.push(`| **Total** | **${repo.analysis.dataFlows.length}** | |`);
    lines.push('');

    // Architecture diagram
    lines.push('## Architecture');
    lines.push('');
    lines.push('```mermaid');
    lines.push('flowchart LR');
    lines.push('  subgraph Server["GraphQL Server"]');
    lines.push('    API[(API)]');
    lines.push('  end');
    lines.push('  subgraph Client["React Application"]');
    lines.push('    Apollo[Apollo Client]');
    lines.push('    Container[Container Component]');
    lines.push('    View[View Component]');
    lines.push('  end');
    lines.push('  API -->|Query Response| Apollo');
    lines.push('  Apollo -->|Cache/Data| Container');
    lines.push('  Container -->|Props| View');
    lines.push('  View -->|User Action| Container');
    lines.push('  Container -->|Mutation| Apollo');
    lines.push('  Apollo -->|GraphQL Request| API');
    lines.push('```');
    lines.push('');

    // Page-based data flow
    lines.push('## Page Data Flows');
    lines.push('');
    // Wrap this whole section so the sticky filter is bounded to it (not "fixed" for the entire doc).
    lines.push('<div class="dataflow-page-flows">');
    lines.push(
      [
        '<div class="ops-filters" data-filter-scope="dataflow">',
        '  <span class="ops-filters__label">Show:</span>',
        '  <label class="ops-toggle"><input type="checkbox" data-filter="direct" checked> Direct</label>',
        '  <label class="ops-toggle"><input type="checkbox" data-filter="close" checked> Close</label>',
        '  <label class="ops-toggle"><input type="checkbox" data-filter="indirect" checked> Indirect</label>',
        '  <label class="ops-toggle"><input type="checkbox" data-filter="common"> Common</label>',
        '</div>',
      ].join('\n')
    );
    lines.push('');

    for (const page of repo.analysis.pages) {
      const pageFeature = this.extractFeatureFromPage(page.filePath);
      const relatedComponents = repo.analysis.components.filter((c) => {
        const compFeature = this.extractFeatureFromComponent(c.filePath);
        return compFeature === pageFeature;
      });

      const hasDataOps =
        page.dataFetching.length > 0 ||
        relatedComponents.some((c) =>
          c.stateManagement.some((s) => s.includes('Apollo') || s.includes('Context'))
        );

      if (!hasDataOps) continue;

      lines.push(`### ${page.path}`);
      lines.push('');
      lines.push(`\`FILE: ${page.filePath}\``);
      lines.push('');

      // Mermaid flow diagram for this page
      const pageOpGroups = this.getPageOperationGroups(page);
      const validQueries = this.flattenGroups(pageOpGroups, 'queries');
      const validMutations = this.flattenGroups(pageOpGroups, 'mutations');

      if (validQueries.length > 0 || validMutations.length > 0) {
        const pageId = page.path.replace(/[^a-zA-Z0-9]/g, '_');
        // Escape special characters in path for Mermaid
        const safePath = page.path.replace(/"/g, "'");

        // Use <pre class="mermaid"> to avoid markdown injecting <p> tags inside HTML blocks.
        // Keep data attributes for filtering/rerendering.
        lines.push(
          `<pre class="mermaid" data-mermaid-scope="dataflow" data-mermaid-page="${pageId}">`
        );
        lines.push('flowchart LR');
        lines.push(`  Page${pageId}["${safePath}"]`);
        lines.push('');

        const maxPerGroup = 10;
        const groupOrder: PageOpGroupKey[] = ['direct', 'close', 'indirect', 'common'];

        for (const key of groupOrder) {
          const g = pageOpGroups[key];
          if (g.queries.length === 0 && g.mutations.length === 0) continue;

          lines.push(`%%DFG_GROUP:${key}:start%%`);

          g.queries.slice(0, maxPerGroup).forEach((q, i) => {
            const qId = `Q${pageId}_${key}_${i}`;
            // Escape special characters in operation name
            const safeQ = q.replace(/"/g, "'").replace(/[<>]/g, '');
            lines.push(`  ${qId}["${safeQ}"]:::query --> Page${pageId}`);
          });

          g.mutations.slice(0, maxPerGroup).forEach((m, i) => {
            const mId = `M${pageId}_${key}_${i}`;
            // Escape special characters in operation name
            const safeM = m.replace(/"/g, "'").replace(/[<>]/g, '');
            lines.push(`  Page${pageId} --> ${mId}["${safeM}"]:::mutation`);
          });

          lines.push(`%%DFG_GROUP:${key}:end%%`);
          lines.push('');
        }

        lines.push('  classDef query fill:#dbeafe,stroke:#1d4ed8,color:#1e40af');
        lines.push('  classDef mutation fill:#fce7f3,stroke:#be185d,color:#9d174d');
        lines.push('</pre>');
        lines.push('');
      }

      // Operations list with clickable tags - grouped by relationship (direct/close/indirect/common)
      const groupOrder: PageOpGroupKey[] = ['direct', 'close', 'indirect', 'common'];
      const groupMeta: Record<
        PageOpGroupKey,
        { label: string; open: boolean; defaultVisible: boolean }
      > = {
        direct: { label: 'Direct (this page)', open: true, defaultVisible: true },
        close: { label: 'Close (related)', open: true, defaultVisible: true },
        indirect: { label: 'Indirect (via imports)', open: false, defaultVisible: true },
        common: { label: 'Common (shared)', open: false, defaultVisible: false },
      };

      const hasAnyOps = groupOrder.some(
        (k) => pageOpGroups[k].queries.length > 0 || pageOpGroups[k].mutations.length > 0
      );
      if (hasAnyOps) {
        for (const key of groupOrder) {
          const g = pageOpGroups[key];
          const meta = groupMeta[key];
          if (g.queries.length === 0 && g.mutations.length === 0) continue;

          const openAttr = meta.open ? ' open' : '';
          const displayStyle = meta.defaultVisible ? '' : ' style="display:none"';
          lines.push(
            `<details class="ops-group" data-ops-scope="dataflow" data-ops-group="${key}"${openAttr}${displayStyle}>`
          );
          lines.push(
            `<summary class="ops-group__summary"><span class="ops-group__title">${meta.label}</span><span class="ops-group__count">${g.queries.length + g.mutations.length}</span></summary>`
          );

          if (g.queries.length > 0) {
            lines.push(`<p><strong>Queries (${g.queries.length})</strong></p>`);
            lines.push('<div class="gql-ops-list">');
            for (const q of g.queries) {
              lines.push(`<span class="gql-op" data-op="${q}">${q}</span>`);
            }
            lines.push('</div>');
          }

          if (g.mutations.length > 0) {
            lines.push(`<p><strong>Mutations (${g.mutations.length})</strong></p>`);
            lines.push('<div class="gql-ops-list">');
            for (const m of g.mutations) {
              lines.push(`<span class="gql-op mutation" data-op="${m}">${m}</span>`);
            }
            lines.push('</div>');
          }

          lines.push('</details>');
          lines.push('');
        }
      }

      lines.push('---');
      lines.push('');
    }

    lines.push('</div>');

    // Context providers
    const providers = new Set<string>();
    for (const flow of contextFlows) {
      providers.add(flow.source.name);
    }

    if (providers.size > 0) {
      lines.push('## Context Providers');
      lines.push('');
      lines.push('| Provider | Description |');
      lines.push('|----------|-------------|');
      for (const provider of providers) {
        lines.push(`| \`${provider}\` | Provides shared state |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private getPageOperationGroups(page: PageInfo): PageOpGroups {
    const groups: PageOpGroupSets = {
      direct: { queries: new Set<string>(), mutations: new Set<string>() },
      close: { queries: new Set<string>(), mutations: new Set<string>() },
      indirect: { queries: new Set<string>(), mutations: new Set<string>() },
      common: { queries: new Set<string>(), mutations: new Set<string>() },
    };

    // Helper to validate operation name
    const isValidOpName = (name: string | undefined | null): name is string => {
      if (!name) return false;
      const trimmed = name.trim();
      // Must have at least 2 characters and contain at least one letter
      return trimmed.length >= 2 && /[a-zA-Z]/.test(trimmed);
    };

    const pickGroupKey = (source: string | undefined): PageOpGroupKey => {
      if (!source) return 'direct';
      const s = source.trim();
      if (s.startsWith('common:')) return 'common';
      if (s.startsWith('close:')) return 'close';
      if (s.startsWith('indirect:')) return 'indirect';
      return 'direct';
    };

    for (const df of page.dataFetching || []) {
      const rawName = df.operationName?.replace(/^[→\->\s]+/, '') || '';
      const cleaned = rawName.replace(/Document$/g, '').trim();
      if (!isValidOpName(cleaned)) continue;

      const key = pickGroupKey(df.source);
      const isMutation = df.type?.includes('Mutation') ?? false;
      if (isMutation) groups[key].mutations.add(cleaned);
      else groups[key].queries.add(cleaned);
    }

    const finalize = (set: Set<string>): string[] =>
      Array.from(set)
        .filter(isValidOpName)
        .sort((a, b) => a.localeCompare(b));

    return {
      direct: {
        queries: finalize(groups.direct.queries),
        mutations: finalize(groups.direct.mutations),
      },
      close: {
        queries: finalize(groups.close.queries),
        mutations: finalize(groups.close.mutations),
      },
      indirect: {
        queries: finalize(groups.indirect.queries),
        mutations: finalize(groups.indirect.mutations),
      },
      common: {
        queries: finalize(groups.common.queries),
        mutations: finalize(groups.common.mutations),
      },
    };
  }

  private flattenGroups(groups: PageOpGroups, kind: 'queries' | 'mutations'): string[] {
    const all = new Set<string>();
    for (const g of Object.values(groups)) {
      for (const name of g[kind]) all.add(name);
    }
    return Array.from(all).sort((a, b) => a.localeCompare(b));
  }

  private generateCrossRepoDoc(report: DocumentationReport): string {
    const lines: string[] = [
      '# Cross Repository Analysis',
      '',
      '## Architecture Overview',
      '',
      '```mermaid',
      'flowchart TB',
    ];

    for (const repo of report.repositories) {
      const repoId = repo.name.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(`  subgraph ${repoId}["${repo.displayName}"]`);
      lines.push(`    ${repoId}_core["Core"]`);
      lines.push('  end');
    }

    lines.push('```');
    lines.push('');

    // API Connections
    lines.push('## API Connections');
    lines.push('');
    for (const conn of report.crossRepoAnalysis.apiConnections) {
      lines.push(`- **${conn.frontend}** → **${conn.backend}**: \`${conn.endpoint}\``);
    }
    lines.push('');

    // Shared types
    lines.push('## Shared Types');
    lines.push('');
    for (const type of report.crossRepoAnalysis.sharedTypes) {
      lines.push(`- \`${type}\``);
    }
    lines.push('');

    return lines.join('\n');
  }

  private createPageDataFlowDiagram(
    page: PageInfo,
    relatedComponents: ComponentInfo[],
    _dataFlows: DataFlow[]
  ): string {
    const lines: string[] = [];

    // Extract queries and mutations from related components
    const queries: string[] = [];
    const mutations: string[] = [];
    const containers: string[] = [];

    for (const comp of relatedComponents) {
      if (comp.type === 'container') {
        containers.push(comp.name);
      }
      for (const hook of comp.hooks) {
        if (hook.includes('Query') || hook.includes('📡')) {
          const name = hook.includes(':') ? hook.split(':')[1].trim() : hook;
          if (!queries.includes(name)) queries.push(name);
        }
        if (hook.includes('Mutation') || hook.includes('✏️')) {
          const name = hook.includes(':') ? hook.split(':')[1].trim() : hook;
          if (!mutations.includes(name)) mutations.push(name);
        }
      }
    }

    // Also check page's own data fetching
    for (const df of page.dataFetching) {
      const name = df.operationName.replace(/^→\s*/, '');
      if (df.type.includes('Query') && !queries.includes(name)) {
        queries.push(name);
      } else if (df.type.includes('Mutation') && !mutations.includes(name)) {
        mutations.push(name);
      }
    }

    // Build ASCII diagram
    lines.push(`[Page: ${page.path}]`);
    lines.push('│');

    if (queries.length > 0 || mutations.length > 0) {
      lines.push('├─ 📡 Data Fetching (Query)');
      for (const q of queries.slice(0, 5)) {
        lines.push(`│   ├─ ${q.substring(0, 40)}`);
        lines.push(`│   │   └─ GraphQL Server → Apollo Cache → Component`);
      }
      if (queries.length > 5) {
        lines.push(`│   └─ ... and ${queries.length - 5} more`);
      }

      if (mutations.length > 0) {
        lines.push('│');
        lines.push('├─ ✏️ Data Mutation (Mutation)');
        for (const m of mutations.slice(0, 5)) {
          lines.push(`│   ├─ ${m.substring(0, 40)}`);
          lines.push(`│   │   └─ Component → GraphQL Server → Apollo Cache`);
        }
        if (mutations.length > 5) {
          lines.push(`│   └─ ... and ${mutations.length - 5} more`);
        }
      }
    }

    if (containers.length > 0) {
      lines.push('│');
      lines.push('├─ 📦 Container Components');
      for (const c of containers.slice(0, 5)) {
        lines.push(`│   └─ ${c}`);
      }
      if (containers.length > 5) {
        lines.push(`│   └─ ... and ${containers.length - 5} more`);
      }
    }

    lines.push('│');
    lines.push('└─ [Render]');

    return lines.join('\n');
  }

  private generateDiagramsDoc(diagrams: MermaidDiagram[]): string {
    const lines: string[] = ['# Diagrams', ''];

    lines.push('## Overview');
    lines.push('');
    lines.push('| Diagram | Type | Description |');
    lines.push('|---------|------|-------------|');

    for (const diagram of diagrams) {
      lines.push(`| ${diagram.title} | \`${diagram.type.toUpperCase()}\` | Auto-generated |`);
    }
    lines.push('');

    for (const diagram of diagrams) {
      lines.push(`## ${diagram.title}`);
      lines.push('');
      lines.push(`\`TYPE: ${diagram.type.toUpperCase()}\``);
      lines.push('');
      lines.push('```mermaid');
      lines.push(diagram.content);
      lines.push('```');
      lines.push('');
    }

    return lines.join('\n');
  }
}
