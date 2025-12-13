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
