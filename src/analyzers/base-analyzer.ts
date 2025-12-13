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
   * Log analysis progress
   */
  protected log(message: string): void {
    console.log(`[${this.getName()}] ${message}`);
  }

  /**
   * Log warning
   */
  protected warn(message: string): void {
    console.warn(`[${this.getName()}] ⚠️ ${message}`);
  }

  /**
   * Log error
   */
  protected error(message: string, error?: Error): void {
    console.error(`[${this.getName()}] ❌ ${message}`, error?.message || '');
  }
}
