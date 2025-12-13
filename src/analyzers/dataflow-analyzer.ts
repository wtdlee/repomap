import { parseSync, Module } from '@swc/core';
import fg from 'fast-glob';
import * as path from 'path';
import * as fs from 'fs/promises';
import { BaseAnalyzer } from './base-analyzer.js';
import type {
  AnalysisResult,
  DataFlow,
  ComponentInfo,
  PropInfo,
  RepositoryConfig,
} from '../types.js';

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
    const batchSize = 100;
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

  private extractHooksUsed(content: string): string[] {
    const hooks: string[] = [];

    // Match useQuery/useMutation/useLazyQuery with first argument (Document name)
    // Pattern: useQuery(DocumentName or useQuery<Type>(DocumentName
    const graphqlHookRegex =
      /\b(useQuery|useMutation|useLazyQuery)(?:<[^>]*>)?\s*\(\s*([A-Z_][A-Za-z0-9_]*)/g;
    let gqlMatch;
    while ((gqlMatch = graphqlHookRegex.exec(content)) !== null) {
      const hookName = gqlMatch[1];
      const docName = gqlMatch[2];

      // Skip generic variable names like Query, Mutation, QUERY, MUTATION
      if (/^(Query|Mutation|QUERY|MUTATION)$/i.test(docName)) {
        continue;
      }

      const operationName = this.extractOperationName(docName);

      if (hookName === 'useQuery' || hookName === 'useLazyQuery') {
        const hookInfo = operationName ? `Query: ${operationName}` : `Query: ${docName}`;
        if (!hooks.includes(hookInfo)) hooks.push(hookInfo);
      } else if (hookName === 'useMutation') {
        const hookInfo = operationName ? `Mutation: ${operationName}` : `Mutation: ${docName}`;
        if (!hooks.includes(hookInfo)) hooks.push(hookInfo);
      }
    }

    // Match other hooks (useState, useEffect, etc.)
    const hookRegex = /\b(use[A-Z][a-zA-Z0-9]*)\s*\(/g;
    let match;

    while ((match = hookRegex.exec(content)) !== null) {
      const hookName = match[1];

      // Skip already processed GraphQL hooks
      if (hookName === 'useQuery' || hookName === 'useMutation' || hookName === 'useLazyQuery') {
        continue;
      }

      if (hookName === 'useContext') {
        // Try to extract context name
        const contextMatch = content
          .slice(match.index)
          .match(/useContext\s*\(\s*([A-Z][A-Za-z0-9]*)/);
        if (contextMatch) {
          const contextName = contextMatch[1].replace(/Context$/, '');
          const hookInfo = `🔄 Context: ${contextName}`;
          if (!hooks.includes(hookInfo)) hooks.push(hookInfo);
        }
      } else if (!hooks.includes(hookName)) {
        hooks.push(hookName);
      }
    }

    return hooks;
  }

  private extractOperationName(args: string): string | null {
    if (!args) return null;

    // Get the first argument (operation name/document)
    const firstArg = args.split(',')[0].trim();

    // Skip object/array/string literals
    if (/^[{[\'"` ]/.test(firstArg)) return null;

    // Clean up the operation name
    const cleanName = firstArg
      .replace(/^(GET_|FETCH_|CREATE_|UPDATE_|DELETE_)/, '')
      .replace(/_QUERY$|_MUTATION$/, '')
      .replace(/Document$/, '')
      .replace(/Query$|Mutation$/, '');

    // Skip generic variable names
    if (!cleanName || cleanName.trim() === '' || /^(QUERY|MUTATION)$/i.test(cleanName.trim())) {
      return null;
    }

    return cleanName;
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
