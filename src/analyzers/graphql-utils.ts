/**
 * Unified GraphQL extraction utilities
 * 統合GraphQL抽出ユーティリティ
 *
 * This module provides a single source of truth for all GraphQL operation extraction.
 * All analyzers should use these utilities instead of implementing their own logic.
 */
import { parseSync, Module, CallExpression } from '@swc/core';
import type { DataFetchingInfo } from '../types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * All supported Apollo/GraphQL query hooks
 */
export const GRAPHQL_QUERY_HOOKS = [
  'useQuery',
  'useLazyQuery',
  'useSuspenseQuery',
  'useBackgroundQuery',
  'useReadQuery',
] as const;

/**
 * All supported Apollo/GraphQL mutation hooks
 */
export const GRAPHQL_MUTATION_HOOKS = ['useMutation'] as const;

/**
 * All supported Apollo/GraphQL subscription and other hooks
 */
export const GRAPHQL_OTHER_HOOKS = ['useSubscription', 'useFragment', 'useApolloClient'] as const;

/**
 * All GraphQL hooks combined
 */
export const ALL_GRAPHQL_HOOKS = [
  ...GRAPHQL_QUERY_HOOKS,
  ...GRAPHQL_MUTATION_HOOKS,
  ...GRAPHQL_OTHER_HOOKS,
] as const;

/**
 * Hook type mapping for data fetching info
 */
export const HOOK_TYPE_MAP: Record<string, DataFetchingInfo['type']> = {
  useQuery: 'useQuery',
  useSuspenseQuery: 'useQuery',
  useBackgroundQuery: 'useQuery',
  useReadQuery: 'useQuery',
  useLazyQuery: 'useLazyQuery',
  useMutation: 'useMutation',
  useSubscription: 'useSubscription',
};

/**
 * Keywords that indicate GraphQL usage in a file
 */
export const GRAPHQL_INDICATORS = [
  'Document',
  'useQuery',
  'useMutation',
  'useLazyQuery',
  'useSuspenseQuery',
  'useBackgroundQuery',
  'useSubscription',
  'Query',
  'Mutation',
  'gql',
  'graphql',
  'GET_',
  'FETCH_',
  'SEARCH_',
  'CREATE_',
  'UPDATE_',
  'DELETE_',
  'SUBSCRIBE_',
  '@apollo',
  'ApolloClient',
] as const;

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Context extracted from a file for GraphQL operation resolution
 */
export interface GraphQLFileContext {
  /** Document imports: import { GetUserDocument } from '...' */
  documentImports: Map<string, string>;
  /** Variable -> operation name mapping from gql() calls */
  variableOperations: Map<string, string>;
  /** Static property mappings: Component.Query = gql`...` */
  staticPropertyOperations: Map<string, string>;
  /** Codegen mapping: Document name -> operation name */
  codegenMap: Map<string, { operationName: string; type: string }>;
}

/**
 * Result of extracting GraphQL operations from a hook call
 */
export interface ExtractedGraphQLOperation {
  operationName: string;
  hookName: string;
  type: DataFetchingInfo['type'];
  variables?: Record<string, string>;
}

// ============================================================================
// Hook Type Utilities
// ============================================================================

/**
 * Check if a hook name is a GraphQL query hook
 */
export function isQueryHook(hookName: string): boolean {
  return (
    (GRAPHQL_QUERY_HOOKS as readonly string[]).includes(hookName) ||
    /^use[A-Z].*Query$/.test(hookName)
  );
}

/**
 * Check if a hook name is a GraphQL mutation hook
 */
export function isMutationHook(hookName: string): boolean {
  return (
    (GRAPHQL_MUTATION_HOOKS as readonly string[]).includes(hookName) ||
    /^use[A-Z].*Mutation$/.test(hookName)
  );
}

/**
 * Check if a hook name is a GraphQL subscription hook
 */
export function isSubscriptionHook(hookName: string): boolean {
  return hookName === 'useSubscription';
}

/**
 * Check if a hook name is any GraphQL hook
 */
