/**
 * Rails Model Analyzer using tree-sitter
 * tree-sitterを使用してモデルファイルを解析する
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { 
  parseRubyFile, 
  findNodes, 
  getClassName,
  getSuperclass,
  getChildByType,
  getChildrenByType,
  type SyntaxNode 
} from './ruby-parser.js';

export interface ModelInfo {
  name: string;
  filePath: string;
  className: string;
  parentClass: string;
  tableName?: string;
  associations: AssociationInfo[];
  validations: ValidationInfo[];
  callbacks: CallbackInfo[];
  scopes: ScopeInfo[];
  concerns: string[];
  enums: EnumInfo[];
  attributes: AttributeInfo[];
  classMethodsCount: number;
  instanceMethodsCount: number;
  line: number;
}

export interface AssociationInfo {
  type: 'belongs_to' | 'has_one' | 'has_many' | 'has_and_belongs_to_many';
  name: string;
  className?: string;
  foreignKey?: string;
  through?: string;
  polymorphic?: boolean;
  dependent?: string;
  optional?: boolean;
  line: number;
}

export interface ValidationInfo {
  type: string; // presence, uniqueness, numericality, etc.
  attributes: string[];
  options?: Record<string, string>;
  line: number;
}

export interface CallbackInfo {
  type: string; // before_save, after_create, etc.
  method: string;
  conditions?: string;
  line: number;
}

export interface ScopeInfo {
  name: string;
  lambda: boolean;
  line: number;
}

export interface EnumInfo {
  name: string;
  values: string[];
  line: number;
}

export interface AttributeInfo {
  name: string;
  type?: string;
  default?: string;
  line: number;
}

export interface RailsModelsResult {
  models: ModelInfo[];
  totalAssociations: number;
  totalValidations: number;
  concerns: string[];
  namespaces: string[];
  errors: string[];
}

export class RailsModelAnalyzer {
  private modelsDir: string;
  private models: ModelInfo[] = [];
  private errors: string[] = [];

  constructor(private rootPath: string) {
    this.modelsDir = path.join(rootPath, 'app', 'models');
  }

  async analyze(): Promise<RailsModelsResult> {
    if (!fs.existsSync(this.modelsDir)) {
      return {
        models: [],
        totalAssociations: 0,
        totalValidations: 0,
        concerns: [],
        namespaces: [],
        errors: [`Models directory not found at ${this.modelsDir}`],
      };
    }

    const modelFiles = await glob('**/*.rb', {
      cwd: this.modelsDir,
      ignore: ['concerns/**', 'application_record.rb'],
    });

    for (const file of modelFiles) {
      const fullPath = path.join(this.modelsDir, file);
      try {
        const model = await this.parseModelFile(fullPath, file);
        if (model) {
          this.models.push(model);
        }
      } catch (error) {
        this.errors.push(`Error parsing ${file}: ${error}`);
      }
    }

    const concerns = [...new Set(
      this.models.flatMap(m => m.concerns)
    )];

    const namespaces = [...new Set(
      this.models
        .map(m => {
          const parts = m.filePath.split('/');
          return parts.length > 1 ? parts.slice(0, -1).join('/') : null;
        })
        .filter((n): n is string => n !== null)
    )];

    const totalAssociations = this.models.reduce(
      (sum, m) => sum + m.associations.length, 
      0
    );

    const totalValidations = this.models.reduce(
      (sum, m) => sum + m.validations.length, 
      0
    );

    return {
      models: this.models,
      totalAssociations,
      totalValidations,
      concerns,
      namespaces,
      errors: this.errors,
    };
  }

  private async parseModelFile(filePath: string, relativePath: string): Promise<ModelInfo | null> {
    const tree = await parseRubyFile(filePath);
    const rootNode = tree.rootNode;

    // Find class definition
    const classNodes = findNodes(rootNode, 'class');
    if (classNodes.length === 0) return null;

    const classNode = classNodes[0];
    const className = getClassName(classNode);
    const parentClass = getSuperclass(classNode);

    if (!className) return null;

    // Skip non-ActiveRecord models
    if (parentClass && !this.isActiveRecordModel(parentClass)) {
      // Still include it but mark as non-AR
    }

    const model: ModelInfo = {
      name: className.replace(/.*::/, ''), // Remove namespace prefix
      filePath: relativePath,
      className,
      parentClass: parentClass || 'ApplicationRecord',
      associations: [],
      validations: [],
      callbacks: [],
      scopes: [],
      concerns: [],
      enums: [],
      attributes: [],
      classMethodsCount: 0,
      instanceMethodsCount: 0,
      line: classNode.startPosition.row + 1,
    };

    // Parse table name if explicitly set
    model.tableName = this.parseTableName(classNode);

    // Find all method calls for associations, validations, etc.
    const calls = findNodes(classNode, 'call');
    
    for (const call of calls) {
      const methodNode = call.childForFieldName('method');
      if (!methodNode) continue;
      
      const methodName = methodNode.text;
      const line = call.startPosition.row + 1;

      // Associations
      if (['belongs_to', 'has_one', 'has_many', 'has_and_belongs_to_many'].includes(methodName)) {
        this.parseAssociation(call, methodName as AssociationInfo['type'], model.associations, line);
      }
      
      // Validations
      else if (methodName.startsWith('validates') || methodName === 'validate') {
        this.parseValidation(call, methodName, model.validations, line);
      }
      
      // Callbacks
      else if (this.isCallback(methodName)) {
        this.parseCallback(call, methodName, model.callbacks, line);
      }
      
      // Scopes
      else if (methodName === 'scope') {
        this.parseScope(call, model.scopes, line);
      }
      
      // Concerns
      else if (methodName === 'include') {
        this.parseInclude(call, model.concerns);
      }
      
      // Enums
      else if (methodName === 'enum') {
        this.parseEnum(call, model.enums, line);
      }
      
      // Attributes
      else if (methodName === 'attribute') {
        this.parseAttribute(call, model.attributes, line);
      }
    }

    // Count methods
    const methods = findNodes(classNode, 'method');
    const singletonMethods = findNodes(classNode, 'singleton_method');
    
    model.instanceMethodsCount = methods.length;
    model.classMethodsCount = singletonMethods.length;

    return model;
  }

  private isActiveRecordModel(parentClass: string): boolean {
    const arBases = [
      'ApplicationRecord',
      'ActiveRecord::Base',
      'ActiveRecord',
    ];
    return arBases.some(base => parentClass.includes(base));
  }

  private parseTableName(classNode: SyntaxNode): string | undefined {
    const calls = findNodes(classNode, 'call');
    
    for (const call of calls) {
      const methodNode = call.childForFieldName('method');
      if (methodNode?.text === 'table_name=') {
        const args = this.getCallArguments(call);
        if (args.length > 0) {
          return args[0].text.replace(/^["']|["']$/g, '');
        }
      }
    }

    // Also check for self.table_name = 
    const assignments = findNodes(classNode, 'assignment');
    for (const assignment of assignments) {
      const left = assignment.child(0);
      if (left?.text?.includes('table_name')) {
        const right = assignment.child(2);
        if (right) {
          return right.text.replace(/^["']|["']$/g, '');
        }
      }
    }

    return undefined;
  }

  private parseAssociation(
    call: SyntaxNode, 
    type: AssociationInfo['type'], 
    associations: AssociationInfo[], 
    line: number
  ): void {
    const args = this.getCallArguments(call);
    if (args.length === 0) return;

    const nameArg = args[0];
    const assocName = nameArg.text.replace(/^:/, '');

    const association: AssociationInfo = {
      type,
      name: assocName,
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
            case 'class_name':
              association.className = value.text.replace(/^["']|["']$/g, '');
              break;
            case 'foreign_key':
              association.foreignKey = value.text.replace(/^["']|["']$/g, '').replace(/^:/, '');
              break;
            case 'through':
              association.through = value.text.replace(/^:/, '');
              break;
            case 'polymorphic':
              association.polymorphic = value.text === 'true';
              break;
            case 'dependent':
              association.dependent = value.text.replace(/^:/, '');
              break;
            case 'optional':
              association.optional = value.text === 'true';
              break;
          }
        }
      }
    }

    associations.push(association);
  }

  private parseValidation(
    call: SyntaxNode, 
    methodName: string, 
    validations: ValidationInfo[], 
    line: number
  ): void {
    const args = this.getCallArguments(call);
    if (args.length === 0) return;

    // Extract attributes being validated
    const attributes: string[] = [];
    const options: Record<string, string> = {};
    let validationType = methodName;

    for (const arg of args) {
      if (arg.type === 'simple_symbol' || arg.type === 'symbol') {
        attributes.push(arg.text.replace(/^:/, ''));
      } else if (arg.type === 'hash') {
        const pairs = getChildrenByType(arg, 'pair');
        for (const pair of pairs) {
          const key = pair.child(0)?.text?.replace(/^:/, '');
          const value = pair.child(2);
          
          if (key && value) {
            // Validation type is usually the key (presence, uniqueness, etc.)
            if (['presence', 'uniqueness', 'numericality', 'length', 'format', 
                 'inclusion', 'exclusion', 'acceptance', 'confirmation'].includes(key)) {
              validationType = key;
              options[key] = value.text;
            } else {
              options[key] = value.text;
            }
          }
        }
      }
    }

    if (attributes.length > 0 || methodName === 'validate') {
      validations.push({
        type: validationType,
        attributes,
        options: Object.keys(options).length > 0 ? options : undefined,
        line,
      });
    }
  }

  private isCallback(methodName: string): boolean {
    const callbacks = [
      'before_validation', 'after_validation',
      'before_save', 'around_save', 'after_save',
      'before_create', 'around_create', 'after_create',
      'before_update', 'around_update', 'after_update',
      'before_destroy', 'around_destroy', 'after_destroy',
      'after_commit', 'after_rollback',
      'after_initialize', 'after_find', 'after_touch',
    ];
    return callbacks.includes(methodName);
  }

  private parseCallback(
    call: SyntaxNode, 
    type: string, 
    callbacks: CallbackInfo[], 
    line: number
  ): void {
    const args = this.getCallArguments(call);
    if (args.length === 0) return;

    const methodArg = args[0];
    const methodName = methodArg.text.replace(/^:/, '');

    const callback: CallbackInfo = {
      type,
      method: methodName,
      line,
    };

    // Check for conditions
    for (const arg of args.slice(1)) {
      if (arg.type === 'hash') {
        const pairs = getChildrenByType(arg, 'pair');
        for (const pair of pairs) {
          const key = pair.child(0)?.text?.replace(/^:/, '');
          const value = pair.child(2);
          
          if (key && value && ['if', 'unless'].includes(key)) {
            callback.conditions = `${key}: ${value.text}`;
          }
        }
      }
    }

    callbacks.push(callback);
  }

  private parseScope(call: SyntaxNode, scopes: ScopeInfo[], line: number): void {
    const args = this.getCallArguments(call);
    if (args.length === 0) return;

    const nameArg = args[0];
    const scopeName = nameArg.text.replace(/^:/, '');

    const isLambda = args.length > 1 && 
      (args[1].type === 'lambda' || args[1].text.includes('->'));

    scopes.push({
      name: scopeName,
      lambda: isLambda,
      line,
    });
  }

  private parseInclude(call: SyntaxNode, concerns: string[]): void {
    const args = this.getCallArguments(call);
    for (const arg of args) {
      if (arg.type === 'constant' || arg.type === 'scope_resolution') {
        concerns.push(arg.text);
      }
    }
  }

  private parseEnum(call: SyntaxNode, enums: EnumInfo[], line: number): void {
    const args = this.getCallArguments(call);
    if (args.length === 0) return;

    // enum status: { draft: 0, published: 1 }
    // or enum :status, { draft: 0, published: 1 }
    for (const arg of args) {
      if (arg.type === 'hash') {
        const pairs = getChildrenByType(arg, 'pair');
        for (const pair of pairs) {
          const key = pair.child(0)?.text?.replace(/^:/, '');
          const value = pair.child(2);
          
          if (key && value && value.type === 'hash') {
            const enumValues: string[] = [];
            const valuePairs = getChildrenByType(value, 'pair');
            for (const vp of valuePairs) {
              const vKey = vp.child(0)?.text?.replace(/^:/, '');
              if (vKey) enumValues.push(vKey);
            }
            
            enums.push({
              name: key,
              values: enumValues,
              line,
            });
          } else if (key && value && value.type === 'array') {
            // enum status: [:draft, :published]
            const enumValues: string[] = [];
            for (let i = 0; i < value.childCount; i++) {
              const child = value.child(i);
              if (child && child.type !== '[' && child.type !== ']' && child.type !== ',') {
                enumValues.push(child.text.replace(/^:/, ''));
              }
            }
            
            enums.push({
              name: key,
              values: enumValues,
              line,
            });
          }
        }
      }
    }
  }

  private parseAttribute(call: SyntaxNode, attributes: AttributeInfo[], line: number): void {
    const args = this.getCallArguments(call);
    if (args.length === 0) return;

    const nameArg = args[0];
    const attrName = nameArg.text.replace(/^:/, '');

    const attr: AttributeInfo = {
      name: attrName,
      line,
    };

    // Parse type and default
    if (args.length > 1) {
      const typeArg = args[1];
      attr.type = typeArg.text.replace(/^:/, '');
    }

    for (const arg of args) {
      if (arg.type === 'hash') {
        const pairs = getChildrenByType(arg, 'pair');
        for (const pair of pairs) {
          const key = pair.child(0)?.text?.replace(/^:/, '');
          const value = pair.child(2);
          
          if (key === 'default' && value) {
            attr.default = value.text;
          }
        }
      }
    }

    attributes.push(attr);
  }

  private getCallArguments(call: SyntaxNode): SyntaxNode[] {
    const args = call.childForFieldName('arguments');
    if (!args) {
      const results: SyntaxNode[] = [];
      for (let i = 0; i < call.childCount; i++) {
        const child = call.child(i);
        if (child && !['identifier', '(', ')', ',', 'call'].includes(child.type)) {
          if (child !== call.childForFieldName('method') && 
              child !== call.childForFieldName('receiver')) {
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
}

// Standalone execution for testing
async function main() {
  const targetPath = process.argv[2] || process.cwd();
  console.log(`Analyzing models in: ${targetPath}`);
  
  const analyzer = new RailsModelAnalyzer(targetPath);
  const result = await analyzer.analyze();
  
  console.log('\n=== Rails Models Analysis ===\n');
  console.log(`Total models: ${result.models.length}`);
  console.log(`Total associations: ${result.totalAssociations}`);
  console.log(`Total validations: ${result.totalValidations}`);
  console.log(`Shared concerns: ${result.concerns.length}`);
  console.log(`Namespaces: ${result.namespaces.join(', ') || '(none)'}`);
  
  if (result.errors.length > 0) {
    console.log(`\n--- Errors (${result.errors.length}) ---`);
    for (const error of result.errors.slice(0, 5)) {
      console.log(`  ❌ ${error}`);
    }
    if (result.errors.length > 5) {
      console.log(`  ... and ${result.errors.length - 5} more`);
    }
  }
  
  console.log('\n--- Sample Models (first 15) ---');
  for (const model of result.models.slice(0, 15)) {
    console.log(`\n  📦 ${model.className} (${model.filePath})`);
    console.log(`     Parent: ${model.parentClass}`);
    
    if (model.associations.length > 0) {
      const assocs = model.associations.slice(0, 3).map(a => `${a.type} :${a.name}`);
      console.log(`     Associations: ${assocs.join(', ')}${model.associations.length > 3 ? '...' : ''}`);
    }
    
    if (model.validations.length > 0) {
      console.log(`     Validations: ${model.validations.length}`);
    }
    
    if (model.scopes.length > 0) {
      const scopeNames = model.scopes.slice(0, 3).map(s => s.name);
      console.log(`     Scopes: ${scopeNames.join(', ')}${model.scopes.length > 3 ? '...' : ''}`);
    }
    
    if (model.enums.length > 0) {
      const enumInfo = model.enums.map(e => `${e.name}(${e.values.length})`);
      console.log(`     Enums: ${enumInfo.join(', ')}`);
    }

    if (model.concerns.length > 0) {
      console.log(`     Concerns: ${model.concerns.slice(0, 3).join(', ')}${model.concerns.length > 3 ? '...' : ''}`);
    }
  }

  // Association type summary
  const allAssociations = result.models.flatMap(m => m.associations);
  const belongsTo = allAssociations.filter(a => a.type === 'belongs_to').length;
  const hasMany = allAssociations.filter(a => a.type === 'has_many').length;
  const hasOne = allAssociations.filter(a => a.type === 'has_one').length;
  
  console.log('\n--- Association Summary ---');
  console.log(`  belongs_to: ${belongsTo}`);
  console.log(`  has_many: ${hasMany}`);
  console.log(`  has_one: ${hasOne}`);
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(console.error);
}

