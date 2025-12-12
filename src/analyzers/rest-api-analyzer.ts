import { Project, SyntaxKind, CallExpression, Node } from 'ts-morph';
import fg from 'fast-glob';
import * as path from 'path';
import { BaseAnalyzer } from './base-analyzer.js';
import type { AnalysisResult, APICall, RepositoryConfig } from '../types.js';

/**
 * Analyzer for REST API calls (fetch, axios, useSWR, etc.)
 * REST API呼び出しの分析器
 */
export class RestApiAnalyzer extends BaseAnalyzer {
  private project: Project;
  private apiCallCounter = 0;

  constructor(config: RepositoryConfig) {
    super(config);
    this.project = new Project({
      tsConfigFilePath: this.resolvePath('tsconfig.json'),
      skipAddingFilesFromTsConfig: true,
    });
  }

  getName(): string {
    return 'RestApiAnalyzer';
  }

  async analyze(): Promise<Partial<AnalysisResult>> {
    this.log('Starting REST API analysis...');

    const apiCalls: APICall[] = [];

    const tsFiles = await fg(['**/*.ts', '**/*.tsx'], {
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

    for (const filePath of tsFiles) {
      try {
        const sourceFile = this.project.addSourceFileAtPath(filePath);
        const relativePath = path.relative(this.basePath, filePath);

        // Find fetch() calls
        const fetchCalls = this.findFetchCalls(sourceFile, relativePath);
        apiCalls.push(...fetchCalls);

        // Find axios calls
        const axiosCalls = this.findAxiosCalls(sourceFile, relativePath);
        apiCalls.push(...axiosCalls);

        // Find useSWR calls
        const swrCalls = this.findSwrCalls(sourceFile, relativePath);
        apiCalls.push(...swrCalls);

        this.project.removeSourceFile(sourceFile);
      } catch {
        // Skip files that can't be parsed
      }
    }

    this.log(`Found ${apiCalls.length} REST API calls`);

    return { apiCalls };
  }

  /**
   * Find fetch() calls
   */
  private findFetchCalls(sourceFile: Node, filePath: string): APICall[] {
    const calls: APICall[] = [];

    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callExpressions) {
      try {
        const expression = call.getExpression();
        const expressionText = expression.getText();

        // Match fetch() or window.fetch()
        if (expressionText === 'fetch' || expressionText === 'window.fetch') {
          const apiCall = this.extractFetchCall(call, filePath);
          if (apiCall) {
            calls.push(apiCall);
          }
        }
      } catch {
        // Skip parsing errors
      }
    }

    return calls;
  }

  /**
   * Find axios calls (axios.get, axios.post, etc.)
   */
  private findAxiosCalls(sourceFile: Node, filePath: string): APICall[] {
    const calls: APICall[] = [];

    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callExpressions) {
      try {
        const expression = call.getExpression();
        const expressionText = expression.getText();

        // Match axios.get, axios.post, axios.put, axios.delete, axios.patch
        const axiosMatch = expressionText.match(/^axios\.(get|post|put|delete|patch)$/i);
        if (axiosMatch) {
          const apiCall = this.extractAxiosCall(call, filePath, axiosMatch[1].toUpperCase());
          if (apiCall) {
            calls.push(apiCall);
          }
        }

        // Match axios() direct call
        if (expressionText === 'axios') {
          const apiCall = this.extractAxiosDirectCall(call, filePath);
          if (apiCall) {
            calls.push(apiCall);
          }
        }
      } catch {
        // Skip parsing errors
      }
    }

    return calls;
  }

  /**
   * Find useSWR calls
   */
  private findSwrCalls(sourceFile: Node, filePath: string): APICall[] {
    const calls: APICall[] = [];

    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callExpressions) {
      try {
        const expression = call.getExpression();
        const expressionText = expression.getText();

        // Match useSWR
        if (expressionText === 'useSWR' || expressionText === 'useSWRImmutable') {
          const apiCall = this.extractSwrCall(call, filePath);
          if (apiCall) {
            calls.push(apiCall);
          }
        }
      } catch {
        // Skip parsing errors
      }
    }

