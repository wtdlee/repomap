import { Project, SyntaxKind } from 'ts-morph';
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
 */
export class GraphQLAnalyzer extends BaseAnalyzer {
  private project: Project;

  constructor(config: RepositoryConfig) {
    super(config);
    this.project = new Project({
      tsConfigFilePath: this.resolvePath('tsconfig.json'),
      skipAddingFilesFromTsConfig: true,
    });
  }

  getName(): string {
    return 'GraphQLAnalyzer';
  }

  async analyze(): Promise<Partial<AnalysisResult>> {
    this.log('Starting GraphQL analysis...');

    const operations: GraphQLOperation[] = [];

    // Analyze .graphql files
    const graphqlOperations = await this.analyzeGraphQLFiles();
    operations.push(...graphqlOperations);

    // Analyze gql`` template literals in TypeScript files
    const inlineOperations = await this.analyzeInlineGraphQL();
    operations.push(...inlineOperations);

    // Analyze GraphQL Code Generator output (__generated__/graphql.ts)
    const codegenOperations = await this.analyzeCodegenGenerated();
    operations.push(...codegenOperations);

    // Deduplicate operations by name (keep first occurrence)
    const uniqueOperations = this.deduplicateOperations(operations);

    // Find where each operation is used (including Document imports)
    await this.findOperationUsage(uniqueOperations);

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
                  fragments: [], // Skip fragment extraction for performance
                  fields: [], // Skip field extraction for performance
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

    const tsFiles = await fg(['**/*.ts', '**/*.tsx'], {
      cwd: this.basePath,
      ignore: [
        '**/node_modules/**',
        '**/.next/**',
        '**/__tests__/**',
        '**/*.test.*',
        '**/*.spec.*',
      ],
      absolute: true,
    });

    for (const filePath of tsFiles) {
      try {
        const sourceFile = this.project.addSourceFileAtPath(filePath);
        const relativePath = path.relative(this.basePath, filePath);

        // Check if file imports gql from any GraphQL-related source
        // Supports: @apollo/client, graphql-tag, graphql.macro, __generated__/gql, gql-masked, etc.
        const hasGqlImport = sourceFile.getImportDeclarations().some((imp) => {
          const spec = imp.getModuleSpecifierValue();
          const namedImports = imp.getNamedImports().map((n) => n.getName());
          const defaultImport = imp.getDefaultImport()?.getText();

          // Check if gql is imported from GraphQL-related modules
          return (
            (namedImports.includes('gql') ||
              namedImports.includes('graphql') ||
              defaultImport === 'gql') &&
            (spec.includes('graphql') ||
              spec.includes('apollo') ||
              spec.includes('gql') ||
              spec.includes('__generated__'))
          );
        });

        // Find gql`` or graphql`` template literals
        const taggedTemplates = sourceFile.getDescendantsOfKind(
          SyntaxKind.TaggedTemplateExpression
        );

        for (const template of taggedTemplates) {
          const tag = template.getTag().getText();
          if (tag === 'gql' || tag === 'graphql') {
            try {
              const templateLiteral = template.getTemplate();
              let content = '';

              if (templateLiteral.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
                content = templateLiteral.getLiteralValue();
              } else if (templateLiteral.isKind(SyntaxKind.TemplateExpression)) {
                // Handle template with substitutions - extract text safely
                const fullText = templateLiteral.getText();
                // Remove template literal backticks and fragment interpolations
                content = fullText
                  .slice(1, -1) // Remove outer backticks
                  .replace(/\$\{[^}]*\}/g, ''); // Remove ${...} entirely (usually fragment refs)
              }

              if (content && content.trim()) {
                try {
                  // Try to parse the GraphQL
                  const document = parseGraphQL(content);
                  const fileOperations = this.extractOperationsFromDocument(document, relativePath);
                  operations.push(...fileOperations);
                } catch {
                  // Skip unparseable GraphQL - this is expected for templates with complex interpolations
                }
              }
            } catch {
              // Skip templates that can't be processed
            }
          }
        }

        // Find gql() function calls: gql(/* GraphQL */ `...`) or gql(`...`)
        // Also supports typed-document-node codegen pattern: gql(/* GraphQL */ `...`)
        const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
        for (const call of callExpressions) {
          try {
            const expression = call.getExpression();
            const expressionText = expression.getText();

            // Match gql() or graphql() function calls
            if (expressionText === 'gql' || expressionText === 'graphql') {
              const args = call.getArguments();
              if (args.length > 0) {
                const firstArg = args[0];
                let content = '';

                // Handle template literal argument (direct or with /* GraphQL */ comment)
                if (firstArg.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
                  content = firstArg.getLiteralValue();
                } else if (firstArg.isKind(SyntaxKind.TemplateExpression)) {
                  const fullText = firstArg.getText();
                  content = fullText.slice(1, -1).replace(/\$\{[^}]*\}/g, ''); // Remove fragment refs
                } else {
                  // Try to get text content (might be a variable or other expression)
                  const argText = firstArg.getText();
                  // Check if it's a template literal wrapped in comments (/* GraphQL */ `...`)
                  if (argText.includes('`')) {
                    // Handle /* GraphQL */ `query { ... }` pattern
                    const match = argText.match(/\/\*\s*GraphQL\s*\*\/\s*`([^`]*)`/);
                    if (match) {
                      content = match[1];
                    } else {
                      // Fallback: just extract template literal
                      const simpleMatch = argText.match(/`([^`]*)`/);
                      if (simpleMatch) {
                        content = simpleMatch[1];
                      }
                    }
                  }
                }

                if (content && content.trim()) {
                  try {
                    const document = parseGraphQL(content);
                    const fileOperations = this.extractOperationsFromDocument(
                      document,
                      relativePath
                    );
                    operations.push(...fileOperations);
                  } catch {
                    // Skip unparseable GraphQL
                  }
                }
              }
            }
          } catch {
            // Skip calls that can't be processed
          }
        }

