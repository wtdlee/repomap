/**
 * Common constants for analyzers
 * 分析器の共通定数
 */
import type { DataFetchingInfo } from '../types.js';

/**
 * All supported Apollo/GraphQL query hooks
 * Apollo/GraphQL クエリフック一覧
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
 * Apollo/GraphQL ミューテーションフック一覧
 */
export const GRAPHQL_MUTATION_HOOKS = ['useMutation'] as const;

/**
 * All supported Apollo/GraphQL subscription and other hooks
 * Apollo/GraphQL サブスクリプション・その他のフック一覧
 */
export const GRAPHQL_OTHER_HOOKS = ['useSubscription', 'useFragment', 'useApolloClient'] as const;

/**
 * All GraphQL hooks combined
 * 全GraphQLフック
 */
export const ALL_GRAPHQL_HOOKS = [
  ...GRAPHQL_QUERY_HOOKS,
  ...GRAPHQL_MUTATION_HOOKS,
  ...GRAPHQL_OTHER_HOOKS,
] as const;

/**
 * Hook type mapping for data fetching info
 * データフェッチング情報用フックタイプマッピング
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
 * Clean operation name by removing common suffixes
 * 共通サフィックスを削除してオペレーション名をクリーンアップ
 */
export function cleanOperationName(name: string): string {
  return name
    .replace(/^(GET_|FETCH_|CREATE_|UPDATE_|DELETE_)/, '')
    .replace(/_QUERY$|_MUTATION$/, '')
    .replace(/Document$/, '')
    .replace(/Query$|Mutation$|Variables$|Subscription$/, '');
}

/**
 * Keywords that indicate GraphQL usage in a file
 * ファイル内のGraphQL使用を示すキーワード
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

/**
 * Check if content has any GraphQL indicators
 */
export function hasGraphQLIndicators(content: string): boolean {
  return GRAPHQL_INDICATORS.some((indicator) => content.includes(indicator));
}
