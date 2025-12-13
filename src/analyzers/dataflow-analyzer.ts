import { parseSync, Module } from '@swc/core';
import fg from 'fast-glob';
import * as path from 'path';
import * as fs from 'fs/promises';
import { BaseAnalyzer } from './base-analyzer.js';
import {
  isQueryHook,
  isMutationHook,
  isSubscriptionHook,
  cleanOperationName,
} from './constants.js';
import type { AnalysisResult, DataFlow, ComponentInfo, RepositoryConfig } from '../types.js';

/**
 * Analyzer for data flow patterns using @swc/core for fast parsing
 * データフローパターンの分析器 (@swc/core使用)
 */
export class DataFlowAnalyzer extends BaseAnalyzer {
  private componentCache: Map<string, ComponentInfo> = new Map();

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

    return { components, dataFlows };
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
    const patterns = dirs.map((dir) => `${dir}/**/*.tsx`);
    const files = await fg(patterns, {
      cwd: this.basePath,
      ignore: [
        '**/*.test.*',
        '**/*.spec.*',
        '**/*.stories.*',
        '**/node_modules/**',
        '**/__generated__/**',
      ],
      absolute: true,
      onlyFiles: true,
      unique: true,
    });

    this.log(`[DataFlowAnalyzer] Found ${files.length} component files to analyze`);

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

    for (const item of ast.body) {
      if (item.type === 'ImportDeclaration') {
        const source = item.source?.value || '';
        if (source.startsWith('.') || source.startsWith('@/')) {
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

    // Extract dependencies from imports
    const dependencies = Array.from(imports.keys()).filter(
      (name) => this.isComponentName(name) || name.startsWith('use')
    );

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

      // Traverse AST to find all hook calls
      this.traverseForHooks(ast, content, documentImports, hooks, seenHooks);
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
   * Traverse AST to find hook calls
   */
  private traverseForHooks(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    content: string,
    documentImports: Map<string, string>,
    hooks: string[],
    seenHooks: Set<string>
  ): void {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'CallExpression') {
      this.analyzeHookCall(node, content, documentImports, hooks, seenHooks);
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          this.traverseForHooks(item, content, documentImports, hooks, seenHooks);
        }
      } else if (value && typeof value === 'object') {
        this.traverseForHooks(value, content, documentImports, hooks, seenHooks);
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
      const operationName = this.extractOperationNameFromCall(call, content, documentImports);
      const hookType = isMutation ? 'Mutation' : isSubscription ? 'Subscription' : 'Query';
      const hookInfo = operationName ? `${hookType}: ${operationName}` : `${hookType}: unknown`;

      if (!seenHooks.has(hookInfo)) {
        seenHooks.add(hookInfo);
        hooks.push(hookInfo);
      }
      return;
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
    documentImports: Map<string, string>
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
    if (call.callee?.span) {
      const start = call.callee.span.end;
      const searchRegion = content.slice(start, start + 100);
      const genericMatch = searchRegion.match(/^<(\w+)(?:Query|Mutation|Variables)?[,>]/);
      if (genericMatch) {
        return cleanOperationName(genericMatch[1]);
      }
    }

    // Method 3: Extract from first argument
    if (call.arguments?.length > 0) {
      const firstArg = call.arguments[0].expression;

      // Identifier: useQuery(GetUserDocument)
      if (firstArg?.type === 'Identifier') {
        const argName = firstArg.value;

        // Skip generic patterns
        if (/^(Query|Mutation|QUERY|MUTATION)$/i.test(argName)) {
          return null;
        }

        // Check Document imports
        const importedName = documentImports.get(argName);
        if (importedName) {
          return importedName;
        }

        return cleanOperationName(argName);
      }

      // MemberExpression: useQuery(queries.GetUser)
      if (firstArg?.type === 'MemberExpression' && firstArg.property?.type === 'Identifier') {
        return cleanOperationName(firstArg.property.value);
      }

      // TaggedTemplateExpression: useQuery(gql`query GetUser { ... }`)
      if (firstArg?.type === 'TaggedTemplateExpression') {
        if (firstArg.template?.quasis?.[0]?.raw) {
          const templateContent = firstArg.template.quasis[0].raw;
          const opMatch = templateContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
          if (opMatch) {
            return opMatch[1];
          }
        }
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
