/**
 * Rails Controller Analyzer using tree-sitter
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import {
  parseRubyFile,
  findNodes,
  getClassName,
  getSuperclass,
  getMethodName,
  getMethodParameters,
  getChildrenByType,
  type SyntaxNode,
} from './ruby-parser.js';

export interface ControllerInfo {
  name: string;
  filePath: string;
  className: string;
  parentClass: string;
  namespace?: string;
  actions: ActionInfo[];
  beforeActions: FilterInfo[];
  afterActions: FilterInfo[];
  aroundActions: FilterInfo[];
  skipBeforeActions: FilterInfo[];
  concerns: string[];
  helpers: string[];
  rescueFrom: RescueInfo[];
  layoutInfo?: LayoutInfo;
  line: number;
}

export interface InstanceVarAssignment {
  name: string; // variable name without @
  assignedType?: string; // Model name if detected (e.g., "Company", "User")
  assignedValue?: string; // simplified value (e.g., "Company.find(...)", "params[:id]")
  line?: number;
}

export interface ActionInfo {
  name: string;
  line: number;
  visibility: 'public' | 'private' | 'protected';
  parameters: string[];
  rendersJson?: boolean;
  rendersHtml?: boolean;
  redirectsTo?: string;
  respondsTo?: string[];
  servicesCalled: string[];
  modelsCalled: string[];
  methodCalls: string[];
  instanceVarAssignments?: InstanceVarAssignment[];
}

export interface FilterInfo {
  name: string;
  only?: string[];
  except?: string[];
  if?: string;
  unless?: string;
  line: number;
}

export interface RescueInfo {
  exception: string;
  handler: string;
  line: number;
}

export interface LayoutInfo {
  name: string;
  conditions?: string;
}

export interface RailsControllersResult {
  controllers: ControllerInfo[];
  totalActions: number;
  namespaces: string[];
  concerns: string[];
  errors: string[];
}

export class RailsControllerAnalyzer {
  private controllersDir: string;
  private controllers: ControllerInfo[] = [];
  private errors: string[] = [];

  constructor(private rootPath: string) {
    this.controllersDir = path.join(rootPath, 'app', 'controllers');
  }

  async analyze(): Promise<RailsControllersResult> {
    if (!fs.existsSync(this.controllersDir)) {
      return {
        controllers: [],
        totalActions: 0,
        namespaces: [],
        concerns: [],
        errors: [`Controllers directory not found at ${this.controllersDir}`],
      };
    }

    const controllerFiles = await glob('**/*_controller.rb', {
      cwd: this.controllersDir,
      ignore: ['concerns/**'],
    });

    for (const file of controllerFiles) {
      const fullPath = path.join(this.controllersDir, file);
      try {
        const controller = await this.parseControllerFile(fullPath, file);
        if (controller) {
          this.controllers.push(controller);
        }
      } catch (error) {
        this.errors.push(`Error parsing ${file}: ${error}`);
      }
    }

    const namespaces = [
      ...new Set(this.controllers.filter((c) => c.namespace).map((c) => c.namespace as string)),
    ];

    const concerns = [...new Set(this.controllers.flatMap((c) => c.concerns))];

    const totalActions = this.controllers.reduce((sum, c) => sum + c.actions.length, 0);

    return {
      controllers: this.controllers,
      totalActions,
      namespaces,
      concerns,
      errors: this.errors,
    };
  }

  private async parseControllerFile(
    filePath: string,
    relativePath: string
  ): Promise<ControllerInfo | null> {
    const tree = await parseRubyFile(filePath);
    const rootNode = tree.rootNode;

    // Extract namespace from path
    const pathParts = relativePath.replace(/_controller\.rb$/, '').split('/');
    const namespace = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : undefined;
    const controllerName = pathParts[pathParts.length - 1];

    // Find class definition
    const classNodes = findNodes(rootNode, 'class');
    if (classNodes.length === 0) return null;

    const classNode = classNodes[0];
    const className = getClassName(classNode);
    const parentClass = getSuperclass(classNode);

    if (!className) return null;

    const controller: ControllerInfo = {
      name: controllerName,
      filePath: relativePath,
      className,
      parentClass: parentClass || 'ApplicationController',
      namespace,
      actions: [],
      beforeActions: [],
      afterActions: [],
      aroundActions: [],
      skipBeforeActions: [],
      concerns: [],
      helpers: [],
      rescueFrom: [],
      line: classNode.startPosition.row + 1,
    };

    // Find all method calls for filters, concerns, etc.
    const calls = findNodes(classNode, 'call');

    for (const call of calls) {
      const methodNode = call.childForFieldName('method');
      if (!methodNode) continue;

      const methodName = methodNode.text;
      const line = call.startPosition.row + 1;

      switch (methodName) {
        case 'before_action':
        case 'before_filter': // Legacy
          this.parseFilter(call, controller.beforeActions, line);
          break;

        case 'after_action':
        case 'after_filter':
          this.parseFilter(call, controller.afterActions, line);
          break;

        case 'around_action':
        case 'around_filter':
          this.parseFilter(call, controller.aroundActions, line);
          break;

        case 'skip_before_action':
        case 'skip_before_filter':
          this.parseFilter(call, controller.skipBeforeActions, line);
          break;

        case 'include':
          this.parseInclude(call, controller.concerns);
          break;

        case 'helper':
          this.parseHelper(call, controller.helpers);
          break;

        case 'layout':
          controller.layoutInfo = this.parseLayout(call);
          break;

        case 'rescue_from':
          this.parseRescueFrom(call, controller.rescueFrom, line);
          break;
      }
    }

    // Find all method definitions
    const _methods = findNodes(classNode, 'method');
    let currentVisibility: ActionInfo['visibility'] = 'public';

    // Track visibility changes through identifiers
    const bodyStatement = classNode.childForFieldName('body');
    if (bodyStatement) {
      for (let i = 0; i < bodyStatement.childCount; i++) {
        const child = bodyStatement.child(i);
        if (!child) continue;

        if (child.type === 'identifier') {
          const text = child.text;
          if (text === 'private') currentVisibility = 'private';
          else if (text === 'protected') currentVisibility = 'protected';
          else if (text === 'public') currentVisibility = 'public';
        } else if (child.type === 'method') {
          const action = this.parseMethod(child, currentVisibility);
          if (action) {
            controller.actions.push(action);
          }
        }
      }
    }

    return controller;
  }

  private parseFilter(call: SyntaxNode, filters: FilterInfo[], line: number): void {
    const args = this.getCallArguments(call);
    if (args.length === 0) return;

    // First argument is the filter name (symbol)
    const nameArg = args[0];
    const filterName = nameArg.text.replace(/^:/, '');

    const filter: FilterInfo = {
      name: filterName,
      line,
    };

    // Parse options
    for (const arg of args.slice(1)) {
      if (arg.type === 'hash') {
        const pairs = getChildrenByType(arg, 'pair');
        for (const pair of pairs) {
          const key = pair.child(0)?.text?.replace(/^:/, '');
          const value = pair.child(2);

          if (!key || !value) continue;

          switch (key) {
            case 'only':
              filter.only = this.extractArrayValues(value);
              break;
            case 'except':
              filter.except = this.extractArrayValues(value);
              break;
            case 'if':
              filter.if = value.text;
              break;
            case 'unless':
              filter.unless = value.text;
              break;
          }
        }
      }
    }

    filters.push(filter);
  }

  private parseInclude(call: SyntaxNode, concerns: string[]): void {
    const args = this.getCallArguments(call);
    for (const arg of args) {
      if (arg.type === 'constant' || arg.type === 'scope_resolution') {
        concerns.push(arg.text);
      }
    }
  }

  private parseHelper(call: SyntaxNode, helpers: string[]): void {
    const args = this.getCallArguments(call);
    for (const arg of args) {
      const value = arg.text.replace(/^:/, '');
      helpers.push(value);
    }
  }

  private parseLayout(call: SyntaxNode): LayoutInfo | undefined {
    const args = this.getCallArguments(call);
    if (args.length === 0) return undefined;

    const nameArg = args[0];
    let layoutName = nameArg.text.replace(/^["']|["']$/g, '');

    // Handle symbol
    if (layoutName.startsWith(':')) {
      layoutName = layoutName.substring(1);
    }

    // Handle proc/lambda (return false or dynamic)
    if (nameArg.type === 'lambda' || nameArg.type === 'proc') {
      layoutName = '(dynamic)';
    }

    const layout: LayoutInfo = { name: layoutName };

    // Parse conditions
    for (const arg of args.slice(1)) {
      if (arg.type === 'hash') {
        layout.conditions = arg.text;
      }
    }

    return layout;
  }

  private parseRescueFrom(call: SyntaxNode, rescues: RescueInfo[], line: number): void {
    const args = this.getCallArguments(call);
    if (args.length === 0) return;

    const exception = args[0].text;
    let handler = 'unknown';

    // Look for with: option
    for (const arg of args.slice(1)) {
      if (arg.type === 'hash' || arg.type === 'pair') {
        const pairs = arg.type === 'hash' ? getChildrenByType(arg, 'pair') : [arg];
        for (const pair of pairs) {
          const key = pair.child(0)?.text?.replace(/^:/, '');
          const value = pair.child(2);

          if (key === 'with' && value) {
            handler = value.text.replace(/^:/, '');
          }
        }
      }
    }

    rescues.push({ exception, handler, line });
  }

  private parseMethod(
    methodNode: SyntaxNode,
    visibility: ActionInfo['visibility']
  ): ActionInfo | null {
    const name = getMethodName(methodNode);
    if (!name) return null;

    // Skip singleton methods (def self.xxx)
    if (methodNode.text.includes('def self.')) return null;

    const action: ActionInfo = {
      name,
      line: methodNode.startPosition.row + 1,
      visibility,
      parameters: getMethodParameters(methodNode),
      servicesCalled: [],
      modelsCalled: [],
      methodCalls: [],
      instanceVarAssignments: [],
    };

    // Analyze method body
    const bodyContent = methodNode.text;

    // Extract instance variable assignments: @var = value
    const ivarRegex = /@([a-z_][a-z0-9_]*)\s*=\s*([^\n]+)/gi;
    let ivarMatch;
    while ((ivarMatch = ivarRegex.exec(bodyContent)) !== null) {
      const varName = ivarMatch[1];
      const assignedValue = ivarMatch[2].trim().slice(0, 100); // Truncate long values

      // Try to detect model type from assignment
      let assignedType: string | undefined;

      // Pattern: Model.find/where/new/create/etc
      const modelMatch = assignedValue.match(
        /^([A-Z][a-zA-Z0-9]+)\.(find|find_by|find_by!|where|all|first|last|new|create|create!|build)/
      );
      if (modelMatch) {
        assignedType = modelMatch[1];
      }

      // Pattern: @parent.association (e.g., @company.users)
      const assocMatch = assignedValue.match(/^@([a-z_]+)\.([a-z_]+)/);
      if (assocMatch && !assignedType) {
        assignedType = `${assocMatch[1]}.${assocMatch[2]}`;
      }

      // Pattern: current_user, current_company, etc.
      const currentMatch = assignedValue.match(/^current_([a-z_]+)/);
      if (currentMatch && !assignedType) {
        assignedType = currentMatch[1].charAt(0).toUpperCase() + currentMatch[1].slice(1);
      }

      // Pattern: SomeService.call (service result)
      const serviceMatch = assignedValue.match(/^([A-Z][a-zA-Z0-9]+Service)\.(call|new|perform)/);
      if (serviceMatch && !assignedType) {
        assignedType = `Service:${serviceMatch[1]}`;
      }

      if (action.instanceVarAssignments) {
        action.instanceVarAssignments.push({
          name: varName,
          assignedType,
          assignedValue:
            assignedValue.length > 60 ? assignedValue.slice(0, 57) + '...' : assignedValue,
        });
      }
    }

    // Check render types
    if (bodyContent.includes('render json:') || bodyContent.includes('render :json')) {
      action.rendersJson = true;
    }
    if (bodyContent.includes('render') && !action.rendersJson) {
      action.rendersHtml = true;
    }

    // Extract redirects
    const redirectMatch = bodyContent.match(/redirect_to\s+([^,\n]+)/);
    if (redirectMatch) {
      action.redirectsTo = redirectMatch[1].trim();
    }

    // Check respond_to formats
    if (bodyContent.includes('respond_to')) {
      const formats: string[] = [];
      if (bodyContent.includes('format.html')) formats.push('html');
      if (bodyContent.includes('format.json')) formats.push('json');
      if (bodyContent.includes('format.xml')) formats.push('xml');
      if (bodyContent.includes('format.js')) formats.push('js');
      if (bodyContent.includes('format.csv')) formats.push('csv');
      if (bodyContent.includes('format.pdf')) formats.push('pdf');
      if (formats.length > 0) {
        action.respondsTo = formats;
      }
    }

    // Find service calls
    const serviceCalls = findNodes(methodNode, 'call');
    for (const call of serviceCalls) {
      const receiver = call.childForFieldName('receiver');
      const method = call.childForFieldName('method');

      if (receiver && method) {
        const receiverText = receiver.text;
        const methodText = method.text;

        // Service pattern: SomeService.call/new/perform
        if (
          receiverText.endsWith('Service') &&
          ['call', 'new', 'perform', 'execute'].includes(methodText)
        ) {
          if (!action.servicesCalled.includes(receiverText)) {
            action.servicesCalled.push(receiverText);
          }
        }

        // Model pattern: User.find/where/create etc.
        const arMethods = [
          'find',
          'find_by',
          'find_by!',
          'where',
          'all',
          'first',
          'last',
          'create',
          'create!',
          'new',
          'update',
          'update!',
          'destroy',
          'delete',
        ];
        if (/^[A-Z][a-zA-Z]+$/.test(receiverText) && arMethods.includes(methodText)) {
          if (
            !['Rails', 'ActiveRecord', 'ActionController', 'ApplicationRecord'].includes(
              receiverText
            )
          ) {
            if (!action.modelsCalled.includes(receiverText)) {
              action.modelsCalled.push(receiverText);
            }
          }
        }

        // Track all method calls
        action.methodCalls.push(`${receiverText}.${methodText}`);
      } else if (method && !receiver) {
        // Method call without receiver
        action.methodCalls.push(method.text);
      }
    }

    return action;
  }

  private getCallArguments(call: SyntaxNode): SyntaxNode[] {
    const args = call.childForFieldName('arguments');
    if (!args) {
      // Arguments might be direct children without parentheses
      const results: SyntaxNode[] = [];
      for (let i = 0; i < call.childCount; i++) {
        const child = call.child(i);
        if (child && !['identifier', '(', ')', ',', 'call'].includes(child.type)) {
          // Skip the method name and receiver
          if (
            child !== call.childForFieldName('method') &&
            child !== call.childForFieldName('receiver')
          ) {
            results.push(child);
          }
        }
      }
      return results;
    }

    const results: SyntaxNode[] = [];
    for (let i = 0; i < args.childCount; i++) {
      const child = args.child(i);
      if (child && child.type !== '(' && child.type !== ')' && child.type !== ',') {
        results.push(child);
      }
    }
    return results;
  }

  private extractArrayValues(node: SyntaxNode): string[] {
    const values: string[] = [];

    if (node.type === 'array') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type !== '[' && child.type !== ']' && child.type !== ',') {
          values.push(child.text.replace(/^:/, ''));
        }
      }
    } else {
      values.push(node.text.replace(/^:/, ''));
    }

    return values;
  }
}

