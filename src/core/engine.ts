import { simpleGit } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseSync } from '@swc/core';
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
import { TsModuleResolver } from '../utils/ts-module-resolver.js';
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

    // Enrich pages with GraphQL operations (evidence-based, import-graph aware)
    await this.enrichPagesWithHookGraphQL(analysis, repoConfig.path);

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
      coverage: {
        tsFilesScanned: 0,
        tsParseFailures: 0,
        graphqlParseFailures: 0,
        codegenFilesDetected: 0,
        codegenFilesParsed: 0,
        codegenExportsFound: 0,
      },
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
      if (result.coverage && merged.coverage) {
        merged.coverage.tsFilesScanned += result.coverage.tsFilesScanned || 0;
        merged.coverage.tsParseFailures += result.coverage.tsParseFailures || 0;
        merged.coverage.graphqlParseFailures += result.coverage.graphqlParseFailures || 0;
        merged.coverage.codegenFilesDetected += result.coverage.codegenFilesDetected || 0;
        merged.coverage.codegenFilesParsed += result.coverage.codegenFilesParsed || 0;
        merged.coverage.codegenExportsFound += result.coverage.codegenExportsFound || 0;
      }
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
   * Enrich pages with GraphQL operations using evidence-based linking.
   *
   * We avoid name/heuristic matching (unstable) and instead use:
   * - GraphQLOperation.usedIn: files where each operation is referenced
   * - Import graph (from DataFlowAnalyzer component.imports) starting at the page entry file
   *
   * This yields:
   * - Accuracy: only operations referenced in the page import closure
   * - Completeness: includes indirect usage via components/hooks
   * - Stability: independent of component naming conventions ("Page", etc.)
   */
  private async enrichPagesWithHookGraphQL(
    analysis: AnalysisResult,
    repoPath: string
  ): Promise<void> {
    type OpType = 'query' | 'mutation' | 'subscription';
    type RuntimeOp = (typeof analysis.graphqlOperations)[number] & { type: OpType };
    const ops = analysis.graphqlOperations.filter((op): op is RuntimeOp => {
      return op.type === 'query' || op.type === 'mutation' || op.type === 'subscription';
    });

    const extRe = /\.(ts|tsx|js|jsx)$/;
    const normalizeRel = (p: string) => path.normalize(p).replace(/\\/g, '/');

    // Build a file universe from repository scan (slow but robust).
    // This is required to resolve imports through non-component modules.
    const includePatterns = (this.config.analysis?.include || ['**/*.ts', '**/*.tsx']).map(String);
    const excludePatterns = (this.config.analysis?.exclude || []).map(String);

    // Use glob to list files.
    const { glob } = await import('glob');
    const allSourceFiles = await glob(includePatterns, {
      cwd: repoPath,
      ignore: [
        '**/node_modules/**',
        '**/.next/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        ...excludePatterns,
      ],
      nodir: true,
      dot: false,
    });

    const knownFiles = new Set<string>(allSourceFiles.map(normalizeRel));
    const normalizedToFile = new Map<string, string>(); // "path/without/ext" -> "path/with/ext"
    for (const f of knownFiles) {
      const normalized = f.replace(extRe, '');
      if (!normalizedToFile.has(normalized)) normalizedToFile.set(normalized, f);
    }

    // Use TypeScript Compiler API for accurate tsconfig paths/aliases resolution.
    const tsResolver = new TsModuleResolver(repoPath, knownFiles);

    // Infer alias bases for "@/..." imports from the repo structure.
    // Default is "src/", but many Rails+React repos use "frontend/src/" etc.
    const aliasBases = new Set<string>(['src/']);
    for (const f of knownFiles) {
      const idx = f.indexOf('/src/');
      if (idx !== -1) {
        aliasBases.add(f.slice(0, idx + 5)); // includes trailing "/src/"
      }
    }

    const resolveToKnownFile = (candidate: string): string | null => {
      const normalized = normalizeRel(candidate).replace(extRe, '');
      const exact = normalizedToFile.get(normalized);
      if (exact) return exact;
      const idx = normalizedToFile.get(normalized + '/index');
      if (idx) return idx;
      return null;
    };

    // Try to read tsconfig/jsconfig paths for accurate alias resolution.
    type TsPaths = Record<string, string[]>;
    const loadTsConfig = async (): Promise<{
      baseUrl?: string;
      paths?: TsPaths;
    }> => {
      const candidates = ['tsconfig.json', 'jsconfig.json'];
      for (const c of candidates) {
        try {
          const raw = await fs.readFile(path.join(repoPath, c), 'utf-8');
          const json = JSON.parse(raw);
          const co = json?.compilerOptions || {};
          const baseUrl = typeof co.baseUrl === 'string' ? co.baseUrl : undefined;
          const paths =
            typeof co.paths === 'object' && co.paths ? (co.paths as TsPaths) : undefined;
          return { baseUrl, paths };
        } catch {
          // ignore
        }
      }
      return {};
    };

    const { baseUrl, paths: tsPaths } = await loadTsConfig();

    const matchTsPath = (spec: string): string[] => {
      if (!tsPaths) return [];
      const out: string[] = [];
      for (const [k, targets] of Object.entries(tsPaths)) {
        if (!k.includes('*')) {
          if (spec === k) out.push(...targets);
          continue;
        }
        const [pre, post] = k.split('*');
        if (!spec.startsWith(pre) || !spec.endsWith(post)) continue;
        const mid = spec.slice(pre.length, spec.length - post.length);
        for (const t of targets) {
          if (!t.includes('*')) {
            out.push(t);
          } else {
            out.push(t.replace('*', mid));
          }
        }
      }
      return out;
    };

    const resolveImport = (fromFile: string, importPath: string): string | null => {
      if (!importPath) return null;

      // 0) Prefer TS compiler resolution (handles tsconfig `extends`, `paths`, workspace aliases, etc.)
      const tsResolved = tsResolver.resolve(fromFile, importPath);
      if (tsResolved) return tsResolved.file;

      // Relative imports
      if (importPath.startsWith('.')) {
        const fromDir = path.dirname(fromFile);
        return resolveToKnownFile(path.join(fromDir, importPath));
      }

      // Alias imports "@/..."
      if (importPath.startsWith('@/')) {
        const sub = importPath.replace('@/', '');
        // 1) tsconfig baseUrl
        if (baseUrl) {
          const resolved = resolveToKnownFile(path.join(baseUrl, sub));
          if (resolved) return resolved;
        }
        // 2) repo structure inferred bases
        for (const base of aliasBases) {
          const resolved = resolveToKnownFile(base + sub);
          if (resolved) return resolved;
        }
        return null;
      }

      // tsconfig paths
      const mapped = matchTsPath(importPath);
      if (mapped.length > 0) {
        for (const m of mapped) {
          const resolved = resolveToKnownFile(baseUrl ? path.join(baseUrl, m) : m);
          if (resolved) return resolved;
        }
      }

      // baseUrl absolute-like imports (e.g., "features/foo")
      if (baseUrl) {
        const resolved = resolveToKnownFile(path.join(baseUrl, importPath));
        if (resolved) return resolved;
      }

      // Ignore bare module imports
      return null;
    };

    // Lazy import extraction cache (AST-based; slower but accurate).
    const importCache = new Map<string, string[]>();
    const fileContentCache = new Map<string, string>();

    const readRelFile = async (rel: string): Promise<string | null> => {
      const key = normalizeRel(rel);
      const cached = fileContentCache.get(key);
      if (cached !== undefined) return cached;
      try {
        const abs = path.join(repoPath, key);
        const content = await fs.readFile(abs, 'utf-8');
        fileContentCache.set(key, content);
        return content;
      } catch {
        fileContentCache.set(key, '');
        return null;
      }
    };

    type ImportEdge = { spec: string; names: string[] | null; pos?: number };

    const extractImportsFromFile = async (rel: string): Promise<ImportEdge[]> => {
      const key = normalizeRel(rel);
      const cached = importCache.get(key);
      if (cached) return cached.map((spec) => ({ spec, names: null }));

      const content = await readRelFile(key);
      if (!content) {
        importCache.set(key, []);
        return [];
      }

      // Parse as TS/TSX by default (works for JS too in most cases)
      let ast: unknown;
      try {
        const isTs = key.endsWith('.ts') || key.endsWith('.tsx');
        const isTsx = key.endsWith('.tsx') || key.endsWith('.jsx');
        ast = parseSync(content, {
          syntax: isTs ? 'typescript' : 'ecmascript',
          tsx: isTsx,
          jsx: isTsx,
          comments: false,
        });
      } catch {
        importCache.set(key, []);
        return [];
      }

      const found = new Set<string>();
      const edges: ImportEdge[] = [];

      const pushSpec = (spec: unknown, names: string[] | null, pos?: number) => {
        if (typeof spec !== 'string' || spec.length === 0) return;
        found.add(spec);
        edges.push({ spec, names, pos });
      };

      // swc AST typing is large; keep traversal with minimal "unknown" narrowing.
      const walk = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        const n = node as Record<string, unknown>;

        // swc module items
        const nAny = n as Record<string, unknown> & {
          type?: string;
          typeOnly?: boolean;
          source?: { value?: string };
          callee?: { type?: string; value?: string };
          arguments?: Array<{ expression?: { type?: string; value?: string } }>;
          specifiers?: Array<Record<string, unknown>>;
        };

        if (nAny.type === 'ImportDeclaration') {
          // Skip type-only imports (they should not affect runtime reachability)
          if (nAny.typeOnly) {
            // no-op
          } else {
            const spec = nAny.source?.value;
            let names: string[] | null = [];
            const specs = nAny.specifiers || [];
            for (const s of specs) {
              const sAny = s as {
                type?: string;
                imported?: { value?: string };
                local?: { value?: string };
              };
              const st = sAny.type;
              if (st === 'ImportDefaultSpecifier' || st === 'ImportNamespaceSpecifier') {
                names = null;
                break;
              }
              if (st === 'ImportSpecifier') {
                const imported = sAny.imported?.value;
                const local = sAny.local?.value;
                const n = imported || local;
                if (n) (names as string[]).push(n);
              }
            }
            if (Array.isArray(names) && names.length === 0) names = null;
            pushSpec(spec, names, (nAny as unknown as { span?: { start?: number } }).span?.start);
          }
        } else if (nAny.type === 'ExportAllDeclaration') {
          // Re-export all (treated as unknown runtime dependency if we ever import this module as unknown)
          pushSpec(
            nAny.source?.value,
            null,
            (nAny as unknown as { span?: { start?: number } }).span?.start
          );
        } else if (nAny.type === 'ExportNamedDeclaration') {
          // Re-export named. Capture exported names when possible.
          const spec = nAny.source?.value;
          const specs = nAny.specifiers || [];
          const names: string[] = [];
          for (const s of specs) {
            const sAny = s as {
              type?: string;
              exported?: { value?: string };
              orig?: { value?: string };
            };
            const st = sAny.type;
            if (st === 'ExportSpecifier') {
              const exported = sAny.exported?.value;
              const orig = sAny.orig?.value;
              const n = exported || orig;
              if (n) names.push(n);
            }
          }
          pushSpec(
            spec,
            names.length > 0 ? names : null,
            (nAny as unknown as { span?: { start?: number } }).span?.start
          );
        } else if (nAny.type === 'CallExpression') {
          // require('x')
          const callee = nAny.callee || null;
          if (callee?.type === 'Identifier' && callee.value === 'require') {
            const a0 = nAny.arguments?.[0]?.expression;
            if (a0?.type === 'StringLiteral')
              pushSpec(
                a0.value,
                null,
                (nAny as unknown as { span?: { start?: number } }).span?.start
              );
          }
          // import('x')
          if (callee?.type === 'Import') {
            const a0 = nAny.arguments?.[0]?.expression;
            if (a0?.type === 'StringLiteral')
              pushSpec(
                a0.value,
                null,
                (nAny as unknown as { span?: { start?: number } }).span?.start
              );
          }
        }

        for (const k of Object.keys(n)) {
          const v = (n as Record<string, unknown>)[k];
          if (Array.isArray(v)) {
            for (const it of v) walk(it);
          } else if (v && typeof v === 'object') {
            walk(v);
          }
        }
      };

      walk(ast);

      const list = Array.from(found);
      importCache.set(key, list);
      return edges.filter((e) => typeof e.spec === 'string' && e.spec.length > 0);
    };

    const lineFromPos = (content: string, pos: number | undefined): number | undefined => {
      if (pos === undefined || pos < 0) return undefined;
      let line = 1;
      for (let i = 0; i < content.length && i < pos; i++) {
        if (content.charCodeAt(i) === 10) line++;
      }
      return line;
    };

    const lineFromIndex = (content: string, idx: number): number | undefined => {
      if (idx < 0) return undefined;
      let line = 1;
      for (let i = 0; i < content.length && i < idx; i++) {
        if (content.charCodeAt(i) === 10) line++;
      }
      return line;
    };

    // Export map cache for barrel resolution: module file -> exportName -> source spec, plus export * sources.
    const exportMapCache = new Map<
      string,
      { named: Map<string, string>; stars: string[]; isBarrel: boolean }
    >();

    const getExportInfo = async (
      rel: string
    ): Promise<{ named: Map<string, string>; stars: string[]; isBarrel: boolean }> => {
      const key = normalizeRel(rel);
      const cached = exportMapCache.get(key);
      if (cached) return cached;

      const content = await readRelFile(key);
      if (!content) {
        const empty = { named: new Map<string, string>(), stars: [], isBarrel: false };
        exportMapCache.set(key, empty);
        return empty;
      }

      let ast: unknown;
      try {
        const isTs = key.endsWith('.ts') || key.endsWith('.tsx');
        const isTsx = key.endsWith('.tsx') || key.endsWith('.jsx');
        ast = parseSync(content, {
          syntax: isTs ? 'typescript' : 'ecmascript',
          tsx: isTsx,
          jsx: isTsx,
          comments: false,
        });
      } catch {
        const empty = { named: new Map<string, string>(), stars: [], isBarrel: false };
        exportMapCache.set(key, empty);
        return empty;
      }

      const named = new Map<string, string>();
      const stars: string[] = [];
      let isBarrel = true;

      const body = (ast as { body?: unknown[] } | null)?.body;
      if (Array.isArray(body)) {
        for (const item of body) {
          const itemAny = item as {
            type?: string;
            source?: { value?: string };
            specifiers?: unknown[];
          };
          const t = itemAny.type;
          if (!t) continue;
          if (t === 'ImportDeclaration') continue;
          if (t === 'ExportAllDeclaration') {
            const spec = itemAny.source?.value;
            if (typeof spec === 'string') stars.push(spec);
            continue;
          }
          if (t === 'ExportNamedDeclaration') {
            const spec = itemAny.source?.value;
            const specs = itemAny.specifiers || [];
            if (typeof spec === 'string' && Array.isArray(specs)) {
              for (const s of specs) {
                const sAny = s as {
                  type?: string;
                  exported?: { value?: string };
                  orig?: { value?: string };
                };
                const st = sAny.type;
                if (st !== 'ExportSpecifier') continue;
                const exported = sAny.exported?.value;
                const orig = sAny.orig?.value;
                const name = exported || orig;
                if (name) named.set(name, spec);
              }
            }
            continue;
          }
          // Any other top-level item means it's not a pure barrel.
          isBarrel = false;
        }
      } else {
        isBarrel = false;
      }

      const info = { named, stars, isBarrel };
      exportMapCache.set(key, info);
      return info;
    };

    const resolveExportFromBarrel = async (
      barrelFile: string,
      exportName: string,
      seen: Set<string>
    ): Promise<string | null> => {
      const key = normalizeRel(barrelFile);
      if (seen.has(key)) return null;
      seen.add(key);

      const info = await getExportInfo(key);
      const directSpec = info.named.get(exportName);
      if (directSpec) {
        return resolveImport(key, directSpec);
      }

      // Search export * sources
      for (const star of info.stars) {
        const starFile = resolveImport(key, star);
        if (!starFile) continue;
        const found = await resolveExportFromBarrel(starFile, exportName, seen);
        if (found) return found;
      }

      return null;
    };

    // Build usage index: file -> operations referenced in that file.
    const fileToOps = new Map<
      string,
      { opName: string; opType: 'query' | 'mutation' | 'subscription' }[]
    >();
    for (const op of ops) {
      const files = new Set<string>();
      if (op.filePath) files.add(op.filePath);
      for (const u of op.usedIn || []) files.add(u);

      for (const f of files) {
        const arr = fileToOps.get(f) || [];
        arr.push({ opName: op.name, opType: op.type });
        fileToOps.set(f, arr);
      }
    }

    const findPageEntryFile = (pageFilePath: string): string | null => {
      if (!pageFilePath) return null;

      // First try canonical Next.js locations using exact relative paths.
      const canonicalCandidates = [
        `src/pages/${pageFilePath}`,
        `pages/${pageFilePath}`,
        `src/app/${pageFilePath}`,
        `app/${pageFilePath}`,
        `frontend/src/pages/${pageFilePath}`,
        `frontend/src/app/${pageFilePath}`,
        `app/javascript/pages/${pageFilePath}`,
        `app/javascript/app/${pageFilePath}`,
      ];
      for (const c of canonicalCandidates) {
        if (knownFiles.has(c)) return c;
        const resolved = resolveToKnownFile(c);
        if (resolved) return resolved;
      }

      // Fallback: Prefer matches under "/pages/" or "/app/" to avoid over-matching.
      const candidates: string[] = [];
      const suffixes = [`/pages/${pageFilePath}`, `/app/${pageFilePath}`, `/${pageFilePath}`];

      for (const f of knownFiles) {
        for (const s of suffixes) {
          if (!f.endsWith(s)) continue;
          if (s.startsWith('/pages/') && !f.includes('/pages/')) continue;
          if (s.startsWith('/app/') && !f.includes('/app/')) continue;
          candidates.push(f);
          break;
        }
      }

      if (candidates.length === 0) return null;
      // Choose the most specific path (shortest prefix / shortest overall length)
      candidates.sort((a, b) => a.length - b.length);
      return candidates[0];
    };

    // (closure builder is implemented inline per-page to keep it async)

    // 1) Collect per-page closest references (distance) and aggregate stats to identify "common" ops.
    const perPageBest = new Map<
      string,
      {
        page: AnalysisResult['pages'][number];
        entryFile: string;
        parent: Map<string, { from: string; spec: string; line?: number; detail?: string }>;
        bestByOp: Map<
          string,
          {
            opName: string;
            opType: 'query' | 'mutation' | 'subscription';
            sourceFile: string;
            distance: number;
          }
        >;
      }
    >();

    // File reachability: how many distinct page entries can reach each file (via import graph).
    // This is the most stable "common/shared" signal across different repo structures.
    const fileReachCount = new Map<string, number>();

    for (const page of analysis.pages) {
      const entryFile = findPageEntryFile(page.filePath);
      if (!entryFile) continue;

      const bestByOp = new Map<
        string,
        {
          opName: string;
          opType: 'query' | 'mutation' | 'subscription';
          sourceFile: string;
          distance: number;
        }
      >();

      const visited = new Set<string>();
      const queue: { f: string; depth: number }[] = [{ f: entryFile, depth: 0 }];
      const parent = new Map<
        string,
        { from: string; spec: string; line?: number; detail?: string }
      >();
      const maxDepth = 30;
      const maxNodes = 20000;

      while (queue.length > 0) {
        const cur = queue.shift();
        if (!cur) break;
        if (visited.has(cur.f)) continue;
        visited.add(cur.f);
        if (visited.size >= maxNodes) break;

        const opsInFile = fileToOps.get(cur.f);
        if (opsInFile) {
          for (const o of opsInFile) {
            const prev = bestByOp.get(o.opName);
            if (!prev || cur.depth < prev.distance) {
              bestByOp.set(o.opName, {
                opName: o.opName,
                opType: o.opType,
                sourceFile: cur.f,
                distance: cur.depth,
              });
            }
          }
        }

        if (cur.depth >= maxDepth) continue;

        const importEdges = await extractImportsFromFile(cur.f);
        for (const e of importEdges) {
          const to = resolveImport(cur.f, e.spec);
          if (!to) continue;
          if (!visited.has(to)) {
            queue.push({ f: to, depth: cur.depth + 1 });
            if (!parent.has(to)) {
              const c = await readRelFile(cur.f);
              const l = c ? lineFromPos(c, e.pos) : undefined;
              const detail =
                Array.isArray(e.names) && e.names.length > 0
                  ? `names:${e.names.join(',')}`
                  : undefined;
              parent.set(to, { from: cur.f, spec: e.spec, line: l, detail });
            }
          }

          // If importing named exports from a barrel, resolve only those exports instead of expanding the whole barrel.
          if (Array.isArray(e.names) && e.names.length > 0) {
            const expInfo = await getExportInfo(to);
            if (expInfo.isBarrel) {
              for (const n of e.names) {
                const resolved = await resolveExportFromBarrel(to, n, new Set<string>());
                if (resolved && !visited.has(resolved)) {
                  queue.push({ f: resolved, depth: cur.depth + 2 });
                  if (!parent.has(resolved)) {
                    parent.set(resolved, {
                      from: to,
                      spec: `re-export:${n}`,
                      line: undefined,
                      detail: 'barrel',
                    });
                  }
                }
              }
            }
          } else if (e.names === null) {
            // Unknown import shape: conservatively include barrel re-export dependencies.
            const expInfo = await getExportInfo(to);
            if (expInfo.isBarrel) {
              for (const spec of expInfo.stars) {
                const rf = resolveImport(to, spec);
                if (rf && !visited.has(rf)) queue.push({ f: rf, depth: cur.depth + 2 });
              }
              for (const spec of expInfo.named.values()) {
                const rf = resolveImport(to, spec);
                if (rf && !visited.has(rf)) queue.push({ f: rf, depth: cur.depth + 2 });
              }
            }
          }
        }
      }

      perPageBest.set(page.path, { page, entryFile, parent, bestByOp });

      // Update reachability counts once per page.
      for (const f of visited) {
        fileReachCount.set(f, (fileReachCount.get(f) || 0) + 1);
      }
    }

    const totalPages = perPageBest.size;
    // Derive an adaptive "common file" threshold from the distribution of reach counts.
    // Use p90 so we only call "common" the files reached by many pages.
    const reachCounts = Array.from(fileReachCount.values()).sort((a, b) => a - b);
    const percentile = (arr: number[], p: number): number => {
      if (arr.length === 0) return 0;
      const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)));
      return arr[idx];
    };
    const p90 = percentile(reachCounts, 0.9);
    const commonFileThreshold = Math.max(10, p90);
    const localFileThreshold = Math.max(2, Math.floor(totalPages * 0.05)); // feature-local-ish

    // 2) Apply enrichment with priority/grouping:
    // - Direct: distance 0 (entry file)
    // - Close: distance 1-2 (page/component-adjacent)
    // - Indirect: distance >= 3
    // - Common: common ops (distance > 0) collapsed in UI
    for (const { page, entryFile, parent, bestByOp } of perPageBest.values()) {
      const existingOps = new Set(
        (page.dataFetching || []).map((df) => df.operationName?.replace(/^[→\->\s]+/, '') || '')
      );

      for (const { opName, opType, sourceFile, distance } of bestByOp.values()) {
        if (existingOps.has(opName)) continue;
        existingOps.add(opName);

        const reach = fileReachCount.get(sourceFile) || 0;

        let source: string | undefined;
        if (distance === 0) {
          source = undefined;
        } else if (reach >= commonFileThreshold) {
          // Reached by many pages => common/shared (objective, repo-agnostic signal)
          source = `common:${sourceFile}`;
        } else if (distance <= 2 || reach <= localFileThreshold) {
          // Close either by import distance or by low reachability (feature-local)
          source = `close:${sourceFile}`;
        } else {
          source = `indirect:${sourceFile}`;
        }

        const confidence: 'certain' | 'likely' | 'unknown' =
          distance === 0 || distance <= 2
            ? 'certain'
            : source?.startsWith('common:')
              ? 'unknown'
              : 'likely';

        // Evidence: operation reference + (best-effort) import edges.
        const evidence: Array<{
          kind: 'import-edge' | 'operation-reference';
          file: string;
          line?: number;
          detail?: string;
        }> = [];

        // 0) Import path chain (entry -> ... -> sourceFile)
        if (distance > 0 && sourceFile !== entryFile) {
          const chain: Array<{
            from: string;
            to: string;
            spec: string;
            line?: number;
            detail?: string;
          }> = [];
          let cur = sourceFile;
          const seen = new Set<string>();
          while (cur !== entryFile) {
            if (seen.has(cur)) break;
            seen.add(cur);
            const p = parent.get(cur);
            if (!p) break;
            chain.push({ from: p.from, to: cur, spec: p.spec, line: p.line, detail: p.detail });
            cur = p.from;
          }
          chain.reverse();
          for (const c of chain) {
            evidence.push({
              kind: 'import-edge',
              file: c.from,
              line: c.line,
              detail: `${c.spec} -> ${c.to}${c.detail ? ` (${c.detail})` : ''}`,
            });
          }
        }

        // 1) Operation reference in the source file (best-effort line)
        const srcContent = await readRelFile(sourceFile);
        if (srcContent) {
          const idx =
            srcContent.indexOf(`${opName}Document`) >= 0
              ? srcContent.indexOf(`${opName}Document`)
              : srcContent.indexOf(opName);
          const line = idx >= 0 ? lineFromIndex(srcContent, idx) : undefined;
          evidence.push({
            kind: 'operation-reference',
            file: sourceFile,
            line,
            detail: `ref:${opName}`,
          });
        } else {
          evidence.push({ kind: 'operation-reference', file: sourceFile, detail: `ref:${opName}` });
        }

        page.dataFetching.push({
          type:
            opType === 'mutation'
              ? 'useMutation'
              : opType === 'subscription'
                ? 'useSubscription'
                : 'useQuery',
          operationName: opName,
          source,
          confidence,
          evidence: evidence.length > 0 ? evidence : undefined,
        });
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
