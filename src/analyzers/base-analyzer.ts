import type { RepositoryConfig, AnalysisResult } from '../types.js';

/**
 * Base class for all analyzers
 * 全分析器の基底クラス
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
   * 分析を実行
   */
  abstract analyze(): Promise<Partial<AnalysisResult>>;

  /**
   * Get the analyzer name
   * 分析器名を取得
   */
  abstract getName(): string;

  /**
   * Resolve path relative to repository root
   * リポジトリルートからの相対パスを解決
   */
  protected resolvePath(relativePath: string): string {
    return `${this.basePath}/${relativePath}`;
  }

  /**
   * Get setting value with fallback
   * 設定値を取得（フォールバック付き）
   */
  protected getSetting(key: string, defaultValue: string = ''): string {
    return this.config.settings[key] ?? defaultValue;
  }

  /**
   * Log analysis progress
   * 分析進捗をログ出力
   */
  protected log(message: string): void {
    console.log(`[${this.getName()}] ${message}`);
  }

  /**
   * Log warning
   * 警告をログ出力
   */
  protected warn(message: string): void {
    console.warn(`[${this.getName()}] ⚠️ ${message}`);
  }

  /**
   * Log error
   * エラーをログ出力
   */
  protected error(message: string, error?: Error): void {
    console.error(`[${this.getName()}] ❌ ${message}`, error?.message || '');
  }
}
