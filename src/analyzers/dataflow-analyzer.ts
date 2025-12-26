import { parseSync, Module } from '@swc/core';
import { glob } from 'glob';
import * as path from 'path';
import * as fs from 'fs/promises';
import { BaseAnalyzer } from './base-analyzer.js';
import {
  isQueryHook,
  isMutationHook,
  isSubscriptionHook,
  cleanOperationName,
} from './graphql-utils.js';
import type { AnalysisResult, DataFlow, ComponentInfo, RepositoryConfig } from '../types.js';

/**
 * Analyzer for data flow patterns using @swc/core for fast parsing
 */
export class DataFlowAnalyzer extends BaseAnalyzer {
  private componentCache: Map<string, ComponentInfo> = new Map();
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
    return 'DataFlowAnalyzer';
  }

  async analyze(): Promise<Partial<AnalysisResult>> {
    this.log('Starting data flow analysis...');

    // Analyze components
    const components = await this.analyzeComponents();

    // Analyze data flows
    const dataFlows = await this.analyzeDataFlows(components);

    this.log(`Analyzed ${components.length} components and ${dataFlows.length} data flows`);

    return { components, dataFlows, coverage: this.coverage };
  }

  private async analyzeComponents(): Promise<ComponentInfo[]> {
    const components: ComponentInfo[] = [];

    // Use configured directories with common fallbacks
    const configuredDirs = [
      this.getSetting('featuresDir', ''),
      this.getSetting('componentsDir', ''),
      this.getSetting('pagesDir', ''),
    ].filter(Boolean);

    // Common directory patterns to scan (will skip non-existent)
    const commonDirs = [
      'src/features',
      'src/components',
      'src/common/components',
      'src/common',
      'src/pages',
      'src/app',
      'src/modules',
      'src/views',
      'src/screens',
      'components',
      'pages',
      'app',
    ];

    const dirs = [...new Set([...configuredDirs, ...commonDirs])];

    // Search all directories at once using glob patterns
    // Include both .tsx and .ts files to analyze custom hooks with GraphQL
    const patterns = dirs.flatMap((dir) => [`${dir}/**/*.tsx`, `${dir}/**/*.ts`]);
    const files = await glob(patterns, {
      cwd: this.basePath,
      ignore: [
        '**/*.test.*',
        '**/*.spec.*',
        '**/*.stories.*',
        '**/node_modules/**',
        '**/__generated__/**',
      ],
      absolute: true,
      nodir: true,
    });

    this.log(`[DataFlowAnalyzer] Found ${files.length} component files to analyze`);
    this.coverage.tsFilesScanned += files.length;

    // Process files in batches to avoid overwhelming I/O
    const batchSize = 50;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      // Read batch files in parallel
      const fileContents = await Promise.all(
        batch.map(async (filePath) => {
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            return { filePath, content };
          } catch {
            return null;
          }
        })
      );

      // Parse and analyze each file
      for (const file of fileContents) {
        if (!file) continue;
        try {
          const ast = parseSync(file.content, {
            syntax: 'typescript',
            tsx: true,
            comments: false,
          });
          const relativePath = path.relative(this.basePath, file.filePath);
          const componentInfos = this.analyzeComponentFile(ast, relativePath, file.content);
          components.push(...componentInfos);
        } catch {
          // Skip files that can't be parsed
          this.coverage.tsParseFailures += 1;
        }
      }
    }

    this.log(`[DataFlowAnalyzer] Extracted ${components.length} components`);

    // Build dependency graph
    this.buildDependencyGraph(components);

    return components;
  }

  private analyzeComponentFile(ast: Module, filePath: string, content: string): ComponentInfo[] {
    const components: ComponentInfo[] = [];
    const imports = this.extractImports(ast);

    for (const item of ast.body) {
      // Export function declaration: export function ComponentName() {}
      if (item.type === 'ExportDeclaration' && item.declaration?.type === 'FunctionDeclaration') {
        const name = item.declaration.identifier?.value;
        if (name && this.isComponentName(name)) {
          const info = this.extractComponentInfo(name, filePath, content, imports);
          components.push(info);
          this.componentCache.set(name, info);
        }
      }

      // Function declaration: function ComponentName() {}
      if (item.type === 'FunctionDeclaration') {
        const name = item.identifier?.value;
        if (name && this.isComponentName(name)) {
          const info = this.extractComponentInfo(name, filePath, content, imports);
          components.push(info);
          this.componentCache.set(name, info);
        }
      }

      // Export default function: export default function ComponentName() {}
      if (item.type === 'ExportDefaultDeclaration' && item.decl?.type === 'FunctionExpression') {
        const name = item.decl.identifier?.value;
        if (name && this.isComponentName(name)) {
          const info = this.extractComponentInfo(name, filePath, content, imports);
          components.push(info);
          this.componentCache.set(name, info);
        }
      }

      // Variable declaration: const ComponentName = () => {} or export const ComponentName = ...
      if (item.type === 'VariableDeclaration') {
        for (const d of item.declarations) {
          if (d.id?.type === 'Identifier') {
            const name = d.id.value;
            if (
              name &&
              (this.isComponentName(name) || name.startsWith('use')) &&
              d.init &&
              (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')
            ) {
              const info = this.extractComponentInfo(name, filePath, content, imports);
              components.push(info);
              this.componentCache.set(name, info);
            }
          }
        }
      }

      // Export variable declaration: export const ComponentName = () => {}
      if (item.type === 'ExportDeclaration' && item.declaration?.type === 'VariableDeclaration') {
        for (const d of item.declaration.declarations) {
          if (d.id?.type === 'Identifier') {
            const name = d.id.value;
            if (
              name &&
              (this.isComponentName(name) || name.startsWith('use')) &&
              d.init &&
              (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')
            ) {
              const info = this.extractComponentInfo(name, filePath, content, imports);
              components.push(info);
              this.componentCache.set(name, info);
            }
          }
        }
      }
    }

    return components;
  }

  private extractImports(ast: Module): Map<string, string> {
    const imports = new Map<string, string>();
    const aliasPrefixes = this.getListSetting('aliasPrefixes', ['@/', '~/', '#/']);

    for (const item of ast.body) {
      if (item.type === 'ImportDeclaration') {
        const source = item.source?.value || '';
        const isAlias = aliasPrefixes.some((p) => source.startsWith(p));
        if (source.startsWith('.') || isAlias) {
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
    }

    return imports;
  }

  private isComponentName(name: string): boolean {
    return /^[A-Z][a-zA-Z0-9]*$/.test(name);
  }

  private extractComponentInfo(
    name: string,
    filePath: string,
    content: string,
    imports: Map<string, string>
  ): ComponentInfo {
    // Determine component type based on path and naming conventions
    let type: ComponentInfo['type'] = 'presentational';

    // Page detection - common patterns for page components
    const pagePathPatterns = ['/pages/', '/app/', '/routes/', '/views/', '/screens/'];
    if (pagePathPatterns.some((pattern) => filePath.includes(pattern))) {
      type = 'page';
    } else if (name.includes('Container') || name.includes('Provider')) {
      type = 'container';
    } else if (
      name.includes('Layout') ||
      name.includes('Shell') ||
      name.includes('Wrapper') ||
      name.includes('Frame') ||
      name.includes('Scaffold') ||
      filePath.includes('/layouts/') ||
      filePath.includes('/layout/')
    ) {
      type = 'layout';
    } else if (name.startsWith('use')) {
      type = 'hook';
    }

    // Extract hooks used (using regex for speed)
    const hooks = this.extractHooksUsed(content);

    // Extract dependencies from imports (names only for backward compatibility)
    const dependencies = Array.from(imports.keys()).filter(
      (depName) => this.isComponentName(depName) || depName.startsWith('use')
    );

    // Extract import info with paths (for accurate GraphQL mapping)
    const importInfos: { name: string; path: string }[] = [];
    for (const [importName, importPath] of imports) {
      importInfos.push({ name: importName, path: importPath });
    }

    // Extract state management patterns
    const stateManagement = this.extractStateManagement(content);

    return {
      name,
      filePath,
      type,
      props: [], // Skip detailed prop extraction for performance
      dependencies,
      dependents: [], // Will be filled later
      hooks,
      stateManagement,
      imports: importInfos,
    };
  }

  /**
   * Extract hooks used in component using AST-based analysis
   * Uses parseSync for accurate detection instead of regex
   */
  private extractHooksUsed(content: string): string[] {
    const hooks: string[] = [];
    const seenHooks = new Set<string>();

    // Quick check: if no hooks pattern, skip parsing
    if (!content.includes('use')) {
      return hooks;
    }

    try {
      const ast = parseSync(content, {
        syntax: 'typescript',
        tsx: true,
        comments: false,
      });

      // Build Document import map for operation name resolution
      const documentImports = this.extractDocumentImportsFromAst(ast);

      // Build variable -> operation name mapping from gql() calls
      // e.g., const Query = gql(`query GetFollowPage { ... }`)
      const variableOperationMap = this.extractVariableOperationMap(ast, content);

      // Traverse AST to find all hook calls
      this.traverseForHooks(ast, content, documentImports, variableOperationMap, hooks, seenHooks);
    } catch {
      // Fallback to regex-based extraction if AST parsing fails
      this.extractHooksWithRegex(content, hooks, seenHooks);
    }

    return hooks;
  }

  /**
   * Extract Document imports from AST for operation name resolution
   */
  private extractDocumentImportsFromAst(ast: Module): Map<string, string> {
    const documentImports = new Map<string, string>();

    for (const item of ast.body) {
      if (item.type === 'ImportDeclaration') {
        const source = item.source?.value || '';
        const isGraphQLImport =
          source.includes('__generated__') ||
          source.includes('generated') ||
          source.includes('graphql') ||
          source.includes('.generated');

        for (const spec of item.specifiers || []) {
          let localName: string | undefined;
          if (spec.type === 'ImportSpecifier') {
            localName = spec.local?.value;
          } else if (spec.type === 'ImportDefaultSpecifier') {
            localName = spec.local?.value;
          }

          if (localName) {
            if (localName.endsWith('Document') || isGraphQLImport) {
              documentImports.set(localName, localName.replace(/Document$/, ''));
            }
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
   * Extract variable -> operation name mapping from gql() calls
   * e.g., const Query = gql(`query GetFollowPage { ... }`) -> { Query: "GetFollowPage" }
   */
  private extractVariableOperationMap(ast: Module, content: string): Map<string, string> {
    const variableMap = new Map<string, string>();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processVariableDeclaration = (node: any) => {
      if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return;

      const varName = node.id.value;
      const init = node.init;

      if (!init) return;

      // Handle: const Query = gql(`query GetFollowPage { ... }`)
      if (init.type === 'CallExpression') {
        const calleeName = this.getCalleeNameFromNode(init.callee);
        if (calleeName === 'gql' || calleeName === 'graphql') {
          const opName = this.extractOperationNameFromGqlCall(init, content);
          if (opName) {
            variableMap.set(varName, opName);
          }
        }
      }

      // Handle: const Query = gql`query GetFollowPage { ... }`
      if (init.type === 'TaggedTemplateExpression') {
        const tagName = this.getCalleeNameFromNode(init.tag);
        if (tagName === 'gql' || tagName === 'graphql') {
          if (init.template?.quasis?.[0]?.raw) {
            const templateContent = init.template.quasis[0].raw;
            const opMatch = templateContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
            if (opMatch) {
              variableMap.set(varName, opMatch[1]);
            }
          }
        }
      }
    };

    // Traverse AST to find variable declarations
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traverse = (node: any) => {
      if (!node || typeof node !== 'object') return;

      processVariableDeclaration(node);

      for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            traverse(item);
          }
        } else if (value && typeof value === 'object') {
          traverse(value);
        }
      }
    };

    traverse(ast);
    return variableMap;
  }

  /**
   * Extract operation name from gql() function call
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractOperationNameFromGqlCall(call: any, content: string): string | null {
    if (!call.arguments?.length) return null;

    const firstArgRaw = call.arguments[0];
    const firstArg = firstArgRaw?.expression || firstArgRaw;

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
   * Traverse AST to find hook calls
   */
  private traverseForHooks(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    content: string,
    documentImports: Map<string, string>,
    variableOperationMap: Map<string, string>,
    hooks: string[],
    seenHooks: Set<string>
  ): void {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'CallExpression') {
      this.analyzeHookCall(node, content, documentImports, variableOperationMap, hooks, seenHooks);
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          this.traverseForHooks(
            item,
            content,
            documentImports,
            variableOperationMap,
            hooks,
            seenHooks
          );
        }
      } else if (value && typeof value === 'object') {
        this.traverseForHooks(
          value,
          content,
          documentImports,
          variableOperationMap,
          hooks,
          seenHooks
        );
      }
    }
  }

  /**
   * Analyze a hook call expression
   */
  private analyzeHookCall(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call: any,
    content: string,
    documentImports: Map<string, string>,
    variableOperationMap: Map<string, string>,
    hooks: string[],
    seenHooks: Set<string>
  ): void {
    const calleeName = this.getCalleeNameFromNode(call.callee);
    if (!calleeName || !calleeName.startsWith('use')) return;

    // Check for GraphQL hooks using shared utilities
    const isQuery = isQueryHook(calleeName);
    const isMutation = isMutationHook(calleeName);
    const isSubscription = isSubscriptionHook(calleeName);

    if (isQuery || isMutation || isSubscription) {
      // IMPORTANT: Only classify as GraphQL if we can verify it has GraphQL arguments
      // This prevents false positives like useQueryParams, useQueryClient, etc.
      const hasGraphQLArgument = this.hasGraphQLArgument(
        call,
        content,
        documentImports,
        variableOperationMap
      );

      if (hasGraphQLArgument) {
        const operationName = this.extractOperationNameFromCall(
          call,
          content,
          documentImports,
          variableOperationMap
        );
        const hookType = isMutation ? 'Mutation' : isSubscription ? 'Subscription' : 'Query';
        const hookInfo = operationName ? `${hookType}: ${operationName}` : `${hookType}: unknown`;

        if (!seenHooks.has(hookInfo)) {
          seenHooks.add(hookInfo);
          hooks.push(hookInfo);
        }
        return;
      }
      // If no GraphQL argument found, fall through to treat as regular hook
    }

    // Handle useContext
    if (calleeName === 'useContext') {
      const contextName = this.extractContextName(call);
      if (contextName) {
        const hookInfo = `🔄 Context: ${contextName}`;
        if (!seenHooks.has(hookInfo)) {
          seenHooks.add(hookInfo);
          hooks.push(hookInfo);
        }
      }
      return;
    }

    // Other hooks (useState, useEffect, etc.)
    if (!seenHooks.has(calleeName)) {
      seenHooks.add(calleeName);
      hooks.push(calleeName);
    }
  }

  /**
   * Check if a hook call has GraphQL-related arguments
   * This verifies the hook is actually used for GraphQL, not just has a similar name
   */
  private hasGraphQLArgument(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call: any,
    content: string,
    documentImports: Map<string, string>,
    variableOperationMap: Map<string, string>
  ): boolean {
    // No arguments = not a GraphQL hook (e.g., useQueryClient())
    if (!call.arguments?.length) return false;

    const firstArgRaw = call.arguments[0];
    const firstArg = firstArgRaw?.expression || firstArgRaw;
    if (!firstArg) return false;

    // Check for various GraphQL argument patterns:

    // 1. Identifier that maps to a Document or gql() result
    if (firstArg.type === 'Identifier') {
      const argName = firstArg.value;

      // Check if it's a known Document import
      if (documentImports.has(argName)) return true;

      // Check if it's a variable from gql() call
      if (variableOperationMap.has(argName)) return true;

      // Check if name ends with Document, Query (capitalized), or Mutation
      // Supports both PascalCase (GetUserQuery) and UPPER_SNAKE_CASE (GET_USER_QUERY)
      if (
        argName.endsWith('Document') ||
        /[A-Z][a-z]*Query$/.test(argName) ||
        /[A-Z][a-z]*Mutation$/.test(argName) ||
        /^[A-Z][A-Z0-9_]*_QUERY$/.test(argName) ||
        /^[A-Z][A-Z0-9_]*_MUTATION$/.test(argName)
      ) {
        return true;
      }
    }

    // 2. Tagged template expression: gql`...` or graphql`...`
    if (firstArg.type === 'TaggedTemplateExpression') {
      const tagName = this.getCalleeNameFromNode(firstArg.tag);
      if (tagName === 'gql' || tagName === 'graphql') return true;
    }

    // 3. Call expression: graphql(...) or gql(...)
    if (firstArg.type === 'CallExpression') {
      const calleeName = this.getCalleeNameFromNode(firstArg.callee);
      if (calleeName === 'gql' || calleeName === 'graphql') return true;
    }

    // 4. Template literal containing GraphQL syntax
    if (firstArg.type === 'TemplateLiteral' && firstArg.quasis?.[0]?.raw) {
      const templateContent = firstArg.quasis[0].raw;
      if (/(?:query|mutation|subscription)\s+\w+/i.test(templateContent)) return true;
    }

    // 5. MemberExpression like Component.Query or queries.GetUser
    if (firstArg.type === 'MemberExpression') {
      const propName = firstArg.property?.value;
      if (propName && /Query$|Mutation$|Document$/.test(propName)) return true;
    }

    // 6. Check source content around the call for GraphQL indicators
    if (call.span) {
      const callContent = content.slice(
        call.span.start,
        Math.min(call.span.end, call.span.start + 500)
      );
      // Look for strong GraphQL indicators in the call
      if (
        callContent.includes('Document') ||
        /\bgql\s*[`(]/.test(callContent) ||
        /\bgraphql\s*[`(]/.test(callContent) ||
        /query\s+\w+\s*[({]/.test(callContent) ||
        /mutation\s+\w+\s*[({]/.test(callContent)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get callee name from call expression node
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getCalleeNameFromNode(callee: any): string | null {
    if (!callee) return null;

    if (callee.type === 'Identifier') {
      return callee.value;
    }

    if (callee.type === 'MemberExpression') {
      if (callee.property?.type === 'Identifier') {
        return callee.property.value;
      }
    }

    return null;
  }

  /**
   * Extract operation name from hook call arguments and type generics
   */
  private extractOperationNameFromCall(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    call: any,
    content: string,
    documentImports: Map<string, string>,
    variableOperationMap: Map<string, string>
  ): string | null {
    // Method 1: Extract from type generic - useQuery<GetUserQuery>
    if (call.typeArguments?.params?.length > 0) {
      const firstTypeArg = call.typeArguments.params[0];
      if (
        firstTypeArg?.type === 'TsTypeReference' &&
        firstTypeArg.typeName?.type === 'Identifier'
      ) {
        const typeName = firstTypeArg.typeName.value;
        return cleanOperationName(typeName);
      }
    }

    // Method 2: Extract from span position (fallback for type generics)
    if (call.callee?.span && call.span) {
      const start = call.callee.span.end;
      const end = Math.min(start + 150, call.span.end);
      const searchRegion = content.slice(start, end);
      const genericMatch = searchRegion.match(
        /^<\s*(\w+)(?:Query|Mutation|Variables|Subscription)?[\s,>]/
      );
      if (genericMatch) {
        return cleanOperationName(genericMatch[1]);
      }
    }

    // Method 3: Extract from first argument
    if (call.arguments?.length > 0) {
      // SWC arguments can be either { expression } or direct expression
      const firstArgRaw = call.arguments[0];
      const firstArg = firstArgRaw?.expression || firstArgRaw;

      if (!firstArg) return null;

      // Identifier: useQuery(GetUserDocument) or useQuery(Query)
      if (firstArg.type === 'Identifier') {
        const argName = firstArg.value;

        // Check variable -> operation name mapping first (from gql() calls)
        // This handles: const Query = gql(`query GetFollowPage { ... }`); useQuery(Query)
        const mappedOpName = variableOperationMap.get(argName);
        if (mappedOpName) {
          return mappedOpName;
        }

        // Check Document imports
        const importedName = documentImports.get(argName);
        if (importedName) {
          return importedName;
        }

        // Skip generic patterns only if no mapping found
        if (/^(Query|Mutation|QUERY|MUTATION)$/i.test(argName)) {
          return null;
        }

        return cleanOperationName(argName);
      }

      // MemberExpression: useQuery(queries.GetUser)
      if (firstArg.type === 'MemberExpression' && firstArg.property?.type === 'Identifier') {
        return cleanOperationName(firstArg.property.value);
      }

      // TaggedTemplateExpression: useQuery(gql`query GetUser { ... }`)
      if (firstArg.type === 'TaggedTemplateExpression') {
        if (firstArg.template?.quasis?.[0]?.raw) {
          const templateContent = firstArg.template.quasis[0].raw;
          const opMatch = templateContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
          if (opMatch) {
            return opMatch[1];
          }
        }
      }

      // CallExpression: useQuery(graphql(`query GetUser { ... }`))
      if (firstArg.type === 'CallExpression') {
        const nestedCallee = this.getCalleeNameFromNode(firstArg.callee);
        if (nestedCallee === 'graphql' || nestedCallee === 'gql') {
          // Extract from nested template literal
          if (firstArg.arguments?.length > 0) {
            const nestedArgRaw = firstArg.arguments[0];
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

      // TemplateLiteral directly: useQuery(`query GetUser { ... }`)
      if (firstArg.type === 'TemplateLiteral' && firstArg.quasis?.[0]?.raw) {
        const templateContent = firstArg.quasis[0].raw;
        const opMatch = templateContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
        if (opMatch) {
          return opMatch[1];
        }
      }
    }

    // Method 4: Fallback - extract from source content around the call
    if (call.span) {
      const callContent = content.slice(call.span.start, call.span.end);
      // Match Document name pattern
      const docMatch = callContent.match(/\b([A-Z][a-zA-Z0-9]*Document)\b/);
      if (docMatch) {
        return cleanOperationName(docMatch[1]);
      }
      // Match query/mutation in inline graphql
      const inlineMatch = callContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
      if (inlineMatch) {
        return inlineMatch[1];
      }
    }

    return null;
  }

  /**
   * Extract context name from useContext call
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractContextName(call: any): string | null {
    if (call.arguments?.length > 0) {
      const firstArg = call.arguments[0].expression;
      if (firstArg?.type === 'Identifier') {
        return firstArg.value.replace(/Context$/, '');
      }
    }
    return null;
  }

  /**
   * Fallback regex-based hook extraction
   */
  private extractHooksWithRegex(content: string, hooks: string[], seenHooks: Set<string>): void {
    // GraphQL hooks with multiline support
    const graphqlHookRegex =
      /\b(useQuery|useMutation|useLazyQuery|useSuspenseQuery|useBackgroundQuery|useSubscription)(?:<[^>]*>)?\s*\(\s*([A-Z_][A-Za-z0-9_]*)?/gs;
    let gqlMatch;

    while ((gqlMatch = graphqlHookRegex.exec(content)) !== null) {
      const hookName = gqlMatch[1];
      const docName = gqlMatch[2];

      if (docName && /^(Query|Mutation|QUERY|MUTATION)$/i.test(docName)) {
        continue;
      }

      const operationName = docName ? cleanOperationName(docName) : 'unknown';
      const hookType = hookName.includes('Mutation')
        ? 'Mutation'
        : hookName.includes('Subscription')
          ? 'Subscription'
          : 'Query';
      const hookInfo = `${hookType}: ${operationName}`;

      if (!seenHooks.has(hookInfo)) {
        seenHooks.add(hookInfo);
        hooks.push(hookInfo);
      }
    }

    // Other hooks
    const hookRegex = /\b(use[A-Z][a-zA-Z0-9]*)\s*\(/g;
    let match;

    while ((match = hookRegex.exec(content)) !== null) {
      const hookName = match[1];

      // Skip already processed GraphQL hooks
      if (
        [
          'useQuery',
          'useMutation',
          'useLazyQuery',
          'useSuspenseQuery',
          'useBackgroundQuery',
          'useSubscription',
        ].includes(hookName)
      ) {
        continue;
      }

      if (hookName === 'useContext') {
        const contextMatch = content
          .slice(match.index)
          .match(/useContext\s*\(\s*([A-Z][A-Za-z0-9]*)/);
        if (contextMatch) {
          const contextName = contextMatch[1].replace(/Context$/, '');
          const hookInfo = `🔄 Context: ${contextName}`;
          if (!seenHooks.has(hookInfo)) {
            seenHooks.add(hookInfo);
            hooks.push(hookInfo);
          }
        }
      } else if (!seenHooks.has(hookName)) {
        seenHooks.add(hookName);
        hooks.push(hookName);
      }
    }
  }

  private extractStateManagement(content: string): string[] {
    const statePatterns: string[] = [];

    if (content.includes('useState')) statePatterns.push('useState');
    if (content.includes('useReducer')) statePatterns.push('useReducer');
    if (content.includes('useContext')) statePatterns.push('useContext');
    if (content.includes('useQuery')) statePatterns.push('Apollo Query');
    if (content.includes('useMutation')) statePatterns.push('Apollo Mutation');
    if (content.includes('useRecoil')) statePatterns.push('Recoil');
    if (content.includes('useSelector') || content.includes('useDispatch')) {
      statePatterns.push('Redux');
    }

    return statePatterns;
  }

  private buildDependencyGraph(components: ComponentInfo[]): void {
    const componentMap = new Map<string, ComponentInfo>();
    for (const comp of components) {
      componentMap.set(comp.name, comp);
    }

    for (const comp of components) {
      for (const dep of comp.dependencies) {
        const depComponent = componentMap.get(dep);
        if (depComponent && !depComponent.dependents.includes(comp.name)) {
          depComponent.dependents.push(comp.name);
        }
      }
    }
  }

  private async analyzeDataFlows(components: ComponentInfo[]): Promise<DataFlow[]> {
    const dataFlows: DataFlow[] = [];
    let flowId = 1;

    // Analyze Context-based data flows
    const contextFlows = this.analyzeContextFlows(components);
    dataFlows.push(...contextFlows.map((flow) => ({ ...flow, id: `flow-${flowId++}` })));

    // Analyze Apollo data flows
    const apolloFlows = this.analyzeApolloFlows(components);
    dataFlows.push(...apolloFlows.map((flow) => ({ ...flow, id: `flow-${flowId++}` })));

    // Analyze prop drilling patterns
    const propDrillingFlows = this.analyzePropDrilling(components);
    dataFlows.push(...propDrillingFlows.map((flow) => ({ ...flow, id: `flow-${flowId++}` })));

    return dataFlows;
  }

  private analyzeContextFlows(components: ComponentInfo[]): Omit<DataFlow, 'id'>[] {
    const flows: Omit<DataFlow, 'id'>[] = [];

    // Find providers
    const providers = components.filter(
      (c) => c.name.includes('Provider') || c.name.includes('Context')
    );

    // Find consumers
    const consumers = components.filter((c) => c.hooks.some((h) => h.includes('Context')));

    for (const provider of providers) {
      const contextName = provider.name.replace('Provider', '').replace('Context', '');

      for (const consumer of consumers) {
        // Check if consumer uses this specific context
        const contextHook = consumer.hooks.find(
          (h) => h.includes('Context') && h.includes(contextName)
        );
        if (contextHook || consumer.hooks.some((h) => h.includes(contextName))) {
          flows.push({
            name: `🔄 ${contextName} Context`,
            description: `Data flows from ${provider.name} to ${consumer.name} via Context`,
            source: { type: 'context', name: provider.name },
            target: { type: 'component', name: consumer.name },
            via: [],
            operations: [contextHook || `useContext(${contextName})`],
          });
        }
      }
    }

    return flows;
  }

  private analyzeApolloFlows(components: ComponentInfo[]): Omit<DataFlow, 'id'>[] {
    const flows: Omit<DataFlow, 'id'>[] = [];

    for (const comp of components) {
      // Find all query hooks with their operation names
      const queryHooks = comp.hooks.filter(
        (h) => h.includes('Query:') || h === 'useQuery' || h === 'useLazyQuery'
      );
      for (const hook of queryHooks) {
        const operationName = hook.includes(':') ? hook.split(':')[1].trim() : comp.name;
        flows.push({
          name: `Query: ${operationName}`,
          description: `${comp.name} fetches ${operationName} via Apollo`,
          source: { type: 'api', name: `GraphQL: ${operationName}` },
          target: { type: 'component', name: comp.name },
          via: [{ type: 'cache', name: 'Apollo Cache' }],
          operations: [hook],
        });
      }

      // Find all mutation hooks with their operation names
      const mutationHooks = comp.hooks.filter(
        (h) => h.includes('Mutation:') || h === 'useMutation'
      );
      for (const hook of mutationHooks) {
        const operationName = hook.includes(':') ? hook.split(':')[1].trim() : comp.name;
        flows.push({
          name: `Mutation: ${operationName}`,
          description: `${comp.name} mutates ${operationName} via Apollo`,
          source: { type: 'component', name: comp.name },
          target: { type: 'api', name: `GraphQL: ${operationName}` },
          via: [],
          operations: [hook],
        });
      }
    }

    return flows;
  }

  private analyzePropDrilling(components: ComponentInfo[]): Omit<DataFlow, 'id'>[] {
    const flows: Omit<DataFlow, 'id'>[] = [];

    // Find components with many props that are passed down
    for (const comp of components) {
      if (comp.props.length > 5 && comp.dependents.length > 0) {
        flows.push({
          name: `Prop Drilling through ${comp.name}`,
          description: `${comp.name} passes ${comp.props.length} props to children`,
          source: { type: 'component', name: comp.name },
          target: { type: 'component', name: comp.dependents[0] },
          via: [],
          operations: ['props'],
        });
      }
    }

    return flows;
  }
}
