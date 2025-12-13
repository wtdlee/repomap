import { simpleGit } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  DocGeneratorConfig,
  RepositoryConfig,
  AnalysisResult,
  DocumentationReport,
  RepositoryReport,
  CrossRepoAnalysis,
  CrossRepoLink,
  APIConnection,
  NavigationFlow,
  DataFlow,
} from '../types.js';
import { PagesAnalyzer } from '../analyzers/pages-analyzer.js';
import { GraphQLAnalyzer } from '../analyzers/graphql-analyzer.js';
import { DataFlowAnalyzer } from '../analyzers/dataflow-analyzer.js';
import { RestApiAnalyzer } from '../analyzers/rest-api-analyzer.js';
import { MermaidGenerator } from '../generators/mermaid-generator.js';
import { MarkdownGenerator } from '../generators/markdown-generator.js';

/**
 * Main documentation generation engine
 */
export class DocGeneratorEngine {
  private config: DocGeneratorConfig;
  private mermaidGenerator: MermaidGenerator;
  private markdownGenerator: MarkdownGenerator;

  constructor(config: DocGeneratorConfig) {
    this.config = config;
    this.mermaidGenerator = new MermaidGenerator();
    this.markdownGenerator = new MarkdownGenerator();
  }

  /**
   * Run documentation generation for all configured repositories
   */
  async generate(): Promise<DocumentationReport> {
    const repositoryReports: RepositoryReport[] = [];

    for (const repoConfig of this.config.repositories) {
      try {
        const report = await this.analyzeRepository(repoConfig);
        repositoryReports.push(report);
      } catch (error) {
        console.error(`❌ ${repoConfig.name}: ${(error as Error).message}`);
      }
    }

    // Cross-repository analysis (silent)
    const crossRepoAnalysis = this.analyzeCrossRepo(repositoryReports);

    // Generate diagrams (silent)
    const results = repositoryReports.map((r) => r.analysis);
    const crossRepoLinks = this.extractCrossRepoLinks(results);
    const diagrams = this.mermaidGenerator.generateAll(results, crossRepoLinks);

    const report: DocumentationReport = {
      generatedAt: new Date().toISOString(),
      repositories: repositoryReports,
      crossRepoAnalysis,
      diagrams,
    };

    // Write documentation (silent)
    await this.writeDocumentation(report);

    return report;
  }

  /**
   * Analyze a single repository
   */
  private async analyzeRepository(repoConfig: RepositoryConfig): Promise<RepositoryReport> {
    // Get repository info
    const { version, commitHash } = await this.getRepoInfo(repoConfig);

    // Run analyzers in parallel for faster analysis
    const analyzers = repoConfig.analyzers
      .map((analyzerType) => this.createAnalyzer(analyzerType, repoConfig))
      .filter((a): a is NonNullable<typeof a> => a !== null);

    const startTime = Date.now();
    const analysisResults = await Promise.all(analyzers.map((analyzer) => analyzer.analyze()));
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`  Analyzed ${repoConfig.displayName} in ${elapsed}s`);

    // Merge results
    const analysis = this.mergeAnalysisResults(
      analysisResults,
      repoConfig.name,
      version,
      commitHash
    );

    // Enrich pages with GraphQL operations from custom hooks
    this.enrichPagesWithHookGraphQL(analysis);

    // Calculate summary
    const summary = {
      totalPages: analysis.pages.length,
      totalComponents: analysis.components.length,
      totalGraphQLOperations: analysis.graphqlOperations.length,
      totalDataFlows: analysis.dataFlows.length,
      authRequiredPages: analysis.pages.filter((p) => p.authentication.required).length,
      publicPages: analysis.pages.filter((p) => !p.authentication.required).length,
    };

