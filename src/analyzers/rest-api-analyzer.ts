import { parseSync, CallExpression, Expression, Module } from '@swc/core';
import fg from 'fast-glob';
import * as path from 'path';
import * as fs from 'fs/promises';
import { BaseAnalyzer } from './base-analyzer.js';
import { parallelMapSafe } from '../utils/parallel.js';
import type { AnalysisResult, APICall, RepositoryConfig } from '../types.js';

/**
 * Analyzer for REST API calls (fetch, axios, useSWR, etc.)
 * REST API呼び出しの分析器
 * Uses @swc/core for fast parsing
 */
export class RestApiAnalyzer extends BaseAnalyzer {
  private apiCallCounter = 0;

  constructor(config: RepositoryConfig) {
    super(config);
  }

  getName(): string {
    return 'RestApiAnalyzer';
  }

  async analyze(): Promise<Partial<AnalysisResult>> {
    this.log('Starting REST API analysis...');

    const tsFiles = await fg(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'], {
      cwd: this.basePath,
      ignore: [
        '**/node_modules/**',
        '**/.next/**',
        '**/__tests__/**',
        '**/*.test.*',
        '**/*.spec.*',
        '**/*.stories.*',
        '**/__generated__/**',
        '**/dist/**',
        '**/build/**',
      ],
      absolute: true,
    });

    // Read and parse files in parallel batches
    const batchSize = 100;
    const allCalls: APICall[] = [];

