import { Project, SyntaxKind, SourceFile, Node, FunctionDeclaration } from 'ts-morph';
import fg from 'fast-glob';
import * as path from 'path';
import { BaseAnalyzer } from './base-analyzer.js';
import type {
  AnalysisResult,
  DataFlow,
  ComponentInfo,
  PropInfo,
  RepositoryConfig,
} from '../types.js';

/**
 * Analyzer for data flow patterns
 * データフローパターンの分析器
 */
export class DataFlowAnalyzer extends BaseAnalyzer {
  private project: Project;
  private componentCache: Map<string, ComponentInfo> = new Map();

  constructor(config: RepositoryConfig) {
    super(config);
    this.project = new Project({
      tsConfigFilePath: this.resolvePath('tsconfig.json'),
      skipAddingFilesFromTsConfig: true,
    });
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

    const dirs = [
      this.getSetting('featuresDir', 'src/features'),
      this.getSetting('componentsDir', 'src/common/components'),
      this.getSetting('pagesDir', 'src/pages'),
    ];

    for (const dir of dirs) {
      const files = await fg(['**/*.tsx'], {
        cwd: this.resolvePath(dir),
        ignore: ['**/*.test.*', '**/*.spec.*', '**/*.stories.*'],
        absolute: true,
      });

      for (const filePath of files) {
        try {
          const sourceFile = this.project.addSourceFileAtPath(filePath);
          const relativePath = path.relative(this.basePath, filePath);
          const componentInfos = this.analyzeComponentFile(sourceFile, relativePath);
          components.push(...componentInfos);
        } catch (error) {
          this.warn(`Failed to analyze ${filePath}: ${(error as Error).message}`);
        }
      }
    }

    // Build dependency graph
    this.buildDependencyGraph(components);

    return components;
  }

  private analyzeComponentFile(sourceFile: SourceFile, filePath: string): ComponentInfo[] {
    const components: ComponentInfo[] = [];

    // Find function components
    const functionDeclarations = sourceFile.getFunctions();
    for (const func of functionDeclarations) {
      const name = func.getName();
      if (name && this.isComponentName(name)) {
        const info = this.extractComponentInfo(func, name, filePath);
        components.push(info);
        this.componentCache.set(name, info);
      }
    }

    // Find arrow function components
    const variableDeclarations = sourceFile.getVariableDeclarations();
    for (const varDecl of variableDeclarations) {
      const name = varDecl.getName();
      if (this.isComponentName(name)) {
        const initializer = varDecl.getInitializer();
        if (
          initializer &&
          (initializer.isKind(SyntaxKind.ArrowFunction) ||
            initializer.isKind(SyntaxKind.FunctionExpression))
        ) {
          const info = this.extractComponentInfo(initializer, name, filePath);
          components.push(info);
          this.componentCache.set(name, info);
        }
      }
    }

    // Find exported hooks
    const hookFunctions = sourceFile.getFunctions().filter((f) => {
      const name = f.getName();
      return name && name.startsWith('use');
    });

    for (const hook of hookFunctions) {
      const name = hook.getName() ?? '';
      const info = this.extractHookInfo(hook, name, filePath);
      components.push(info);
      this.componentCache.set(name, info);
    }

    return components;
  }

  private isComponentName(name: string): boolean {
    return /^[A-Z][a-zA-Z0-9]*$/.test(name);
  }

  private extractComponentInfo(node: Node, name: string, filePath: string): ComponentInfo {
    const sourceFile = node.getSourceFile();

    // Determine component type
    let type: ComponentInfo['type'] = 'presentational';
    if (filePath.includes('/pages/')) {
      type = 'page';
    } else if (name.includes('Container') || name.includes('Provider')) {
      type = 'container';
    } else if (name.includes('Layout')) {
      type = 'layout';
    }

    // Extract props
    const props = this.extractProps(node);

    // Extract hooks used
    const hooks = this.extractHooksUsed(node);

    // Extract dependencies (imported components)
    const dependencies = this.extractDependencies(sourceFile);

    // Extract state management patterns
    const stateManagement = this.extractStateManagement(node);

    return {
      name,
      filePath,
      type,
      props,
      dependencies,
      dependents: [], // Will be filled later
      hooks,
      stateManagement,
    };
  }