export function isGraphQLHook(hookName: string): boolean {
  return (
    (ALL_GRAPHQL_HOOKS as readonly string[]).includes(hookName) ||
    isQueryHook(hookName) ||
    isMutationHook(hookName)
  );
}

/**
 * Get the data fetching type for a hook
 */
export function getHookType(hookName: string): DataFetchingInfo['type'] {
  if (HOOK_TYPE_MAP[hookName]) {
    return HOOK_TYPE_MAP[hookName];
  }
  if (hookName.includes('Mutation')) {
    return 'useMutation';
  }
  if (hookName.includes('Lazy')) {
    return 'useLazyQuery';
  }
  if (hookName.includes('Subscription')) {
    return 'useSubscription';
  }
  return 'useQuery';
}

/**
 * Check if content has any GraphQL indicators
 */
export function hasGraphQLIndicators(content: string): boolean {
  return GRAPHQL_INDICATORS.some((indicator) => content.includes(indicator));
}

// ============================================================================
// Name Cleaning Utilities
// ============================================================================

/**
 * Clean operation name by removing common suffixes
 */
export function cleanOperationName(name: string): string {
  return name
    .replace(/^(GET_|FETCH_|CREATE_|UPDATE_|DELETE_)/, '')
    .replace(/_QUERY$|_MUTATION$/, '')
    .replace(/Document$/, '')
    .replace(/Query$|Mutation$|Variables$|Subscription$/, '');
}

// ============================================================================
// AST Utilities
// ============================================================================

/**
 * Safely parse TypeScript/TSX content to AST
 */
export function parseToAst(content: string): Module | null {
  try {
    return parseSync(content, {
      syntax: 'typescript',
      tsx: true,
      comments: false,
    });
  } catch {
    return null;
  }
}

/**
 * Get callee name from a call expression
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCalleeName(callee: any): string | null {
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
 * Traverse AST and call callback for each node
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function traverseAst(node: any, callback: (node: any) => void): void {
  if (!node || typeof node !== 'object') return;

  callback(node);

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        traverseAst(item, callback);
      }
    } else if (value && typeof value === 'object') {
      traverseAst(value, callback);
    }
  }
}

// ============================================================================
// GraphQL Context Extraction (Single Pass)
// ============================================================================

/**
 * Extract all GraphQL context from a file in a single AST pass
 * This is the main entry point for file-level analysis
 */
export function extractGraphQLContext(
  ast: Module,
  content: string,
  codegenMap?: Map<string, { operationName: string; type: string }>
): GraphQLFileContext {
  const context: GraphQLFileContext = {
    documentImports: new Map(),
    variableOperations: new Map(),
    staticPropertyOperations: new Map(),
    codegenMap: codegenMap || new Map(),
  };

  traverseAst(ast, (node) => {
    // Extract Document imports
    if (node.type === 'ImportDeclaration') {
      extractDocumentImportsFromNode(node, context.documentImports);
    }

    // Extract variable declarations with gql() or gql``
    if (node.type === 'VariableDeclarator') {
      extractVariableOperationFromNode(node, content, context.variableOperations);
    }

    // Extract static properties: Component.Query = gql`...`
    if (node.type === 'AssignmentExpression') {
      extractStaticPropertyOperationFromNode(node, content, context.staticPropertyOperations);
    }
  });

  return context;
}

/**
 * Extract Document imports from an ImportDeclaration node
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractDocumentImportsFromNode(node: any, imports: Map<string, string>): void {
  const source = node.source?.value || '';

  const isGraphQLImport =
    source.includes('__generated__') ||
    source.includes('generated') ||
    source.includes('graphql') ||
    source.includes('.generated') ||
    source.endsWith('.graphql');

  for (const spec of node.specifiers || []) {
    let localName: string | undefined;
    if (spec.type === 'ImportSpecifier') {
      localName = spec.local?.value;
    } else if (spec.type === 'ImportDefaultSpecifier') {
      localName = spec.local?.value;
    }

    if (!localName) continue;

    // Track Document imports
    if (localName.endsWith('Document') || isGraphQLImport) {
      imports.set(localName, localName.replace(/Document$/, ''));
    }

    // Track Query/Mutation type imports
    if (localName.endsWith('Query') || localName.endsWith('Mutation')) {
      imports.set(localName, localName.replace(/Query$|Mutation$/, ''));
    }
  }
}

/**
 * Extract operation name from a variable declarator (const Query = gql`...`)
 */

