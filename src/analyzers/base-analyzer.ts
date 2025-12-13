import type { RepositoryConfig, AnalysisResult } from '../types.js';

/**
 * Base class for all analyzers
 */
export abstract class BaseAnalyzer {
  protected config: RepositoryConfig;
  protected basePath: string;

  constructor(config: RepositoryConfig) {
    this.config = config;
    this.basePath = config.path;
  }

  /**
   * Run the analysis
   */
  abstract analyze(): Promise<Partial<AnalysisResult>>;

  /**
   * Get the analyzer name
   */
  abstract getName(): string;

  /**
   * Resolve path relative to repository root
   */
  protected resolvePath(relativePath: string): string {
    return `${this.basePath}/${relativePath}`;
  }

  /**
   * Get setting value with fallback
   */
  protected getSetting(key: string, defaultValue: string = ''): string {
    return this.config.settings[key] ?? defaultValue;
  }

  /**
   * Get list-like setting value (comma/newline separated).
   * Example: "useMyQuery, useMyMutation" -> ["useMyQuery", "useMyMutation"]
   */
  protected getListSetting(key: string, defaultValue: string[] = []): string[] {
    const raw = this.getSetting(key, '');
    if (!raw) return defaultValue;
    return raw
      .split(/[,\n]/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Resolve effective GraphQL hook patterns by combining:
   * - a preset selected by `settings.graphqlHookPreset` (default: "auto")
   * - user-defined patterns from `settings.graphqlHookPatterns`
   *
   * Presets are meant to improve out-of-the-box support for common "production variants"
   * (Relay/urql/custom wrappers) while keeping false positives low.
   */
  protected getGraphQLHookPatterns(): string[] {
    const preset = (this.getSetting('graphqlHookPreset', 'auto') || 'auto').trim().toLowerCase();
    const user = this.getListSetting('graphqlHookPatterns', []);

    const relay = [
      'useLazyLoadQuery',
      'usePreloadedQuery',
      'useQueryLoader',
      'useMutation',
      'useSubscription',
      'useFragment',
      'usePaginationFragment',
      'useRefetchableFragment',
      'useRelayEnvironment',
    ];
    const urql = ['useUrql*'];
    const commonWrappers = [
      'useGql*',
      'useGraphQL*',
      'useGraphql*',
      'useApiQuery*',
      'useApiMutation*',
    ];

    let presetPatterns: string[] = [];
    if (preset === 'none' || preset === 'off' || preset === 'false') {
      presetPatterns = [];
    } else if (preset === 'apollo') {
      // Apollo built-ins are handled by the default hook list.
      presetPatterns = [];
    } else if (preset === 'urql') {
      presetPatterns = urql;
    } else if (preset === 'relay') {
      presetPatterns = relay;
    } else {
      // "auto" (default): safe-ish superset
      presetPatterns = [...relay, ...urql, ...commonWrappers];
    }

    return Array.from(new Set([...presetPatterns, ...user]));
  }

  /**
   * Log analysis progress (silent by default, set REPOMAP_VERBOSE=1 to enable)
   */
  protected log(_message: string): void {
    // Silent by default for cleaner output
    // Enable with REPOMAP_VERBOSE=1
    if (process.env.REPOMAP_VERBOSE === '1') {
      console.log(`[${this.getName()}] ${_message}`);
    }
  }

  /**
   * Log warning (always shown)
   */
  protected warn(message: string): void {
    console.warn(`⚠️ ${message}`);
  }

  /**
   * Log error (always shown)
   */
  protected error(message: string, error?: Error): void {
    console.error(`❌ ${message}`, error?.message || '');
  }
}
