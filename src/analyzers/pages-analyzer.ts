import {
  parseSync,
  Module,
  ImportDeclaration,
  ExportDeclaration,
  CallExpression,
  Expression,
} from '@swc/core';
import fg from 'fast-glob';
import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { BaseAnalyzer } from './base-analyzer.js';
import { parallelMapSafe } from '../utils/parallel.js';
import { parseCodegenDocumentExports } from './codegen-ts-ast.js';
import { TsModuleResolver } from '../utils/ts-module-resolver.js';
import {
  ALL_GRAPHQL_HOOKS,
  isQueryHook,
  isMutationHook,
  getHookType,
  extractGraphQLContext,
  resolveOperationName,
  hasGraphQLArgument,
  getCalleeName,
  traverseAst,
  isGraphQLHook,
  cleanOperationName,
  type GraphQLFileContext,
} from './graphql-utils.js';
import type {
  AnalysisResult,
  PageInfo,
  AuthRequirement,
  DataFetchingInfo,
  NavigationInfo,
  RepositoryConfig,
  StepInfo,
} from '../types.js';

/**
 * Analyzer for Next.js/React pages using @swc/core for fast parsing
 */
export class PagesAnalyzer extends BaseAnalyzer {
  // Codegen Document → Operation name mapping
  private codegenMap = new Map<string, { operationName: string; operationType: string }>();
  private tsResolver: TsModuleResolver | null = null;
  private coverage = {
    tsFilesScanned: 0,
    tsParseFailures: 0,
    graphqlParseFailures: 0,
    codegenFilesDetected: 0,
    codegenFilesParsed: 0,
    codegenExportsFound: 0,
  };

  constructor(config: RepositoryConfig) {
    super(config);
  }

  getName(): string {
    return 'PagesAnalyzer';
  }

  async analyze(): Promise<Partial<AnalysisResult>> {
    this.log('Starting page analysis...');

    // Load codegen mapping if available
    await this.loadCodegenMapping();

    // Find page files from multiple possible locations
    const pageFiles = await this.findPageFiles();
    this.coverage.tsFilesScanned += pageFiles.length;

    this.log(`Found ${pageFiles.length} page files`);

    // Read all files in parallel batches for better I/O performance
    const batchSize = 50;
    const fileContents = new Map<string, string>();

    for (let i = 0; i < pageFiles.length; i += batchSize) {
      const batch = pageFiles.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (filePath) => {
          try {
            const content = await fsPromises.readFile(filePath, 'utf-8');
            return { filePath, content };
          } catch {
            return null;
          }
        })
      );

