import { Project, SourceFile, SyntaxKind, Node } from 'ts-morph';
import fg from 'fast-glob';
import * as path from 'path';
import { BaseAnalyzer } from './base-analyzer.js';
import { parallelMapSafe } from '../utils/parallel.js';
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
 * Analyzer for Next.js pages
 * Next.jsページの分析器
 */
export class PagesAnalyzer extends BaseAnalyzer {
  private project: Project;
  // Codegen Document → Operation name mapping
  private codegenMap = new Map<string, { operationName: string; operationType: string }>();

  constructor(config: RepositoryConfig) {
    super(config);
    this.project = new Project({
      tsConfigFilePath: this.resolvePath('tsconfig.json'),
      skipAddingFilesFromTsConfig: true,
    });
  }

  /**
   * Extract GraphQL operation name from a gql template literal or function call
   * Handles multiple patterns:
   * - gql`query Name { ... }`
   * - gql(/‌* GraphQL *‌/ `query Name { ... }`)
   * - graphql(`query Name { ... }`)
   */
  private extractOperationNameFromGql(text: string): string | null {
    // Pattern 1: Direct operation keyword with name
    const directMatch = text.match(/(?:query|mutation|subscription)\s+(\w+)/);
    if (directMatch && directMatch[1]) {
      return directMatch[1];
    }

    // Pattern 2: After backtick (with possible whitespace/newlines)
    const backtickMatch = text.match(/`\s*(?:query|mutation|subscription)\s+(\w+)/);
    if (backtickMatch && backtickMatch[1]) {
      return backtickMatch[1];
    }

    // Pattern 3: After GraphQL comment
    const commentMatch = text.match(
      /GraphQL[^`]*`\s*(?:\n\s*)?(?:query|mutation|subscription)\s+(\w+)/
    );
    if (commentMatch && commentMatch[1]) {
      return commentMatch[1];
    }

    return null;
  }

  /**
   * Find and extract operation name from a variable declaration in source file
   * Handles cases like: const Query = gql(comment `query ActualName...`)
   */
  private findOperationNameFromVariable(
    sourceFile: SourceFile,
    variableName: string
  ): string | null {
    // Method 1: Try to find variable declaration directly
    let varDecl = sourceFile.getVariableDeclaration(variableName);

    // Method 2: Try exported declarations
    if (!varDecl) {
      const exportedDecls = sourceFile.getExportedDeclarations();
      const exported = exportedDecls.get(variableName);
      if (exported && exported.length > 0) {
        const firstExport = exported[0];
        if (Node.isVariableDeclaration(firstExport)) {
          varDecl = firstExport;
        }
      }
    }

    // Method 3: Search all variable declarations
    if (!varDecl) {
      const allVarDecls = sourceFile.getVariableDeclarations();
      varDecl = allVarDecls.find((v) => v.getName() === variableName);
    }

    // Method 4: Full text search for pattern (most comprehensive)
    // This handles cases where the variable might not be found through AST
    if (!varDecl) {
      const fullText = sourceFile.getFullText();
      // Match: const Query = gql(/* GraphQL */ `query ActualName...
      // Or: const Query = gql`query ActualName...
      const patterns = [
        // gql(/* GraphQL */ `query Name...
        new RegExp(
          `(?:const|let|var)\\s+${variableName}\\s*=\\s*gql\\s*\\(\\s*/\\*[^*]*\\*/\\s*\`\\s*(?:query|mutation|subscription)\\s+(\\w+)`,
          's'
        ),
        // gql`query Name...
        new RegExp(
          `(?:const|let|var)\\s+${variableName}\\s*=\\s*gql\`\\s*(?:query|mutation|subscription)\\s+(\\w+)`,
          's'
        ),
        // gql(`query Name... (without comment)
        new RegExp(
          `(?:const|let|var)\\s+${variableName}\\s*=\\s*gql\\s*\\(\`\\s*(?:query|mutation|subscription)\\s+(\\w+)`,
          's'
        ),
        // graphql(`query Name...
        new RegExp(
          `(?:const|let|var)\\s+${variableName}\\s*=\\s*graphql\\s*\\(\`\\s*(?:query|mutation|subscription)\\s+(\\w+)`,
          's'
        ),
      ];

      for (const pattern of patterns) {
        const match = fullText.match(pattern);
        if (match && match[1]) {
          return match[1];
        }
      }

      return null;
    }

    // Extract from initializer
    const initializer = varDecl.getInitializer();
    if (!initializer) return null;

