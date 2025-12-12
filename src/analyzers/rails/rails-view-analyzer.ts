/**
 * Rails View Analyzer
 * Analyzes HAML/ERB views and their connections to controllers and APIs
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { glob } from 'glob';

export interface RailsViewInfo {
  name: string; // View name (e.g., "index", "show")
  path: string; // File path relative to app/views
  controller: string; // Controller name (e.g., "users", "projects")
  action: string; // Action name (e.g., "index", "show")
  format: string; // Format (html, json, etc.)
  template: 'haml' | 'erb' | 'other';
  routePath?: string; // Mapped route path
  partials: string[]; // Used partials
  helpers: string[]; // Used helpers
  instanceVars: string[]; // Instance variables (@var)
  line?: number;
}

export interface RailsPageInfo {
  route: string; // Route path (e.g., "/users/:id")
  method: string; // HTTP method
  controller: string; // Controller name
  action: string; // Action name
  view?: RailsViewInfo; // Associated view
  apis: RailsApiCall[]; // API calls in controller
  services: string[]; // Service calls
  grpcCalls: string[]; // gRPC calls
  modelAccess: string[]; // Model access
}

export interface RailsApiCall {
  type: 'grpc' | 'service' | 'http' | 'internal';
  name: string;
  method?: string;
  source: string; // File where it's called
  line?: number;
}

export interface RailsViewAnalysisResult {
  views: RailsViewInfo[];
  pages: RailsPageInfo[];
  summary: {
    totalViews: number;
    totalPages: number;
    byController: Record<string, number>;
    byTemplate: Record<string, number>;
  };
}

export async function analyzeRailsViews(rootPath: string): Promise<RailsViewAnalysisResult> {
  const viewsPath = path.join(rootPath, 'app/views');
  const controllersPath = path.join(rootPath, 'app/controllers');

  // Check if views directory exists
  try {
    await fs.access(viewsPath);
  } catch {
    return {
      views: [],
      pages: [],
      summary: { totalViews: 0, totalPages: 0, byController: {}, byTemplate: {} },
    };
  }

  // Find all view files
  const viewFiles = await glob('**/*.{haml,erb,html.haml,html.erb}', {
    cwd: viewsPath,
    nodir: true,
  });

  const views: RailsViewInfo[] = [];
  const byController: Record<string, number> = {};
  const byTemplate: Record<string, number> = {};

  for (const file of viewFiles) {
    const view = await parseViewFile(viewsPath, file);
    if (view) {
      views.push(view);

      // Count by controller
      byController[view.controller] = (byController[view.controller] || 0) + 1;

      // Count by template
      byTemplate[view.template] = (byTemplate[view.template] || 0) + 1;
    }
  }

  // Analyze controllers and map to pages
  const pages = await analyzeControllersForPages(controllersPath, views, rootPath);

  return {
    views,
    pages,
    summary: {
      totalViews: views.length,
      totalPages: pages.length,
      byController,
      byTemplate,
    },
  };
}

async function parseViewFile(
  viewsPath: string,
  relativePath: string
): Promise<RailsViewInfo | null> {
  const fullPath = path.join(viewsPath, relativePath);

  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    const parts = relativePath.split('/');

    // Skip mailer views, layouts, shared
    if (
      parts.some(
        (p) => p.endsWith('_mailer') || p === 'layouts' || p === 'shared' || p === 'devise'
      )
    ) {
      return null;
    }

    // Parse controller and action from path
    // e.g., users/show.html.haml -> controller: users, action: show
    const fileName = parts.pop() || '';
    const controller = parts.join('/') || 'application';

    // Parse filename: action.format.template
    const nameParts = fileName.split('.');
    const action = nameParts[0].replace(/^_/, ''); // Remove leading underscore for partials
    const isPartial = fileName.startsWith('_');
    const template = fileName.endsWith('.haml')
      ? 'haml'
      : fileName.endsWith('.erb')
        ? 'erb'
        : 'other';
    const format = nameParts.length > 2 ? nameParts[1] : 'html';

    // Skip partials for main page list
    if (isPartial) return null;

    // Extract information from content
    const partials = extractPartials(content, template);
    const helpers = extractHelpers(content, template);
    const instanceVars = extractInstanceVars(content);

    return {
      name: action,
      path: relativePath,
      controller,
      action,
      format,
      template,
      partials,
      helpers,
      instanceVars,
    };
  } catch {
    return null;
  }
}

