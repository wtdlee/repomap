import { simpleGit } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import fg from 'fast-glob';
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
import { AnalysisCache } from './cache.js';

/**
 * Main documentation generation engine
 * メインドキュメント生成エンジン
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
    console.log('🚀 Starting documentation generation...\n');

    const repositoryReports: RepositoryReport[] = [];

    for (const repoConfig of this.config.repositories) {
      try {
        console.log(`\n📦 Analyzing ${repoConfig.displayName}...`);
        const report = await this.analyzeRepository(repoConfig);
        repositoryReports.push(report);
        console.log(`✅ Completed ${repoConfig.displayName}`);
      } catch (error) {
        console.error(`❌ Failed to analyze ${repoConfig.name}:`, (error as Error).message);
      }
    }

    // Cross-repository analysis
    console.log('\n🔗 Running cross-repository analysis...');
    const crossRepoAnalysis = this.analyzeCrossRepo(repositoryReports);

    // Generate diagrams
    console.log('\n📊 Generating diagrams...');
    const results = repositoryReports.map((r) => r.analysis);
    const crossRepoLinks = this.extractCrossRepoLinks(results);
    const diagrams = this.mermaidGenerator.generateAll(results, crossRepoLinks);

    const report: DocumentationReport = {
      generatedAt: new Date().toISOString(),
      repositories: repositoryReports,
      crossRepoAnalysis,
      diagrams,
    };

    // Write documentation
    console.log('\n📝 Writing documentation...');
    await this.writeDocumentation(report);

    console.log('\n✨ Documentation generation complete!');
    console.log(`📁 Output: ${this.config.outputDir}`);

    return report;
  }

  /**
   * Analyze a single repository (with caching)
   */
  private async analyzeRepository(repoConfig: RepositoryConfig): Promise<RepositoryReport> {
    // Initialize cache
    const cache = new AnalysisCache(repoConfig.path);
    await cache.init();

    // Get repository info
    const { version, commitHash } = await this.getRepoInfo(repoConfig);

    // Compute content hash for cache key
    const sourceFiles = await fg(['**/*.{ts,tsx,graphql}'], {
      cwd: repoConfig.path,
      ignore: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**'],
      absolute: true,
    });
    const contentHash = await cache.computeFilesHash(sourceFiles);
    const cacheKey = `analysis_${repoConfig.name}_${commitHash}`;

    // Check cache
    const cachedResult = cache.get<AnalysisResult>(cacheKey, contentHash);
    if (cachedResult) {
      console.log(`  ⚡ Using cached analysis (${cache.getStats().entries} entries)`);

      const summary = {
        totalPages: cachedResult.pages.length,
        totalComponents: cachedResult.components.length,
        totalGraphQLOperations: cachedResult.graphqlOperations.length,
        totalDataFlows: cachedResult.dataFlows.length,
        authRequiredPages: cachedResult.pages.filter((p) => p.authentication.required).length,
        publicPages: cachedResult.pages.filter((p) => !p.authentication.required).length,
      };

      return {
        name: repoConfig.name,
        displayName: repoConfig.displayName,
        version,
        commitHash,
        analysis: cachedResult,
        summary,
      };
    }

    // Run analyzers in PARALLEL for faster analysis
    const analyzers = repoConfig.analyzers
      .map((analyzerType) => this.createAnalyzer(analyzerType, repoConfig))
      .filter((a): a is NonNullable<typeof a> => a !== null);

    console.log(`  Running ${analyzers.length} analyzers in parallel...`);
    const startTime = Date.now();

    const analysisResults = await Promise.all(analyzers.map((analyzer) => analyzer.analyze()));

    console.log(`  Analysis completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    // Merge results
    const analysis = this.mergeAnalysisResults(
      analysisResults,
      repoConfig.name,
      version,
      commitHash
    );

    // Save to cache
    cache.set(cacheKey, contentHash, analysis);
    await cache.save();
    console.log(`  💾 Analysis cached for future runs`);

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
        if (config.type === 'nextjs') {
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
      console.log(`  📄 ${filePath}`);
    }

    // Write JSON report
    const jsonPath = path.join(outputDir, 'report.json');
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`  📋 report.json`);
  }
}
