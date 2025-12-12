import { Project, SyntaxKind } from 'ts-morph';
import fg from 'fast-glob';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseGraphQL, DocumentNode, DefinitionNode, TypeNode } from 'graphql';
import { BaseAnalyzer } from './base-analyzer.js';
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

    // Find where each operation is used
    await this.findOperationUsage(operations);

    this.log(`Found ${operations.length} GraphQL operations`);

    return { graphqlOperations: operations };
  }

  private async analyzeGraphQLFiles(): Promise<GraphQLOperation[]> {
    const operations: GraphQLOperation[] = [];

    const graphqlFiles = await fg(['**/*.graphql'], {
      cwd: this.basePath,
      ignore: ['**/node_modules/**', '**/.next/**'],
      absolute: true,
    });

    for (const filePath of graphqlFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const document = parseGraphQL(content);
        const fileOperations = this.extractOperationsFromDocument(
          document,
          path.relative(this.basePath, filePath)
        );
        operations.push(...fileOperations);
      } catch (error) {
        this.warn(`Failed to parse ${filePath}: ${(error as Error).message}`);
      }
    }

    return operations;
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
      ignore: ['**/node_modules/**', '**/.next/**'],
      absolute: true,
    });

    const operationNames = new Map<string, GraphQLOperation>();
    for (const op of operations) {
      operationNames.set(op.name, op);
    }

    for (const filePath of tsFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const relativePath = path.relative(this.basePath, filePath);

        for (const [name, operation] of operationNames) {
          // Check if the operation is used in this file
          if (
            content.includes(`useQuery<${name}`) ||
            content.includes(`useMutation<${name}`) ||
            content.includes(`useLazyQuery<${name}`) ||
            content.includes(`${name}Query`) ||
            content.includes(`${name}Mutation`) ||
            content.includes(`${name}Variables`)
          ) {
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