function extractPartials(content: string, template: 'haml' | 'erb' | 'other'): string[] {
  const partials: string[] = [];

  if (template === 'haml') {
    // HAML: = render 'partial' or = render partial: 'name'
    const matches = content.matchAll(/=\s*render\s+(?:partial:\s*)?['"]([^'"]+)['"]/g);
    for (const match of matches) {
      partials.push(match[1]);
    }
  } else if (template === 'erb') {
    // ERB: <%= render 'partial' %>
    const matches = content.matchAll(/<%=?\s*render\s+(?:partial:\s*)?['"]([^'"]+)['"]/g);
    for (const match of matches) {
      partials.push(match[1]);
    }
  }

  return [...new Set(partials)];
}

function extractHelpers(content: string, template: 'haml' | 'erb' | 'other'): string[] {
  const helpers: string[] = [];

  // Common helpers: link_to, form_for, image_tag, etc.
  const helperPattern =
    /\b(link_to|form_for|form_with|image_tag|content_for|yield|render|t|l|raw|html_safe|simple_form_for)\b/g;
  const matches = content.matchAll(helperPattern);

  for (const match of matches) {
    helpers.push(match[1]);
  }

  return [...new Set(helpers)];
}

function extractInstanceVars(content: string): string[] {
  const vars: string[] = [];
  const matches = content.matchAll(/@(\w+)/g);

  for (const match of matches) {
    if (!['import', 'media', 'keyframes', 'charset'].includes(match[1])) {
      vars.push(match[1]);
    }
  }

  return [...new Set(vars)];
}