function extractVariableOperationFromNode(
  node: any,
  content: string,
  operations: Map<string, string>
): void {
  if (node.id?.type !== 'Identifier') return;

  const varName = node.id.value;
  const init = node.init;
  if (!init) return;

  let operationName: string | null = null;

  // Handle: const Query = gql(`query GetFollowPage { ... }`)
  if (init.type === 'CallExpression') {
    const calleeName = getCalleeName(init.callee);
    if (calleeName === 'gql' || calleeName === 'graphql') {
      operationName = extractOperationNameFromGqlCall(init, content);
    }
  }

  // Handle: const Query = gql`query GetFollowPage { ... }`
  if (init.type === 'TaggedTemplateExpression') {
    const tagName = getCalleeName(init.tag);
    if (tagName === 'gql' || tagName === 'graphql') {
      operationName = extractOperationNameFromTemplate(init.template, content);
    }
  }

  // Handle: const doc = GetUserDocument (reference to another variable)
  if (init.type === 'Identifier') {
    const initName = init.value;
    if (
      initName.endsWith('Document') ||
      initName.endsWith('Query') ||
      initName.endsWith('Mutation')
    ) {
      operations.set(varName, initName);
      return;
    }
  }

  if (operationName) {
    operations.set(varName, operationName);
  }
}

/**
 * Extract operation name from static property assignment (Component.Query = gql`...`)
 */

function extractStaticPropertyOperationFromNode(
  node: any,
  content: string,
  operations: Map<string, string>
): void {
  if (node.left?.type !== 'MemberExpression') return;

  const obj = node.left.object;
  const prop = node.left.property;

  if (obj?.type !== 'Identifier' || prop?.type !== 'Identifier') return;

  const key = `${obj.value}.${prop.value}`;
  const init = node.right;
  if (!init) return;

  let operationName: string | null = null;

  // Handle: Component.Query = gql(`query GetData { ... }`)
  if (init.type === 'CallExpression') {
    const calleeName = getCalleeName(init.callee);
    if (calleeName === 'gql' || calleeName === 'graphql') {
      operationName = extractOperationNameFromGqlCall(init, content);
    }
  }

  // Handle: Component.Query = gql`query GetData { ... }`
  if (init.type === 'TaggedTemplateExpression') {
    const tagName = getCalleeName(init.tag);
    if (tagName === 'gql' || tagName === 'graphql') {
      operationName = extractOperationNameFromTemplate(init.template, content);
    }
  }

  if (operationName) {
    operations.set(key, operationName);
  }
}

/**
 * Extract operation name from gql() function call
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractOperationNameFromGqlCall(call: any, content: string): string | null {
  if (!call.arguments?.length) return null;

  const firstArgRaw = call.arguments[0];
  const firstArg = firstArgRaw?.expression || firstArgRaw;

  // Template literal: gql(`query GetUser { ... }`)
  if (firstArg?.type === 'TemplateLiteral') {
    return extractOperationNameFromTemplate(firstArg, content);
  }

  // Fallback: extract from source span
  if (call.span) {
    const callContent = content.slice(call.span.start, call.span.end);
    const opMatch = callContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);
    if (opMatch) {
      return opMatch[1];
    }
  }

  return null;
}

/**
 * Extract operation name from template literal
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractOperationNameFromTemplate(template: any, _content: string): string | null {
  if (!template?.quasis?.[0]) return null;

  // Try raw first, then cooked
  const templateContent = template.quasis[0].raw || template.quasis[0].cooked || '';
  const opMatch = templateContent.match(/(?:query|mutation|subscription)\s+(\w+)/i);

  return opMatch ? opMatch[1] : null;
}

// ============================================================================
// Operation Name Resolution (Main API)
// ============================================================================

/**
 * Check if a hook call has GraphQL-related arguments
 * This verifies the hook is actually used for GraphQL, not just has a similar name
 * e.g., useQueryParams() is NOT a GraphQL hook, but useQuery(GetUserDocument) IS
 */
