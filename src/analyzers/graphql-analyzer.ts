import { parseSync, Module, TaggedTemplateExpression, CallExpression, Expression } from '@swc/core';
import fg from 'fast-glob';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseGraphQL, DocumentNode, DefinitionNode, TypeNode } from 'graphql';
import { BaseAnalyzer } from './base-analyzer.js';
import { parallelMapSafe } from '../utils/parallel.js';
import type {
  AnalysisResult,
  GraphQLOperation,
  VariableInfo,
  GraphQLField,
  RepositoryConfig,
} from '../types.js';

/**
 * Analyzer for GraphQL operations
 * GraphQL操作の分析器
 * Uses @swc/core for fast parsing
 */
export class GraphQLAnalyzer extends BaseAnalyzer {
  constructor(config: RepositoryConfig) {
    super(config);
  }

  getName(): string {
    return 'GraphQLAnalyzer';
  }

  async analyze(): Promise<Partial<AnalysisResult>> {
    this.log('Starting GraphQL analysis...');

    const operations: GraphQLOperation[] = [];

    // Analyze .graphql files
    this.log('[GraphQLAnalyzer] Step 1: Analyzing .graphql files...');
    const graphqlOperations = await this.analyzeGraphQLFiles();
    operations.push(...graphqlOperations);
    this.log(`[GraphQLAnalyzer] Step 1 done: ${graphqlOperations.length} from .graphql files`);

    // Analyze gql`` template literals in TypeScript files
    this.log('[GraphQLAnalyzer] Step 2: Analyzing inline GraphQL...');
    const inlineOperations = await this.analyzeInlineGraphQL();
    operations.push(...inlineOperations);
    this.log(`[GraphQLAnalyzer] Step 2 done: ${inlineOperations.length} inline operations`);

    // Analyze GraphQL Code Generator output (__generated__/graphql.ts)
    this.log('[GraphQLAnalyzer] Step 3: Analyzing codegen output...');
    const codegenOperations = await this.analyzeCodegenGenerated();
    operations.push(...codegenOperations);
    this.log(`[GraphQLAnalyzer] Step 3 done: ${codegenOperations.length} from codegen`);

    // Deduplicate operations by name (keep first occurrence)
    const uniqueOperations = this.deduplicateOperations(operations);
    this.log(`[GraphQLAnalyzer] Deduplicated: ${uniqueOperations.length} unique operations`);

    // Find where each operation is used (including Document imports)
    this.log('[GraphQLAnalyzer] Step 4: Finding operation usage...');
    await this.findOperationUsage(uniqueOperations);
    this.log('[GraphQLAnalyzer] Step 4 done');

    this.log(`Found ${uniqueOperations.length} GraphQL operations`);

    return { graphqlOperations: uniqueOperations };
  }

