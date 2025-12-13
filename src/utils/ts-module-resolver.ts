import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

type Maybe<T> = T | null;

export interface ResolvedModuleEvidence {
  fromFile: string; // repo-relative
  specifier: string;
  resolvedFile: string; // repo-relative
  configFile?: string; // repo-relative tsconfig/jsconfig used
}

/**
 * TypeScript Compiler API based module resolver.
 *
 * - Resolves with real tsconfig/jsconfig (including `extends`, `baseUrl`, `paths`)
 * - Handles monorepo/workspace aliases much better than manual heuristics
 * - Returns repo-relative paths only (filters out node_modules)
 */
export class TsModuleResolver {
  private readonly repoRootAbs: string;
  private readonly knownFiles: Set<string>; // repo-relative, normalized with "/"

  private readonly configCache = new Map<string, Maybe<ts.ParsedCommandLine>>();
  private readonly configPathCache = new Map<string, Maybe<string>>();

  constructor(repoRootAbs: string, knownFiles: Set<string>) {
    this.repoRootAbs = path.resolve(repoRootAbs);
    this.knownFiles = knownFiles;
  }

  resolve(
    fromFileRel: string,
    specifier: string
  ): { file: string; evidence: ResolvedModuleEvidence } | null {
    if (!specifier) return null;
    // Fast skip for typical package imports like "react".
    // We still allow non-relative specifiers with "/" because they are often workspace aliases.
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('@')) {
      if (!specifier.includes('/')) return null;
    }

    const fromAbs = path.join(this.repoRootAbs, fromFileRel);
    const parsed = this.getParsedConfigForFile(fromAbs);

    const host: ts.ModuleResolutionHost = {
      fileExists: (p) => fs.existsSync(p),
      readFile: (p) => {
        try {
          return fs.readFileSync(p, 'utf8');
        } catch {
          return undefined;
        }
      },
      directoryExists: (p) => {
        try {
          return fs.existsSync(p) && fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      getCurrentDirectory: () => this.repoRootAbs,
      realpath: ts.sys.realpath,
    };

    const compilerOptions: ts.CompilerOptions = parsed?.options || {
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: true,
    };

    const resolved = ts.resolveModuleName(specifier, fromAbs, compilerOptions, host);
    const resolvedFileAbs = resolved.resolvedModule?.resolvedFileName;
    if (!resolvedFileAbs) return null;

    const rel = this.toRepoRelative(resolvedFileAbs);
    if (!rel) return null;

    // Prefer a known source file (exclude .d.ts and non-included files).
    const normalized = this.normalizeRel(rel);
    const best = this.pickKnownFile(normalized);
    if (!best) return null;

    const configPath = this.getConfigPathForFile(fromAbs);
    const configFileRel = configPath ? this.toRepoRelative(configPath) || undefined : undefined;

    return {
      file: best,
      evidence: {
        fromFile: this.normalizeRel(fromFileRel),
        specifier,
        resolvedFile: best,
        configFile: configFileRel,
      },
    };
  }

  private getConfigPathForFile(fromAbs: string): Maybe<string> {
    const dirAbs = path.dirname(fromAbs);
    const cached = this.configPathCache.get(dirAbs);
    if (cached !== undefined) return cached;

    const found = this.findNearestConfig(dirAbs);
    this.configPathCache.set(dirAbs, found);
    return found;
  }

  private getParsedConfigForFile(fromAbs: string): Maybe<ts.ParsedCommandLine> {
    const configAbs = this.getConfigPathForFile(fromAbs);
    if (!configAbs) return null;

    const cached = this.configCache.get(configAbs);
    if (cached !== undefined) return cached;

    try {
      const read = ts.readConfigFile(configAbs, ts.sys.readFile);
      if (read.error) {
        this.configCache.set(configAbs, null);
        return null;
      }
      const parsed = ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        path.dirname(configAbs),
        undefined,
        configAbs
      );
      this.configCache.set(configAbs, parsed);
      return parsed;
    } catch {
      this.configCache.set(configAbs, null);
      return null;
    }
  }

  private findNearestConfig(startDirAbs: string): Maybe<string> {
    let cur = path.resolve(startDirAbs);
    const root = this.repoRootAbs;

    while (true) {
      const tsconfig = path.join(cur, 'tsconfig.json');
      const jsconfig = path.join(cur, 'jsconfig.json');
      if (fs.existsSync(tsconfig)) return tsconfig;
      if (fs.existsSync(jsconfig)) return jsconfig;

      if (cur === root) break;
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
      if (!cur.startsWith(root)) break;
    }

    return null;
  }

  private toRepoRelative(absPath: string): Maybe<string> {
    const resolved = path.resolve(absPath);
    if (!resolved.startsWith(this.repoRootAbs)) return null;
    const rel = path.relative(this.repoRootAbs, resolved);
    return this.normalizeRel(rel);
  }

  private normalizeRel(p: string): string {
    return path.normalize(p).replace(/\\/g, '/');
  }

  private pickKnownFile(rel: string): Maybe<string> {
    // Direct match
    if (this.knownFiles.has(rel)) return rel;

    // Strip extension
    const withoutExt = rel.replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|d\.ts)$/, '');
    const direct = this.firstKnownByStem(withoutExt);
    if (direct) return direct;

    // index resolution
    const idx = this.firstKnownByStem(`${withoutExt}/index`);
    if (idx) return idx;

    return null;
  }

  private firstKnownByStem(stem: string): Maybe<string> {
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
    for (const ext of exts) {
      const cand = `${stem}${ext}`;
      if (this.knownFiles.has(cand)) return cand;
    }
    return null;
  }
}