// Standalone execution for testing
async function main() {
  const targetPath = process.argv[2] || process.cwd();
  console.log(`Analyzing controllers in: ${targetPath}`);

  const analyzer = new RailsControllerAnalyzer(targetPath);
  const result = await analyzer.analyze();

  console.log('\n=== Rails Controllers Analysis ===\n');
  console.log(`Total controllers: ${result.controllers.length}`);
  console.log(`Total actions: ${result.totalActions}`);
  console.log(`Namespaces: ${result.namespaces.join(', ') || '(none)'}`);
  console.log(`Shared concerns: ${result.concerns.length}`);

  if (result.errors.length > 0) {
    console.log(`\n--- Errors (${result.errors.length}) ---`);
    for (const error of result.errors.slice(0, 5)) {
      console.log(`  ❌ ${error}`);
    }
    if (result.errors.length > 5) {
      console.log(`  ... and ${result.errors.length - 5} more`);
    }
  }

  console.log('\n--- Sample Controllers (first 10) ---');
  for (const controller of result.controllers.slice(0, 10)) {
    console.log(`\n  📁 ${controller.className} (${controller.filePath})`);
    console.log(`     Parent: ${controller.parentClass}`);
    console.log(
      `     Actions (${controller.actions.length}): ${controller.actions
        .map((a) => a.name)
        .slice(0, 5)
        .join(', ')}${controller.actions.length > 5 ? '...' : ''}`
    );
    if (controller.beforeActions.length > 0) {
      console.log(`     Before: ${controller.beforeActions.map((f) => f.name).join(', ')}`);
    }
    if (controller.concerns.length > 0) {
      console.log(`     Concerns: ${controller.concerns.join(', ')}`);
    }
  }

  // Summary of actions by visibility
  const publicActions = result.controllers.flatMap((c) =>
    c.actions.filter((a) => a.visibility === 'public')
  );
  const privateActions = result.controllers.flatMap((c) =>
    c.actions.filter((a) => a.visibility === 'private')
  );

  console.log('\n--- Action Visibility Summary ---');
  console.log(`  Public: ${publicActions.length}`);
  console.log(`  Private: ${privateActions.length}`);
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(console.error);
}