  /**
   * Deduplicate operations by name, keeping the first occurrence
   */
  private deduplicateOperations(operations: GraphQLOperation[]): GraphQLOperation[] {
    const seen = new Map<string, GraphQLOperation>();
    for (const op of operations) {
      if (!seen.has(op.name)) {
        seen.set(op.name, op);
      } else {
        // Merge usedIn arrays
        const existing = seen.get(op.name);
        if (existing) {
          for (const usedIn of op.usedIn) {
            if (!existing.usedIn.includes(usedIn)) {
              existing.usedIn.push(usedIn);
            }
          }
        }
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Analyze GraphQL Code Generator output files
   * Supports client preset pattern: __generated__/graphql.ts
   */
  private async analyzeCodegenGenerated(): Promise<GraphQLOperation[]> {
    const operations: GraphQLOperation[] = [];

    // Find potential codegen output files
    const generatedFiles = await fg(
      ['**/__generated__/graphql.ts', '**/__generated__/gql.ts', '**/generated/graphql.ts'],
      {
        cwd: this.basePath,
        ignore: ['**/node_modules/**', '**/.next/**'],
        absolute: true,
      }
    );

    for (const filePath of generatedFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const relativePath = path.relative(this.basePath, filePath);

        // Optimized line-by-line parsing (Document definitions are on single lines)
        const lines = content.split('\n');
        for (const line of lines) {
          // Quick check before regex
          if (!line.includes('Document =') || !line.includes('DocumentNode')) continue;

          // Match: export const XxxDocument = {...} as unknown as DocumentNode
          const match = line.match(
            /export\s+const\s+(\w+Document)\s*=\s*(\{"kind":"Document".+\})\s*as\s+unknown\s+as\s+DocumentNode/
          );
          if (!match) continue;

          const documentName = match[1];
          const documentJson = match[2];

          try {
            const documentObj = JSON.parse(documentJson);

            if (documentObj.kind === 'Document' && documentObj.definitions) {
              // Only process first definition (main operation)
              const def = documentObj.definitions[0];
              if (def?.kind === 'OperationDefinition') {
                const operationName = def.name?.value || documentName.replace(/Document$/, '');
                const operationType = def.operation as 'query' | 'mutation' | 'subscription';

                // Extract variables (simplified for performance)
                const variables: VariableInfo[] = (def.variableDefinitions || []).map(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (varDef: any) => ({
                    name: varDef.variable?.name?.value || 'unknown',
                    type: this.extractTypeFromAst(varDef.type),
                    required: varDef.type?.kind === 'NonNullType',
                  })
                );

                operations.push({
                  name: operationName,
                  type: operationType,
                  filePath: relativePath,
                  usedIn: [],
                  variables,
                  returnType: this.inferReturnTypeFromAst(def),
                  fragments: this.extractFragmentReferencesFromAst(def),
                  fields: this.extractFieldsFromAst(def.selectionSet),
                });
              }
            }
          } catch {
            // Skip unparseable JSON
          }
        }

        this.log(`Found ${operations.length} operations in codegen output: ${relativePath}`);
      } catch (error) {
        this.warn(`Failed to analyze codegen file ${filePath}: ${(error as Error).message}`);
      }
    }

    return operations;
  }

  /**
   * Extract type string from AST type node
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractTypeFromAst(typeNode: any): string {
    if (!typeNode) return 'unknown';

    if (typeNode.kind === 'NonNullType') {
      return `${this.extractTypeFromAst(typeNode.type)}!`;
    }
    if (typeNode.kind === 'ListType') {
      return `[${this.extractTypeFromAst(typeNode.type)}]`;
    }
    if (typeNode.kind === 'NamedType') {
      return typeNode.name?.value || 'unknown';
    }
    return 'unknown';
  }

  /**
   * Extract fields from AST selection set
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractFieldsFromAst(selectionSet: any, depth: number = 0): GraphQLField[] {
    if (!selectionSet?.selections || depth > 5) return [];

    const fields: GraphQLField[] = [];
    for (const selection of selectionSet.selections) {
      if (selection.kind === 'Field') {
        const field: GraphQLField = {
          name: selection.name?.value || 'unknown',
        };

        if (selection.arguments?.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const args = selection.arguments.map((arg: any) => arg.name?.value).join(', ');
          field.type = `(${args})`;
        }

        if (selection.selectionSet) {
          field.fields = this.extractFieldsFromAst(selection.selectionSet, depth + 1);
        }

        fields.push(field);
      } else if (selection.kind === 'FragmentSpread') {
        fields.push({ name: `...${selection.name?.value}`, type: 'fragment' });
      } else if (selection.kind === 'InlineFragment') {
        const typeName = selection.typeCondition?.name?.value || 'inline';
        fields.push({
          name: `... on ${typeName}`,
          type: 'inline-fragment',
          fields: this.extractFieldsFromAst(selection.selectionSet, depth + 1),
        });
      }
    }
    return fields;
  }

  /**
   * Extract fragment references from AST
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractFragmentReferencesFromAst(definition: any): string[] {
    const fragments: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visit = (node: any) => {
      if (!node) return;

      if (node.kind === 'FragmentSpread') {
        fragments.push(node.name?.value);
      }

      if (node.selectionSet?.selections) {
        for (const selection of node.selectionSet.selections) {
          visit(selection);
        }
      }
    };

    visit(definition);
    return fragments.filter(Boolean);
  }

  /**
   * Infer return type from AST definition
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inferReturnTypeFromAst(definition: any): string {
    if (definition.selectionSet?.selections?.length > 0) {
      const firstSelection = definition.selectionSet.selections[0];
      if (firstSelection.kind === 'Field') {
        return firstSelection.name?.value || 'unknown';
      }
    }
    return 'unknown';
  }

  private async analyzeGraphQLFiles(): Promise<GraphQLOperation[]> {
    const graphqlFiles = await fg(['**/*.graphql'], {
      cwd: this.basePath,
      ignore: ['**/node_modules/**', '**/.next/**'],
      absolute: true,
    });

    // Process files in parallel
    const results = await parallelMapSafe(graphqlFiles, async (filePath) => {
      const content = await fs.readFile(filePath, 'utf-8');
      const document = parseGraphQL(content);
      return this.extractOperationsFromDocument(document, path.relative(this.basePath, filePath));
    });