      for (const result of results) {
        if (result) {
          fileContents.set(result.filePath, result.content);
        }
      }
    }

    // Analyze pages in parallel
    const pages = await parallelMapSafe(
      pageFiles,
      async (filePath) => {
        const content = fileContents.get(filePath);
        if (!content) return null;

        const pagesPath = this.detectPagesRoot(filePath);
        return this.analyzePageFile(filePath, content, pagesPath);
      },
      8
    );

    // Filter out null results
    const validPages = pages.filter((p): p is PageInfo => p !== null);

    this.log(`Analyzed ${validPages.length} pages successfully`);

    return { pages: validPages, coverage: this.coverage };
  }

  /**
   * Load GraphQL Code Generator mapping from __generated__ files
   * Dynamically searches for codegen output files
   */
  private async loadCodegenMapping(): Promise<void> {
    // Dynamically find all potential codegen files
    const generatedFiles = await fg(
      [
        '**/__generated__/graphql.ts',
        '**/__generated__/gql.ts',
        '**/generated/graphql.ts',
        '**/generated/gql.ts',
        '**/*.generated.ts',
        '**/graphql.ts', // Root level graphql files
      ],
      {
        cwd: this.basePath,
        ignore: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**'],
        absolute: true,
      }
    );

    for (const fullPath of generatedFiles) {
      try {
        const content = await fsPromises.readFile(fullPath, 'utf-8');
        const relPath = path.relative(this.basePath, fullPath);

        // Fast pre-filter: most codegen outputs contain "Document" + "definitions"
        if (!content.includes('Document') || !content.includes('definitions')) continue;

        this.coverage.codegenFilesDetected += 1;
        const exports = parseCodegenDocumentExports(content, relPath);
        this.coverage.codegenFilesParsed += 1;
        this.coverage.codegenExportsFound += exports.length;
        for (const e of exports) {
          this.codegenMap.set(e.documentName, {
            operationName: e.operationName,
            operationType: e.operationType,
          });
        }

        if (exports.length > 0) {
          this.log(`Loaded ${exports.length} codegen mappings from ${relPath}`);
        }
      } catch {
        // Skip if can't read
      }
    }
  }

  /**
   * Analyze a single page file using SWC
   */
  private analyzePageFile(filePath: string, content: string, pagesPath: string): PageInfo | null {
    try {
      const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
      const ast = parseSync(content, {
        syntax: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'ecmascript',
        tsx: isTsx,
        jsx: isTsx,
        comments: false,
      });

      const relativePath = path.relative(pagesPath, filePath);
      const routePath = this.filePathToRoutePath(relativePath);

      // Extract page component
      const pageComponent = this.findPageComponent(ast, content);
      if (!pageComponent) {
        return null;
      }

      // Extract various page information
      const params = this.extractRouteParams(routePath);
      const imports = this.extractImports(ast);
      const layout = this.extractLayout(ast, content);
      const authentication = this.extractAuthRequirement(ast, content, filePath);
      const permissions = this.extractPermissions(content);
      const dataFetching = this.extractDataFetching(ast, content, imports);
      const linkedPages = this.extractLinkedPages(ast, content);
      const navigation = this.extractNavigation(content);
      const steps = this.extractSteps(content);

      return {
        path: routePath,
        filePath: relativePath,
        component: pageComponent,
        params,
        layout,
        authentication,
        permissions,
        dataFetching,
        navigation,
        linkedPages,
        steps: steps.length > 0 ? steps : undefined,
      };
    } catch {
      this.coverage.tsParseFailures += 1;
      return null;
    }
  }

  /**
   * Find page files from multiple possible locations
   */
  private async findPageFiles(): Promise<string[]> {
    const pagesDir = this.getSetting('pagesDir', 'src/pages');
    const allFiles: string[] = [];

    // 1. Check Next.js standard directories
    const nextjsDirsSet = new Set([pagesDir, 'pages', 'src/pages', 'app', 'src/app']);
    const nextjsDirs = [...nextjsDirsSet];

    for (const dir of nextjsDirs) {
      // Skip Rails 'app' directory
      if (dir === 'app' || dir === 'src/app') {
        const railsIndicators = ['controllers', 'models', 'views', 'helpers'];
        const dirPath = this.resolvePath(dir);
        const hasRailsStructure = railsIndicators.some((subdir) => {
          try {
            return fs.existsSync(path.join(dirPath, subdir));
          } catch {
            return false;
          }
        });
        if (hasRailsStructure) {
          continue;
        }
      }

      const dirPath = this.resolvePath(dir);
      try {
        const isAppRouterDir = dir === 'app' || dir === 'src/app' || dir.endsWith('/app');
        const patterns = isAppRouterDir
          ? ['**/page.{tsx,ts,jsx,js}'] // Next.js App Router pages only
          : ['**/*.tsx', '**/*.ts', '**/*.jsx', '**/*.js']; // Next.js Pages Router / generic

        const files = await fg(patterns, {
          cwd: dirPath,
          ignore: [
            '_app.tsx',
            '_app.ts',
            '_app.jsx',
            '_app.js',
            '_document.tsx',
            '_document.ts',
            '_error.tsx',
            'api/**',
            '**/*.test.*',
            '**/*.spec.*',
            '**/node_modules/**',
            '**/components/pages/**',
          ],
          absolute: true,
        });
        allFiles.push(...files);
        if (files.length > 0) {
          this.log(`Found ${files.length} pages in ${dir}`);
        }
      } catch {
        // Directory doesn't exist
      }
    }

    // 2. Check Rails + React structures
    const railsReactDirs = ['frontend/src/**/pages', 'app/javascript/**/pages'];

    for (const pattern of railsReactDirs) {
      try {
        const files = await fg(
          [
            `${pattern}/**/*.tsx`,
            `${pattern}/**/*.ts`,
            `${pattern}/**/*.jsx`,
            `${pattern}/**/*.js`,
          ],
          {
            cwd: this.basePath,
            ignore: ['**/*.test.*', '**/*.spec.*', '**/node_modules/**', '**/components/pages/**'],
            absolute: true,
          }
        );
        allFiles.push(...files);
      } catch {
        // Pattern doesn't match
      }
    }

    // 3. Fallback: SPA with react-router-dom
    if (allFiles.length === 0) {
      const spaRoutes = await this.findSPARoutes();
      if (spaRoutes.length > 0) {
        this.log(`Found ${spaRoutes.length} SPA routes from App.tsx`);
        allFiles.push(...spaRoutes);
      }
    }

    return [...new Set(allFiles)];
  }

  /**
   * Find routes from SPA (react-router-dom) based projects
   */
  private async findSPARoutes(): Promise<string[]> {
    const routeFiles: string[] = [];
    // Prepare TS resolver once for alias imports (best-effort).
    if (!this.tsResolver) {
      try {
        const known = await fg(['**/*.{ts,tsx,js,jsx}'], {
          cwd: this.basePath,
          ignore: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**'],
          absolute: false,
          onlyFiles: true,
          unique: true,
          dot: false,
        });
        this.tsResolver = new TsModuleResolver(
          this.basePath,
          new Set(known.map((f) => f.replace(/\\/g, '/')))
        );
      } catch {
        this.tsResolver = null;
      }
    }
    const appPatterns = [
      'src/App.tsx',
      'src/App.jsx',
      'src/App.js',
      'App.tsx',
      'App.jsx',
      'App.js',
    ];

    for (const pattern of appPatterns) {
      const appPath = this.resolvePath(pattern);
      if (!fs.existsSync(appPath)) continue;

      try {
        const content = await fsPromises.readFile(appPath, 'utf-8');

        if (!content.includes('react-router') && !content.includes('Route')) {
          continue;
        }

        // Parse and extract imports
        const ast = parseSync(content, {
          syntax: 'typescript',
          tsx: true,
        });

        const importMap = this.extractImports(ast);

        // Find Route component usage in JSX
        this.traverseNode(ast, (node) => {
          if (node.type === 'JSXOpeningElement') {
            const tagName = this.getJsxTagName(node);
            if (tagName === 'Route' || tagName === 'PrivateRoute') {
              // Extract component prop
              const componentProp = this.getJsxAttribute(node, 'component');
              const elementProp = this.getJsxAttribute(node, 'element');

              const componentName = componentProp || elementProp;
              const importPath = componentName ? importMap.get(componentName) : undefined;
              if (importPath) {
                const resolvedPath = this.resolveImportPath(appPath, importPath);
                if (resolvedPath && fs.existsSync(resolvedPath)) {
                  routeFiles.push(resolvedPath);
                }
              }
            }
          }
        });

        if (routeFiles.length > 0) {
          routeFiles.push(appPath);
        }
      } catch {
        // Failed to parse App file
      }
    }

    return routeFiles;
  }

  /**
   * Resolve import path to absolute file path
   */
  private resolveImportPath(fromFileAbs: string, importPath: string): string | null {
    // Relative first
    if (!importPath.startsWith('.')) {
      // Try TS module resolution for aliases (tsconfig paths, workspace aliases, ~/#, etc.)
      const relFrom = path.relative(this.basePath, fromFileAbs).replace(/\\/g, '/');
      if (this.tsResolver) {
        const resolved = this.tsResolver.resolve(relFrom, importPath);
        if (resolved) {
          return path.join(this.basePath, resolved.file);
        }
      }
      return null;
    }

    const extensions = [
      '.tsx',
      '.ts',
      '.jsx',
      '.js',
      '/index.tsx',
      '/index.ts',
      '/index.jsx',
      '/index.js',
    ];
    const baseDir = path.dirname(fromFileAbs);
    const basePath = path.resolve(baseDir, importPath);

    for (const ext of extensions) {
      const fullPath = basePath + ext;
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }

    // Check if it's a directory with index file
    if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
      for (const ext of ['/index.tsx', '/index.ts', '/index.jsx', '/index.js']) {
        const indexPath = basePath + ext;
        if (fs.existsSync(indexPath)) {
          return indexPath;
        }
      }
    }

    return null;
  }

  /**
   * Detect the pages root directory from a file path
   */
  private detectPagesRoot(filePath: string): string {
    const pagesPatterns = [
      '/src/pages/',
      '/pages/',
      '/src/app/',
      '/app/',
      '/frontend/src/pages/',
      '/app/javascript/pages/',
    ];

    for (const pattern of pagesPatterns) {
      const idx = filePath.indexOf(pattern);
      if (idx !== -1) {
        return filePath.substring(0, idx + pattern.length - 1);
      }
    }

    return this.basePath;
  }

  private filePathToRoutePath(filePath: string): string {
    // Normalize and strip extension
    let p = filePath.replace(/\\/g, '/').replace(/\.(tsx?|jsx?)$/, '');

    // Next.js App Router: ".../page" or "page" (root) maps to directory route
    p = p.replace(/\/page$/, '').replace(/^page$/, '');
    // (Optional) route handlers are not pages, but avoid accidental mapping if ever included
    p = p.replace(/\/route$/, '').replace(/^route$/, '');

    // Remove route groups: "(group)" segments
    const segments = p
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        // Strip intercepting route prefixes like "(.)", "(..)", "(...)" if present
        const stripped = seg.replace(/^\(\.\.\.\)|^\(\.\.\)|^\(\.\)/, '');
        return stripped;
      });

    const filtered = segments.filter((seg) => {
      if (seg.startsWith('(') && seg.endsWith(')')) return false; // route group
      if (seg.startsWith('@')) return false; // parallel routes slot
      return true;
    });

    const normalized = filtered.join('/').replace(/\/index$/, '');

    return (
      '/' +
      normalized
        .replace(/\[\[\.\.\.(\w+)\]\]/g, '*')
        .replace(/\[\.\.\.(\w+)\]/g, '*')
        .replace(/\[(\w+)\]/g, ':$1')
    );
  }

  private extractRouteParams(routePath: string): string[] {
    const params: string[] = [];
    const paramMatch = routePath.match(/:(\w+)/g);
    if (paramMatch) {
      for (const p of paramMatch) {
        params.push(p.slice(1));
      }
    }
    return params;
  }

  /**
   * Find the name of the default export (function/class declaration)
   * Returns null if the default export is anonymous or an expression
   */
  private findDefaultExportName(ast: Module): string | null {
    for (const item of ast.body) {
      if (item.type === 'ExportDefaultDeclaration') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const decl = item.decl as any;
        // Named function (declaration or expression)
        if (
          (decl?.type === 'FunctionExpression' || decl?.type === 'FunctionDeclaration') &&
          decl.identifier?.value
        ) {
          return decl.identifier.value;
        }
        // Class component
        if (
          (decl?.type === 'ClassDeclaration' || decl?.type === 'ClassExpression') &&
          decl.identifier?.value
        ) {
          return decl.identifier.value;
        }
        // Identifier reference: export default ComponentName
        if (decl?.type === 'Identifier') {
          return decl.value;
        }
      }
      // export default ComponentName (expression form)
      if (item.type === 'ExportDefaultExpression') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const expr = (item as any).expression;
        if (expr?.type === 'Identifier') {
          return expr.value;
        }
      }
    }
    return null;
  }

  /**
   * Find page component name from AST
   */
  private findPageComponent(ast: Module, content: string): string | null {
    // First, look for named default export function (most accurate for page components)
    const defaultExportName = this.findDefaultExportName(ast);
    if (defaultExportName && defaultExportName !== 'Page' && defaultExportName !== 'default') {
      return defaultExportName;
    }

    // Fallback: try to find the main component used in JSX
    const jsxComponent = this.findMainJsxComponent(ast, content);
    if (jsxComponent && jsxComponent !== 'Page' && jsxComponent !== 'default') {
      return jsxComponent;
    }

    // Look for default export
    for (const item of ast.body) {
      // export default function ComponentName() {}
      // export default async function ComponentName() {}
      // export default class ComponentName {}
      if (item.type === 'ExportDefaultDeclaration') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const decl = item.decl as any;
        // Named function (declaration or expression)
        if (
          (decl?.type === 'FunctionExpression' || decl?.type === 'FunctionDeclaration') &&
          decl.identifier?.value
        ) {
          const name = decl.identifier.value;
          // If it's a generic name, try to find JSX component instead
          if (name !== 'Page') return name;
        }
        // Class component (legacy React)
        if (
          (decl?.type === 'ClassDeclaration' || decl?.type === 'ClassExpression') &&
          decl.identifier?.value
        ) {
          const name = decl.identifier.value;
          if (name !== 'Page') return name;
        }
        if (decl?.type === 'Identifier') {
          const name = decl.value;
          if (name !== 'Page') return name;
        }
        // Arrow function or anonymous - use JSX component if found
        if (decl?.type === 'ArrowFunctionExpression') {
          if (jsxComponent) return jsxComponent;
          return 'default';
        }
        // Anonymous function without identifier - use JSX component if found
        if (
          (decl?.type === 'FunctionExpression' || decl?.type === 'FunctionDeclaration') &&
          !decl.identifier
        ) {
          if (jsxComponent) return jsxComponent;
          return 'default';
        }
      }

      // export default ComponentName
      if (item.type === 'ExportDefaultExpression') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const expr = (item as any).expression;
        if (expr?.type === 'Identifier') {
          const name = expr.value;
          if (name !== 'Page') return name;
        }
      }
    }

    // If we found a JSX component, use it
    if (jsxComponent) {
      return jsxComponent;
    }

    // Look for Page variable (last resort)
    for (const item of ast.body) {
      if (item.type === 'VariableDeclaration') {
        for (const d of item.declarations) {
          if (d.id?.type === 'Identifier' && d.id.value === 'Page') {
            return 'Page';
          }
        }
      }
    }

    // Look for exported function declarations
    for (const item of ast.body) {
      if (item.type === 'ExportDeclaration' && item.declaration?.type === 'FunctionDeclaration') {
        const name = item.declaration.identifier?.value;
        if (name && /^[A-Z]/.test(name)) {
          return name;
        }
      }
    }

    // Fallback: find any PascalCase function/const
    for (const item of ast.body) {
      if (item.type === 'FunctionDeclaration') {
        const name = item.identifier?.value;
        if (name && /^[A-Z]/.test(name)) {
          return name;
        }
      }
      if (item.type === 'VariableDeclaration') {
        for (const d of item.declarations) {
          if (d.id?.type === 'Identifier') {
            const name = d.id.value;
            if (
              name &&
              /^[A-Z]/.test(name) &&
              content.includes('return') &&
              content.includes('<')
            ) {
              return name;
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Find the main component used in the page's JSX
   * This is more accurate than using the default export name like "Page"
   */
  private findMainJsxComponent(ast: Module, content: string): string | null {
    const imports = this.extractImports(ast);
    const importedComponents = new Set<string>();

    // Common directory patterns for UI components across different project structures
    const componentPathPatterns = [
      'features',
      'components',
      'containers',
      'views',
      'screens',
      'pages',
      'layouts',
      'ui',
      'modules',
      'widgets',
      'shared',
    ];

    // Collect imported components (PascalCase from component directories)
    for (const [name, source] of imports) {
      if (
        /^[A-Z]/.test(name) &&
        componentPathPatterns.some((pattern) => source.includes(pattern))
      ) {
        importedComponents.add(name);
      }
    }

    // Find JSX elements that match imported components
    const jsxMatches: Array<{ name: string; index: number }> = [];

    for (const compName of importedComponents) {
      // Match <ComponentName or <ComponentName> patterns
      const regex = new RegExp(`<${compName}[\\s/>]`, 'g');
      let match;
      while ((match = regex.exec(content)) !== null) {
        jsxMatches.push({ name: compName, index: match.index });
      }
    }

    // Prefer Container/Page components
    const containerMatch = jsxMatches.find(
      (m) =>
        m.name.includes('Container') ||
        m.name.includes('Page') ||
        m.name.includes('View') ||
        m.name.includes('Screen')
    );
    if (containerMatch) {
      return containerMatch.name;
    }

    // Otherwise return the first match (likely the main component)
    if (jsxMatches.length > 0) {
      // Sort by position in file (earlier = likely more important)
      jsxMatches.sort((a, b) => a.index - b.index);
      return jsxMatches[0].name;
    }

    return null;
  }

  /**
   * Extract imports from AST
   */
  private extractImports(ast: Module): Map<string, string> {
    const imports = new Map<string, string>();

    for (const item of ast.body) {
      if (item.type === 'ImportDeclaration') {
        const source = (item as ImportDeclaration).source?.value || '';
        for (const spec of item.specifiers || []) {
          if (spec.type === 'ImportSpecifier' && spec.local?.value) {
            imports.set(spec.local.value, source);
          }
          if (spec.type === 'ImportDefaultSpecifier' && spec.local?.value) {
            imports.set(spec.local.value, source);
          }
        }
      }
    }

    return imports;
  }

  /**
   * Extract layout from page
   */
  private extractLayout(ast: Module, content: string): string | undefined {
    // Look for getLayout pattern
    if (content.includes('getLayout')) {
      // Try to find layout component name from JSX
      const layoutMatch = content.match(/getLayout\s*=.*?<(\w+Layout|\w+Shell)/);
      if (layoutMatch) {
        return layoutMatch[1];
      }
    }
    return undefined;
  }

  /**
   * Extract authentication requirements
   */
  private extractAuthRequirement(ast: Module, content: string, filePath: string): AuthRequirement {
    const fileName = path.basename(filePath);

    // Public pages that don't require auth
    const publicPages = [
      '404.tsx',
      'permission-denied.tsx',
      '_app.tsx',
      '_document.tsx',
      '_error.tsx',
    ];
    const isPublicPage = publicPages.some((p) => fileName === p);

    const result: AuthRequirement = {
      required: !isPublicPage,
    };

    // Look for auth wrapper components in JSX
    const authPatterns = [
      'RequiredCondition',
      'ProtectedRoute',
      'AuthGuard',
      'PrivateRoute',
      'WithAuth',
      'RequireAuth',
      'Authenticated',
      'Authorized',
    ];

    for (const pattern of authPatterns) {
      if (content.includes(`<${pattern}`)) {
        result.condition = 'Additional permissions required';

        // Extract roles if present
        const roles = this.extractRolesFromContent(content);
        if (roles.length > 0) {
          result.roles = roles;
        }
        break;
      }
    }

    return result;
  }

  /**
   * Extract roles from content
   */
  private extractRolesFromContent(content: string): string[] {
    const roles: string[] = [];

    // Look for role patterns in JSX attributes
    this.traverseNode({ content } as unknown as Module, () => {});

    // Pattern: EnumRole.Value
    const enumMatches = content.matchAll(/(\w+Role|\w+Permission)\.(\w+)/g);
    for (const match of enumMatches) {
      roles.push(match[2]);
    }

    return [...new Set(roles)];
  }

  /**
   * Extract permissions from content
   */
  private extractPermissions(content: string): string[] {
    const permissions: string[] = [];

    // Look for permission patterns
    const permissionMatches = content.matchAll(/(?:Permission|Role|isAdmin)\.\w+/g);
    for (const match of permissionMatches) {
      if (!permissions.includes(match[0])) {
        permissions.push(match[0]);
      }
    }

    return permissions;
  }

  /**
   * Extract data fetching operations using unified GraphQL context extraction
   * Uses shared utilities for consistent operation name resolution
   */
  private extractDataFetching(
    ast: Module,
    content: string,
    _imports: Map<string, string>
  ): DataFetchingInfo[] {
    const dataFetching: DataFetchingInfo[] = [];
    const seenOperations = new Set<string>();

    // Convert codegenMap to the expected format
    const codegenMapConverted = new Map<string, { operationName: string; type: string }>();
    for (const [key, value] of this.codegenMap) {
      codegenMapConverted.set(key, {
        operationName: value.operationName,
        type: value.operationType,
      });
    }

    // Use unified GraphQL context extraction
    const graphqlContext = extractGraphQLContext(ast, content, codegenMapConverted);
    const extraHookPatterns = this.getGraphQLHookPatterns();

    // Find all hook calls using AST traversal
    traverseAst(ast, (node) => {
      if (node.type === 'CallExpression') {
        const call = node as CallExpression;
        const calleeName = getCalleeName(call.callee);

        if (!calleeName) return;

        // Check for GraphQL hooks - MUST verify it has actual GraphQL arguments
        // This prevents false positives like useQueryParams, useQueryClient, etc.
        if (
          isGraphQLHook(calleeName, extraHookPatterns) &&
          hasGraphQLArgument(call, content, graphqlContext)
        ) {
          const operationName = resolveOperationName(call, content, graphqlContext);
          const type = getHookType(calleeName, extraHookPatterns);

          const result: DataFetchingInfo = {
            type,
            operationName: operationName || 'unknown',
          };

          // Extract variables
          const variables = this.extractVariablesFromCall(call);
          if (Object.keys(variables).length > 0) {
            result.variables = variables;
          }

          const key = `${result.type}:${result.operationName}`;
          if (!seenOperations.has(key)) {
            seenOperations.add(key);
            dataFetching.push(result);
          }
        }

        // Check for Apollo client direct calls: client.query({ query: ... })
        if (calleeName === 'query' || calleeName === 'mutate') {
          const result = this.analyzeClientDirectCall(call, content, graphqlContext);
          if (result) {
            const key = `${result.type}:${result.operationName}`;
            if (!seenOperations.has(key)) {
              seenOperations.add(key);
              dataFetching.push(result);
            }
          }
        }
      }
    });

    // Check for getServerSideProps
    this.extractSSRDataFetching(ast, content, dataFetching, seenOperations);

    // Check for getStaticProps
    if (content.includes('getStaticProps')) {
      const key = 'getStaticProps:getStaticProps';
      if (!seenOperations.has(key)) {
        seenOperations.add(key);
        dataFetching.push({
          type: 'getStaticProps',
          operationName: 'getStaticProps',
        });
      }
    }

    return dataFetching;
  }

  /**
   * Analyze Apollo client direct calls: client.query({ query: MyQuery })
   */
  private analyzeClientDirectCall(
    call: CallExpression,
    _content: string,
    graphqlContext: GraphQLFileContext
  ): DataFetchingInfo | null {
    if (!call.arguments?.length) return null;

    const firstArgRaw = call.arguments[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstArg = (firstArgRaw as any)?.expression || firstArgRaw;

    if (firstArg?.type !== 'ObjectExpression') return null;

    // Look for { query: ... } property
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const prop of (firstArg as any).properties || []) {
      if (
        prop.type === 'KeyValueProperty' &&
        prop.key?.type === 'Identifier' &&
        prop.key.value === 'query'
      ) {
        const queryValue = prop.value;
        let operationName: string | null = null;

        // Identifier: { query: MyQuery }
        if (queryValue?.type === 'Identifier') {
          const varName = queryValue.value;
          // Check variable operations mapping
          operationName =
            graphqlContext.variableOperations.get(varName) ||
            graphqlContext.documentImports.get(varName) ||
            cleanOperationName(varName);
        }

        // MemberExpression: { query: Component.Query }
        if (queryValue?.type === 'MemberExpression') {
          const objName = queryValue.object?.type === 'Identifier' ? queryValue.object.value : null;
          const propName =
            queryValue.property?.type === 'Identifier' ? queryValue.property.value : null;
          if (objName && propName) {
            const key = `${objName}.${propName}`;
            operationName =
              graphqlContext.staticPropertyOperations.get(key) || cleanOperationName(propName);
          }
        }

        if (operationName) {
          const calleeName = getCalleeName(call.callee);
          return {
            type: calleeName === 'mutate' ? 'useMutation' : 'useQuery',
            operationName,
          };
        }
      }
    }

    return null;
  }

  /**
   * Extract Document imports from AST
   * Tracks imports like: import { GetUserDocument } from '__generated__/graphql'
   */
  private extractDocumentImports(ast: Module): Map<string, string> {
    const documentImports = new Map<string, string>();

    for (const item of ast.body) {
      if (item.type === 'ImportDeclaration') {
        const source = (item as ImportDeclaration).source?.value || '';

        // Check if import is from generated/graphql files
        const isGraphQLImport =
          source.includes('__generated__') ||
          source.includes('generated') ||
          source.includes('graphql') ||
          source.includes('.generated');

        for (const spec of item.specifiers || []) {
          const localName =
            spec.type === 'ImportSpecifier'
              ? spec.local?.value
              : spec.type === 'ImportDefaultSpecifier'
                ? spec.local?.value
                : null;

          if (localName) {
            // Track Document imports
            if (localName.endsWith('Document') || isGraphQLImport) {
              const operationName = localName.replace(/Document$/, '');
              documentImports.set(localName, operationName);
            }
            // Track Query/Mutation type imports for generic extraction
            if (localName.endsWith('Query') || localName.endsWith('Mutation')) {
              documentImports.set(localName, localName.replace(/Query$|Mutation$/, ''));
            }
          }
        }
      }
    }

    return documentImports;
  }

  /**
   * Extract variable assignments that reference Documents or gql() calls
   * Tracks: const doc = GetUserDocument
   * Tracks: const Query = gql(`query GetFollowPage { ... }`)
   */
  private extractVariableAssignments(ast: Module, content: string): Map<string, string> {
    const assignments = new Map<string, string>();

    this.traverseNode(ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
        const varName = node.id.value;
        const init = node.init;

        if (!init) return;

        // Handle: const doc = GetUserDocument
        if (init.type === 'Identifier') {
          const initName = init.value;
          if (initName.endsWith('Document') || initName.endsWith('Query')) {
            assignments.set(varName, initName);
          }
        }

        // Handle: const Query = gql(`query GetFollowPage { ... }`)
        if (init.type === 'CallExpression') {
          const calleeName = this.getCalleeName(init.callee);
          if (calleeName === 'gql' || calleeName === 'graphql') {
            const opName = this.extractOperationNameFromGqlCall(init, content);
            if (opName) {
              assignments.set(varName, opName);
            }
          }
        }

        // Handle: const Query = gql`query GetFollowPage { ... }`
        if (init.type === 'TaggedTemplateExpression') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tagName = this.getCalleeName((init as any).tag);
          if (tagName === 'gql' || tagName === 'graphql') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const template = (init as any).template;
            if (template?.quasis?.[0]?.raw) {
              const templateContent = template.quasis[0].raw;
              const opMatch = templateContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
              if (opMatch) {
                assignments.set(varName, opMatch[1]);
              }
            }
          }
        }
      }
    });

    return assignments;
  }

  /**
   * Extract operation name from gql() function call
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractOperationNameFromGqlCall(call: any, content: string): string | null {
    if (!call.arguments?.length) return null;

    const firstArgRaw = call.arguments[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstArg = (firstArgRaw as any)?.expression || firstArgRaw;

    // Template literal: gql(`query GetUser { ... }`)
    if (firstArg?.type === 'TemplateLiteral' && firstArg.quasis?.[0]?.raw) {
      const templateContent = firstArg.quasis[0].raw;
      const opMatch = templateContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
      if (opMatch) {
        return opMatch[1];
      }
    }

    // Fallback: extract from source span
    if (call.span) {
      const callContent = content.slice(call.span.start, call.span.end);
      const opMatch = callContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
      if (opMatch) {
        return opMatch[1];
      }
    }

    return null;
  }

  /**
   * Analyze a GraphQL hook call expression
   * Supports: useQuery, useMutation, useLazyQuery, useSuspenseQuery, etc.
   */
  private analyzeGraphQLHookCall(
    call: CallExpression,
    content: string,
    documentImports: Map<string, string>,
    variableAssignments: Map<string, string>
  ): DataFetchingInfo | null {
    const calleeName = this.getCalleeName(call.callee);
    if (!calleeName) return null;

    const extraHookPatterns = this.getGraphQLHookPatterns();

    // Check if this is a GraphQL hook using shared utilities
    const isStandardHook = (ALL_GRAPHQL_HOOKS as readonly string[]).includes(calleeName);
    const isCustomQuery =
      isQueryHook(calleeName, extraHookPatterns) && !calleeName.includes('Params');
    const isCustomMutation = isMutationHook(calleeName, extraHookPatterns);

    if (!isStandardHook && !isCustomQuery && !isCustomMutation) {
      return null;
    }

    // Determine hook type using shared utility
    const resolvedType = getHookType(calleeName, extraHookPatterns);

    // Extract operation name from multiple sources
    let operationName = calleeName.replace(/^use/, '').replace(/Query$|Mutation$/, '');

    // Method 1: Extract from type generic - useQuery<GetUserQuery>
    const genericName = this.extractTypeGeneric(call, content);
    if (genericName) {
      operationName = genericName.replace(/Query$|Mutation$|Variables$/, '');
    }

    // Method 2: Extract from first argument
    if (call.arguments && call.arguments.length > 0) {
      // SWC arguments can be either { expression } or direct expression
      const firstArgRaw = call.arguments[0];
      const firstArg = firstArgRaw?.expression || firstArgRaw;
      const argOperationName = this.extractOperationFromArgument(
        firstArg,
        documentImports,
        variableAssignments
      );
      if (argOperationName) {
        operationName = argOperationName;
      }
    }

    // Extract variables
    const variables = this.extractVariablesFromCall(call);

    return { type: resolvedType, operationName, variables };
  }

  /**
   * Extract type generic from hook call - useQuery<GetUserQuery>
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractTypeGeneric(call: any, content: string): string | null {
    // SWC stores type arguments in typeArguments
    if (call.typeArguments?.params?.length > 0) {
      const firstTypeArg = call.typeArguments.params[0];
      if (
        firstTypeArg?.type === 'TsTypeReference' &&
        firstTypeArg.typeName?.type === 'Identifier'
      ) {
        return firstTypeArg.typeName.value;
      }
    }

    // Fallback: Extract from source using span positions
    if (call.callee?.span) {
      const start = call.callee.span.end;
      const searchRegion = content.slice(start, start + 100);
      const genericMatch = searchRegion.match(/^<(\w+)(?:Query|Mutation|Variables)?[,>]/);
      if (genericMatch) {
        return genericMatch[1];
      }
    }

    return null;
  }

  /**
   * Extract operation name from function argument
   * Supports: Identifier, MemberExpression, variable references, graphql() calls
   */
  private extractOperationFromArgument(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arg: any,
    documentImports: Map<string, string>,
    variableAssignments: Map<string, string>
  ): string | null {
    if (!arg) return null;

    // Direct identifier: useQuery(GetUserDocument) or useQuery(Query)
    if (arg.type === 'Identifier') {
      const argName = arg.value;

      // Skip React Query patterns
      if (['[', '{', "'", '"', '`'].some((c) => argName.startsWith(c))) {
        return null;
      }

      // Check if it's a variable assignment (e.g., const Query = gql(`query GetFollowPage`))
      // This handles cases where variable name is generic like "Query" but maps to real operation
      const mappedOpName = variableAssignments.get(argName);
      if (mappedOpName) {
        // If mapped name looks like an operation name (not a Document reference), return it directly
        if (!mappedOpName.endsWith('Document') && !mappedOpName.endsWith('Query')) {
          return mappedOpName;
        }
        // Otherwise, check if it's a reference to another Document
        return documentImports.get(mappedOpName) || mappedOpName.replace(/Document$/, '');
      }

      // Check if it's a known Document import
      const importedName = documentImports.get(argName);
      if (importedName) {
        return importedName;
      }

      // Check codegen map
      const codegenEntry = this.codegenMap.get(argName);
      if (codegenEntry) {
        return codegenEntry.operationName;
      }

      // Skip generic patterns only if no mapping found
      if (/^(Query|Mutation|QUERY|MUTATION)$/i.test(argName)) {
        return null;
      }

      // Default: clean up the name
      return argName.replace(/Document$/, '').replace(/Query$|Mutation$/, '');
    }

    // Member expression: useQuery(gql.GetUser) or useQuery(queries.GetUser)
    if (arg.type === 'MemberExpression') {
      if (arg.property?.type === 'Identifier') {
        const propName = arg.property.value;
        return propName.replace(/Document$/, '').replace(/Query$|Mutation$/, '');
      }
    }

    // Tagged template: useQuery(gql`...`)
    if (arg.type === 'TaggedTemplateExpression') {
      if (arg.template?.quasis?.[0]?.raw) {
        const templateContent = arg.template.quasis[0].raw;
        const opMatch = templateContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
        if (opMatch) {
          return opMatch[1];
        }
      }
    }

    // CallExpression: useQuery(graphql(`query GetUser { ... }`))
    if (arg.type === 'CallExpression') {
      const calleeName = this.getCalleeName(arg.callee);
      if (calleeName === 'graphql' || calleeName === 'gql') {
        // Extract from nested template literal
        if (arg.arguments?.length > 0) {
          const nestedArgRaw = arg.arguments[0];
          const nestedArg = nestedArgRaw?.expression || nestedArgRaw;
          if (nestedArg?.type === 'TemplateLiteral' && nestedArg.quasis?.[0]?.raw) {
            const templateContent = nestedArg.quasis[0].raw;
            const opMatch = templateContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
            if (opMatch) {
              return opMatch[1];
            }
          }
        }
      }
    }

    // TemplateLiteral directly
    if (arg.type === 'TemplateLiteral' && arg.quasis?.[0]?.raw) {
      const templateContent = arg.quasis[0].raw;
      const opMatch = templateContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
      if (opMatch) {
        return opMatch[1];
      }
    }

    return null;
  }

  /**
   * Extract variables from hook call options
   */
  private extractVariablesFromCall(call: CallExpression): string[] {
    const variables: string[] = [];

    if (call.arguments && call.arguments.length > 1) {
      // SWC arguments can be either { expression } or direct expression
      const optionsArgRaw = call.arguments[1];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const optionsArg: any = (optionsArgRaw as any)?.expression || optionsArgRaw;
      if (optionsArg?.type === 'ObjectExpression') {
        for (const prop of optionsArg.properties || []) {
          if (
            prop.type === 'KeyValueProperty' &&
            prop.key?.type === 'Identifier' &&
            prop.key.value === 'variables'
          ) {
            if (prop.value?.type === 'ObjectExpression') {
              for (const varProp of prop.value.properties || []) {
                // Handle both KeyValueProperty and Identifier (shorthand) in variables object
                if (varProp.type === 'KeyValueProperty' && varProp.key?.type === 'Identifier') {
                  variables.push(varProp.key.value);
                } else if (varProp.type === 'Identifier') {
                  // Shorthand property: { foo } is represented as Identifier
                  variables.push(varProp.value);
                }
              }
            }
          }
        }
      }
    }

    return variables;
  }

  /**
   * Extract SSR data fetching (getServerSideProps)
   */
  private extractSSRDataFetching(
    ast: Module,
    content: string,
    dataFetching: DataFetchingInfo[],
    seenOperations: Set<string>
  ): void {
    // Build import map for SSR query resolution
    const imports = this.extractImports(ast);
    const documentImports = this.extractDocumentImports(ast);

    for (const item of ast.body) {
      if (item.type === 'ExportDeclaration') {
        const decl = (item as ExportDeclaration).declaration;
        if (decl?.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            if (d.id?.type === 'Identifier' && d.id.value === 'getServerSideProps') {
              // Find all .query() calls within getServerSideProps
              this.extractSSRQueriesFromNode(
                d,
                content,
                imports,
                documentImports,
                dataFetching,
                seenOperations
              );
            }
          }
        }
        if (
          decl?.type === 'FunctionDeclaration' &&
          decl.identifier?.value === 'getServerSideProps'
        ) {
          // Find all .query() calls within getServerSideProps function
          this.extractSSRQueriesFromNode(
            decl,
            content,
            imports,
            documentImports,
            dataFetching,
            seenOperations
          );
        }
      }
    }
  }

  /**
   * Extract SSR queries from a node (getServerSideProps body)
   */
  private extractSSRQueriesFromNode(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    content: string,
    imports: Map<string, string>,
    documentImports: Map<string, string>,
    dataFetching: DataFetchingInfo[],
    seenOperations: Set<string>
  ): void {
    traverseAst(node, (child) => {
      if (child.type !== 'CallExpression') return;

      const calleeName = getCalleeName(child.callee);

      // Check for client.query() or graphqlGatewayClient.query() pattern
      if (calleeName === 'query' || calleeName === 'mutate') {
        const operationName = this.extractQueryFromClientCall(
          child,
          content,
          imports,
          documentImports
        );
        if (operationName) {
          const key = `getServerSideProps:→ ${operationName}`;
          if (!seenOperations.has(key)) {
            seenOperations.add(key);
            dataFetching.push({
              type: 'getServerSideProps',
              operationName: `→ ${operationName}`,
            });
          }
        }
      }
    });
  }

  /**
   * Extract operation name from client.query({ query: ... }) call
   */
  private extractQueryFromClientCall(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call: any,
    content: string,
    imports: Map<string, string>,
    documentImports: Map<string, string>
  ): string | null {
    if (!call.arguments?.length) return null;

    const firstArgRaw = call.arguments[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstArg = (firstArgRaw as any)?.expression || firstArgRaw;

    if (firstArg?.type !== 'ObjectExpression') return null;

    // Look for { query: ... } property
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const prop of (firstArg as any).properties || []) {
      if (
        prop.type === 'KeyValueProperty' &&
        prop.key?.type === 'Identifier' &&
        prop.key.value === 'query'
      ) {
        const queryValue = prop.value;

        // Identifier: { query: MeetupPostsPageQuery }
        if (queryValue?.type === 'Identifier') {
          const varName = queryValue.value;

          // Check imports first
          if (documentImports.has(varName)) {
            return documentImports.get(varName) || null;
          }

          // Check codegen map
          const codegenEntry = this.codegenMap.get(varName);
          if (codegenEntry) {
            return codegenEntry.operationName;
          }

          // Try to resolve from import source (e.g., pages.graphql)
          const importSource = imports.get(varName);
          if (importSource) {
            // Clean up the name
            return cleanOperationName(varName);
          }

          return cleanOperationName(varName);
        }

        // MemberExpression: { query: Component.Query } or { query: Container.NonIdempotentQuery }
        if (queryValue?.type === 'MemberExpression') {
          const objName = queryValue.object?.type === 'Identifier' ? queryValue.object.value : null;
          const propName =
            queryValue.property?.type === 'Identifier' ? queryValue.property.value : null;

          if (objName && propName) {
            // Return as ComponentName.PropertyName format
            // The actual query name will be resolved when analyzing the component
            return `${objName}.${propName}`;
          }
        }
      }
    }

    return null;
  }

  /**
   * Extract navigation info
   */
  private extractNavigation(content: string): NavigationInfo {
    // Default navigation info
    const navigation: NavigationInfo = {
      visible: true,
      currentNavItem: null,
    };

    // Check for navigation visibility patterns
    if (content.includes('hideNavigation') || content.includes('noNav')) {
      navigation.visible = false;
    }

    // Check for mini/collapsed nav
    if (content.includes('miniNav') || content.includes('collapsedNav')) {
      navigation.mini = true;
    }

    // Try to find current nav item
    const navItemMatch = content.match(/currentNav(?:Item)?[:\s=]+['"`]([^'"`]+)['"`]/);
    if (navItemMatch) {
      navigation.currentNavItem = navItemMatch[1];
    }

    return navigation;
  }

  /**
   * Extract linked pages from Link components
   */
  private extractLinkedPages(ast: Module, _content: string): string[] {
    const pages: string[] = [];

    this.traverseNode(ast, (node) => {
      if (node.type === 'JSXOpeningElement') {
        const tagName = this.getJsxTagName(node);
        if (tagName === 'Link') {
          const href = this.getJsxAttribute(node, 'href');
          if (href && href.startsWith('/') && !href.includes('http')) {
            // Normalize to route path
            const routePath = href.split('?')[0].split('#')[0];
            if (!pages.includes(routePath)) {
              pages.push(routePath);
            }
          }
        }
      }
    });

    return pages;
  }

  /**
   * Extract steps from wizard/stepper patterns
   */
  private extractSteps(content: string): StepInfo[] {
    const steps: StepInfo[] = [];

    // Look for common step patterns
    const stepMatches = content.matchAll(/(?:step|Step)\s*[:=]\s*['"`]([^'"`]+)['"`]/g);
    let idx = 0;
    for (const match of stepMatches) {
      steps.push({ id: idx++, name: match[1] });
    }

    return steps;
  }

  // ========== AST Helper Methods ==========

  /**
   * Traverse AST nodes recursively
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private traverseNode(node: any, callback: (node: any) => void): void {
    if (!node || typeof node !== 'object') return;

    callback(node);

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          this.traverseNode(item, callback);
        }
      } else if (value && typeof value === 'object') {
        this.traverseNode(value, callback);
      }
    }
  }

  /**
   * Get callee name from call expression
   */
  private getCalleeName(callee: Expression | { type: 'Super' | 'Import' }): string | null {
    if (callee.type === 'Identifier') {
      return callee.value;
    }
    if (callee.type === 'MemberExpression') {
      const obj = callee.object;
      const prop = callee.property;
      if (obj.type === 'Identifier' && prop.type === 'Identifier') {
        return `${obj.value}.${prop.value}`;
      }
    }
    return null;
  }

  /**
   * Get JSX tag name
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getJsxTagName(node: any): string | null {
    if (node.name?.type === 'Identifier') {
      return node.name.value;
    }
    return null;
  }

  /**
   * Get JSX attribute value
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getJsxAttribute(node: any, attrName: string): string | null {
    if (!node.attributes) return null;

    for (const attr of node.attributes) {
      if (attr.type === 'JSXAttribute' && attr.name?.value === attrName) {
        if (attr.value?.type === 'StringLiteral') {
          return attr.value.value;
        }
        if (attr.value?.type === 'JSXExpressionContainer') {
          if (attr.value.expression?.type === 'Identifier') {
            return attr.value.expression.value;
          }
          if (attr.value.expression?.type === 'StringLiteral') {
            return attr.value.expression.value;
          }
        }
      }
    }
    return null;
  }
}