    return {
      name: repoConfig.name,
      displayName: repoConfig.displayName,
      version,
      commitHash,
      analysis,
      summary,
    };
  }

  /**
   * Get repository version and commit info
   */
  private async getRepoInfo(
    repoConfig: RepositoryConfig
  ): Promise<{ version: string; commitHash: string }> {
    try {
      const git = simpleGit(repoConfig.path);
      const log = await git.log({ n: 1 });
      const commitHash = log.latest?.hash || 'unknown';

      // Try to get version from package.json
      let version = 'unknown';
      try {
        const packageJsonPath = path.join(repoConfig.path, 'package.json');
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
        version = packageJson.version || 'unknown';
      } catch {
        // Ignore if no package.json
      }

      return { version, commitHash };
    } catch {
      return { version: 'unknown', commitHash: 'unknown' };
    }
  }

  /**
   * Create analyzer instance based on type
   */
  private createAnalyzer(
    type: string,
    config: RepositoryConfig
  ): PagesAnalyzer | GraphQLAnalyzer | DataFlowAnalyzer | RestApiAnalyzer | null {
    switch (type) {
      case 'pages':
        // Support Next.js, React, and Rails+React projects
        if (config.type === 'nextjs' || config.type === 'rails' || config.type === 'generic') {
          return new PagesAnalyzer(config);
        }
        break;
      case 'graphql':
        return new GraphQLAnalyzer(config);
      case 'dataflow':
      case 'components':
        return new DataFlowAnalyzer(config);
      case 'rest-api':
      case 'api':
        return new RestApiAnalyzer(config);
    }
    return null;
  }

  /**
   * Merge multiple analysis results
   */
  private mergeAnalysisResults(
    results: Partial<AnalysisResult>[],
    repository: string,
    version: string,
    commitHash: string
  ): AnalysisResult {
    const merged: AnalysisResult = {
      repository,
      timestamp: new Date().toISOString(),
      version,
      commitHash,
      pages: [],
      graphqlOperations: [],
      apiCalls: [],
      components: [],
      dataFlows: [],
      apiEndpoints: [],
      models: [],
      crossRepoLinks: [],
    };

    for (const result of results) {
      if (result.pages) merged.pages.push(...result.pages);
      if (result.graphqlOperations) merged.graphqlOperations.push(...result.graphqlOperations);
      if (result.apiCalls) merged.apiCalls.push(...result.apiCalls);
      if (result.components) merged.components.push(...result.components);
      if (result.dataFlows) merged.dataFlows.push(...result.dataFlows);
      if (result.apiEndpoints) merged.apiEndpoints.push(...result.apiEndpoints);
      if (result.models) merged.models.push(...result.models);
      if (result.crossRepoLinks) merged.crossRepoLinks.push(...result.crossRepoLinks);
    }

    return merged;
  }

  /**
   * Analyze cross-repository relationships
   */
  private analyzeCrossRepo(reports: RepositoryReport[]): CrossRepoAnalysis {
    const sharedTypes: string[] = [];
    const apiConnections: APIConnection[] = [];
    const navigationFlows: NavigationFlow[] = [];
    const dataFlowAcrossRepos: DataFlow[] = [];

    // Find shared GraphQL operations
    const operationsByName = new Map<string, string[]>();
    for (const report of reports) {
      for (const op of report.analysis.graphqlOperations) {
        const repos = operationsByName.get(op.name) || [];
        repos.push(report.name);
        operationsByName.set(op.name, repos);
      }
    }

    // Operations used across repos are likely shared types
    for (const [name, repos] of operationsByName) {
      if (repos.length > 1) {
        sharedTypes.push(name);
      }
    }

    // Find frontend to backend connections
    const frontendRepos = reports.filter((r) => r.analysis.pages.length > 0);
    const backendRepos = reports.filter((r) => r.analysis.apiEndpoints.length > 0);

    for (const frontend of frontendRepos) {
      for (const backend of backendRepos) {
        for (const endpoint of backend.analysis.apiEndpoints) {
          apiConnections.push({
            frontend: frontend.name,
            backend: backend.name,
            endpoint: endpoint.path,
            operations: frontend.analysis.graphqlOperations
              .filter((op) => op.usedIn.length > 0)
              .map((op) => op.name),
          });
        }
      }
    }

    return {
      sharedTypes,
      apiConnections,
      navigationFlows,
      dataFlowAcrossRepos,
    };
  }

  /**
   * Extract cross-repository links
   */
  private extractCrossRepoLinks(results: AnalysisResult[]): CrossRepoLink[] {
    const links: CrossRepoLink[] = [];

    // Find GraphQL operations that connect repos
    const operationsByName = new Map<string, AnalysisResult[]>();
    for (const result of results) {
      for (const op of result.graphqlOperations) {
        const existing = operationsByName.get(op.name) || [];
        existing.push(result);
        operationsByName.set(op.name, existing);
      }
    }

    for (const [name, repos] of operationsByName) {
      if (repos.length > 1) {
        links.push({
          sourceRepo: repos[0].repository,
          sourcePath: `graphql/${name}`,
          targetRepo: repos[1].repository,
          targetPath: `graphql/${name}`,
          linkType: 'graphql-operation',
          description: `Shared GraphQL operation: ${name}`,
        });
      }
    }

    return links;
  }

  /**
   * Enrich pages with GraphQL operations from custom hooks and imported variables
   * Links GraphQL operations to pages via custom hooks and imported variables
   *
   * Strategy:
   * 1. Build hookName → GraphQL operations mapping from:
   *    - graphqlOperations.filePath (hook files contain GraphQL definitions)
   *    - components with type='hook' and their hooks array
   * 2. Build variableName → GraphQL operations mapping from:
   *    - graphqlOperations.variableNames (e.g., "Query" → "GetNewProfile")
   * 3. For each page/component, add matched GraphQL operations to dataFetching
   */
  private enrichPagesWithHookGraphQL(analysis: AnalysisResult): void {
    // Step 1: Build hook → GraphQL mapping from graphqlOperations.filePath
    const hookToGraphQL = new Map<string, Set<string>>();

    for (const op of analysis.graphqlOperations) {
      if (!op.filePath) continue;

      // Extract hook name from file path (e.g., "useInternalPostPermission.ts" → "useInternalPostPermission")
      const fileName = op.filePath.split('/').pop() || '';
      const baseName = fileName.replace(/\.(ts|tsx|js|jsx)$/, '');

      // Only process if it looks like a hook file
      if (baseName.startsWith('use')) {
        if (!hookToGraphQL.has(baseName)) {
          hookToGraphQL.set(baseName, new Set());
        }
        hookToGraphQL.get(baseName)!.add(op.name);
      }
    }

    // Step 2: Build hook → GraphQL mapping from components with type='hook'
    for (const comp of analysis.components) {
      if (comp.type !== 'hook') continue;

      // Extract GraphQL operations from hooks array (e.g., "Query: GetProduct")
      const graphqlOps: string[] = [];
      for (const hook of comp.hooks) {
        const match = hook.match(/^(Query|Mutation|Subscription):\s*(.+)$/);
        if (match) {
          graphqlOps.push(match[2]);
        }
      }

      if (graphqlOps.length > 0) {
        if (!hookToGraphQL.has(comp.name)) {
          hookToGraphQL.set(comp.name, new Set());
        }
        for (const op of graphqlOps) {
          hookToGraphQL.get(comp.name)!.add(op);
        }
      }
    }

    // Step 3: Build filePath → GraphQL operations mapping
    // This is the key for accurate matching: match by file path, not variable name
    const filePathToGraphQL = new Map<
      string,
      { opName: string; opType: 'query' | 'mutation' | 'subscription' }[]
    >();

    for (const op of analysis.graphqlOperations) {
      if (op.type !== 'query' && op.type !== 'mutation' && op.type !== 'subscription') continue;
      if (!op.filePath) continue;

      // Normalize file path (remove extension for matching)
      const normalizedPath = op.filePath.replace(/\.(ts|tsx|js|jsx)$/, '');

      if (!filePathToGraphQL.has(normalizedPath)) {
        filePathToGraphQL.set(normalizedPath, []);
      }
      filePathToGraphQL.get(normalizedPath)!.push({ opName: op.name, opType: op.type });
    }

    // Step 4: Build operation type lookup (exclude fragments)
    const opTypeMap = new Map<string, 'query' | 'mutation' | 'subscription'>();
    for (const op of analysis.graphqlOperations) {
      if (op.type === 'query' || op.type === 'mutation' || op.type === 'subscription') {
        opTypeMap.set(op.name, op.type);
      }
    }

    // Step 5: Enrich pages dataFetching
    for (const page of analysis.pages) {
      // Get existing operation names
      const existingOps = new Set(
        page.dataFetching.map((df) => df.operationName?.replace(/^[→\->\s]+/, '') || '')
      );

      // Check components (containers) that this page uses
      const pageComponent = analysis.components.find(
        (c) => c.filePath === `src/pages/${page.filePath}`
      );

      if (!pageComponent) continue;

      // Collect hooks from page component and its dependencies
      const hooksToCheck: string[] = [];
      hooksToCheck.push(...pageComponent.hooks.filter((h) => h.startsWith('use')));
      // Also check dependencies that are hooks
      for (const dep of pageComponent.dependencies) {
        if (dep.startsWith('use')) {
          hooksToCheck.push(dep);
        }
      }

      // Add GraphQL operations from hooks
      for (const hookName of hooksToCheck) {
        const graphqlOps = hookToGraphQL.get(hookName);
        if (!graphqlOps) continue;

        for (const opName of graphqlOps) {
          if (existingOps.has(opName)) continue;
          existingOps.add(opName);

          const opType = opTypeMap.get(opName) || 'query';
          page.dataFetching.push({
            type: opType === 'mutation' ? 'useMutation' : 'useQuery',
            operationName: opName,
            source: `hook:${hookName}`,
          });
        }
      }

      // Add GraphQL operations from imported files (file path based matching)
      if (pageComponent.imports) {
        for (const imp of pageComponent.imports) {
          // Resolve relative import path to absolute path from page's directory
          const pageDir = path.dirname(pageComponent.filePath);
          let resolvedPath = imp.path;

          if (imp.path.startsWith('.')) {
            // Resolve relative path
            resolvedPath = path.join(pageDir, imp.path);
            // Normalize (remove .., .)
            resolvedPath = path.normalize(resolvedPath);
          } else if (imp.path.startsWith('@/')) {
            // Handle @/ alias (common in Next.js projects)
            resolvedPath = imp.path.replace('@/', 'src/');
          }

          // Remove extension for matching
          resolvedPath = resolvedPath.replace(/\.(ts|tsx|js|jsx)$/, '');

          // Check if this file contains GraphQL operations
          const graphqlOps = filePathToGraphQL.get(resolvedPath);
          if (!graphqlOps) continue;

          for (const op of graphqlOps) {
            if (existingOps.has(op.opName)) continue;
            existingOps.add(op.opName);

            page.dataFetching.push({
              type: op.opType === 'mutation' ? 'useMutation' : 'useQuery',
              operationName: op.opName,
              source: `import:${imp.path}`,
            });
          }
        }
      }
    }

    // Step 6: Also enrich components with container type
    for (const comp of analysis.components) {
      if (comp.type !== 'container' && comp.type !== 'page') continue;

      // Find matching page to add dataFetching
      const matchingPage = analysis.pages.find(
        (p) => p.component === comp.name || p.filePath?.includes(comp.name)
      );
      if (!matchingPage) continue;

      // Get existing operation names from page
      const existingOps = new Set(
        matchingPage.dataFetching.map((df) => df.operationName?.replace(/^[→\->\s]+/, '') || '')
      );

      // Check hooks in this component
      for (const hookName of comp.hooks) {
        if (!hookName.startsWith('use')) continue;

        const graphqlOps = hookToGraphQL.get(hookName);
        if (!graphqlOps) continue;

        for (const opName of graphqlOps) {
          if (existingOps.has(opName)) continue;
          existingOps.add(opName);

          const opType = opTypeMap.get(opName) || 'query';
          matchingPage.dataFetching.push({
            type: opType === 'mutation' ? 'useMutation' : 'useQuery',
            operationName: opName,
            source: `component:${comp.name}`,
          });
        }
      }

      // Also check dependencies that are hooks
      for (const dep of comp.dependencies) {
        if (!dep.startsWith('use')) continue;

        const graphqlOps = hookToGraphQL.get(dep);
        if (!graphqlOps) continue;

        for (const opName of graphqlOps) {
          if (existingOps.has(opName)) continue;
          existingOps.add(opName);

          const opType = opTypeMap.get(opName) || 'query';
          matchingPage.dataFetching.push({
            type: opType === 'mutation' ? 'useMutation' : 'useQuery',
            operationName: opName,
            source: `component:${comp.name}`,
          });
        }
      }

      // Also check imported files for GraphQL operations
      if (comp.imports) {
        for (const imp of comp.imports) {
          const compDir = path.dirname(comp.filePath);
          let resolvedPath = imp.path;

          if (imp.path.startsWith('.')) {
            resolvedPath = path.normalize(path.join(compDir, imp.path));
          } else if (imp.path.startsWith('@/')) {
            resolvedPath = imp.path.replace('@/', 'src/');
          }

          resolvedPath = resolvedPath.replace(/\.(ts|tsx|js|jsx)$/, '');

          const graphqlOps = filePathToGraphQL.get(resolvedPath);
          if (!graphqlOps) continue;

          for (const op of graphqlOps) {
            if (existingOps.has(op.opName)) continue;
            existingOps.add(op.opName);

            matchingPage.dataFetching.push({
              type: op.opType === 'mutation' ? 'useMutation' : 'useQuery',
              operationName: op.opName,
              source: `component:${comp.name}`,
            });
          }
        }
      }
    }
  }

  /**
   * Write documentation to output directory
   */
  private async writeDocumentation(report: DocumentationReport): Promise<void> {
    const outputDir = this.config.outputDir;

    // Create output directory
    await fs.mkdir(outputDir, { recursive: true });

    // Generate markdown files
    const docs = this.markdownGenerator.generateDocumentation(report);

    for (const [filePath, content] of docs) {
      const fullPath = path.join(outputDir, filePath);
      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fullPath, content, 'utf-8');
    }

    // Write JSON report
    const jsonPath = path.join(outputDir, 'report.json');
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  }
}