    for (let i = 0; i < tsFiles.length; i += batchSize) {
      const batch = tsFiles.slice(i, i + batchSize);
      const results = await parallelMapSafe(
        batch,
        async (filePath) => {
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const relativePath = path.relative(this.basePath, filePath);
            const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');

            const ast = parseSync(content, {
              syntax:
                filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'ecmascript',
              tsx: isTsx,
              jsx: isTsx,
            });

            return this.analyzeModule(ast, content, relativePath);
          } catch {
            return [];
          }
        },
        10
      );
      allCalls.push(...results.flat());
    }

    this.log(`Found ${allCalls.length} REST API calls`);
    return { apiCalls: allCalls };
  }

  /**
   * Analyze a parsed module for API calls
   */
  private analyzeModule(ast: Module, content: string, filePath: string): APICall[] {
    const calls: APICall[] = [];
    const lines = content.split('\n');

    // Traverse AST to find call expressions
    this.traverseNode(ast, (node) => {
      if (node.type === 'CallExpression') {
        const call = node as CallExpression;
        const apiCall = this.analyzeCallExpression(call, filePath, lines);
        if (apiCall) {
          calls.push(apiCall);
        }
      }
    });

    return calls;
  }

  /**
   * Traverse AST nodes recursively
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private traverseNode(node: any, callback: (node: any) => void): void {
    if (!node || typeof node !== 'object') return;

    callback(node);

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          this.traverseNode(item, callback);
        }
      } else if (value && typeof value === 'object') {
        this.traverseNode(value, callback);
      }
    }
  }

  /**
   * Analyze a call expression for API calls
   */
  private analyzeCallExpression(
    call: CallExpression,
    filePath: string,
    lines: string[]
  ): APICall | null {
    const callee = call.callee;
    if (callee.type === 'Super' || callee.type === 'Import') return null;
    const calleeName = this.getCalleeName(callee);

    if (!calleeName) return null;

    // fetch() or window.fetch()
    if (calleeName === 'fetch' || calleeName === 'window.fetch') {
      return this.extractFetchCall(call, filePath, lines);
    }

    // axios.get(), axios.post(), etc.
    const axiosMatch = calleeName.match(/^axios\.(get|post|put|delete|patch)$/i);
    if (axiosMatch) {
      return this.extractAxiosMethodCall(call, filePath, lines, axiosMatch[1].toUpperCase());
    }

    // axios() direct call
    if (calleeName === 'axios') {
      return this.extractAxiosDirectCall(call, filePath, lines);
    }

    // useSWR() or useSWRImmutable()
    if (calleeName === 'useSWR' || calleeName === 'useSWRImmutable') {
      return this.extractSwrCall(call, filePath, lines);
    }

    return null;
  }

  /**
   * Get callee name from expression
   */
  private getCalleeName(callee: Expression): string | null {
    if (callee.type === 'Identifier') {
      return callee.value;
    }
    if (callee.type === 'MemberExpression') {
      const obj = callee.object;
      const prop = callee.property;
      if (obj.type === 'Identifier' && prop.type === 'Identifier') {
        return `${obj.value}.${prop.value}`;
      }
    }
    return null;
  }

  /**
   * Extract API call from fetch()
   */
  private extractFetchCall(
    call: CallExpression,
    filePath: string,
    lines: string[]
  ): APICall | null {
    if (call.arguments.length === 0) return null;

    const firstArg = call.arguments[0];
    const urlInfo = this.extractUrlFromExpression(firstArg.expression);

    if (!urlInfo.url) return null;
    if (!urlInfo.isPlaceholder && !this.isApiUrl(urlInfo.url)) return null;

    let method: APICall['method'] = 'GET';
    let requiresAuth = false;

    // Check options argument
    if (call.arguments.length > 1) {
      const optionsArg = call.arguments[1].expression;
      if (optionsArg.type === 'ObjectExpression') {
        for (const prop of optionsArg.properties) {
          if (prop.type === 'KeyValueProperty' && prop.key.type === 'Identifier') {
            if (prop.key.value === 'method' && prop.value.type === 'StringLiteral') {
              method = this.normalizeMethod(prop.value.value);
            }
            if (prop.key.value === 'credentials' || prop.key.value === 'headers') {
              requiresAuth = true;
            }
          }
        }
      }
    }

    const line = this.getLineNumber(call.span.start, lines);

    return {
      id: `api-${++this.apiCallCounter}`,
      method,
      url: urlInfo.url,
      callType: 'fetch',
      filePath,
      line,
      containingFunction: 'unknown',
      usedIn: [],
      requiresAuth,
      category: this.categorizeApi(urlInfo.url),
    };
  }

  /**
   * Extract API call from axios.method()
   */
  private extractAxiosMethodCall(
    call: CallExpression,
    filePath: string,
    lines: string[],
    method: string
  ): APICall | null {
    if (call.arguments.length === 0) return null;

    const firstArg = call.arguments[0];
    const urlInfo = this.extractUrlFromExpression(firstArg.expression);

    if (!urlInfo.url) return null;

    const line = this.getLineNumber(call.span.start, lines);

    return {
      id: `api-${++this.apiCallCounter}`,
      method: this.normalizeMethod(method),
      url: urlInfo.url,
      callType: 'axios',
      filePath,
      line,
      containingFunction: 'unknown',
      usedIn: [],
      requiresAuth: false,
      category: this.categorizeApi(urlInfo.url),
    };
  }

  /**
   * Extract API call from axios() direct call
   */
  private extractAxiosDirectCall(
    call: CallExpression,
    filePath: string,
    lines: string[]
  ): APICall | null {
    if (call.arguments.length === 0) return null;

    const configArg = call.arguments[0].expression;
    if (configArg.type !== 'ObjectExpression') return null;

    let url: string | null = null;
    let method: APICall['method'] = 'GET';

    for (const prop of configArg.properties) {
      if (prop.type === 'KeyValueProperty' && prop.key.type === 'Identifier') {
        if (prop.key.value === 'url' && prop.value.type === 'StringLiteral') {
          url = prop.value.value;
        }
        if (prop.key.value === 'method' && prop.value.type === 'StringLiteral') {
          method = this.normalizeMethod(prop.value.value);
        }
      }
    }

    if (!url) return null;

    const line = this.getLineNumber(call.span.start, lines);

    return {
      id: `api-${++this.apiCallCounter}`,
      method,
      url,
      callType: 'axios',
      filePath,
      line,
      containingFunction: 'unknown',
      usedIn: [],
      requiresAuth: false,
      category: this.categorizeApi(url),
    };
  }

  /**
   * Extract API call from useSWR()
   */
  private extractSwrCall(call: CallExpression, filePath: string, lines: string[]): APICall | null {
    if (call.arguments.length === 0) return null;

    const keyArg = call.arguments[0].expression;
    const urlInfo = this.extractUrlFromExpression(keyArg);

    if (!urlInfo.url) return null;

    const line = this.getLineNumber(call.span.start, lines);

    return {
      id: `api-${++this.apiCallCounter}`,
      method: 'GET',
      url: urlInfo.url,
      callType: 'useSWR',
      filePath,
      line,
      containingFunction: 'unknown',
      usedIn: [],
      requiresAuth: false,
      category: this.categorizeApi(urlInfo.url),
    };
  }

  /**
   * Extract URL from an expression
   */
  private extractUrlFromExpression(expr: Expression): {
    url: string | null;
    isPlaceholder: boolean;
  } {
    if (expr.type === 'StringLiteral') {
      return { url: expr.value, isPlaceholder: false };
    }

    if (expr.type === 'TemplateLiteral') {
      // Simple template without expressions
      if (expr.quasis.length === 1 && expr.expressions.length === 0) {
        return { url: expr.quasis[0].raw, isPlaceholder: false };
      }
      // Template with expressions - create parameterized path
      const parts = expr.quasis.map((q) => q.raw);
      const url = parts.join(':param');
      return { url, isPlaceholder: true };
    }

    if (expr.type === 'Identifier') {
      return { url: `[${expr.value}]`, isPlaceholder: true };
    }

    if (expr.type === 'MemberExpression') {
      const obj = expr.object.type === 'Identifier' ? expr.object.value : '?';
      const prop = expr.property.type === 'Identifier' ? expr.property.value : '?';
      return { url: `[${obj}.${prop}]`, isPlaceholder: true };
    }

    // Conditional expression: condition ? url : null
    if (expr.type === 'ConditionalExpression') {
      const consequent = this.extractUrlFromExpression(expr.consequent);
      if (consequent.url) return consequent;
      return this.extractUrlFromExpression(expr.alternate);
    }

    return { url: null, isPlaceholder: false };
  }

  /**
   * Get line number from byte offset
   */
  private getLineNumber(offset: number, lines: string[]): number {
    let currentOffset = 0;
    for (let i = 0; i < lines.length; i++) {
      currentOffset += lines[i].length + 1; // +1 for newline
      if (currentOffset > offset) {
        return i + 1;
      }
    }
    return lines.length;
  }

  /**
   * Static file extensions to exclude from API detection
   */
  private static readonly STATIC_FILE_EXTENSIONS =
    /\.(css|js|mjs|cjs|ts|tsx|jsx|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|eot|otf|mp3|mp4|webm|ogg|wav|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz|rar|html|htm|xml|txt|md|map|wasm)$/i;

  /**
   * Non-API URL schemes to exclude
   */
  private static readonly NON_API_SCHEMES = /^(data:|blob:|javascript:|mailto:|tel:|file:)/;

  /**
   * Check if URL looks like an API endpoint (generic approach)
   * Uses exclusion-based logic: if it's not a static file, it's likely an API
   */
  private isApiUrl(url: string): boolean {
    // Exclude non-HTTP schemes
    if (RestApiAnalyzer.NON_API_SCHEMES.test(url)) return false;

    // Exclude static file extensions
    if (RestApiAnalyzer.STATIC_FILE_EXTENSIONS.test(url)) return false;

    // Exclude empty or whitespace-only URLs
    if (!url.trim()) return false;

    // Accept relative paths (likely internal API)
    if (url.startsWith('/')) return true;

    // Accept absolute URLs (http/https)
    if (url.startsWith('http://') || url.startsWith('https://')) return true;

    // Accept placeholder URLs (variables, dynamic)
    if (url.startsWith('[')) return true;

    // Accept URLs with API-like patterns
    if (
      url.includes('/api/') ||
      url.includes('/v1/') ||
      url.includes('/v2/') ||
      url.includes('/graphql')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Known external service patterns for categorization
   */
  private static readonly SERVICE_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /amazonaws\.com|\.s3\./i, name: 'AWS' },
    { pattern: /googleapis\.com|google\.com\/api/i, name: 'Google API' },
    { pattern: /graph\.facebook\.com|facebook\.com\/v\d+/i, name: 'Facebook' },
    { pattern: /api\.twitter\.com|twitter\.com\/\d+/i, name: 'Twitter/X' },
    { pattern: /api\.github\.com|github\.com\/api/i, name: 'GitHub API' },
    { pattern: /stripe\.com/i, name: 'Stripe' },
    { pattern: /paypal\.com/i, name: 'PayPal' },
    { pattern: /slack\.com/i, name: 'Slack' },
    { pattern: /discord\.com|discordapp\.com/i, name: 'Discord' },
    { pattern: /twilio\.com/i, name: 'Twilio' },
    { pattern: /sendgrid\.(com|net)/i, name: 'SendGrid' },
    { pattern: /mailchimp\.com/i, name: 'Mailchimp' },
    { pattern: /hubspot\.com|hsforms\.com/i, name: 'HubSpot' },
    { pattern: /salesforce\.com/i, name: 'Salesforce' },
    { pattern: /zendesk\.com/i, name: 'Zendesk' },
    { pattern: /intercom\.io/i, name: 'Intercom' },
    { pattern: /firebase(io)?\.com|firestore\.googleapis/i, name: 'Firebase' },
    { pattern: /supabase\.(co|com|io)/i, name: 'Supabase' },
    { pattern: /auth0\.com/i, name: 'Auth0' },
    { pattern: /okta\.com/i, name: 'Okta' },
    { pattern: /clerk\.(dev|com)/i, name: 'Clerk' },
    { pattern: /cloudflare\.com|workers\.dev/i, name: 'Cloudflare' },
    { pattern: /vercel\.com|vercel\.app/i, name: 'Vercel' },
    { pattern: /netlify\.com|netlify\.app/i, name: 'Netlify' },
    { pattern: /heroku\.com|herokuapp\.com/i, name: 'Heroku' },
    { pattern: /railway\.app/i, name: 'Railway' },
    { pattern: /render\.com/i, name: 'Render' },
    { pattern: /digitalocean\.com/i, name: 'DigitalOcean' },
    { pattern: /algolia\.(com|net|io)/i, name: 'Algolia' },
    { pattern: /elastic\.co|elasticsearch/i, name: 'Elasticsearch' },
    { pattern: /mongodb\.com|mongodb\.net/i, name: 'MongoDB' },
    { pattern: /planetscale\.com/i, name: 'PlanetScale' },
    { pattern: /sentry\.io/i, name: 'Sentry' },
    { pattern: /datadog\.com/i, name: 'Datadog' },
    { pattern: /segment\.(com|io)/i, name: 'Segment' },
    { pattern: /mixpanel\.com/i, name: 'Mixpanel' },
    { pattern: /amplitude\.com/i, name: 'Amplitude' },
    { pattern: /openai\.com/i, name: 'OpenAI' },
    { pattern: /anthropic\.com/i, name: 'Anthropic' },
    { pattern: /cohere\.(ai|com)/i, name: 'Cohere' },
  ];

  /**
   * Categorize API by URL pattern (generic approach)
   * Automatically extracts service name from domain if not in known patterns
   */
  private categorizeApi(url: string): string | undefined {
    // Check placeholder URLs
    if (url.startsWith('[')) return 'Dynamic URL';

    // Check internal routes
    if (url.startsWith('/')) {
      if (url.startsWith('/api/')) return 'Internal API';
      if (url.includes('/graphql')) return 'GraphQL';
      return 'Internal Route';
    }

    // Check known service patterns
    for (const { pattern, name } of RestApiAnalyzer.SERVICE_PATTERNS) {
      if (pattern.test(url)) {
        return name;
      }
    }

    // Extract domain name for unknown external APIs
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;

      // Remove common prefixes and suffixes
      const domainParts = hostname.replace(/^(api\.|www\.)/, '').split('.');
      if (domainParts.length >= 2) {
        // Get the main domain name (e.g., "example" from "api.example.com")
        const mainDomain = domainParts[domainParts.length - 2];
        // Capitalize first letter
        return mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1) + ' API';
      }
    } catch {
      // Invalid URL, skip categorization
    }

    return 'External API';
  }

  /**
   * Normalize HTTP method
   */
  private normalizeMethod(method: string): APICall['method'] {
    const upper = method.toUpperCase();
    if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(upper)) {
      return upper as APICall['method'];
    }
    return 'unknown';
  }
}
