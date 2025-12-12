import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

interface CacheEntry {
  hash: string;
  timestamp: number;
  data: unknown;
}

interface CacheManifest {
  version: string;
  entries: Record<string, CacheEntry>;
}

const CACHE_VERSION = '1.0';

/**
 * File-based cache for analysis results
 * ファイルベースのキャッシュシステム
 */
export class AnalysisCache {
  private cacheDir: string;
  private manifest: CacheManifest;
  private manifestPath: string;
  private dirty = false;

  constructor(repoPath: string) {
    this.cacheDir = path.join(repoPath, '.repomap-cache');
    this.manifestPath = path.join(this.cacheDir, 'manifest.json');
    this.manifest = { version: CACHE_VERSION, entries: {} };
  }

  /**
   * Initialize cache directory and load manifest
   */
  async init(): Promise<void> {
    // Create cache directory
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch (err) {
      console.warn(`  Warning: Could not create cache directory: ${(err as Error).message}`);
      return;
    }

    // Load existing manifest
    try {
      const data = await fs.readFile(this.manifestPath, 'utf-8');
      const loaded = JSON.parse(data) as CacheManifest;

      // Check version compatibility
      if (loaded.version === CACHE_VERSION) {
        this.manifest = loaded;
      } else {
        console.log('  Cache version mismatch, clearing cache...');
        await this.clear();
      }
    } catch {
      // Manifest doesn't exist yet, will be created on save
    }
  }

  /**
   * Compute hash for a file
   */
  async computeFileHash(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return crypto.createHash('md5').update(content).digest('hex');
    } catch {
      return '';
    }
  }

  /**
   * Compute hash for multiple files
   */
  async computeFilesHash(filePaths: string[]): Promise<string> {
    const hashes = await Promise.all(
      filePaths.slice(0, 100).map((f) => this.computeFileHash(f)) // Limit to 100 files for performance
    );
    return crypto.createHash('md5').update(hashes.join('')).digest('hex');
  }

  /**
   * Get cached data if valid
   */
  get<T>(key: string, currentHash: string): T | null {
    const entry = this.manifest.entries[key];
    if (entry && entry.hash === currentHash) {
      return entry.data as T;
    }
    return null;
  }

  /**
   * Store data in cache
   */
  set(key: string, hash: string, data: unknown): void {
    this.manifest.entries[key] = {
      hash,
      timestamp: Date.now(),
      data,
    };
    this.dirty = true;
  }

  /**
   * Save manifest to disk
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    try {
      // Ensure directory exists
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2));
      this.dirty = false;
    } catch (error) {
      console.warn('  Warning: Failed to save cache:', (error as Error).message);
    }
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    this.manifest = { version: CACHE_VERSION, entries: {} };
    this.dirty = true;
    try {
      await fs.rm(this.cacheDir, { recursive: true, force: true });
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch {
      // Ignore errors
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): { entries: number; size: string } {
    const entries = Object.keys(this.manifest.entries).length;
    const size = JSON.stringify(this.manifest).length;
    return {
      entries,
      size:
        size > 1024 * 1024
          ? `${(size / 1024 / 1024).toFixed(1)}MB`
          : `${(size / 1024).toFixed(1)}KB`,
    };
  }
}