async function analyzeControllersForPages(
  controllersPath: string,
  views: RailsViewInfo[],
  rootPath: string
): Promise<RailsPageInfo[]> {
  const pages: RailsPageInfo[] = [];

  try {
    await fs.access(controllersPath);
  } catch {
    return pages;
  }

  const controllerFiles = await glob('**/*_controller.rb', {
    cwd: controllersPath,
    nodir: true,
  });

  // Load routes if available
  const routesMap = await loadRoutesMap(rootPath);

  for (const file of controllerFiles) {
    const fullPath = path.join(controllersPath, file);
    const content = await fs.readFile(fullPath, 'utf-8');

    // Parse controller name from filename
    // e.g., users_controller.rb -> users
    const controllerName = file.replace(/_controller\.rb$/, '').replace(/\//g, '/');

    // Extract actions and their API calls
    const controllerPages = parseControllerActions(content, controllerName, file, views, routesMap);
    pages.push(...controllerPages);
  }

  return pages;
}

async function loadRoutesMap(
  rootPath: string
): Promise<Map<string, { path: string; method: string }>> {
  const routesMap = new Map<string, { path: string; method: string }>();

  try {
    // Try to load from previously analyzed routes
    const railsDataPath = path.join(rootPath, '.repomap', 'rails-routes.json');
    const data = await fs.readFile(railsDataPath, 'utf-8');
    const routes = JSON.parse(data);

    for (const route of routes) {
      const key = `${route.controller}#${route.action}`;
      routesMap.set(key, { path: route.path, method: route.method });
    }
  } catch {
    // Routes not available
  }

  return routesMap;
}

function parseControllerActions(
  content: string,
  controllerName: string,
  sourceFile: string,
  views: RailsViewInfo[],
  routesMap: Map<string, { path: string; method: string }>
): RailsPageInfo[] {
  const pages: RailsPageInfo[] = [];

  // Extract public actions (methods before private/protected)
  const publicSection = content.split(/\n\s*(private|protected)\b/)[0];

  // Match action definitions
  const actionPattern = /def\s+(\w+)/g;
  let match;

  while ((match = actionPattern.exec(publicSection)) !== null) {
    const action = match[1];

    // Skip common non-action methods
    if (
      ['initialize', 'new', 'create', 'update', 'destroy', 'index', 'show', 'edit'].includes(
        action
      ) ||
      action.startsWith('set_') ||
      action.startsWith('_')
    ) {
      // These ARE valid actions, don't skip
    }

    // Find the action body
    const actionStart = match.index;
    const actionBody = extractActionBody(publicSection, actionStart);

    // Extract API calls from action
    const apis = extractApiCalls(actionBody, sourceFile);
    const services = extractServiceCalls(actionBody);
    const grpcCalls = extractGrpcCalls(actionBody);
    const modelAccess = extractModelAccess(actionBody);

    // Find matching view
    const view = views.find((v) => v.controller === controllerName && v.action === action);

    // Get route info
    const routeKey = `${controllerName}#${action}`;
    const routeInfo = routesMap.get(routeKey);

    pages.push({
      route: routeInfo?.path || `/${controllerName}/${action}`,
      method: routeInfo?.method || 'GET',
      controller: controllerName,
      action,
      view,
      apis,
      services,
      grpcCalls,
      modelAccess,
    });
  }

  return pages;
}

function extractActionBody(content: string, startIndex: number): string {
  // Simple extraction - find matching 'end'
  let depth = 0;
  let started = false;
  let body = '';

  for (let i = startIndex; i < content.length; i++) {
    const line = content.slice(i, content.indexOf('\n', i) + 1 || content.length);

    if (line.match(/^\s*(def|class|module|if|unless|case|while|until|for|begin|do)\b/)) {
      depth++;
      started = true;
    }
    if (line.match(/^\s*end\b/)) {
      depth--;
      if (started && depth === 0) {
        break;
      }
    }

    body += line;
    i = content.indexOf('\n', i);
    if (i === -1) break;
  }

  return body;
}

function extractApiCalls(content: string, sourceFile: string): RailsApiCall[] {
  const apis: RailsApiCall[] = [];

  // HTTP client calls
  const httpPatterns = [
    /HTTPClient\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi,
    /RestClient\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi,
    /Faraday\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi,
    /Net::HTTP\.(get|post)\s*\(/gi,
  ];

  for (const pattern of httpPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      apis.push({
        type: 'http',
        name: match[2] || 'HTTP call',
        method: match[1]?.toUpperCase(),
        source: sourceFile,
      });
    }
  }

  return apis;
}

function extractServiceCalls(content: string): string[] {
  const services: string[] = [];

  // Match Service.call or Service.call! or Service.new.call
  const pattern = /(\w+(?:::\w+)*Service)\.(?:call!?|new)/g;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    services.push(match[1]);
  }

  return [...new Set(services)];
}

function extractGrpcCalls(content: string): string[] {
  const grpcCalls: string[] = [];

  // Match gRPC calls: Grpc::XxxService or XxxGrpcService
  const patterns = [
    /(\w+(?:::\w+)*Grpc(?:::\w+)?)\./g,
    /Grpc::(\w+(?:::\w+)*)/g,
    /(\w+GrpcService)\./g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      grpcCalls.push(match[1]);
    }
  }

  return [...new Set(grpcCalls)];
}

function extractModelAccess(content: string): string[] {
  const models: string[] = [];

  // Match model access: ModelName.find, ModelName.where, etc.
  const pattern =
    /([A-Z][a-zA-Z0-9]+)\.(?:find|where|find_by|first|last|all|create|update|destroy|new)/g;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    // Skip common non-model classes
    if (
      !['File', 'Dir', 'Time', 'Date', 'DateTime', 'JSON', 'YAML', 'CSV', 'Logger'].includes(
        match[1]
      )
    ) {
      models.push(match[1]);
    }
  }

  return [...new Set(models)];
}