    return calls;
  }

  /**
   * Extract API call info from fetch()
   */
  private extractFetchCall(call: CallExpression, filePath: string): APICall | null {
    const args = call.getArguments();
    if (args.length === 0) return null;

    const urlArg = args[0].getText();
    const urlInfo = this.extractUrlFromArg(urlArg);

    if (!urlInfo.url) return null;

    // Skip non-API URLs only if we have a concrete URL (not a placeholder)
    if (!urlInfo.isPlaceholder && !this.isApiUrl(urlInfo.url)) return null;

    let method: APICall['method'] = 'GET';
    let requiresAuth = false;

    // Check options argument for method
    if (args.length > 1) {
      const optionsText = args[1].getText();
      const methodMatch = optionsText.match(/method:\s*["'](\w+)["']/i);
      if (methodMatch) {
        method = this.normalizeMethod(methodMatch[1]);
      }
      requiresAuth =
        optionsText.includes('credentials') ||
        optionsText.includes('Authorization') ||
        optionsText.includes('withCredentials');
    }

    const containingFunction = this.getContainingFunctionName(call);
    const line = call.getStartLineNumber();

    return {
      id: `api-${++this.apiCallCounter}`,
      method,
      url: urlInfo.url,
      callType: 'fetch',
      filePath,
      line,
      containingFunction,
      usedIn: [],
      requiresAuth,
      category: this.categorizeApi(urlInfo.url),
    };
  }

  /**
   * Extract API call info from axios.method()
   */
  private extractAxiosCall(call: CallExpression, filePath: string, method: string): APICall | null {
    const args = call.getArguments();
    if (args.length === 0) return null;

    const urlArg = args[0].getText();
    const urlInfo = this.extractUrlFromArg(urlArg);

    if (!urlInfo.url) return null;

    let requiresAuth = false;
    if (args.length > 1) {
      const optionsText = args[args.length - 1].getText();
      requiresAuth =
        optionsText.includes('withCredentials') || optionsText.includes('Authorization');
    }

    const containingFunction = this.getContainingFunctionName(call);
    const line = call.getStartLineNumber();

    return {
      id: `api-${++this.apiCallCounter}`,
      method: this.normalizeMethod(method),
      url: urlInfo.url,
      callType: 'axios',
      filePath,
      line,
      containingFunction,
      usedIn: [],
      requiresAuth,
      category: this.categorizeApi(urlInfo.url),
    };
  }

  /**
   * Extract API call info from axios() direct call
   */
  private extractAxiosDirectCall(call: CallExpression, filePath: string): APICall | null {
    const args = call.getArguments();
    if (args.length === 0) return null;

    const configText = args[0].getText();
    const urlMatch = configText.match(/url:\s*["'`]([^"'`]+)["'`]/);
    const methodMatch = configText.match(/method:\s*["'](\w+)["']/i);

    if (!urlMatch) return null;

    const url = urlMatch[1];
    const method = methodMatch ? this.normalizeMethod(methodMatch[1]) : 'GET';
    const requiresAuth =
      configText.includes('withCredentials') || configText.includes('Authorization');

    const containingFunction = this.getContainingFunctionName(call);
    const line = call.getStartLineNumber();

    return {
      id: `api-${++this.apiCallCounter}`,
      method,
      url,
      callType: 'axios',
      filePath,
      line,
      containingFunction,
      usedIn: [],
      requiresAuth,
      category: this.categorizeApi(url),
    };
  }

  /**
   * Extract API call info from useSWR()
   */
  private extractSwrCall(call: CallExpression, filePath: string): APICall | null {
    const args = call.getArguments();
    if (args.length === 0) return null;

    const keyArg = args[0].getText();
    let url: string | null = null;

    // String literal: useSWR("/api/users", fetcher)
    if (keyArg.startsWith('"') || keyArg.startsWith("'") || keyArg.startsWith('`')) {
      url = this.cleanStringLiteral(keyArg);
    }
    // Conditional: useSWR(condition ? "/api/users" : null, fetcher)
    else if (keyArg.includes('?') && keyArg.includes(':')) {
      // Try to find URL in true branch
      let match = keyArg.match(/\?\s*["'`]([^"'`]+)["'`]/);
      if (match) {
        url = match[1];
      } else {
        // Try to find URL in false branch
        match = keyArg.match(/:\s*["'`]([^"'`]+)["'`]/);
        if (match) {
          url = match[1];
        }
      }

      // If still no URL, check for template literals in the condition
      if (!url) {
        match = keyArg.match(/\?\s*`([^`]+)`/);
        if (match) {
          url = match[1].replace(/\$\{[^}]+\}/g, ':param');
        }
      }
    }
    // Function call pattern
    else {
      const urlInfo = this.extractUrlFromArg(keyArg);
      if (urlInfo.url && !keyArg.includes('null') && !keyArg.includes('undefined')) {
        url = urlInfo.url;
      }
    }

    if (!url) return null;

    const containingFunction = this.getContainingFunctionName(call);
    const line = call.getStartLineNumber();

    return {
      id: `api-${++this.apiCallCounter}`,
      method: 'GET', // SWR is typically for GET requests
      url,
      callType: 'useSWR',
      filePath,
      line,
      containingFunction,
      usedIn: [],
      requiresAuth: false,
      category: this.categorizeApi(url),
    };
  }

  /**
   * Get the name of the containing function/component
   */
  private getContainingFunctionName(node: Node): string {
    let current: Node | undefined = node;

    while (current) {
      // Function declaration
      if (Node.isFunctionDeclaration(current)) {
        return current.getName() || 'anonymous';
      }

      // Variable declaration with arrow function
      if (Node.isVariableDeclaration(current)) {
        return current.getName();
      }

      // Method declaration
      if (Node.isMethodDeclaration(current)) {
        return current.getName();
      }

      // Arrow function in variable
      if (Node.isArrowFunction(current)) {
        const parent = current.getParent();
        if (parent && Node.isVariableDeclaration(parent)) {
          return parent.getName();
        }
      }

      current = current.getParent();
    }

    return 'unknown';
  }

  /**
   * Extract URL from argument (handles literals, variables, function calls)
   */
  private extractUrlFromArg(argText: string): { url: string | null; isPlaceholder: boolean } {
    // String literal: "url" or 'url' or `url`
    if (/^["'`]/.test(argText)) {
      const url = this.cleanStringLiteral(argText);
      return { url, isPlaceholder: false };
    }

    // Function call: someUrlBuilder("/path") or buildUrl(`/path`)
    const funcCallMatch = argText.match(/^(\w+)\s*\(\s*["'`]([^"'`]+)["'`]/);
    if (funcCallMatch) {
      return { url: `[${funcCallMatch[1]}] ${funcCallMatch[2]}`, isPlaceholder: true };
    }

    // Function call with template literal: someFunc(`/path/${var}`)
    const funcTemplateMatch = argText.match(/^(\w+)\s*\(\s*`([^`]+)`/);
    if (funcTemplateMatch) {
      const path = funcTemplateMatch[2].replace(/\$\{[^}]+\}/g, ':param');
      return { url: `[${funcTemplateMatch[1]}] ${path}`, isPlaceholder: true };
    }

    // Variable reference: use as placeholder
    if (/^\w+(\.\w+)*$/.test(argText)) {
      return { url: `[${argText}]`, isPlaceholder: true };
    }

    // Property access: obj.url
    if (argText.includes('.')) {
      return { url: `[${argText}]`, isPlaceholder: true };
    }

    return { url: null, isPlaceholder: false };
  }

  /**
   * Clean string literal (remove quotes)
   */
  private cleanStringLiteral(value: string): string | null {
    // Remove quotes and template literal markers
    const cleaned = value.replace(/^["'`]|["'`]$/g, '').trim();

    // Skip template literals with expressions
    if (cleaned.includes('${')) {
      // Try to extract the base path and convert expressions to :param
      const parameterized = cleaned.replace(/\$\{[^}]+\}/g, ':param');
      return parameterized;
    }

    return cleaned || null;
  }

  /**
   * Check if URL looks like an API endpoint
   */
  private isApiUrl(url: string): boolean {
    // Skip data URLs, blob URLs, etc.
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      return false;
    }

    // Skip file extensions that are clearly not APIs
    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|html)$/i.test(url)) {
      return false;
    }

    // Accept paths that look like API endpoints
    return (
      url.startsWith('/') ||
      url.startsWith('http') ||
      url.includes('/api/') ||
      url.includes('.json') ||
      // Common external API patterns
      url.includes('api.') ||
      url.includes('github.io') || // GitHub Pages hosted APIs
      url.includes('hsforms.com') || // HubSpot
      url.includes('hubspot') || // HubSpot
      url.includes('amazonaws.com') || // AWS S3
      url.includes('s3.') || // AWS S3 alternative
      url.includes('googleapis.com') || // Google APIs
      url.includes('stripe.com') || // Stripe
      url.includes('graph.facebook.com') || // Facebook
      url.includes('api.twitter.com') || // Twitter
      url.includes('slack.com') || // Slack
      url.includes('discord.com') || // Discord
      url.includes('sendgrid.com') || // SendGrid
      url.includes('twilio.com') || // Twilio
      url.includes('firebase') || // Firebase
      url.includes('supabase') || // Supabase
      url.includes('auth0.com') || // Auth0
      url.includes('okta.com') || // Okta
      url.includes('cloudflare.com') || // Cloudflare
      url.includes('vercel.com') || // Vercel
      url.includes('netlify.com') // Netlify
    );
  }

  /**
   * Categorize API by URL pattern
   */
  private categorizeApi(url: string): string | undefined {
    // External services
    if (url.includes('hsforms.com') || url.includes('hubspot')) return 'HubSpot';
    if (url.includes('amazonaws.com') || url.includes('s3.')) return 'AWS S3';
    if (url.includes('googleapis.com')) return 'Google API';
    if (url.includes('stripe.com')) return 'Stripe';
    if (url.includes('graph.facebook.com')) return 'Facebook';
    if (url.includes('api.twitter.com')) return 'Twitter';
    if (url.includes('slack.com')) return 'Slack';
    if (url.includes('discord.com')) return 'Discord';
    if (url.includes('sendgrid.com')) return 'SendGrid';
    if (url.includes('twilio.com')) return 'Twilio';
    if (url.includes('firebase')) return 'Firebase';
    if (url.includes('supabase')) return 'Supabase';
    if (url.includes('auth0.com')) return 'Auth0';
    if (url.includes('okta.com')) return 'Okta';
    if (url.includes('github.io')) return 'GitHub Pages API';

    // Internal patterns
    if (url.startsWith('/api/')) return 'Internal API';
    if (url.startsWith('/')) return 'Internal Route';

    // Dynamic/placeholder URLs
    if (url.startsWith('[')) return 'Dynamic URL';

    return undefined;
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