    return results.flat();
  }

  private async analyzeInlineGraphQL(): Promise<GraphQLOperation[]> {
    const operations: GraphQLOperation[] = [];

    const tsFiles = await fg(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'], {
      cwd: this.basePath,
      ignore: [
        '**/node_modules/**',
        '**/.next/**',
        '**/__tests__/**',
        '**/*.test.*',
        '**/*.spec.*',
        '**/__generated__/**',
      ],
      absolute: true,
    });

    // Process files in parallel batches
    const batchSize = 100;
    for (let i = 0; i < tsFiles.length; i += batchSize) {
      const batch = tsFiles.slice(i, i + batchSize);
      const results = await parallelMapSafe(
        batch,
        async (filePath) => {
          try {
            const content = await fs.readFile(filePath, 'utf-8');

            // Quick pre-filter: skip files without GraphQL indicators
            if (!content.includes('gql') && !content.includes('graphql')) {
              return [];
            }

            const relativePath = path.relative(this.basePath, filePath);
            const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');

            const ast = parseSync(content, {
              syntax:
                filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'ecmascript',
              tsx: isTsx,
              jsx: isTsx,
            });

            return this.analyzeModuleForGraphQL(ast, content, relativePath);
          } catch {
            return [];
          }
        },
        10
      );
      operations.push(...results.flat());
    }

    return operations;
  }

  /**
   * Analyze a parsed module for GraphQL operations
   */
  private analyzeModuleForGraphQL(
    ast: Module,
    content: string,
    filePath: string
  ): GraphQLOperation[] {
    const operations: GraphQLOperation[] = [];
    const variableContextStack: string[] = [];

    // Traverse AST to find tagged templates and call expressions
    this.traverseNodeWithContext(ast, variableContextStack, (node, currentVarName) => {
      // Tagged template: gql`...` or graphql`...`
      if (node.type === 'TaggedTemplateExpression') {
        const tagged = node as TaggedTemplateExpression;
        const tagName = this.getTagName(tagged.tag);

        if (tagName === 'gql' || tagName === 'graphql') {
          const graphqlContent = this.extractTemplateContent(tagged.template, content);
          if (graphqlContent) {
            try {
              const document = parseGraphQL(graphqlContent);
              const fileOps = this.extractOperationsFromDocument(document, filePath);

              // Add variable name context
              if (currentVarName) {
                for (const op of fileOps) {
                  op.variableNames = op.variableNames || [];
                  op.variableNames.push(currentVarName);
                  op.variableNames.push(`${op.name}Document`);
                }
              }

              operations.push(...fileOps);
            } catch {
              // Skip unparseable GraphQL
            }
          }
        }
      }

      // Call expression: gql(`...`) or graphql(`...`)
      if (node.type === 'CallExpression') {
        const call = node as CallExpression;
        const calleeName = this.getCalleeName(call.callee);

        if (calleeName === 'gql' || calleeName === 'graphql') {
          if (call.arguments.length > 0) {
            const firstArg = call.arguments[0].expression;
            const graphqlContent = this.extractGraphQLFromExpression(firstArg, content);

            if (graphqlContent) {
              try {
                const document = parseGraphQL(graphqlContent);
                const fileOps = this.extractOperationsFromDocument(document, filePath);

                // Add variable name context
                if (currentVarName) {
                  for (const op of fileOps) {
                    op.variableNames = op.variableNames || [];
                    op.variableNames.push(currentVarName);
                    op.variableNames.push(`${op.name}Document`);
                  }
                }

                operations.push(...fileOps);
              } catch {
                // Skip unparseable GraphQL
              }
            }
          }
        }
      }
    });

    return operations;
  }

  /**
   * Traverse AST nodes with variable context tracking
   */

  private traverseNodeWithContext(
    node: any,
    varStack: string[],
    callback: (node: any, currentVarName: string | null) => void
  ): void {
    if (!node || typeof node !== 'object') return;

    // Track variable declaration context
    let addedVar = false;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      varStack.push(node.id.value);
      addedVar = true;
    }

    callback(node, varStack.length > 0 ? varStack[varStack.length - 1] : null);

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          this.traverseNodeWithContext(item, varStack, callback);
        }
      } else if (value && typeof value === 'object') {
        this.traverseNodeWithContext(value, varStack, callback);
      }
    }

    if (addedVar) {
      varStack.pop();
    }
  }

  /**
   * Get tag name from tagged template expression
   */
  private getTagName(tag: Expression): string | null {
    if (tag.type === 'Identifier') {
      return tag.value;
    }
    return null;
  }

  /**
   * Get callee name from call expression
   */
  private getCalleeName(callee: Expression | { type: 'Super' | 'Import' }): string | null {
    if (callee.type === 'Identifier') {
      return callee.value;
    }
    return null;
  }

  /**
   * Extract content from template literal
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractTemplateContent(template: any, fullContent: string): string | null {
    if (template.type === 'TemplateLiteral') {
      // Simple template without expressions
      if (template.quasis.length === 1 && template.expressions.length === 0) {
        return template.quasis[0].raw;
      }
      // Template with expressions - extract from source
      const start = template.span.start;
      const end = template.span.end;
      const rawContent = fullContent.slice(start, end);
      // Remove backticks and interpolations
      return rawContent.slice(1, -1).replace(/\$\{[^}]*\}/g, '');
    }
    return null;
  }

  /**
   * Extract GraphQL content from expression (handles various patterns)
   */
  private extractGraphQLFromExpression(expr: Expression, fullContent: string): string | null {
    if (expr.type === 'TemplateLiteral') {
      return this.extractTemplateContent(expr, fullContent);
    }

    // Handle /* GraphQL */ `...` pattern - extract from source
    if (expr.type === 'StringLiteral') {
      return expr.value;
    }

    return null;
  }

  private extractOperationsFromDocument(
    document: DocumentNode,
    filePath: string
  ): GraphQLOperation[] {
    const operations: GraphQLOperation[] = [];

    for (const definition of document.definitions) {
      const operation = this.extractOperation(definition, filePath);
      if (operation) {
        operations.push(operation);
      }
    }

    return operations;
  }

  private extractOperation(definition: DefinitionNode, filePath: string): GraphQLOperation | null {
    if (definition.kind === 'OperationDefinition') {
      const name = definition.name?.value || 'anonymous';
      const type = definition.operation as 'query' | 'mutation' | 'subscription';
      const variables = this.extractVariables(definition);
      const fragments = this.extractFragmentReferences(definition);
      const fields = this.extractFields(definition);

      return {
        name,
        type,
        filePath,
        usedIn: [],
        variables,
        returnType: this.inferReturnType(definition),
        fragments,
        fields,
      };
    }

    if (definition.kind === 'FragmentDefinition') {
      return {
        name: definition.name.value,
        type: 'fragment',
        filePath,
        usedIn: [],
        variables: [],
        returnType: definition.typeCondition.name.value,
        fragments: this.extractFragmentReferences(definition),
        fields: this.extractFields(definition),
      };
    }

    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractFields(definition: any): GraphQLField[] {
    const fields: GraphQLField[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extractFromSelectionSet = (selectionSet: any, depth: number = 0): GraphQLField[] => {
      if (!selectionSet || !selectionSet.selections || depth > 5) return [];

      const result: GraphQLField[] = [];
      for (const selection of selectionSet.selections) {
        if (selection.kind === 'Field') {
          const field: GraphQLField = {
            name: selection.name.value,
          };

          // Extract arguments as part of type info
          if (selection.arguments && selection.arguments.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const args = selection.arguments.map((arg: any) => arg.name.value).join(', ');
            field.type = `(${args})`;
          }

          // Recursively extract nested fields
          if (selection.selectionSet) {
            field.fields = extractFromSelectionSet(selection.selectionSet, depth + 1);
          }

          result.push(field);
        } else if (selection.kind === 'FragmentSpread') {
          result.push({ name: `...${selection.name.value}`, type: 'fragment' });
        } else if (selection.kind === 'InlineFragment') {
          if (selection.selectionSet) {
            const typeName = selection.typeCondition?.name?.value || 'inline';
            result.push({
              name: `... on ${typeName}`,
              type: 'inline-fragment',
              fields: extractFromSelectionSet(selection.selectionSet, depth + 1),
            });
          }
        }
      }
      return result;
    };

    if (definition.selectionSet) {
      return extractFromSelectionSet(definition.selectionSet);
    }

    return fields;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractVariables(definition: any): VariableInfo[] {
    const variables: VariableInfo[] = [];

    if (definition.variableDefinitions) {
      for (const varDef of definition.variableDefinitions) {
        const name = varDef.variable.name.value;
        const type = this.typeNodeToString(varDef.type);
        const required = varDef.type.kind === 'NonNullType';

        variables.push({ name, type, required });
      }
    }

    return variables;
  }

  private typeNodeToString(typeNode: TypeNode): string {
    if (typeNode.kind === 'NonNullType') {
      return `${this.typeNodeToString(typeNode.type)}!`;
    }
    if (typeNode.kind === 'ListType') {
      return `[${this.typeNodeToString(typeNode.type)}]`;
    }
    if (typeNode.kind === 'NamedType') {
      return typeNode.name.value;
    }
    return 'unknown';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractFragmentReferences(definition: any): string[] {
    const fragments: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visit = (node: any) => {
      if (!node) return;

      if (node.kind === 'FragmentSpread') {
        fragments.push(node.name.value);
      }

      if (node.selectionSet) {
        for (const selection of node.selectionSet.selections) {
          visit(selection);
        }
      }
    };

    visit(definition);
    return fragments;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inferReturnType(definition: any): string {
    if (definition.selectionSet && definition.selectionSet.selections.length > 0) {
      const firstSelection = definition.selectionSet.selections[0];
      if (firstSelection.kind === 'Field') {
        return firstSelection.name.value;
      }
    }
    return 'unknown';
  }

  private async findOperationUsage(operations: GraphQLOperation[]): Promise<void> {
    if (operations.length === 0) return;

    const tsFiles = await fg(['**/*.ts', '**/*.tsx'], {
      cwd: this.basePath,
      ignore: ['**/node_modules/**', '**/.next/**', '**/__generated__/**'],
      absolute: true,
    });

    // Build lookup maps for O(1) access
    const operationByName = new Map<string, GraphQLOperation>();
    const operationByDocument = new Map<string, GraphQLOperation>();
    const operationByVariableName = new Map<string, GraphQLOperation>();

    for (const op of operations) {
      operationByName.set(op.name, op);
      operationByDocument.set(`${op.name}Document`, op);
      // Map all variable names to operation
      if (op.variableNames) {
        for (const varName of op.variableNames) {
          operationByVariableName.set(varName, op);
        }
      }
    }

    // Collect all searchable names for single regex
    const allSearchableNames = new Set<string>();
    for (const op of operations) {
      allSearchableNames.add(`${op.name}Document`);
      if (op.variableNames) {
        for (const varName of op.variableNames) {
          allSearchableNames.add(varName);
        }
      }
    }

    // Build a single regex to match all names at once (if not too large)
    let namesPattern: RegExp | null = null;
    const namesArray = Array.from(allSearchableNames);
    if (namesArray.length > 0 && namesArray.length < 2000) {
      // Escape special regex chars and sort by length (longest first) for proper matching
      const escaped = namesArray
        .sort((a, b) => b.length - a.length)
        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      namesPattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'g');
    }

    // Process files in parallel batches
    const batchSize = 100;
    for (let i = 0; i < tsFiles.length; i += batchSize) {
      const batch = tsFiles.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (filePath) => {
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const relativePath = path.relative(this.basePath, filePath);

            // Quick pre-filter: skip files without relevant keywords
            if (
              !content.includes('Document') &&
              !content.includes('useQuery') &&
              !content.includes('useMutation') &&
              !content.includes('Query') &&
              !content.includes('Mutation') &&
              !content.includes('GET_') &&
              !content.includes('SEARCH_') &&
              !content.includes('CREATE_') &&
              !content.includes('UPDATE_') &&
              !content.includes('DELETE_')
            ) {
              return;
            }

            // Find all references using single regex
            if (namesPattern) {
              const foundNames = new Set<string>();
              let match;
              while ((match = namesPattern.exec(content)) !== null) {
                foundNames.add(match[1]);
              }
              namesPattern.lastIndex = 0;

              // Map found names to operations
              for (const name of foundNames) {
                const operation =
                  operationByDocument.get(name) || operationByVariableName.get(name);
                if (operation && relativePath !== operation.filePath) {
                  if (!operation.usedIn.includes(relativePath)) {
                    operation.usedIn.push(relativePath);
                  }
                }
              }
            }

            // Also check traditional patterns (useQuery<Name>, etc.)
            for (const [name, operation] of operationByName) {
              if (relativePath === operation.filePath) continue;
              if (operation.usedIn.includes(relativePath)) continue;

              if (
                content.includes(`useQuery<${name}`) ||
                content.includes(`useMutation<${name}`) ||
                content.includes(`useLazyQuery<${name}`) ||
                content.includes(`useSubscription<${name}`) ||
                content.includes(`${name}Query`) ||
                content.includes(`${name}Mutation`)
              ) {
                operation.usedIn.push(relativePath);
              }
            }
          } catch {
            // Skip unreadable files
          }
        })
      );
    }
  }
}
