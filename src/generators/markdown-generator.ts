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
      lines.push('| Page | Auth | Layout | Data |');
      lines.push('|------|------|--------|------|');

      for (const page of pages) {
        const pathDisplay = page.path.replace(`/${category}`, '') || '/';
        const auth = page.authentication.required ? 'Required' : 'Public';
        const layout = page.layout || '-';
        const dataOps: string[] = [];
        const seenNames = new Set<string>();

        // Deduplicate queries and mutations by clean name, prioritize direct queries over refs
        const allDf = page.dataFetching;
        const queries = allDf.filter((df) => !df.type.includes('Mutation'));
        const mutations = allDf.filter((df) => df.type.includes('Mutation'));

        // Process queries - deduplicate by clean name, prefer direct over ref
        const uniqueQueries: { cleanName: string; isRef: boolean }[] = [];
        for (const q of queries) {
          const rawName = q.operationName || '';
          if (!rawName || rawName.trim().length < 2) continue;
          const isRef = rawName.startsWith('→') || rawName.startsWith('->');
          const cleanName = rawName.replace(/^[→\->\s]+/, '').trim();
          if (!cleanName || cleanName.length < 2) continue;

          // Skip if already seen, but update to direct if previously was ref
          const existing = uniqueQueries.find((u) => u.cleanName === cleanName);
          if (existing) {
            if (!isRef && existing.isRef) {
              existing.isRef = false; // Upgrade ref to direct
            }
            continue;
          }
          if (!seenNames.has(cleanName)) {
            seenNames.add(cleanName);
            uniqueQueries.push({ cleanName, isRef });
          }
        }

        // Process mutations - deduplicate by clean name, prefer direct over ref
        const uniqueMutations: { cleanName: string; isRef: boolean }[] = [];
        for (const m of mutations) {
          const rawName = m.operationName || '';
          if (!rawName || rawName.trim().length < 2) continue;
          const isRef = rawName.startsWith('→') || rawName.startsWith('->');
          const cleanName = rawName.replace(/^[→\->\s]+/, '').trim();
          if (!cleanName || cleanName.length < 2) continue;

          const existing = uniqueMutations.find((u) => u.cleanName === cleanName);
          if (existing) {
            if (!isRef && existing.isRef) {
              existing.isRef = false;
            }
            continue;
          }
          if (!seenNames.has(cleanName)) {
            seenNames.add(cleanName);
            uniqueMutations.push({ cleanName, isRef });
          }
        }

        // Show first 2 unique queries
        for (const q of uniqueQueries.slice(0, 2)) {
          if (q.isRef) {
            dataOps.push(
              `<span class="gql-ref" data-ref="${q.cleanName}" title="Component">${q.cleanName}</span>`
            );
          } else {
            dataOps.push(`<span class="gql-op" data-op="${q.cleanName}">${q.cleanName}</span>`);
          }
        }

        // Show first 2 unique mutations
        for (const m of uniqueMutations.slice(0, 2)) {
          if (m.isRef) {
            dataOps.push(
              `<span class="gql-ref mutation" data-ref="${m.cleanName}" title="Component">${m.cleanName}</span>`
            );
          } else {
            dataOps.push(
              `<span class="gql-op mutation" data-op="${m.cleanName}">${m.cleanName}</span>`
            );
          }
        }

        // Calculate remaining based on deduplicated counts
        const remaining =
          uniqueQueries.length +
          uniqueMutations.length -
          Math.min(uniqueQueries.length, 2) -
          Math.min(uniqueMutations.length, 2);
        if (remaining > 0) {
          dataOps.push(
            `<span class="gql-more" data-type="all" data-page="${page.path}">+${remaining} more</span>`
          );
        }
        const data = dataOps.length > 0 ? dataOps.join(' ') : '-';

        lines.push(`| \`${pathDisplay}\` | ${auth} | ${layout} | ${data} |`);
      }
      lines.push('');

      // Details for each page with GraphQL operations
      for (const page of pages) {
        const queries = page.dataFetching.filter((df) => !df.type.includes('Mutation'));
        const mutations = page.dataFetching.filter((df) => df.type.includes('Mutation'));

        if (queries.length > 0 || mutations.length > 0) {
          // Deduplicate queries by clean name
          const seenQueryNames = new Set<string>();
          const uniqueQueries: { cleanName: string; isRef: boolean }[] = [];
          for (const q of queries) {
            const rawName = q.operationName || '';
            if (!rawName || rawName.trim().length < 2) continue;
            const isRef = rawName.startsWith('→') || rawName.startsWith('->');
            const cleanName = rawName.replace(/^[→\->\s]+/, '').trim();
            if (!cleanName || cleanName.length < 2) continue;

            const existing = uniqueQueries.find((u) => u.cleanName === cleanName);
            if (existing) {
              if (!isRef && existing.isRef) existing.isRef = false;
              continue;
            }
            if (!seenQueryNames.has(cleanName)) {
              seenQueryNames.add(cleanName);
              uniqueQueries.push({ cleanName, isRef });
            }
          }

          // Deduplicate mutations by clean name
          const seenMutNames = new Set<string>();
          const uniqueMutations: { cleanName: string; isRef: boolean }[] = [];
          for (const m of mutations) {
            const rawName = m.operationName || '';
            if (!rawName || rawName.trim().length < 2) continue;
            const isRef = rawName.startsWith('→') || rawName.startsWith('->');
            const cleanName = rawName.replace(/^[→\->\s]+/, '').trim();
            if (!cleanName || cleanName.length < 2) continue;

            const existing = uniqueMutations.find((u) => u.cleanName === cleanName);
            if (existing) {
              if (!isRef && existing.isRef) existing.isRef = false;
              continue;
            }
            if (!seenMutNames.has(cleanName)) {
              seenMutNames.add(cleanName);
              uniqueMutations.push({ cleanName, isRef });
            }
          }

          if (uniqueQueries.length === 0 && uniqueMutations.length === 0) continue;

          lines.push(`### ${page.path}`);
          lines.push('');
          lines.push(`> ${page.filePath}`);
          lines.push('');

          // Queries section
          if (uniqueQueries.length > 0) {
            lines.push(`**Queries (${uniqueQueries.length})**`);
            lines.push('');
            lines.push('<div class="gql-ops-list">');
            for (const q of uniqueQueries) {
              if (q.isRef) {
                lines.push(
                  `<span class="gql-ref" data-ref="${q.cleanName}" title="Component">${q.cleanName}</span>`
                );
              } else {
                lines.push(`<span class="gql-op" data-op="${q.cleanName}">${q.cleanName}</span>`);
              }
            }
            lines.push('</div>');
            lines.push('');
          }

          // Mutations section
          if (uniqueMutations.length > 0) {
            lines.push(`**Mutations (${uniqueMutations.length})**`);
            lines.push('');
            lines.push('<div class="gql-ops-list">');
            for (const m of uniqueMutations) {
              if (m.isRef) {
                lines.push(
                  `<span class="gql-ref mutation" data-ref="${m.cleanName}" title="Component">${m.cleanName}</span>`
                );
              } else {
                lines.push(
                  `<span class="gql-op mutation" data-op="${m.cleanName}">${m.cleanName}</span>`
                );
              }
            }
            lines.push('</div>');
            lines.push('');
          }

          lines.push('');
        }
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
        const dataOps = this.formatComponentDataOps(comp);
        lines.push(`| ${comp.name} | Container | ${dataOps || '-'} |`);
      }

      // Presentational components (show all with data)
      for (const comp of presentationals.slice(0, 10)) {
        const dataOps = this.formatComponentDataOps(comp);
        lines.push(`| ${comp.name} | UI | ${dataOps || '-'} |`);
      }

      // Hook components (show all with data)
      for (const comp of hooks) {
        const dataOps = this.formatComponentDataOps(comp);
        lines.push(`| ${comp.name} | Hook | ${dataOps || '-'} |`);
      }
      lines.push('');

      // Collapsible section for remaining UI components
      if (presentationals.length > 10) {
        const remainingComps = presentationals.slice(10);
        const sectionId = `more-ui-${pagePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
        lines.push(`<details id="${sectionId}">`);
        lines.push(
          `<summary style="cursor:pointer;color:var(--accent);padding:8px 0">▸ Show ${remainingComps.length} more UI components</summary>`
        );
        lines.push('');
        lines.push('| Component | Type | Data |');
        lines.push('|-----------|------|------|');
        for (const comp of remainingComps) {
          const dataOps = this.formatComponentDataOps(comp);
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
        const dataOps = this.formatComponentDataOps(comp);
        lines.push(`| ${comp.name} | ${shortPath} | ${dataOps || '-'} |`);
      }
      lines.push('');

      // Collapsible section for remaining components
      if (components.length > 25) {
        const remainingComps = components.slice(25);
        const sectionId = `more-${type}-components`;
        lines.push(`<details id="${sectionId}">`);
        lines.push(
          `<summary style="cursor:pointer;color:var(--accent);padding:8px 0">▸ Show ${remainingComps.length} more ${type} components</summary>`
        );
        lines.push('');
        lines.push('| Name | File | Data |');
        lines.push('|------|------|------|');
        for (const comp of remainingComps) {
          const shortPath = comp.filePath.replace('src/features/', '').replace('src/', '');
          const dataOps = this.formatComponentDataOps(comp);
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

  private formatComponentDataOps(comp: ComponentInfo): string {
    const queries: string[] = [];
    const mutations: string[] = [];

    for (const hook of comp.hooks) {
      const queryMatch = hook.match(/(?:useQuery|Query):\s*(\w+)/);
      const mutationMatch = hook.match(/(?:useMutation|Mutation):\s*(\w+)/);

      if (queryMatch && queryMatch[1] && queryMatch[1].trim().length >= 2) {
        queries.push(queryMatch[1]);
      } else if (mutationMatch && mutationMatch[1] && mutationMatch[1].trim().length >= 2) {
        mutations.push(mutationMatch[1]);
      }
    }

    // Filter out empty or invalid names
    const validQueries = queries.filter((q) => q && q.trim().length >= 2);
    const validMutations = mutations.filter((m) => m && m.trim().length >= 2);

    if (validQueries.length === 0 && validMutations.length === 0) {
      return '';
    }

    const ops: string[] = [];
    const maxShowQueries = 2;
    const maxShowMutations = 2;

    // Show first N queries - use original name for consistency
    const shownQueries = validQueries.slice(0, maxShowQueries);
    for (const name of shownQueries) {
      ops.push(`<span class="gql-op" data-op="${name}">${name}</span>`);
    }

    // Show first N mutations - use original name for consistency
    const shownMutations = validMutations.slice(0, maxShowMutations);
    for (const name of shownMutations) {
      ops.push(`<span class="gql-op mutation" data-op="${name}">${name}</span>`);
    }

    // Calculate remaining correctly
    const hiddenQueries = validQueries.slice(maxShowQueries);
    const hiddenMutations = validMutations.slice(maxShowMutations);
    const remaining = hiddenQueries.length + hiddenMutations.length;

    if (remaining > 0) {
      // Store all hidden operations in data attributes for accurate display
      const allQueries = JSON.stringify(validQueries).replace(/"/g, '&quot;');
      const allMutations = JSON.stringify(validMutations).replace(/"/g, '&quot;');
      ops.push(
        `<span class="gql-ref" data-ref="${comp.name}" data-queries="${allQueries}" data-mutations="${allMutations}" title="View all ${validQueries.length} queries and ${validMutations.length} mutations">+${remaining} more</span>`
      );
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
      const pageOps = this.getPageOperations(
        page,
        relatedComponents,
        repo.analysis.graphqlOperations
      );

      // Filter out empty operation names before creating diagram
      const validQueries = pageOps.queries.filter((q) => q && q.trim().length > 0);
      const validMutations = pageOps.mutations.filter((m) => m && m.trim().length > 0);

      if (validQueries.length > 0 || validMutations.length > 0) {
        lines.push('```mermaid');
        lines.push('flowchart LR');
        const pageId = page.path.replace(/[^a-zA-Z0-9]/g, '_');
        // Escape special characters in path for Mermaid
        const safePath = page.path.replace(/"/g, "'");
        lines.push(`  Page${pageId}["${safePath}"]`);

        validQueries.slice(0, 5).forEach((q, i) => {
          const qId = `Q${pageId}_${i}`;
          // Escape special characters in operation name
          const safeQ = q.replace(/"/g, "'").replace(/[<>]/g, '');
          lines.push(`  ${qId}["${safeQ}"]:::query --> Page${pageId}`);
        });

        validMutations.slice(0, 5).forEach((m, i) => {
          const mId = `M${pageId}_${i}`;
          // Escape special characters in operation name
          const safeM = m.replace(/"/g, "'").replace(/[<>]/g, '');
          lines.push(`  Page${pageId} --> ${mId}["${safeM}"]:::mutation`);
        });

        lines.push('  classDef query fill:#dbeafe,stroke:#1d4ed8,color:#1e40af');
        lines.push('  classDef mutation fill:#fce7f3,stroke:#be185d,color:#9d174d');
        lines.push('```');
        lines.push('');
      }

      // Operations list with clickable tags - grouped by type
      if (pageOps.queries.length > 0 || pageOps.mutations.length > 0) {
        // Queries section - use original name for consistency, filter empty
        if (validQueries.length > 0) {
          lines.push(`**Queries (${validQueries.length})**`);
          lines.push('');
          lines.push('<div class="gql-ops-list">');
          for (const q of validQueries) {
            const isRef = q.startsWith('→') || q.startsWith('->');
            const cleanName = q.replace(/^[→\->\s]+/, '');
            if (cleanName && cleanName.trim().length > 0) {
              if (isRef) {
                lines.push(
                  `<span class="gql-ref" data-ref="${cleanName}" title="Component: ${cleanName}">${cleanName}</span>`
                );
              } else {
                lines.push(`<span class="gql-op" data-op="${cleanName}">${cleanName}</span>`);
              }
            }
          }
          lines.push('</div>');
          lines.push('');
        }

        // Mutations section - use original name for consistency, filter empty
        if (validMutations.length > 0) {
          lines.push(`**Mutations (${validMutations.length})**`);
          lines.push('');
          lines.push('<div class="gql-ops-list">');
          for (const m of validMutations) {
            const isRef = m.startsWith('→') || m.startsWith('->');
            const cleanName = m.replace(/^[→\->\s]+/, '');
            if (cleanName && cleanName.trim().length > 0) {
              if (isRef) {
                lines.push(
                  `<span class="gql-ref mutation" data-ref="${cleanName}" title="Component: ${cleanName}">${cleanName}</span>`
                );
              } else {
                lines.push(
                  `<span class="gql-op mutation" data-op="${cleanName}">${cleanName}</span>`
                );
              }
            }
          }
          lines.push('</div>');
          lines.push('');
        }
      }

      lines.push('---');
      lines.push('');
    }

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

  private getPageOperations(
    page: PageInfo,
    relatedComponents: ComponentInfo[],
    _allOperations: GraphQLOperation[]
  ): { queries: string[]; mutations: string[] } {
    const queries = new Set<string>();
    const mutations = new Set<string>();

    // Helper to validate operation name
    const isValidOpName = (name: string | undefined | null): boolean => {
      if (!name) return false;
      const trimmed = name.trim();
      // Must have at least 2 alphanumeric characters
      return trimmed.length >= 2 && /[a-zA-Z]/.test(trimmed);
    };

    // From page dataFetching
    for (const df of page.dataFetching) {
      const rawName = df.operationName?.replace(/^[→\->\s]+/, '') || '';
      const name = rawName.replace(/Document$/g, '');
      if (isValidOpName(name)) {
        if (df.type?.includes('Mutation')) {
          mutations.add(name);
        } else {
          queries.add(name);
        }
      }
    }

    // From related components
    for (const comp of relatedComponents) {
      for (const hook of comp.hooks) {
        if (hook.includes('Query')) {
          const match = hook.match(/:\s*(.+)$/);
          if (match && isValidOpName(match[1])) {
            queries.add(match[1].trim());
          }
        }
        if (hook.includes('Mutation')) {
          const match = hook.match(/:\s*(.+)$/);
          if (match && isValidOpName(match[1])) {
            mutations.add(match[1].trim());
          }
        }
      }
    }

    // Filter out any remaining invalid names
    return {
      queries: Array.from(queries).filter(isValidOpName),
      mutations: Array.from(mutations).filter(isValidOpName),
    };
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