        // Find exported const queries with GraphQL-like naming patterns
        // Supports: SCREAMING_CASE (e.g., SEARCH_COMPANIES) and PascalCase (e.g., Query, Mutation)
        if (hasGqlImport) {
          const variableDeclarations = sourceFile.getVariableDeclarations();
          for (const varDecl of variableDeclarations) {
            const name = varDecl.getName();
            // Match GraphQL-like variable names
            const isGraphQLLike =
              name.includes('QUERY') ||
              name.includes('MUTATION') ||
              name.includes('FRAGMENT') ||
              name.includes('Query') ||
              name.includes('Mutation') ||
              name.includes('Subscription') ||
              // SCREAMING_CASE constants ending in related words
              /^[A-Z_]+_(QUERY|MUTATION|FRAGMENT|SUBSCRIPTION)$/.test(name) ||
              // PascalCase Query suffix
              /Query$|Mutation$|Fragment$|Subscription$/.test(name);

            if (isGraphQLLike) {
              const initializer = varDecl.getInitializer();
              // Tagged template is handled above, but let's also handle
              // cases where the initializer is a call expression
              if (initializer && initializer.isKind(SyntaxKind.CallExpression)) {
                // Already handled above in the call expression loop
              }
            }
          }
        }
      } catch (error) {
        this.warn(`Failed to analyze ${filePath}: ${(error as Error).message}`);
      }
    }

    return operations;
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
    const tsFiles = await fg(['**/*.ts', '**/*.tsx'], {
      cwd: this.basePath,
      ignore: ['**/node_modules/**', '**/.next/**', '**/__generated__/**'],
      absolute: true,
    });

    const operationNames = new Map<string, GraphQLOperation>();
    for (const op of operations) {
      operationNames.set(op.name, op);
      // Also map Document name for codegen pattern
      operationNames.set(`${op.name}Document`, op);
    }

    for (const filePath of tsFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const relativePath = path.relative(this.basePath, filePath);

        for (const [name, operation] of operationNames) {
          // Skip if this is the definition file itself
          if (relativePath === operation.filePath) continue;

          // Check traditional patterns
          const traditionalPatterns = [
            `useQuery<${name}`,
            `useMutation<${name}`,
            `useLazyQuery<${name}`,
            `useSubscription<${name}`,
            `${name}Query`,
            `${name}Mutation`,
            `${name}Variables`,
          ];

          // Check codegen Document import patterns
          const codegenPatterns = [
            // Import pattern: import { XxxDocument } from
            new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`),
            // useQuery(XxxDocument) or useMutation(XxxDocument)
            new RegExp(`useQuery\\s*\\(\\s*${name}`),
            new RegExp(`useMutation\\s*\\(\\s*${name}`),
            new RegExp(`useLazyQuery\\s*\\(\\s*${name}`),
            new RegExp(`useSubscription\\s*\\(\\s*${name}`),
            // useSuspenseQuery(XxxDocument)
            new RegExp(`useSuspenseQuery\\s*\\(\\s*${name}`),
            // Apollo client.query({ query: XxxDocument })
            new RegExp(`query\\s*:\\s*${name}`),
            new RegExp(`mutation\\s*:\\s*${name}`),
          ];

          const hasTraditionalMatch = traditionalPatterns.some((pattern) =>
            content.includes(pattern)
          );
          const hasCodegenMatch = codegenPatterns.some((pattern) => pattern.test(content));

          if (hasTraditionalMatch || hasCodegenMatch) {
            if (!operation.usedIn.includes(relativePath)) {
              operation.usedIn.push(relativePath);
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
}