export function hasGraphQLArgument(
  call: CallExpression,
  content: string,
  context: GraphQLFileContext
): boolean {
  // No arguments = not a GraphQL hook (e.g., useQueryClient())
  if (!call.arguments?.length) return false;

  const firstArgRaw = call.arguments[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firstArg = (firstArgRaw as any)?.expression || firstArgRaw;
  if (!firstArg) return false;

  // Check type generic first - useQuery<GetUserQuery>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((call as any).typeArguments?.params?.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstTypeArg = (call as any).typeArguments.params[0];
    if (firstTypeArg?.type === 'TsTypeReference' && firstTypeArg.typeName?.type === 'Identifier') {
      const typeName = firstTypeArg.typeName.value;
      // Check if type name looks like a GraphQL type
      if (/Query$|Mutation$|Subscription$|Document$/.test(typeName)) {
        return true;
      }
    }
  }

  // Check for various GraphQL argument patterns:

  // 1. Identifier that maps to a Document or gql() result
  if (firstArg.type === 'Identifier') {
    const argName = firstArg.value;

    // Check if it's a known Document import
    if (context.documentImports.has(argName)) return true;

    // Check if it's a variable from gql() call
    if (context.variableOperations.has(argName)) return true;

    // Check if name ends with Document, or looks like a GraphQL query name
    // Supports both PascalCase (GetUserQuery) and UPPER_SNAKE_CASE (GET_USER_QUERY)
    if (
      argName.endsWith('Document') ||
      /^[A-Z][a-zA-Z0-9]*Query$/.test(argName) ||
      /^[A-Z][a-zA-Z0-9]*Mutation$/.test(argName) ||
      /^[A-Z][A-Z0-9_]*_QUERY$/.test(argName) ||
      /^[A-Z][A-Z0-9_]*_MUTATION$/.test(argName)
    ) {
      return true;
    }
  }

  // 2. Tagged template expression: gql`...` or graphql`...`
  if (firstArg.type === 'TaggedTemplateExpression') {
    const tagName = getCalleeName(firstArg.tag);
    if (tagName === 'gql' || tagName === 'graphql') return true;
  }

  // 3. Call expression: graphql(...) or gql(...)
  if (firstArg.type === 'CallExpression') {
    const calleeName = getCalleeName(firstArg.callee);
    if (calleeName === 'gql' || calleeName === 'graphql') return true;
  }

  // 4. Template literal containing GraphQL syntax
  if (firstArg.type === 'TemplateLiteral' && firstArg.quasis?.[0]?.raw) {
    const templateContent = firstArg.quasis[0].raw;
    if (/(?:query|mutation|subscription)\s+\w+/i.test(templateContent)) return true;
  }

  // 5. MemberExpression like Component.Query or queries.GetUser
  if (firstArg.type === 'MemberExpression') {
    const propName = firstArg.property?.value;
    if (propName && /Query$|Mutation$|Document$/.test(propName)) return true;

    // Check static property operations
    const objName = firstArg.object?.type === 'Identifier' ? firstArg.object.value : null;
    if (objName && propName) {
      const key = `${objName}.${propName}`;
      if (context.staticPropertyOperations.has(key)) return true;
    }
  }

  // 6. Check source content around the call for GraphQL indicators
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const span = (call as any).span;
  if (span) {
    const callContent = content.slice(span.start, Math.min(span.end, span.start + 500));
    // Look for strong GraphQL indicators in the call
    if (
      /\bDocument\b/.test(callContent) ||
      /\bgql\s*[`(]/.test(callContent) ||
      /\bgraphql\s*[`(]/.test(callContent) ||
      /query\s+[A-Z]\w+\s*[({]/.test(callContent) ||
      /mutation\s+[A-Z]\w+\s*[({]/.test(callContent)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve operation name from a hook call using file context
 * This is the main API for resolving operation names
 */
export function resolveOperationName(
  call: CallExpression,
  content: string,
  context: GraphQLFileContext
): string | null {
  // Method 1: Extract from type generic - useQuery<GetUserQuery>
  const fromGeneric = extractFromTypeGeneric(call, content);
  if (fromGeneric) return fromGeneric;

  // Method 2: Extract from first argument
  if (call.arguments?.length > 0) {
    const firstArgRaw = call.arguments[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstArg = (firstArgRaw as any)?.expression || firstArgRaw;

    if (firstArg) {
      const fromArg = extractFromArgument(firstArg, content, context);
      if (fromArg) return fromArg;
    }
  }

  return null;
}

/**
 * Extract operation name from type generic
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFromTypeGeneric(call: any, content: string): string | null {
  // Direct from AST
  if (call.typeArguments?.params?.length > 0) {
    const firstTypeArg = call.typeArguments.params[0];
    if (firstTypeArg?.type === 'TsTypeReference' && firstTypeArg.typeName?.type === 'Identifier') {
      return cleanOperationName(firstTypeArg.typeName.value);
    }
  }

  // Fallback: extract from span position
  if (call.callee?.span && call.span) {
    const start = call.callee.span.end;
    const end = Math.min(start + 150, call.span.end);
    const searchRegion = content.slice(start, end);
    const genericMatch = searchRegion.match(
      /^<\s*(\w+)(?:Query|Mutation|Variables|Subscription)?[\s,>]/
    );
    if (genericMatch) {
      return cleanOperationName(genericMatch[1]);
    }
  }

  return null;
}

/**
 * Extract operation name from call argument
 */

function extractFromArgument(
  arg: any,
  content: string,
  context: GraphQLFileContext
): string | null {
  // Identifier: useQuery(Query) or useQuery(GetUserDocument)
  if (arg.type === 'Identifier') {
    return resolveIdentifierToOperation(arg.value, context);
  }

  // Member expression: useQuery(Component.Query) or client.query({ query: MyQuery })
  if (arg.type === 'MemberExpression') {
    return resolveMemberExpressionToOperation(arg, context);
  }

  // Tagged template: useQuery(gql`query GetUser { ... }`)
  if (arg.type === 'TaggedTemplateExpression') {
    const tagName = getCalleeName(arg.tag);
    if (tagName === 'gql' || tagName === 'graphql') {
      return extractOperationNameFromTemplate(arg.template, content);
    }
  }

  // Direct template literal (less common)
  if (arg.type === 'TemplateLiteral') {
    return extractOperationNameFromTemplate(arg, content);
  }

  // CallExpression: useQuery(graphql(`query GetUser { ... }`))
  if (arg.type === 'CallExpression') {
    const calleeName = getCalleeName(arg.callee);
    if (calleeName === 'gql' || calleeName === 'graphql') {
      return extractOperationNameFromGqlCall(arg, content);
    }
  }

  // ObjectExpression: client.query({ query: MyQuery })
  if (arg.type === 'ObjectExpression') {
    return extractFromObjectExpression(arg, content, context);
  }

  return null;
}

/**
 * Resolve an identifier to an operation name using context
 */
function resolveIdentifierToOperation(name: string, context: GraphQLFileContext): string | null {
  // 1. Check variable -> operation mapping (highest priority)
  // This handles: const Query = gql(`query GetFollowPage { ... }`); useQuery(Query)
  const variableOp = context.variableOperations.get(name);
  if (variableOp) {
    // If it's a reference to another variable, resolve recursively
    if (context.variableOperations.has(variableOp)) {
      return resolveIdentifierToOperation(variableOp, context);
    }
    // If it looks like a Document reference, try to resolve it
    if (
      variableOp.endsWith('Document') ||
      variableOp.endsWith('Query') ||
      variableOp.endsWith('Mutation')
    ) {
      return context.documentImports.get(variableOp) || cleanOperationName(variableOp);
    }
    return variableOp;
  }

  // 2. Check Document imports
  const importedOp = context.documentImports.get(name);
  if (importedOp) {
    return importedOp;
  }

  // 3. Check codegen map
  const codegenEntry = context.codegenMap.get(name);
  if (codegenEntry) {
    return codegenEntry.operationName;
  }

  // 4. Skip generic patterns only if no mapping found
  if (/^(Query|Mutation|QUERY|MUTATION|Document)$/i.test(name)) {
    return null;
  }

  // 5. Clean and return the name
  return cleanOperationName(name);
}

/**
 * Resolve member expression to operation name
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveMemberExpressionToOperation(expr: any, context: GraphQLFileContext): string | null {
  const objName = expr.object?.type === 'Identifier' ? expr.object.value : null;
  const propName = expr.property?.type === 'Identifier' ? expr.property.value : null;

  if (!propName) return null;

  // Check static property mapping: Component.Query
  if (objName) {
    const key = `${objName}.${propName}`;
    const staticOp = context.staticPropertyOperations.get(key);
    if (staticOp) {
      return staticOp;
    }
  }

  // Default: use property name
  return cleanOperationName(propName);
}

/**
 * Extract operation from object expression (for client.query({ query: MyQuery }))
 */

function extractFromObjectExpression(
  obj: any,
  content: string,
  context: GraphQLFileContext
): string | null {
  for (const prop of obj.properties || []) {
    if (
      prop.type === 'KeyValueProperty' &&
      prop.key?.type === 'Identifier' &&
      prop.key.value === 'query'
    ) {
      return extractFromArgument(prop.value, content, context);
    }
  }
  return null;
}

// ============================================================================
// High-Level APIs for Analyzers
// ============================================================================

/**
 * Extract all GraphQL operations from a file
 * Returns a list of operations with their hook names and types
 */
export function extractGraphQLOperationsFromFile(
  content: string,
  codegenMap?: Map<string, { operationName: string; type: string }>
): ExtractedGraphQLOperation[] {
  const operations: ExtractedGraphQLOperation[] = [];
  const seen = new Set<string>();

  // Quick check
  if (!hasGraphQLIndicators(content)) {
    return operations;
  }

  const ast = parseToAst(content);
  if (!ast) return operations;

  const context = extractGraphQLContext(ast, content, codegenMap);

  traverseAst(ast, (node) => {
    if (node.type !== 'CallExpression') return;

    const calleeName = getCalleeName(node.callee);
    if (!calleeName) return;

    // Check for GraphQL hooks
    if (isGraphQLHook(calleeName)) {
      const operationName = resolveOperationName(node, content, context);
      const type = getHookType(calleeName);
      const key = `${type}:${operationName || 'unknown'}`;

      if (!seen.has(key)) {
        seen.add(key);
        operations.push({
          operationName: operationName || 'unknown',
          hookName: calleeName,
          type,
        });
      }
    }

    // Check for Apollo client direct calls: client.query({ query: ... })
    if (calleeName === 'query' || calleeName === 'mutate') {
      if (node.arguments?.length > 0) {
        const firstArgRaw = node.arguments[0];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const firstArg = (firstArgRaw as any)?.expression || firstArgRaw;
        if (firstArg?.type === 'ObjectExpression') {
          const operationName = extractFromObjectExpression(firstArg, content, context);
          const type = calleeName === 'mutate' ? 'useMutation' : 'useQuery';
          const key = `${type}:${operationName || 'unknown'}`;

          if (operationName && !seen.has(key)) {
            seen.add(key);
            operations.push({
              operationName,
              hookName: `client.${calleeName}`,
              type,
            });
          }
        }
      }
    }
  });

  return operations;
}

/**
 * Get displayable hook info string (for backward compatibility)
 */
export function getHookInfoString(op: ExtractedGraphQLOperation): string {
  const typeMap: Record<string, string> = {
    useQuery: 'Query',
    useLazyQuery: 'Query',
    useMutation: 'Mutation',
    useSubscription: 'Subscription',
  };
  const displayType = typeMap[op.type] || 'Query';
  return `${displayType}: ${op.operationName}`;
}
