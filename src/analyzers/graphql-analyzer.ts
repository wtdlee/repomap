import { parseSync, Module, TaggedTemplateExpression, CallExpression, Expression } from '@swc/core';
import fg from 'fast-glob';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  parse as parseGraphQL,
  getLocation,
  DocumentNode,
  DefinitionNode,
  TypeNode,
} from 'graphql';
import { BaseAnalyzer } from './base-analyzer.js';
import { parallelMapSafe } from '../utils/parallel.js';
import { isGraphQLHook, hasGraphQLIndicators } from './graphql-utils.js';
import { parseCodegenDocumentExports } from './codegen-ts-ast.js';
import type {
  AnalysisResult,
  GraphQLOperation,
  VariableInfo,
  GraphQLField,
  RepositoryConfig,
} from '../types.js';

/**
 * Analyzer for GraphQL operations
 * Uses @swc/core for fast parsing
 */
export class GraphQLAnalyzer extends BaseAnalyzer {
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

    return { graphqlOperations: uniqueOperations, coverage: this.coverage };
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
   * Supports multiple codegen patterns: client preset, near-operation-file, etc.
   */
  private async analyzeCodegenGenerated(): Promise<GraphQLOperation[]> {
    const operations: GraphQLOperation[] = [];

    // Find potential codegen output files with broader patterns
    const generatedFiles = await fg(
      [
        '**/__generated__/graphql.ts',
        '**/__generated__/gql.ts',
        '**/generated/graphql.ts',
        '**/generated/gql.ts',
        '**/*.generated.ts',
        '**/*.generated.tsx',
        '**/graphql/generated.ts',
        '**/gql/generated.ts',
      ],
      {
        cwd: this.basePath,
        ignore: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**'],
        absolute: true,
      }
    );

    for (const filePath of generatedFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const relativePath = path.relative(this.basePath, filePath);

        // Fast pre-filter
        if (!content.includes('Document') || !content.includes('definitions')) continue;

        this.coverage.codegenFilesDetected += 1;
        const exports = parseCodegenDocumentExports(content, relativePath);
        this.coverage.codegenFilesParsed += 1;
        this.coverage.codegenExportsFound += exports.length;
        for (const e of exports) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const doc = e.document as any;
          const def = doc?.definitions?.[0];
          if (!def || def.kind !== 'OperationDefinition') continue;

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
            name: e.operationName,
            type: e.operationType,
            filePath: relativePath,
            usedIn: [],
            variables,
            returnType: this.inferReturnTypeFromAst(def),
            fragments: this.extractFragmentReferencesFromAst(def),
            fields: this.extractFieldsFromAst(def.selectionSet),
            variableNames: [e.documentName],
          });
        }

        if (exports.length > 0) {
          this.log(`Found ${exports.length} operations in codegen output: ${relativePath}`);
        }
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
      try {
        const document = parseGraphQL(content);
        return this.extractOperationsFromDocument(document, path.relative(this.basePath, filePath));
      } catch {
        this.coverage.graphqlParseFailures += 1;
        return [];
      }
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
    this.coverage.tsFilesScanned += tsFiles.length;

    // Process files in parallel batches
    const batchSize = 50;
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
            this.coverage.tsParseFailures += 1;
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
              this.coverage.graphqlParseFailures += 1;
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
                this.coverage.graphqlParseFailures += 1;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    varStack: string[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

      const loc = definition.loc ? getLocation(definition.loc.source, definition.loc.start) : null;

      return {
        name,
        type,
        filePath,
        line: loc?.line,
        column: loc?.column,
        usedIn: [],
        variables,
        returnType: this.inferReturnType(definition),
        fragments,
        fields,
      };
    }

    if (definition.kind === 'FragmentDefinition') {
      const loc = definition.loc ? getLocation(definition.loc.source, definition.loc.start) : null;
      return {
        name: definition.name.value,
        type: 'fragment',
        filePath,
        line: loc?.line,
        column: loc?.column,
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
    const extraHookPatterns = this.getGraphQLHookPatterns();

    const tsFiles = await fg(['**/*.ts', '**/*.tsx'], {
      cwd: this.basePath,
      ignore: [
        '**/node_modules/**',
        '**/.next/**',
        '**/__generated__/**',
        '**/dist/**',
        '**/build/**',
      ],
      absolute: true,
    });

    // Build comprehensive lookup maps for O(1) access
    const operationByName = new Map<string, GraphQLOperation>();
    const operationByDocument = new Map<string, GraphQLOperation>();
    const operationByVariableName = new Map<string, GraphQLOperation>();
    const operationByQueryType = new Map<string, GraphQLOperation>();

    for (const op of operations) {
      operationByName.set(op.name, op);
      operationByDocument.set(`${op.name}Document`, op);

      // Add Query/Mutation type variants for generic extraction
      operationByQueryType.set(`${op.name}Query`, op);
      operationByQueryType.set(`${op.name}Mutation`, op);
      operationByQueryType.set(`${op.name}Subscription`, op);
      operationByQueryType.set(`${op.name}QueryVariables`, op);
      operationByQueryType.set(`${op.name}MutationVariables`, op);

      // Map all variable names to operation
      if (op.variableNames) {
        for (const varName of op.variableNames) {
          operationByVariableName.set(varName, op);
        }
      }
    }

    // Collect all searchable names
    const allSearchableNames = new Set<string>();
    for (const op of operations) {
      allSearchableNames.add(op.name);
      allSearchableNames.add(`${op.name}Document`);
      allSearchableNames.add(`${op.name}Query`);
      allSearchableNames.add(`${op.name}Mutation`);
      allSearchableNames.add(`${op.name}Subscription`);
      if (op.variableNames) {
        for (const varName of op.variableNames) {
          allSearchableNames.add(varName);
        }
      }
    }

    // Build a single regex to match all names at once
    let namesPattern: RegExp | null = null;
    const namesArray = Array.from(allSearchableNames);
    if (namesArray.length > 0 && namesArray.length < 2000) {
      const escaped = namesArray
        .sort((a, b) => b.length - a.length)
        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      namesPattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'g');
    }

    // Process files in parallel batches
    const batchSize = 50;
    for (let i = 0; i < tsFiles.length; i += batchSize) {
      const batch = tsFiles.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (filePath) => {
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const relativePath = path.relative(this.basePath, filePath);

            // Expanded pre-filter: check for any GraphQL-related keywords
            if (!hasGraphQLIndicators(content)) {
              return;
            }

            // Method 1: Find all references using single regex (fast path)
            if (namesPattern) {
              const foundNames = new Set<string>();
              let match;
              while ((match = namesPattern.exec(content)) !== null) {
                foundNames.add(match[1]);
              }
              namesPattern.lastIndex = 0;

              // Map found names to operations (conservative)
              //
              // Important:
              // - Do NOT use operationByQueryType / operationByName here.
              //   Query/Mutation type names can appear in many files (type-only imports),
              //   which causes massive false positives in usedIn.
              // - Prefer Document references here, and rely on AST-based
              //   usage analysis below for accurate hook/generic detection.
              for (const name of foundNames) {
                const operation = operationByDocument.get(name);

                if (operation && relativePath !== operation.filePath) {
                  if (!operation.usedIn.includes(relativePath)) {
                    operation.usedIn.push(relativePath);
                  }
                }
              }
            }

            // Method 2: AST-based hook analysis for accurate type generic extraction
            await this.findUsageWithAST(
              content,
              filePath,
              relativePath,
              operationByName,
              operationByQueryType,
              operationByVariableName,
              extraHookPatterns
            );
          } catch {
            // Skip unreadable files
          }
        })
      );
    }
  }

  /**
   * Find operation usage using AST analysis for accurate type generic extraction
   */
  private async findUsageWithAST(
    content: string,
    filePath: string,
    relativePath: string,
    operationByName: Map<string, GraphQLOperation>,
    operationByQueryType: Map<string, GraphQLOperation>,
    operationByVariableName: Map<string, GraphQLOperation>,
    extraHookPatterns: string[]
  ): Promise<void> {
    try {
      const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
      const ast = parseSync(content, {
        syntax: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'ecmascript',
        tsx: isTsx,
        jsx: isTsx,
        comments: false,
      });

      // Traverse AST to find hook calls with type generics
      this.traverseNodeForUsage(ast, content, (node) => {
        if (node.type === 'CallExpression') {
          const calleeName = this.getCalleeNameForUsage(node.callee);

          // Check if it's a GraphQL hook
          if (calleeName && isGraphQLHook(calleeName, extraHookPatterns)) {
            // Extract type generic: useQuery<GetUserQuery>
            const typeName = this.extractTypeGenericFromCall(node, content);
            if (typeName) {
              const operation =
                operationByQueryType.get(typeName) ||
                operationByName.get(typeName.replace(/Query$|Mutation$|Variables$/, ''));
              if (operation && relativePath !== operation.filePath) {
                if (!operation.usedIn.includes(relativePath)) {
                  operation.usedIn.push(relativePath);
                }
              }
            }

            // Extract from first argument
            const argName = this.extractFirstArgName(node);
            if (argName) {
              const cleanName = argName.replace(/Document$/, '');
              const operation =
                operationByVariableName.get(argName) ||
                operationByVariableName.get(cleanName) ||
                operationByName.get(cleanName) ||
                operationByQueryType.get(argName);
              if (operation && relativePath !== operation.filePath) {
                if (!operation.usedIn.includes(relativePath)) {
                  operation.usedIn.push(relativePath);
                }
              }
            }
          }
        }
      });
    } catch {
      // Skip files that can't be parsed
    }
  }

  /**
   * Traverse AST nodes for usage analysis
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private traverseNodeForUsage(node: any, content: string, callback: (node: any) => void): void {
    if (!node || typeof node !== 'object') return;

    callback(node);

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          this.traverseNodeForUsage(item, content, callback);
        }
      } else if (value && typeof value === 'object') {
        this.traverseNodeForUsage(value, content, callback);
      }
    }
  }

  /**
   * Get callee name for usage tracking
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getCalleeNameForUsage(callee: any): string | null {
    if (!callee) return null;

    if (callee.type === 'Identifier') {
      return callee.value;
    }

    if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier') {
      return callee.property.value;
    }

    return null;
  }

  /**
   * Extract type generic from hook call
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractTypeGenericFromCall(call: any, content: string): string | null {
    // Method 1: Direct type arguments
    if (call.typeArguments?.params?.length > 0) {
      const firstTypeArg = call.typeArguments.params[0];
      if (
        firstTypeArg?.type === 'TsTypeReference' &&
        firstTypeArg.typeName?.type === 'Identifier'
      ) {
        return firstTypeArg.typeName.value;
      }
    }

    // Method 2: Extract from source position
    if (call.callee?.span) {
      const start = call.callee.span.end;
      const searchRegion = content.slice(start, start + 150);
      const genericMatch = searchRegion.match(
        /^<\s*(\w+)(?:Query|Mutation|Variables|Subscription)?(?:\s*,|\s*>)/
      );
      if (genericMatch) {
        return genericMatch[1];
      }
    }

    return null;
  }

  /**
   * Extract first argument name from call
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractFirstArgName(call: any): string | null {
    if (call.arguments?.length > 0) {
      const firstArg = call.arguments[0].expression;

      if (firstArg?.type === 'Identifier') {
        return firstArg.value;
      }

      if (firstArg?.type === 'MemberExpression' && firstArg.property?.type === 'Identifier') {
        return firstArg.property.value;
      }
    }

    return null;
  }
}