    const text = initializer.getText();
    return this.extractOperationNameFromGql(text);
  }

  getName(): string {
    return 'PagesAnalyzer';
  }

  async analyze(): Promise<Partial<AnalysisResult>> {
    this.log('Starting page analysis...');

    // Load codegen mapping if available
    await this.loadCodegenMapping();

    // Analyze _app.tsx for global providers/context
    await this.analyzeAppFile();

    // Find page files from multiple possible locations
    const pageFiles = await this.findPageFiles();

    this.log(`Found ${pageFiles.length} page files`);

    // Add all files to project first (sequential for ts-morph safety)
    for (const filePath of pageFiles) {
      try {
        this.project.addSourceFileAtPath(filePath);
      } catch {
        // Ignore files that can't be added
      }
    }

    // Analyze pages in parallel (using already-added source files)
    const pages = await parallelMapSafe(
      pageFiles,
      async (filePath) => {
        return this.analyzePageFile(filePath, this.basePath);
      },
      4 // Limit concurrency for ts-morph stability
    );

    // Filter out null results
    const validPages = pages.filter((p): p is PageInfo => p !== null);

    this.log(`Analyzed ${validPages.length} pages successfully`);

    return { pages: validPages };
  }

  private async analyzePageFile(filePath: string, pagesPath: string): Promise<PageInfo | null> {
    const sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) return null;
    const relativePath = path.relative(pagesPath, filePath);
    const routePath = this.filePathToRoutePath(relativePath);

    // Extract page component
    const pageComponent = this.findPageComponent(sourceFile);
    if (!pageComponent) {
      return null;
    }

    // Extract various page information
    const params = this.extractRouteParams(routePath);
    const layout = this.extractLayout(sourceFile);
    const authentication = this.extractAuthRequirement(sourceFile);
    const permissions = this.extractPermissions(sourceFile);
    const dataFetching = this.extractDataFetching(sourceFile);
    const navigation = this.extractNavigation(sourceFile);
    const linkedPages = this.extractLinkedPages(sourceFile);
    const steps = this.extractSteps(sourceFile);

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
  }

  private filePathToRoutePath(filePath: string): string {
    return (
      '/' +
      filePath
        .replace(/\.tsx?$/, '')
        .replace(/\/index$/, '')
        .replace(/\[\.\.\.(\w+)\]/g, '*')
        .replace(/\[(\w+)\]/g, ':$1')
    );
  }

  private extractRouteParams(routePath: string): string[] {
    const params: string[] = [];
    const paramRegex = /:(\w+)/g;
    let match;
    while ((match = paramRegex.exec(routePath)) !== null) {
      params.push(match[1]);
    }
    return params;
  }

  private findPageComponent(sourceFile: SourceFile): string | null {
    // Find default export
    const defaultExport = sourceFile.getDefaultExportSymbol();
    if (defaultExport) {
      const name = defaultExport.getName();
      // Handle 'default' export name
      if (name !== 'default') {
        return name;
      }
    }

    // Check for export default function/const
    const exportAssignment = sourceFile.getExportAssignment((e) => !e.isExportEquals());
    if (exportAssignment) {
      const expr = exportAssignment.getExpression();
      if (expr) {
        const text = expr.getText();
        // If it's a simple identifier, return it
        if (/^[A-Z][a-zA-Z0-9]*$/.test(text)) {
          return text;
        }
        // If it's a function expression, try to find the function name
        if (Node.isFunctionExpression(expr) || Node.isArrowFunction(expr)) {
          return 'default';
        }
      }
    }

    // Find export default function declaration
    const functions = sourceFile.getFunctions();
    for (const func of functions) {
      if (func.isDefaultExport()) {
        return func.getName() || 'default';
      }
    }

    // Find Page variable
    const pageVar = sourceFile.getVariableDeclaration('Page');
    if (pageVar) {
      return 'Page';
    }

    // Find NextPage typed variable (even without default export)
    const varDeclarations = sourceFile.getVariableDeclarations();
    for (const varDecl of varDeclarations) {
      const typeNode = varDecl.getTypeNode();
      if (typeNode) {
        const typeText = typeNode.getText();
        if (
          typeText.includes('NextPage') ||
          typeText.includes('FC') ||
          typeText.includes('React.FC')
        ) {
          return varDecl.getName();
        }
      }
    }

    // Find any PascalCase exported function/const that looks like a component
    for (const varDecl of varDeclarations) {
      const name = varDecl.getName();
      if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
        const init = varDecl.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          // Check if it returns JSX
          const text = init.getText();
          if (text.includes('return') && (text.includes('<') || text.includes('jsx'))) {
            return name;
          }
        }
      }
    }

    return null;
  }

  private extractLayout(sourceFile: SourceFile): string | undefined {
    // Look for getLayout property
    const getLayoutAssignment = sourceFile
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .find((node) => node.getName() === 'getLayout');

    if (getLayoutAssignment) {
      const parent = getLayoutAssignment.getParent();
      if (Node.isBinaryExpression(parent)) {
        const right = parent.getRight();
        // Extract layout component name from the function
        const jsxElements = right.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);
        if (jsxElements.length > 0) {
          return jsxElements[0].getTagNameNode().getText();
        }
      }
    }

    return undefined;
  }

  private extractAuthRequirement(sourceFile: SourceFile): AuthRequirement {
    const filePath = sourceFile.getFilePath();
    const fileName = filePath.split('/').pop() || '';

    // Pages that don't require authentication (exceptions)
    const publicPages = [
      '404.tsx',
      'permission-denied.tsx',
      '_app.tsx',
      '_document.tsx',
      '_error.tsx',
    ];
    const isPublicPage = publicPages.some((p) => fileName === p);

    // Default: ALL pages require authentication (because _app.tsx wraps everything with RequireAuthorization)
    const result: AuthRequirement = {
      required: !isPublicPage,
    };

    try {
      // Look for common auth/permission wrapper components (generic patterns)
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

      const authWrapper = sourceFile
        .getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
        .find((node) => {
          const tagName = node.getTagNameNode().getText();
          return authPatterns.some((pattern) => tagName.includes(pattern));
        });

      if (authWrapper) {
        // Has additional permission requirements beyond basic auth
        result.condition = 'Additional permissions required';

        // Extract condition/roles - safely iterate attributes
        const attributes = authWrapper.getAttributes();
        for (const attr of attributes) {
          if (attr.isKind(SyntaxKind.JsxAttribute)) {
            try {
              const name = attr.getNameNode().getText();
              // Common attribute names for conditions/roles
              if (
                ['condition', 'roles', 'permissions', 'requiredRoles', 'allowedRoles'].includes(
                  name
                )
              ) {
                const initializer = attr.getInitializer();
                if (initializer) {
                  result.condition = initializer.getText();

                  // Extract roles from condition
                  const roles = this.extractRolesFromCondition(initializer.getText());
                  if (roles.length > 0) {
                    result.roles = roles;
                  }
                }
              }
            } catch {
              // Skip this attribute
            }
          }
        }
      }
    } catch {
      // Return default on error
    }

    return result;
  }

  private extractRolesFromCondition(condition: string): string[] {
    const roles: string[] = [];

    // Generic patterns for role extraction:
    // - EnumName.RoleName (e.g., UserRole.Admin, MembershipRole.Owner)
    // - 'role-name' or "role-name" string literals
    // - ROLE_NAME constants

    // Pattern 1: Enum-style roles (SomeEnum.RoleName)
    const enumRoleRegex = /(\w+Role|\w+Permission)\.(\w+)/g;
    let match;
    while ((match = enumRoleRegex.exec(condition)) !== null) {
      roles.push(match[2]);
    }

    // Pattern 2: String literals containing 'admin', 'user', 'owner', etc.
    const stringRoleRegex = /['"]([a-zA-Z_-]+)['"]/g;
    while ((match = stringRoleRegex.exec(condition)) !== null) {
      const val = match[1];
      // Only add if it looks like a role
      if (/admin|user|owner|member|guest|manager|editor|viewer/i.test(val)) {
        roles.push(val);
      }
    }

    // Pattern 3: UPPER_CASE constants
    const constRoleRegex = /\b(ROLE_\w+|[A-Z]+_ROLE)\b/g;
    while ((match = constRoleRegex.exec(condition)) !== null) {
      roles.push(match[1]);
    }

    return [...new Set(roles)]; // Remove duplicates
  }

  private extractPermissions(sourceFile: SourceFile): string[] {
    const permissions: string[] = [];

    // Look for permission checks in the code
    const permissionChecks = sourceFile
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .filter((node) => {
        const text = node.getText();
        return text.includes('Permission') || text.includes('Role') || text.includes('isAdmin');
      });

    for (const check of permissionChecks) {
      const text = check.getText();
      if (!permissions.includes(text)) {
        permissions.push(text);
      }
    }

    return permissions;
  }

  private extractDataFetching(sourceFile: SourceFile): DataFetchingInfo[] {
    const dataFetching: DataFetchingInfo[] = [];

    // Build a map of imported GraphQL hooks (including aliases)
    // e.g., import { useQuery as getQuery } from '@apollo/client'
    const apolloHookAliases = new Map<string, string>();
    const apolloHooks = ['useQuery', 'useMutation', 'useLazyQuery', 'useSubscription'];

    for (const imp of sourceFile.getImportDeclarations()) {
      const moduleSpec = imp.getModuleSpecifierValue();
      if (moduleSpec.includes('@apollo/client') || moduleSpec.includes('apollo')) {
        for (const named of imp.getNamedImports()) {
          const originalName = named.getName();
          const alias = named.getAliasNode()?.getText() || originalName;
          if (apolloHooks.includes(originalName)) {
            apolloHookAliases.set(alias, originalName);
          }
        }
      }
    }

    // Check if this file uses Apollo Client
    const hasApolloImport =
      apolloHookAliases.size > 0 ||
      sourceFile.getImportDeclarations().some((imp) => {
        const moduleSpecifier = imp.getModuleSpecifierValue();
        return moduleSpecifier.includes('@apollo/client') || moduleSpecifier.includes('apollo');
      });

    // Find GraphQL hook calls - including aliases and custom hooks that wrap Apollo hooks
    const graphqlHookCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => {
        const expression = call.getExpression().getText();

        // Direct Apollo hook or alias
        if (apolloHookAliases.has(expression) || apolloHooks.includes(expression)) {
          return true;
        }

        // Custom hooks pattern: use*Query, use*Mutation (e.g., useUserQuery, useFetchPosts)
        // But exclude non-GraphQL hooks like useQueryParams, useQueryString
        if (
          /^use[A-Z].*Query$/.test(expression) &&
          !expression.includes('Params') &&
          !expression.includes('String')
        ) {
          return true;
        }
        if (/^use[A-Z].*Mutation$/.test(expression)) {
          return true;
        }

        return false;
      });

    for (const call of graphqlHookCalls) {
      const hookName = call.getExpression().getText();

      // Determine the actual type (resolve alias to original name)
      let resolvedType: DataFetchingInfo['type'];
      if (apolloHookAliases.has(hookName)) {
        resolvedType = apolloHookAliases.get(hookName) as DataFetchingInfo['type'];
      } else if (hookName.includes('Mutation')) {
        resolvedType = 'useMutation';
      } else if (hookName.includes('Lazy')) {
        resolvedType = 'useLazyQuery';
      } else {
        resolvedType = 'useQuery';
      }

      const args = call.getArguments();

      // Custom hooks might not have arguments (they encapsulate the query)
      if (args.length === 0) {
        // For custom hooks like useUserQuery(), extract name from hook name
        if (/^use[A-Z]/.test(hookName)) {
          const operationName = hookName.replace(/^use/, '').replace(/Query$|Mutation$/, '');
          dataFetching.push({ type: resolvedType, operationName, variables: [] });
        }
        continue;
      }

      const firstArg = args[0];
      const firstArgText = firstArg.getText();

      // Skip if first argument is:
      // - An array literal: ['key', ...]
      // - An object literal: { queryKey: ... }
      // - A string literal: 'queryKey'
      // These are React Query/TanStack Query patterns, not Apollo
      if (
        firstArgText.startsWith('[') ||
        firstArgText.startsWith('{') ||
        firstArgText.startsWith("'") ||
        firstArgText.startsWith('"') ||
        firstArgText.startsWith('`')
      ) {
        continue;
      }

      // Apollo Client pattern: first arg should be a Document identifier
      // Valid patterns: GetUserDocument, GET_USER_QUERY, gql`...`
      const isApolloPattern =
        hasApolloImport ||
        firstArgText.endsWith('Document') ||
        firstArgText.endsWith('Query') ||
        firstArgText.endsWith('Mutation') ||
        firstArgText.includes('gql') ||
        /^[A-Z_]+$/.test(firstArgText); // SCREAMING_CASE constant

      if (!isApolloPattern) {
        continue;
      }

      const operationName = firstArgText.replace(/Document$/, '').replace(/Query$|Mutation$/, '');

      const variables: string[] = [];

      if (args.length > 1) {
        const optionsArg = args[1];
        const variablesProperty = optionsArg
          .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
          .find((prop) => {
            try {
              return prop.getName() === 'variables';
            } catch {
              return false;
            }
          });

        if (variablesProperty) {
          const initializer = variablesProperty.getInitializer();
          if (initializer) {
            // Extract variable names
            const props = initializer.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
            for (const prop of props) {
              try {
                variables.push(prop.getName());
              } catch {
                // Skip
              }
            }
          }
        }
      }

      dataFetching.push({ type: resolvedType, operationName, variables });
    }

    // Find getServerSideProps and extract GraphQL queries
    const getServerSidePropsVar = sourceFile.getVariableDeclaration('getServerSideProps');
    const getServerSidePropsFunc = sourceFile.getFunction('getServerSideProps');
    const ssrNode = getServerSidePropsVar || getServerSidePropsFunc;

    if (ssrNode) {
      // Look for imported Document patterns (e.g., GetUserOnboardingUserDocument)
      const imports = sourceFile.getImportDeclarations();
      for (const imp of imports) {
        const namedImports = imp.getNamedImports();
        for (const named of namedImports) {
          const name = named.getName();
          if (name.endsWith('Document')) {
            // Check if this document is used in the file
            const usages = sourceFile
              .getDescendantsOfKind(SyntaxKind.Identifier)
              .filter((id) => id.getText() === name);
            if (usages.length > 0) {
              const operationName = name.replace(/Document$/, '');
              dataFetching.push({
                type: 'getServerSideProps',
                operationName: `→ ${operationName}`,
              });
            }
          }
        }
      }

      // Also look for inline query patterns: graphqlClient.query({ query: ... })
      const text = ssrNode.getText();
      const queryMatches = text.match(/query:\s*(\w+)/g);
      if (queryMatches) {
        for (const match of queryMatches) {
          const docName = match.replace(/query:\s*/, '');
          if (
            !dataFetching.some((d) => d.operationName?.includes(docName.replace(/Document$/, '')))
          ) {
            dataFetching.push({
              type: 'getServerSideProps',
              operationName: `→ ${docName.replace(/Document$/, '')}`,
            });
          }
        }
      }
    }

    // Find getStaticProps
    const getStaticPropsVar = sourceFile.getVariableDeclaration('getStaticProps');
    const getStaticPropsFunc = sourceFile.getFunction('getStaticProps');
    if (getStaticPropsVar || getStaticPropsFunc) {
      dataFetching.push({
        type: 'getStaticProps',
        operationName: 'getStaticProps',
      });
    }

    // Track component imports from relative paths and analyze their GraphQL usage
    const imports = sourceFile.getImportDeclarations();
    const sourceFilePath = sourceFile.getFilePath();
    const sourceFileDir = path.dirname(sourceFilePath);

    for (const imp of imports) {
      const moduleSpec = imp.getModuleSpecifierValue();

      // Skip external packages (node_modules) - only track relative imports
      const isRelativeImport = moduleSpec.startsWith('.') || moduleSpec.startsWith('/');
      const isInternalAlias =
        !moduleSpec.includes('node_modules') &&
        !moduleSpec.startsWith('@types/') &&
        moduleSpec.startsWith('@') === false; // Skip scoped packages

      if (isRelativeImport || isInternalAlias) {
        // Skip codegen/generated folders - these contain GraphQL types, not components
        if (moduleSpec.includes('__generated__') || moduleSpec.includes('/generated/')) {
          continue;
        }

        // Collect component names from this import
        const componentNames: string[] = [];

        // Check named imports for component-like names (PascalCase)
        const namedImports = imp.getNamedImports();
        for (const named of namedImports) {
          const name = named.getName();
          if (this.isComponentName(name)) {
            componentNames.push(name);
          }
        }

        // Check default import
        const defaultImport = imp.getDefaultImport();
        if (defaultImport) {
          const name = defaultImport.getText();
          if (this.isComponentName(name)) {
            componentNames.push(name);
          }
        }

        // For each component, try to analyze the imported file for GraphQL
        for (const componentName of componentNames) {
          // Try to resolve and analyze the imported component file
          const importedQueries = this.analyzeImportedComponent(
            sourceFileDir,
            moduleSpec,
            componentName
          );

          if (importedQueries.length > 0) {
            // Add the queries found in the component with a reference marker
            for (const query of importedQueries) {
              dataFetching.push({
                type: query.type,
                operationName: query.operationName.startsWith('→')
                  ? `→ ${query.operationName} (${componentName})`
                  : `→ ${query.operationName} (${componentName})`,
                variables: query.variables,
              });
            }
          } else {
            // No queries found, just mark as component reference
            dataFetching.push({
              type: 'component',
              operationName: componentName,
              variables: [],
            });
          }
        }
      }
    }

    return dataFetching;
  }

  // Symbol tracking cache to avoid re-analyzing the same files
  private symbolTraceCache = new Map<string, DataFetchingInfo[]>();

  /**
   * Analyze an imported component file for GraphQL queries with full symbol tracing
   * 임포트된 컴포넌트를 재귀적으로 완전 추적
   */
  private analyzeImportedComponent(
    sourceFileDir: string,
    moduleSpec: string,
    componentName: string,
    visited: Set<string> = new Set(),
    depth: number = 0
  ): DataFetchingInfo[] {
    const MAX_DEPTH = 10; // 무한 루프 방지
    if (depth > MAX_DEPTH) return [];

    const queries: DataFetchingInfo[] = [];

    try {
      // Resolve the import path
      const resolvedPath = path.resolve(sourceFileDir, moduleSpec);

      // Create a unique key for cycle detection
      const cacheKey = `${resolvedPath}:${componentName}`;
      if (visited.has(cacheKey)) {
        return []; // 순환 참조 방지
      }
      visited.add(cacheKey);

      // Check cache
      if (this.symbolTraceCache.has(cacheKey)) {
        return this.symbolTraceCache.get(cacheKey)!;
      }

      // Try different file extensions and index files
      const possiblePaths = [
        `${resolvedPath}.tsx`,
        `${resolvedPath}.ts`,
        `${resolvedPath}/index.tsx`,
        `${resolvedPath}/index.ts`,
        `${resolvedPath}/${componentName}.tsx`,
        `${resolvedPath}/${componentName}.ts`,
      ];

      let componentFile: SourceFile | undefined;
      let componentFilePath: string | undefined;

      for (const tryPath of possiblePaths) {
        try {
          componentFile = this.project.addSourceFileAtPath(tryPath);
          if (componentFile) {
            componentFilePath = tryPath;
            break;
          }
        } catch {
          // File doesn't exist, try next
        }
      }

      if (!componentFile || !componentFilePath) return queries;

      // If this is an index file, follow re-exports to find the actual component file
      if (componentFilePath.endsWith('index.tsx') || componentFilePath.endsWith('index.ts')) {
        const actualFile = this.followReExport(
          componentFile,
          componentName,
          path.dirname(componentFilePath)
        );
        if (actualFile) {
          componentFile = actualFile;
        }
      }

      // Check for Apollo Client imports (also check for gql imports which indicate GraphQL usage)
      // Also check for graphql.macro, graphql-tag which are commonly used
      const hasGraphQLImport = componentFile.getImportDeclarations().some((imp) => {
        const spec = imp.getModuleSpecifierValue();
        return (
          spec.includes('@apollo/client') ||
          spec.includes('apollo') ||
          spec.includes('gql') ||
          spec.includes('graphql') || // graphql.macro, graphql-tag
          spec.includes('__generated__')
        );
      });

      // Get all relative imports for full symbol tracing
      const relativeImports = componentFile.getImportDeclarations().filter((imp) => {
        const spec = imp.getModuleSpecifierValue();
        return spec.startsWith('./') || spec.startsWith('../');
      });

      // 1. Analyze custom hooks (use* pattern)
      for (const imp of relativeImports) {
        const hookSpec = imp.getModuleSpecifierValue();
        const hookNames = imp
          .getNamedImports()
          .map((n) => n.getName())
          .filter((n) => /^use[A-Z]/.test(n));

        for (const hookName of hookNames) {
          const hookQueries = this.analyzeCustomHook(
            path.dirname(componentFile.getFilePath()),
            hookSpec,
            hookName,
            visited,
            depth + 1
          );
          queries.push(...hookQueries);
        }
      }

      // 2. Deep trace all imported components (not just Container/Page)
      for (const imp of relativeImports) {
        const nestedSpec = imp.getModuleSpecifierValue();
        const namedImports = imp.getNamedImports().map((n) => n.getName());
        const defaultImport = imp.getDefaultImport()?.getText();

        // Analyze ALL PascalCase imports (components)
        const componentImports = namedImports.filter(
          (n) => /^[A-Z]/.test(n) && this.isComponentName(n)
        );

        for (const nestedComponentName of componentImports) {
          const nestedQueries = this.analyzeImportedComponent(
            path.dirname(componentFile.getFilePath()),
            nestedSpec,
            nestedComponentName,
            visited,
            depth + 1
          );
          queries.push(...nestedQueries);
        }

        // Also check default imports
        if (defaultImport && /^[A-Z]/.test(defaultImport) && this.isComponentName(defaultImport)) {
          const nestedQueries = this.analyzeImportedComponent(
            path.dirname(componentFile.getFilePath()),
            nestedSpec,
            defaultImport,
            visited,
            depth + 1
          );
          queries.push(...nestedQueries);
        }
      }

      // 3. If has GraphQL imports, look for direct hook calls
      if (hasGraphQLImport) {
        // Find GraphQL hook calls in the component
        const hookCalls = componentFile
          .getDescendantsOfKind(SyntaxKind.CallExpression)
          .filter((call) => {
            const expression = call.getExpression().getText();
            return ['useQuery', 'useMutation', 'useLazyQuery', 'useSubscription'].includes(
              expression
            );
          });

        for (const call of hookCalls) {
          const hookName = call.getExpression().getText();
          const args = call.getArguments();

          if (args.length === 0) continue;

          const firstArg = args[0];
          const firstArgText = firstArg.getText();

          // Extract operation name from the first argument
          let operationName = firstArgText;
          let operationType: string | null = null;

          // Try codegen mapping first
          const codegenInfo = this.resolveDocumentName(firstArgText);
          if (codegenInfo) {
            operationName = codegenInfo.operationName;
            operationType = codegenInfo.operationType;
          }
          // Handle codegen Document pattern: SomeQueryDocument → SomeQuery
          else if (firstArgText.endsWith('Document')) {
            operationName = firstArgText.replace(/Document$/, '');
          }
          // If it's a variable reference, try to find the actual query name
          else if (/^[A-Za-z]/.test(firstArgText)) {
            // Use the helper function to find operation name from variable
            const extractedName = this.findOperationNameFromVariable(componentFile, firstArgText);
            if (extractedName) {
              operationName = extractedName;
            }

            // If still using the original variable name and it's a common pattern,
            // try to extract operation name from it (e.g., ProfilePreviewQuery → ProfilePreview)
            if (
              operationName === firstArgText &&
              firstArgText !== 'Query' &&
              firstArgText !== 'Mutation'
            ) {
              const nameMatch = firstArgText.match(/^(.+?)(Query|Mutation|Subscription)$/);
              if (nameMatch) {
                operationName = nameMatch[1];
              }
            }
          }

          // Clean up operation name - but don't remove if it would become empty
          // Also don't clean if it's just "Query" or "Mutation" (common variable names)
          if (operationName !== 'Query' && operationName !== 'Mutation') {
            const cleanedName = operationName
              .replace(/Document$/, '')
              .replace(/Query$|Mutation$/, '');
            operationName = cleanedName || operationName;
          }

          // If operationName is still a generic name like "Query", try to extract from variable name pattern
          // e.g., from useQuery(Query, ...) where Query = gql`query ActualName { ... }`
          if (operationName === 'Query' || operationName === 'Mutation' || operationName === '') {
            // The variable lookup already happened above but may have failed
            // In this case, keep the original but mark it needs the file context
            if (operationName === '') {
              operationName = firstArgText || 'Unknown';
            }
          }

          const type = operationType
            ? operationType === 'mutation'
              ? 'useMutation'
              : operationType === 'subscription'
                ? 'useSubscription'
                : hookName.includes('Lazy')
                  ? 'useLazyQuery'
                  : 'useQuery'
            : hookName.includes('Mutation')
              ? 'useMutation'
              : hookName.includes('Lazy')
                ? 'useLazyQuery'
                : 'useQuery';

          queries.push({
            type: type as DataFetchingInfo['type'],
            operationName,
            variables: [],
          });
        }
      }

      // Cache the results
      this.symbolTraceCache.set(cacheKey, queries);
    } catch {
      // Failed to analyze imported component, skip
    }

    return queries;
  }

  /**
   * Analyze a custom hook file for GraphQL queries with recursive tracing
   */
  private analyzeCustomHook(
    sourceFileDir: string,
    moduleSpec: string,
    hookName: string,
    visited: Set<string> = new Set(),
    depth: number = 0
  ): DataFetchingInfo[] {
    const MAX_DEPTH = 10;
    if (depth > MAX_DEPTH) return [];

    const queries: DataFetchingInfo[] = [];

    try {
      // Resolve the import path
      const resolvedPath = path.resolve(sourceFileDir, moduleSpec);

      // Create a unique key for cycle detection
      const cacheKey = `hook:${resolvedPath}:${hookName}`;
      if (visited.has(cacheKey)) return [];
      visited.add(cacheKey);

      // Check cache
      if (this.symbolTraceCache.has(cacheKey)) {
        return this.symbolTraceCache.get(cacheKey)!;
      }

      const possiblePaths = [
        `${resolvedPath}.tsx`,
        `${resolvedPath}.ts`,
        `${resolvedPath}/${hookName}.tsx`,
        `${resolvedPath}/${hookName}.ts`,
        `${resolvedPath}/index.tsx`,
        `${resolvedPath}/index.ts`,
      ];

      let hookFile: SourceFile | undefined;

      for (const tryPath of possiblePaths) {
        try {
          hookFile = this.project.addSourceFileAtPath(tryPath);
          if (hookFile) break;
        } catch {
          // File doesn't exist, try next
        }
      }

      if (!hookFile) return queries;

      // Check for Apollo Client imports
      const hasGraphQLImport = hookFile.getImportDeclarations().some((imp) => {
        const spec = imp.getModuleSpecifierValue();
        return (
          spec.includes('@apollo/client') ||
          spec.includes('apollo') ||
          spec.includes('graphql') ||
          spec.includes('__generated__')
        );
      });

      // Also trace nested custom hooks even if no direct GraphQL import
      const relativeImports = hookFile.getImportDeclarations().filter((imp) => {
        const spec = imp.getModuleSpecifierValue();
        return spec.startsWith('./') || spec.startsWith('../');
      });

      for (const imp of relativeImports) {
        const nestedSpec = imp.getModuleSpecifierValue();
        const nestedHookNames = imp
          .getNamedImports()
          .map((n) => n.getName())
          .filter((n) => /^use[A-Z]/.test(n));

        for (const nestedHookName of nestedHookNames) {
          const nestedQueries = this.analyzeCustomHook(
            path.dirname(hookFile.getFilePath()),
            nestedSpec,
            nestedHookName,
            visited,
            depth + 1
          );
          queries.push(...nestedQueries);
        }
      }

      if (!hasGraphQLImport && queries.length === 0) {
        return queries;
      }

      // Find useQuery/useMutation calls in the hook
      const hookCalls = hookFile.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
        const expression = call.getExpression().getText();
        return ['useQuery', 'useMutation', 'useLazyQuery', 'useSubscription'].includes(expression);
      });

      for (const call of hookCalls) {
        const callHookName = call.getExpression().getText();
        const args = call.getArguments();

        if (args.length === 0) continue;

        const firstArgText = args[0].getText();
        let operationName = firstArgText;
        let operationType: string | null = null;

        // Try codegen mapping first
        const codegenInfo = this.resolveDocumentName(firstArgText);
        if (codegenInfo) {
          operationName = codegenInfo.operationName;
          operationType = codegenInfo.operationType;
        }
        // Handle codegen Document pattern: SomeQueryDocument → SomeQuery
        else if (firstArgText.endsWith('Document')) {
          operationName = firstArgText.replace(/Document$/, '');
        }
        // If it's a variable reference, try to find the actual query name
        else if (/^[A-Za-z]/.test(firstArgText)) {
          // Use the helper function to find operation name from variable
          const extractedName = this.findOperationNameFromVariable(hookFile, firstArgText);
          if (extractedName) {
            operationName = extractedName;
          }

          // If still using the original variable name and it's a common pattern,
          // try to extract operation name from it (e.g., ProfilePreviewQuery → ProfilePreview)
          if (
            operationName === firstArgText &&
            firstArgText !== 'Query' &&
            firstArgText !== 'Mutation'
          ) {
            const nameMatch = firstArgText.match(/^(.+?)(Query|Mutation|Subscription)$/);
            if (nameMatch) {
              operationName = nameMatch[1];
            }
          }
        }

        // Clean up operation name - but don't remove if it would become empty
        // Also don't clean if it's just "Query" or "Mutation" (common variable names)
        if (operationName !== 'Query' && operationName !== 'Mutation') {
          const cleanedName = operationName
            .replace(/Document$/, '')
            .replace(/Query$|Mutation$/, '');
          operationName = cleanedName || operationName;
        }

        // Prevent empty operation names
        if (operationName === '') {
          operationName = firstArgText || 'Unknown';
        }

        const type = operationType
          ? operationType === 'mutation'
            ? 'useMutation'
            : operationType === 'subscription'
              ? 'useSubscription'
              : callHookName.includes('Lazy')
                ? 'useLazyQuery'
                : 'useQuery'
          : callHookName.includes('Mutation')
            ? 'useMutation'
            : callHookName.includes('Lazy')
              ? 'useLazyQuery'
              : 'useQuery';

        queries.push({
          type: type as DataFetchingInfo['type'],
          operationName: `→ ${operationName} (via ${hookName})`,
          variables: [],
        });
      }

      // Cache the results
      this.symbolTraceCache.set(cacheKey, queries);
    } catch {
      // Failed to analyze hook
    }

    return queries;
  }

  // Global context providers and their GraphQL queries
  private globalContextQueries: DataFetchingInfo[] = [];

  /**
   * Find page files from multiple possible locations
   * Next.js, React, Rails+React 구조 모두 지원
   */
  private async findPageFiles(): Promise<string[]> {
    const pagesDir = this.getSetting('pagesDir', 'src/pages');
    const allFiles: string[] = [];

    // 1. Check Next.js standard directories
    const nextjsDirs = [pagesDir, 'pages', 'src/pages', 'app', 'src/app'];

    for (const dir of nextjsDirs) {
      const dirPath = this.resolvePath(dir);
      try {
        const files = await fg(['**/*.tsx', '**/*.ts', '**/*.jsx', '**/*.js'], {
          cwd: dirPath,
          ignore: [
            '_app.tsx',
            '_app.ts',
            '_app.jsx',
            '_app.js',
            '_document.tsx',
            '_document.ts',
            '_document.jsx',
            '_document.js',
            '_error.tsx',
            '_error.ts',
            '_error.jsx',
            '_error.js',
            'api/**',
            '**/*.test.*',
            '**/*.spec.*',
            '**/node_modules/**',
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
    const railsReactDirs = [
      'frontend/src/**/pages',
      'frontend/src/**/components/pages',
      'app/javascript/**/pages',
      'app/javascript/**/components/pages',
    ];

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
            ignore: ['**/*.test.*', '**/*.spec.*', '**/node_modules/**', '**/vendor/**'],
            absolute: true,
          }
        );
        allFiles.push(...files);
        if (files.length > 0) {
          this.log(`Found ${files.length} React pages in ${pattern}`);
        }
      } catch {
        // Pattern doesn't match
      }
    }

    // 3. Check for entry point files (Rails with Webpacker/Shakapacker)
    const entryPatterns = [
      'frontend/src/**/index.tsx',
      'frontend/src/**/App.tsx',
      'app/javascript/packs/*.tsx',
      'app/javascript/packs/*.jsx',
    ];

    for (const pattern of entryPatterns) {
      try {
        const files = await fg([pattern], {
          cwd: this.basePath,
          ignore: ['**/node_modules/**', '**/vendor/**'],
          absolute: true,
        });
        // Don't add duplicates
        for (const file of files) {
          if (!allFiles.includes(file)) {
            allFiles.push(file);
          }
        }
      } catch {
        // Pattern doesn't match
      }
    }

    // Remove duplicates
    return [...new Set(allFiles)];
  }

  /**
   * Analyze _app.tsx for global providers that use GraphQL
   * _app.tsx에서 전역 Context Provider의 GraphQL 분석
   */
  private async analyzeAppFile(): Promise<void> {
    const pagesDir = this.getSetting('pagesDir', 'src/pages');
    const possiblePaths = [
      this.resolvePath(`${pagesDir}/_app.tsx`),
      this.resolvePath(`${pagesDir}/_app.ts`),
    ];

    for (const appPath of possiblePaths) {
      try {
        const appFile = this.project.addSourceFileAtPath(appPath);
        if (!appFile) continue;

        // Find Provider components used in _app
        const jsxElements = appFile.getDescendantsOfKind(SyntaxKind.JsxElement);
        const jsxSelfClosing = appFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);

        const providerNames = new Set<string>();

        for (const el of [...jsxElements, ...jsxSelfClosing]) {
          const tagName = el.getFirstDescendantByKind(SyntaxKind.Identifier)?.getText();
          if (tagName && (tagName.includes('Provider') || tagName.includes('Context'))) {
            providerNames.add(tagName);
          }
        }

        // Find imports for these providers
        for (const imp of appFile.getImportDeclarations()) {
          const spec = imp.getModuleSpecifierValue();
          if (!spec.startsWith('./') && !spec.startsWith('../')) continue;

          const namedImports = imp.getNamedImports().map((n) => n.getName());
          const defaultImport = imp.getDefaultImport()?.getText();

          for (const providerName of providerNames) {
            if (namedImports.includes(providerName) || defaultImport === providerName) {
              // Analyze the provider file for GraphQL usage
              const providerQueries = this.analyzeImportedComponent(
                path.dirname(appPath),
                spec,
                providerName,
                new Set(),
                0
              );

              for (const q of providerQueries) {
                // Mark as global context
                this.globalContextQueries.push({
                  ...q,
                  operationName: `[Global] ${q.operationName}`,
                });
              }
            }
          }
        }

        if (this.globalContextQueries.length > 0) {
          this.log(`Found ${this.globalContextQueries.length} global context queries from _app`);
        }
        return;
      } catch {
        // File doesn't exist, continue
      }
    }
  }

  /**
   * Load codegen mapping from __generated__ folders (optional)
   * 코드젠 폴더가 있으면 Document → Operation name 매핑 로드
   */
  private async loadCodegenMapping(): Promise<void> {
    const possibleDirs = [
      '__generated__',
      'src/__generated__',
      'src/__generated__/gql-graphql-gateway',
      'generated',
      'src/generated',
    ];

    for (const dir of possibleDirs) {
      const generatedPath = this.resolvePath(dir);
      try {
        const files = await fg(['**/*.ts', '**/*.tsx'], {
          cwd: generatedPath,
          absolute: true,
          onlyFiles: true,
        });

        for (const file of files) {
          try {
            const sourceFile = this.project.addSourceFileAtPath(file);

            // Look for DocumentNode exports with operation names
            // Pattern 1: export const SomeQueryDocument = gql`query SomeName { ... }`
            // Pattern 2: export type SomeQueryDocument = DocumentNode
            const varDecls = sourceFile.getVariableDeclarations();
            for (const varDecl of varDecls) {
              const name = varDecl.getName();
              if (name.endsWith('Document')) {
                const initializer = varDecl.getInitializer()?.getText() ?? '';

                // Extract operation name and type from gql template
                const operationMatch = initializer.match(/(?:query|mutation|subscription)\s+(\w+)/);
                const typeMatch = initializer.match(/(query|mutation|subscription)\s+/);

                if (operationMatch) {
                  this.codegenMap.set(name, {
                    operationName: operationMatch[1],
                    operationType: typeMatch ? typeMatch[1] : 'query',
                  });
                }
              }
            }

            // Pattern 3: Look at type definitions
            // export type SomeQuery = { ... }
            // This indicates SomeQueryDocument exists
            const typeAliases = sourceFile.getTypeAliases();
            for (const typeAlias of typeAliases) {
              const name = typeAlias.getName();
              if (
                (name.endsWith('Query') ||
                  name.endsWith('Mutation') ||
                  name.endsWith('Subscription')) &&
                !name.endsWith('Variables')
              ) {
                const docName = name + 'Document';
                if (!this.codegenMap.has(docName)) {
                  const operationType = name.endsWith('Mutation')
                    ? 'mutation'
                    : name.endsWith('Subscription')
                      ? 'subscription'
                      : 'query';
                  this.codegenMap.set(docName, {
                    operationName: name,
                    operationType,
                  });
                }
              }
            }
          } catch {
            // Skip file on error
          }
        }

        if (this.codegenMap.size > 0) {
          this.log(`Loaded ${this.codegenMap.size} codegen mappings from ${dir}`);
          return; // Found and loaded, no need to check other dirs
        }
      } catch {
        // Directory doesn't exist, continue
      }
    }
  }

  /**
   * Resolve Document name to operation name using codegen map
   */
  private resolveDocumentName(
    documentName: string
  ): { operationName: string; operationType: string } | null {
    // Skip generic GraphQL type names - these are not actual operation names
    const genericTypeNames = new Set(['Query', 'Mutation', 'Subscription']);
    if (genericTypeNames.has(documentName)) {
      return null;
    }

    // Direct lookup
    if (this.codegenMap.has(documentName)) {
      return this.codegenMap.get(documentName)!;
    }

    // Try with Document suffix
    const withSuffix = documentName.endsWith('Document') ? documentName : documentName + 'Document';
    if (this.codegenMap.has(withSuffix)) {
      return this.codegenMap.get(withSuffix)!;
    }

    return null;
  }

  /**
   * Follow re-export in index file to find the actual component file
   */
  private followReExport(
    indexFile: SourceFile,
    componentName: string,
    indexDir: string
  ): SourceFile | null {
    try {
      // Look for export declarations that export the component
      // e.g., export { ProfilePreviewContainer } from "./ProfilePreviewContainer"
      const exportDecls = indexFile.getExportDeclarations();
      let firstExportFile: SourceFile | null = null;

      for (const exportDecl of exportDecls) {
        const namedExports = exportDecl.getNamedExports();
        for (const named of namedExports) {
          const moduleSpec = exportDecl.getModuleSpecifierValue();
          if (!moduleSpec) continue;

          const resolvedPath = path.resolve(indexDir, moduleSpec);
          const possiblePaths = [
            `${resolvedPath}.tsx`,
            `${resolvedPath}.ts`,
            `${resolvedPath}/index.tsx`,
            `${resolvedPath}/index.ts`,
          ];

          // Try to load the file
          let file: SourceFile | undefined;
          for (const tryPath of possiblePaths) {
            try {
              file = this.project.addSourceFileAtPath(tryPath);
              if (file) break;
            } catch {
              // Try next path
            }
          }

          if (!file) continue;

          // Store first export as fallback (for default imports with different names)
          if (!firstExportFile) {
            firstExportFile = file;
          }

          // Check if this is the exact component we're looking for
          if (
            named.getName() === componentName ||
            named.getAliasNode()?.getText() === componentName
          ) {
            return file;
          }
        }
      }

      // If exact match not found, return first export (handles default imports)
      if (firstExportFile) {
        return firstExportFile;
      }

      // Also check for: export * from "./SomeModule"
      for (const exportDecl of indexFile.getExportDeclarations()) {
        if (exportDecl.isNamespaceExport()) {
          const moduleSpec = exportDecl.getModuleSpecifierValue();
          if (moduleSpec) {
            const resolvedPath = path.resolve(indexDir, moduleSpec);
            const possiblePaths = [`${resolvedPath}.tsx`, `${resolvedPath}.ts`];

            for (const tryPath of possiblePaths) {
              try {
                const file = this.project.addSourceFileAtPath(tryPath);
                if (file) {
                  // Check if this file exports the component
                  const hasExport = file.getExportedDeclarations().has(componentName);
                  if (hasExport) return file;
                }
              } catch {
                // Try next path
              }
            }
          }
        }
      }
    } catch {
      // Failed to follow re-export
    }

    return null;
  }

  /**
   * Check if a name looks like a React component (PascalCase with common suffixes)
   */
  private isComponentName(name: string): boolean {
    // Must be PascalCase (start with uppercase)
    if (!/^[A-Z]/.test(name)) return false;

    // Exclude GraphQL-related type names (not actual components)
    // These are generated types from codegen or GraphQL operations
    if (
      name.endsWith('Query') ||
      name.endsWith('Mutation') ||
      name.endsWith('Subscription') ||
      name.endsWith('Fragment') ||
      name.endsWith('Document') ||
      name.endsWith('Variables') ||
      name === 'Query' ||
      name === 'Mutation' ||
      name === 'Subscription'
    ) {
      return false;
    }

    // Exclude React/Next.js type definitions (not actual components)
    const typeDefinitions = new Set([
      'NextPage',
      'NextPageContext',
      'NextApiRequest',
      'NextApiResponse',
      'GetServerSideProps',
      'GetStaticProps',
      'GetStaticPaths',
      'InferGetServerSidePropsType',
      'InferGetStaticPropsType',
      'FC',
      'FunctionComponent',
      'VFC',
      'Component',
      'PureComponent',
      'ReactNode',
      'ReactElement',
      'PropsWithChildren',
      'ComponentProps',
      'ComponentType',
      'ElementType',
      'RefObject',
      'MutableRefObject',
      'Dispatch',
      'SetStateAction',
      'ChangeEvent',
      'MouseEvent',
      'KeyboardEvent',
      'FormEvent',
      'SyntheticEvent',
    ]);

    if (typeDefinitions.has(name)) {
      return false;
    }

    // Common component suffixes that likely contain data fetching
    const componentSuffixes = [
      'Container',
      'Page',
      'Screen',
      'View',
      'Form',
      'Modal',
      'Dialog',
      'Panel',
      'Root',
      'Provider',
      'Wrapper',
    ];

    // Check for suffix match
    if (componentSuffixes.some((suffix) => name.endsWith(suffix))) {
      return true;
    }

    // Also match if it ends with Page-like patterns
    if (/Page[A-Z]?\w*$/.test(name) || /Container[A-Z]?\w*$/.test(name)) {
      return true;
    }

    // Match PascalCase names that look like feature components
    // e.g., CancellationEngagement, UserProfile, ProjectSettings
    if (/^[A-Z][a-z]+[A-Z][a-z]+/.test(name)) {
      return true;
    }

    return false;
  }

  private extractNavigation(sourceFile: SourceFile): NavigationInfo {
    const result: NavigationInfo = {
      visible: true,
      currentNavItem: null,
    };

    try {
      // Find globalNavigationStyle assignment
      const navStyleAssignment = sourceFile
        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
        .find((node) => {
          try {
            return node.getName() === 'globalNavigationStyle';
          } catch {
            return false;
          }
        });

      if (navStyleAssignment) {
        const parent = navStyleAssignment.getParent();
        if (Node.isBinaryExpression(parent)) {
          const right = parent.getRight();

          // Extract visible
          const visibleProp = right
            .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
            .find((prop) => {
              try {
                return prop.getName() === 'visible';
              } catch {
                return false;
              }
            });
          if (visibleProp) {
            result.visible = visibleProp.getInitializer()?.getText() === 'true';
          }

          // Extract currentNavItem
          const navItemProp = right
            .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
            .find((prop) => {
              try {
                return prop.getName() === 'currentNavItem';
              } catch {
                return false;
              }
            });
          if (navItemProp) {
            const value = navItemProp.getInitializer()?.getText();
            result.currentNavItem = value && value !== 'null' ? value.replace(/['"]/g, '') : null;
          }

          // Extract mini
          const miniProp = right
            .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
            .find((prop) => {
              try {
                return prop.getName() === 'mini';
              } catch {
                return false;
              }
            });
          if (miniProp) {
            result.mini = miniProp.getInitializer()?.getText() === 'true';
          }
        }
      }
    } catch {
      // Return default on error
    }

    return result;
  }

  /**
   * Extract multi-step flow information (wizard, stepper, onboarding)
   */
  private extractSteps(sourceFile: SourceFile): StepInfo[] {
    const steps: StepInfo[] = [];

    // Pattern 1: useState with step-like variable names
    const useStateCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText() === 'useState');

    for (const call of useStateCalls) {
      const parent = call.getParent();
      if (!parent) continue;

      const parentText = parent.getText();
      // Match: const [step, setStep] = useState(0) or [currentStep, setCurrentStep]
      const stepMatch = parentText.match(
        /\[\s*(step|currentStep|activeStep|page|currentPage|phase|stage)\s*,/i
      );
      if (stepMatch) {
        // Found a step state, now look for step-related JSX or switch cases
        const stepVarName = stepMatch[1];

        // Look for switch statements or conditional rendering
        const switchStatements = sourceFile.getDescendantsOfKind(SyntaxKind.SwitchStatement);
        for (const switchStmt of switchStatements) {
          const expression = switchStmt.getExpression().getText();
          if (expression.includes(stepVarName)) {
            const caseBlocks = switchStmt.getClauses();
            caseBlocks.forEach((clause, idx) => {
              if (clause.isKind(SyntaxKind.CaseClause)) {
                const caseExpr = clause.getExpression()?.getText() || String(idx);
                // Try to find component name in case block
                const jsxElements = clause.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);
                const componentName =
                  jsxElements.length > 0 ? jsxElements[0].getTagNameNode().getText() : undefined;

                steps.push({
                  id: caseExpr.replace(/['"]/g, ''),
                  name: `Step ${caseExpr.replace(/['"]/g, '')}`,
                  component: componentName,
                });
              }
            });
          }
        }

        // Look for array of steps/components
        const arrayLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression);
        for (const arr of arrayLiterals) {
          const parentVar = arr.getParent();
          if (parentVar && parentVar.getText().match(/steps|pages|screens|views|components/i)) {
            const elements = arr.getElements();
            elements.forEach((el, idx) => {
              const elText = el.getText();
              // Could be component reference or object
              if (elText.startsWith('{')) {
                // Object literal, try to extract name/label
                const nameMatch = elText.match(/(?:name|label|title)\s*:\s*['"]([^'"]+)['"]/);
                const compMatch = elText.match(/(?:component|content)\s*:\s*<?\s*(\w+)/);
                steps.push({
                  id: idx + 1,
                  name: nameMatch ? nameMatch[1] : `Step ${idx + 1}`,
                  component: compMatch ? compMatch[1] : undefined,
                });
              } else if (/^[A-Z]/.test(elText)) {
                // Component reference
                steps.push({
                  id: idx + 1,
                  name: elText,
                  component: elText,
                });
              }
            });
          }
        }
      }
    }

    // Pattern 2: Stepper/Wizard component usage
    const jsxElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);
    for (const jsx of jsxElements) {
      const tagName = jsx.getTagNameNode().getText();
      if (tagName.match(/Stepper|Wizard|Steps|TabPanel|FormStep/i)) {
        // Find Step children
        const parent = jsx.getParent();
        if (parent && parent.isKind(SyntaxKind.JsxElement)) {
          const children = parent.getJsxChildren();
          children.forEach((child, idx) => {
            if (
              child.isKind(SyntaxKind.JsxElement) ||
              child.isKind(SyntaxKind.JsxSelfClosingElement)
            ) {
              const childTag = child.isKind(SyntaxKind.JsxElement)
                ? child.getOpeningElement().getTagNameNode().getText()
                : child.getTagNameNode().getText();

              // Get label/title attribute
              const attrs = child.isKind(SyntaxKind.JsxElement)
                ? child.getOpeningElement().getAttributes()
                : child.getAttributes();

              let stepName = childTag;
              for (const attr of attrs) {
                if (attr.isKind(SyntaxKind.JsxAttribute)) {
                  const name = attr.getNameNode().getText();
                  if (name === 'label' || name === 'title' || name === 'name') {
                    const value = attr.getInitializer()?.getText();
                    if (value) {
                      stepName = value.replace(/['"{}]/g, '');
                      break;
                    }
                  }
                }
              }

              steps.push({
                id: idx + 1,
                name: stepName,
                component: childTag,
              });
            }
          });
        }
      }
    }

    // Pattern 3: Conditional rendering with step variable
    const conditionalExprs = sourceFile.getDescendantsOfKind(SyntaxKind.ConditionalExpression);
    for (const cond of conditionalExprs) {
      const condition = cond.getCondition().getText();
      if (condition.match(/step\s*===?\s*\d+|currentStep|activeStep/i)) {
        // Extract step number and components
        const whenTrue = cond.getWhenTrue();
        // Note: whenFalse (cond.getWhenFalse()) could be used for nested step detection

        const stepNumMatch = condition.match(/===?\s*(\d+)/);
        if (stepNumMatch && steps.length === 0) {
          // Only add if we haven't found steps through other patterns
          const trueJsx = whenTrue.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);

          if (trueJsx.length > 0) {
            steps.push({
              id: parseInt(stepNumMatch[1]),
              component: trueJsx[0].getTagNameNode().getText(),
            });
          }
        }
      }
    }

    return steps;
  }

  private extractLinkedPages(sourceFile: SourceFile): string[] {
    const linkedPages: string[] = [];

    // Find router.push/replace calls
    const routerCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => {
        const text = call.getExpression().getText();
        return (
          text.includes('router.push') || text.includes('router.replace') || text.includes('Link')
        );
      });

    for (const call of routerCalls) {
      const args = call.getArguments();
      if (args.length > 0) {
        const pathArg = args[0].getText();
        // Extract path string
        const pathMatch = pathArg.match(/['"`]([^'"`]+)['"`]/);
        if (pathMatch && !linkedPages.includes(pathMatch[1])) {
          linkedPages.push(pathMatch[1]);
        }
      }
    }

    // Find Link components
    const linkElements = sourceFile
      .getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
      .filter((node) => node.getTagNameNode().getText() === 'Link');

    for (const link of linkElements) {
      try {
        // Get all attributes and filter for JsxAttribute type (not JsxSpreadAttribute)
        const attributes = link.getAttributes();
        for (const attr of attributes) {
          // Check if it's a JsxAttribute
          if (attr.isKind(SyntaxKind.JsxAttribute)) {
            const nameNode = attr.getNameNode();
            const name = nameNode.getText();
            if (name === 'href') {
              const value = attr.getInitializer()?.getText();
              if (value) {
                const pathMatch = value.match(/['"`]([^'"`]+)['"`]/);
                if (pathMatch && !linkedPages.includes(pathMatch[1])) {
                  linkedPages.push(pathMatch[1]);
                }
              }
            }
          }
        }
      } catch {
        // Skip if attribute extraction fails
      }
    }

    return linkedPages;
  }
}