  private extractHookInfo(
    node: FunctionDeclaration,
    name: string,
    filePath: string
  ): ComponentInfo {
    const sourceFile = node.getSourceFile();

    const props = this.extractProps(node);
    const hooks = this.extractHooksUsed(node);
    const dependencies = this.extractDependencies(sourceFile);
    const stateManagement = this.extractStateManagement(node);

    return {
      name,
      filePath,
      type: 'hook',
      props,
      dependencies,
      dependents: [],
      hooks,
      stateManagement,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractProps(node: any): PropInfo[] {
    const props: PropInfo[] = [];

    // Get parameter type
    const parameters = node.getParameters?.() || [];
    if (parameters.length > 0) {
      const propsParam = parameters[0];
      const typeNode = propsParam.getTypeNode?.();

      if (typeNode) {
        // Extract properties from type
        const members = typeNode.getDescendantsOfKind?.(SyntaxKind.PropertySignature) || [];
        for (const member of members) {
          props.push({
            name: member.getName(),
            type: member.getType().getText(),
            required: !member.hasQuestionToken(),
          });
        }
      }
    }

    return props;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractHooksUsed(node: any): string[] {
    const hooks: string[] = [];

    const callExpressions = node.getDescendantsOfKind?.(SyntaxKind.CallExpression) || [];
    for (const call of callExpressions) {
      try {
        const callName = call.getExpression().getText();
        if (callName.startsWith('use')) {
          // For useQuery/useMutation, try to extract the operation name
          if (
            callName === 'useQuery' ||
            callName === 'useMutation' ||
            callName === 'useLazyQuery'
          ) {
            const operationInfo = this.extractOperationName(call, callName);
            if (!hooks.includes(operationInfo)) {
              hooks.push(operationInfo);
            }
          } else if (callName === 'useContext') {
            const contextInfo = this.extractContextName(call);
            if (!hooks.includes(contextInfo)) {
              hooks.push(contextInfo);
            }
          } else if (!hooks.includes(callName)) {
            hooks.push(callName);
          }
        }
      } catch {
        // Skip on error
      }
    }

    return hooks;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractOperationName(call: any, hookType: string): string {
    try {
      const args = call.getArguments?.() || [];
      if (args.length > 0) {
        const firstArg = args[0].getText();
        // Clean up the operation name
        const cleanName = firstArg
          .replace(/^(GET_|FETCH_|CREATE_|UPDATE_|DELETE_)/, '')
          .replace(/_QUERY$|_MUTATION$/, '')
          .replace(/Document$/, '')
          .replace(/Query$|Mutation$/, '');

        // Format nicely
        const icon = hookType === 'useMutation' ? '✏️' : '📡';
        const type = hookType === 'useMutation' ? 'Mutation' : 'Query';
        return `${icon} ${type}: ${cleanName}`;
      }
    } catch {
      // Ignore errors
    }
    return hookType;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractContextName(call: any): string {
    try {
      const args = call.getArguments?.() || [];
      if (args.length > 0) {
        const contextName = args[0]
          .getText()
          .replace(/Context$/, '')
          .replace(/^Session|^Token|^Apollo/, (m: string) => m);
        return `🔄 Context: ${contextName}`;
      }
    } catch {
      // Ignore errors
    }
    return 'useContext';
  }

  private extractDependencies(sourceFile: SourceFile): string[] {
    const dependencies: string[] = [];

    const importDeclarations = sourceFile.getImportDeclarations();
    for (const importDecl of importDeclarations) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();

      // Only track local imports
      if (moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('@/')) {
        const namedImports = importDecl.getNamedImports();
        for (const namedImport of namedImports) {
          const name = namedImport.getName();
          if (this.isComponentName(name) || name.startsWith('use')) {
            dependencies.push(name);
          }
        }

        const defaultImport = importDecl.getDefaultImport();
        if (defaultImport) {
          const name = defaultImport.getText();
          if (this.isComponentName(name)) {
            dependencies.push(name);
          }
        }
      }
    }

    return dependencies;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractStateManagement(node: any): string[] {
    const statePatterns: string[] = [];

    const nodeText = node.getText?.() || '';

    // Check for various state management patterns
    if (nodeText.includes('useState')) statePatterns.push('useState');
    if (nodeText.includes('useReducer')) statePatterns.push('useReducer');
    if (nodeText.includes('useContext')) statePatterns.push('useContext');
    if (nodeText.includes('useQuery')) statePatterns.push('Apollo Query');
    if (nodeText.includes('useMutation')) statePatterns.push('Apollo Mutation');
    if (nodeText.includes('useRecoil')) statePatterns.push('Recoil');
    if (nodeText.includes('useSelector') || nodeText.includes('useDispatch')) {
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
          name: `📡 ${operationName}`,
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
          name: `✏️ ${operationName}`,
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
