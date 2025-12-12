/**
 * Rails Routes Analyzer using tree-sitter
 * tree-sitterを使用してroutes.rbを解析する
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseRubyFile,
  findNodes,
  getChildText,
  getChildByType,
  getChildrenByType,
  getCallArguments,
  type SyntaxNode,
} from './ruby-parser.js';

export interface RailsRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  path: string;
  controller: string;
  action: string;
  name?: string;
  namespace?: string;
  authenticated?: boolean;
  line: number;
}

export interface ResourceInfo {
  name: string;
  controller: string;
  only?: string[];
  except?: string[];
  nested: ResourceInfo[];
  memberRoutes: RailsRoute[];
  collectionRoutes: RailsRoute[];
  line: number;
}

export interface MountedEngine {
  engine: string;
  mountPath: string;
  line: number;
}

export interface RailsRoutesResult {
  routes: RailsRoute[];
  namespaces: string[];
  resources: ResourceInfo[];
  mountedEngines: MountedEngine[];
  drawnFiles: string[];
  errors: string[];
}

export class RailsRoutesAnalyzer {
  private routesDir: string;
  private routes: RailsRoute[] = [];
  private namespaces: string[] = [];
  private resources: ResourceInfo[] = [];
  private mountedEngines: MountedEngine[] = [];
  private drawnFiles: string[] = [];
  private errors: string[] = [];

  constructor(private rootPath: string) {
    this.routesDir = path.join(rootPath, 'config', 'routes');
  }

  async analyze(): Promise<RailsRoutesResult> {
    const mainRoutesFile = path.join(this.rootPath, 'config', 'routes.rb');

    if (!fs.existsSync(mainRoutesFile)) {
      return {
        routes: [],
        namespaces: [],
        resources: [],
        mountedEngines: [],
        drawnFiles: [],
        errors: [`routes.rb not found at ${mainRoutesFile}`],
      };
    }

    try {
      await this.parseRoutesFile(mainRoutesFile, []);
    } catch (error) {
      this.errors.push(`Error parsing ${mainRoutesFile}: ${error}`);
    }

    return {
      routes: this.routes,
      namespaces: [...new Set(this.namespaces)],
      resources: this.resources,
      mountedEngines: this.mountedEngines,
      drawnFiles: this.drawnFiles,
      errors: this.errors,
    };
  }

  private async parseRoutesFile(filePath: string, currentNamespaces: string[]): Promise<void> {
    const tree = await parseRubyFile(filePath);
    const rootNode = tree.rootNode;

    // Find all method calls
    const calls = findNodes(rootNode, 'call');

    for (const call of calls) {
      const methodNode = call.childForFieldName('method');
      if (!methodNode) continue;

      const methodName = methodNode.text;
      const line = call.startPosition.row + 1;

      switch (methodName) {
        case 'get':
        case 'post':
        case 'put':
        case 'patch':
        case 'delete':
        case 'match':
          this.parseHttpRoute(call, methodName, currentNamespaces, line);
          break;

        case 'resources':
        case 'resource':
          await this.parseResources(call, currentNamespaces, line, methodName === 'resource');
          break;

        case 'namespace':
          await this.parseNamespace(call, currentNamespaces, filePath);
          break;

        case 'mount':
          this.parseMount(call, line);
          break;

        case 'draw':
          await this.parseDraw(call, currentNamespaces);
          break;

        case 'devise_for':
          this.parseDeviseFor(call, currentNamespaces, line);
          break;

        case 'root':
          this.parseRoot(call, currentNamespaces, line);
          break;
      }
    }
  }

  private parseHttpRoute(
    call: SyntaxNode,
    method: string,
    namespaces: string[],
    line: number
  ): void {
    const args = getCallArguments(call);
    if (args.length === 0) return;

    // First argument is the path
    const pathArg = args[0];
    let routePath = this.extractStringValue(pathArg);
    if (!routePath) return;

    // Find controller#action from 'to:' option or second argument
    let controller = '';
    let action = '';

    // Look for hash/pair arguments
    for (const arg of args) {
      if (arg.type === 'hash' || arg.type === 'pair') {
        const pairs = arg.type === 'hash' ? getChildrenByType(arg, 'pair') : [arg];
        for (const pair of pairs) {
          const key = pair.child(0)?.text?.replace(/^:/, '');
          const value = pair.child(2);

          if (key === 'to' && value) {
            const toValue = this.extractStringValue(value);
            if (toValue && toValue.includes('#')) {
              [controller, action] = toValue.split('#');
            }
          }
        }
      } else if (arg.type === 'string' || arg.type === 'string_content') {
        const strValue = this.extractStringValue(arg);
        if (strValue && strValue.includes('#') && !controller) {
          [controller, action] = strValue.split('#');
        }
      }
    }

    // If no explicit controller#action, try to infer from path
    if (!controller && !action) {
      const pathParts = routePath.replace(/^\//, '').split('/');
      controller = pathParts[0] || '';
      action = pathParts[1] || 'index';
    }

    // Apply namespace prefix
    if (namespaces.length > 0 && controller && !controller.includes('/')) {
      controller = `${namespaces.join('/')}/${controller}`;
    }

    // Build full path with namespace
    const fullPath = this.buildPath(namespaces, routePath);

    this.routes.push({
      method: method === 'match' ? 'ALL' : (method.toUpperCase() as RailsRoute['method']),
      path: fullPath,
      controller,
      action,
      namespace: namespaces.join('/') || undefined,
      line,
    });
  }

  private async parseResources(
    call: SyntaxNode,
    namespaces: string[],
    line: number,
    singular: boolean
  ): Promise<void> {
    const args = getCallArguments(call);
    if (args.length === 0) return;

    // First argument is the resource name (symbol)
    const nameArg = args[0];
    let resourceName = nameArg.text.replace(/^:/, '');

    const resource: ResourceInfo = {
      name: resourceName,
      controller: namespaces.length > 0 ? `${namespaces.join('/')}/${resourceName}` : resourceName,
      nested: [],
      memberRoutes: [],
      collectionRoutes: [],
      line,
    };

    // Parse options (only:, except:, etc.)
    for (const arg of args) {
      if (arg.type === 'hash') {
        const pairs = getChildrenByType(arg, 'pair');
        for (const pair of pairs) {
          const key = pair.child(0)?.text?.replace(/^:/, '');
          const value = pair.child(2);

          if (key === 'only' && value) {
            resource.only = this.extractArrayValues(value);
          } else if (key === 'except' && value) {
            resource.except = this.extractArrayValues(value);
          }
        }
      }
    }

    // Generate RESTful routes
    this.generateResourceRoutes(resource, namespaces, singular);
    this.resources.push(resource);

    // Parse nested block if exists
    const block = call.childForFieldName('block');
    if (block) {
      // Look for member/collection blocks and nested resources
      const nestedCalls = findNodes(block, 'call');
      for (const nestedCall of nestedCalls) {
        const nestedMethod = nestedCall.childForFieldName('method')?.text;

        if (nestedMethod === 'member') {
          // Parse member routes
          const memberBlock = nestedCall.childForFieldName('block');
          if (memberBlock) {
            this.parseMemberCollectionRoutes(memberBlock, resource, namespaces, 'member');
          }
        } else if (nestedMethod === 'collection') {
          // Parse collection routes
          const collectionBlock = nestedCall.childForFieldName('block');
          if (collectionBlock) {
            this.parseMemberCollectionRoutes(collectionBlock, resource, namespaces, 'collection');
          }
        }
      }
    }
  }

  private parseMemberCollectionRoutes(
    block: SyntaxNode,
    resource: ResourceInfo,
    namespaces: string[],
    type: 'member' | 'collection'
  ): void {
    const calls = findNodes(block, 'call');

    for (const call of calls) {
      const methodNode = call.childForFieldName('method');
      if (!methodNode) continue;

      const method = methodNode.text;
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

      const args = getCallArguments(call);
      if (args.length === 0) continue;

      const actionName = args[0].text.replace(/^:/, '');
      const basePath =
        type === 'member'
          ? `/${resource.name}/:id/${actionName}`
          : `/${resource.name}/${actionName}`;

      const route: RailsRoute = {
        method: method.toUpperCase() as RailsRoute['method'],
        path: this.buildPath(namespaces, basePath),
        controller: resource.controller,
        action: actionName,
        namespace: namespaces.join('/') || undefined,
        line: call.startPosition.row + 1,
      };

      if (type === 'member') {
        resource.memberRoutes.push(route);
      } else {
        resource.collectionRoutes.push(route);
      }
      this.routes.push(route);
    }
  }

  private async parseNamespace(
    call: SyntaxNode,
    currentNamespaces: string[],
    currentFile: string
  ): Promise<void> {
    const args = getCallArguments(call);
    if (args.length === 0) return;

    const nsName = args[0].text.replace(/^:/, '');
    this.namespaces.push(nsName);

    const newNamespaces = [...currentNamespaces, nsName];

    // Parse the namespace block
    const block = call.childForFieldName('block');
    if (block) {
      // Look for draw calls or nested route definitions
      const nestedCalls = findNodes(block, 'call');

      for (const nestedCall of nestedCalls) {
        const methodNode = nestedCall.childForFieldName('method');
        if (!methodNode) continue;

        const methodName = methodNode.text;
        const line = nestedCall.startPosition.row + 1;

        switch (methodName) {
          case 'get':
          case 'post':
          case 'put':
          case 'patch':
          case 'delete':
          case 'match':
            this.parseHttpRoute(nestedCall, methodName, newNamespaces, line);
            break;

          case 'resources':
          case 'resource':
            await this.parseResources(nestedCall, newNamespaces, line, methodName === 'resource');
            break;

          case 'draw':
            await this.parseDraw(nestedCall, newNamespaces);
            break;
        }
      }
    }
  }

  private parseMount(call: SyntaxNode, line: number): void {
    const args = getCallArguments(call);
    if (args.length === 0) return;

    // First arg is the engine
    const engineArg = args[0];
    const engine = engineArg.text;

    // Find mount path from 'at:' option or '=>' syntax
    let mountPath = '/';

    for (const arg of args) {
      if (arg.type === 'hash' || arg.type === 'pair') {
        const pairs = arg.type === 'hash' ? getChildrenByType(arg, 'pair') : [arg];
        for (const pair of pairs) {
          const key = pair.child(0)?.text?.replace(/^:/, '');
          const value = pair.child(2);

          if (key === 'at' && value) {
            mountPath = this.extractStringValue(value) || mountPath;
          }
        }
      } else if (arg.type === 'string') {
        // Could be the path in "mount Engine => '/path'" syntax
        const strValue = this.extractStringValue(arg);
        if (strValue && strValue.startsWith('/')) {
          mountPath = strValue;
        }
      }
    }

    this.mountedEngines.push({
      engine,
      mountPath,
      line,
    });
  }

  private async parseDraw(call: SyntaxNode, namespaces: string[]): Promise<void> {
    const args = getCallArguments(call);
    if (args.length === 0) return;

    const drawName = args[0].text.replace(/^:/, '');
    const drawFile = path.join(this.routesDir, `${drawName}.rb`);

    if (fs.existsSync(drawFile)) {
      this.drawnFiles.push(drawFile);
      try {
        await this.parseRoutesFile(drawFile, namespaces);
      } catch (error) {
        this.errors.push(`Error parsing drawn file ${drawFile}: ${error}`);
      }
    }
  }

  private parseDeviseFor(call: SyntaxNode, namespaces: string[], line: number): void {
    const args = getCallArguments(call);
    if (args.length === 0) return;

    const resource = args[0].text.replace(/^:/, '');

    // Generate standard Devise routes
    const deviseRoutes: Array<{
      method: RailsRoute['method'];
      path: string;
      action: string;
      controller: string;
    }> = [
      { method: 'GET', path: `/${resource}/sign_in`, action: 'new', controller: 'devise/sessions' },
      {
        method: 'POST',
        path: `/${resource}/sign_in`,
        action: 'create',
        controller: 'devise/sessions',
      },
      {
        method: 'DELETE',
        path: `/${resource}/sign_out`,
        action: 'destroy',
        controller: 'devise/sessions',
      },
      {
        method: 'GET',
        path: `/${resource}/password/new`,
        action: 'new',
        controller: 'devise/passwords',
      },
      {
        method: 'POST',
        path: `/${resource}/password`,
        action: 'create',
        controller: 'devise/passwords',
      },
      {
        method: 'GET',
        path: `/${resource}/sign_up`,
        action: 'new',
        controller: 'devise/registrations',
      },
      {
        method: 'POST',
        path: `/${resource}`,
        action: 'create',
        controller: 'devise/registrations',
      },
    ];

    for (const dr of deviseRoutes) {
      this.routes.push({
        method: dr.method,
        path: this.buildPath(namespaces, dr.path),
        controller: dr.controller,
        action: dr.action,
        namespace: namespaces.join('/') || undefined,
        line,
        authenticated: false,
      });
    }
  }

  private parseRoot(call: SyntaxNode, namespaces: string[], line: number): void {
    const args = getCallArguments(call);

    let controller = '';
    let action = 'index';

    for (const arg of args) {
      if (arg.type === 'string') {
        const value = this.extractStringValue(arg);
        if (value && value.includes('#')) {
          [controller, action] = value.split('#');
        }
      } else if (arg.type === 'hash' || arg.type === 'pair') {
        const pairs = arg.type === 'hash' ? getChildrenByType(arg, 'pair') : [arg];
        for (const pair of pairs) {
          const key = pair.child(0)?.text?.replace(/^:/, '');
          const value = pair.child(2);

          if (key === 'to' && value) {
            const toValue = this.extractStringValue(value);
            if (toValue && toValue.includes('#')) {
              [controller, action] = toValue.split('#');
            }
          }
        }
      }
    }

    if (controller) {
      this.routes.push({
        method: 'GET',
        path: this.buildPath(namespaces, '/'),
        controller,
        action,
        namespace: namespaces.join('/') || undefined,
        line,
      });
    }
  }

  private generateResourceRoutes(
    resource: ResourceInfo,
    namespaces: string[],
    singular: boolean
  ): void {
    const basePath = this.buildPath(namespaces, `/${resource.name}`);

    const allActions = singular
      ? ['show', 'new', 'create', 'edit', 'update', 'destroy']
      : ['index', 'show', 'new', 'create', 'edit', 'update', 'destroy'];

    const actions =
      resource.only ||
      (resource.except ? allActions.filter((a) => !resource.except!.includes(a)) : allActions);

    const restfulRoutes: Array<{ method: RailsRoute['method']; path: string; action: string }> = [];

    if (!singular) {
      if (actions.includes('index')) {
        restfulRoutes.push({ method: 'GET', path: basePath, action: 'index' });
      }
    }

    if (actions.includes('new')) {
      restfulRoutes.push({ method: 'GET', path: `${basePath}/new`, action: 'new' });
    }
    if (actions.includes('create')) {
      restfulRoutes.push({ method: 'POST', path: basePath, action: 'create' });
    }

    const showPath = singular ? basePath : `${basePath}/:id`;
    if (actions.includes('show')) {
      restfulRoutes.push({ method: 'GET', path: showPath, action: 'show' });
    }
    if (actions.includes('edit')) {
      restfulRoutes.push({ method: 'GET', path: `${showPath}/edit`, action: 'edit' });
    }
    if (actions.includes('update')) {
      restfulRoutes.push({ method: 'PUT', path: showPath, action: 'update' });
      restfulRoutes.push({ method: 'PATCH', path: showPath, action: 'update' });
    }
    if (actions.includes('destroy')) {
      restfulRoutes.push({ method: 'DELETE', path: showPath, action: 'destroy' });
    }

    for (const route of restfulRoutes) {
      this.routes.push({
        method: route.method,
        path: route.path,
        controller: resource.controller,
        action: route.action,
        namespace: namespaces.join('/') || undefined,
        line: resource.line,
      });
    }
  }

  private buildPath(namespaces: string[], routePath: string): string {
    if (routePath.startsWith('/')) {
      return routePath;
    }

    const nsPath = namespaces.length > 0 ? `/${namespaces.join('/')}` : '';
    return `${nsPath}/${routePath}`;
  }

  private extractStringValue(node: SyntaxNode): string | null {
    if (node.type === 'string') {
      // String has quotes, extract content
      const content = getChildByType(node, 'string_content');
      return content ? content.text : node.text.replace(/^["']|["']$/g, '');
    }
    if (node.type === 'string_content') {
      return node.text;
    }
    if (node.type === 'simple_symbol' || node.type === 'symbol') {
      return node.text.replace(/^:/, '');
    }
    return node.text.replace(/^["']|["']$/g, '');
  }

  private extractArrayValues(node: SyntaxNode): string[] {
    const values: string[] = [];

    if (node.type === 'array') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type !== '[' && child.type !== ']' && child.type !== ',') {
          const value = this.extractStringValue(child);
          if (value) values.push(value);
        }
      }
    } else {
      // Single value
      const value = this.extractStringValue(node);
      if (value) values.push(value);
    }

    return values;
  }
}

// Standalone execution for testing
async function main() {
  const targetPath = process.argv[2] || process.cwd();
  console.log(`Analyzing routes in: ${targetPath}`);

  const analyzer = new RailsRoutesAnalyzer(targetPath);
  const result = await analyzer.analyze();

  console.log('\n=== Rails Routes Analysis ===\n');
  console.log(`Total routes: ${result.routes.length}`);
  console.log(`Namespaces: ${result.namespaces.join(', ') || '(none)'}`);
  console.log(`Resources: ${result.resources.length}`);
  console.log(`Mounted engines: ${result.mountedEngines.length}`);
  console.log(`External route files: ${result.drawnFiles.length}`);

  if (result.errors.length > 0) {
    console.log(`\n--- Errors ---`);
    for (const error of result.errors) {
      console.log(`  ❌ ${error}`);
    }
  }

  console.log('\n--- Sample Routes (first 30) ---');
  for (const route of result.routes.slice(0, 30)) {
    console.log(
      `  ${route.method.padEnd(7)} ${route.path.padEnd(50)} => ${route.controller}#${route.action}`
    );
  }

  console.log('\n--- Mounted Engines ---');
  for (const engine of result.mountedEngines) {
    console.log(`  ${engine.engine} => ${engine.mountPath}`);
  }

  console.log('\n--- External Route Files ---');
  for (const file of result.drawnFiles) {
    console.log(`  ${path.basename(file)}`);
  }
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(console.error);
}
