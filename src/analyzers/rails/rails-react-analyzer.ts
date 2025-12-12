/**
 * Rails React Component Analyzer
 * Analyzes React components used in Rails views (HAML/ERB)
 * and maps them to their entry points and source files
 *
 * Supports multiple React-Rails integration patterns:
 * - react-rails gem (data-react-component, render_react_component)
 * - react_on_rails gem (react_component, redux_store)
 * - Webpacker packs
 * - Vite entrypoints
 * - Custom entry point patterns
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { glob } from 'glob';

export interface ReactComponentMapping {
  name: string; // Component name used in views
  entryFile?: string; // Entry point file
  sourceFile?: string; // Actual component source
  importPath?: string; // Import path from entry file
  ssr: boolean; // Server-side rendered
  usedIn: ReactComponentUsage[]; // Where it's used
}

export interface ReactComponentUsage {
  viewPath: string; // View file path
  controller: string; // Controller name
  action: string; // Action name
  propsVar?: string; // Props variable
  line?: number;
  pattern: ReactMountPattern;
}

export type ReactMountPattern =
  | 'data-react-component' // react-rails: data attribute
  | 'render_react_component' // react-rails: helper
  | 'react_component' // react_on_rails: helper
  | 'redux_store' // react_on_rails: redux
  | 'stimulus-reflex' // Stimulus with React
  | 'turbo-frame-react'; // Turbo with React

export interface ReactAnalysisResult {
  components: ReactComponentMapping[];
  entryPoints: EntryPointInfo[];
  detectedPaths: DetectedPaths;
  summary: {
    totalComponents: number;
    totalEntryPoints: number;
    ssrComponents: number;
    clientComponents: number;
  };
}

export interface EntryPointInfo {
  file: string;
  fullPath: string;
  componentName: string;
  imports: string[];
  selector?: string;
}

export interface DetectedPaths {
  entryDirs: string[];
  componentDirs: string[];
  integrationPattern:
    | 'react-rails'
    | 'react_on_rails'
    | 'webpacker'
    | 'vite'
    | 'custom'
    | 'unknown';
}

// Common entry point directory patterns
const COMMON_ENTRY_PATTERNS = [
  // Webpacker (Rails 5.1+)
  'app/javascript/packs',
  'app/javascript/entrypoints',
  // Vite Rails
  'app/frontend/entrypoints',
  // jsbundling-rails
  'app/javascript/application',
  // Custom patterns
  'frontend/assets/javascripts/entries',
  'frontend/entries',
  'app/assets/javascripts/entries',
  'client/entries',
  'src/entries',
];

// Common component directory patterns
const COMMON_COMPONENT_PATTERNS = [
  // Standard Rails
  'app/javascript/components',
  'app/javascript/react',
  'app/javascript/src/components',
  // Webpacker
  'app/javascript/bundles',
  // Vite
  'app/frontend/components',
  'app/frontend/react',
  // Custom patterns
  'frontend/assets/javascripts/react',
  'frontend/assets/javascripts/components',
  'frontend/src',
  'frontend/src/components',
  'frontend/components',
  'client/components',
  'src/components',
];

// React mount patterns in views
const VIEW_PATTERNS = {
  // react-rails gem
  dataReactComponent: /react_component:\s*["']([A-Za-z0-9_/]+)["']/g,
  renderReactComponent: /render_react_component\s*\(?\s*["']([A-Za-z0-9_/]+)["']/g,
  // react_on_rails gem
  reactComponent: /<%=?\s*react_component\s*\(\s*["']([A-Za-z0-9_/]+)["']/g,
  reduxStore: /<%=?\s*redux_store\s*\(\s*["']([A-Za-z0-9_/]+)["']/g,
  // Generic patterns
  dataComponent: /data-component\s*[=:]\s*["']([A-Za-z0-9_/]+)["']/g,
  dataReactClass: /data-react-class\s*[=:]\s*["']([A-Za-z0-9_/]+)["']/g,
};

export async function analyzeReactComponents(rootPath: string): Promise<ReactAnalysisResult> {
  const components = new Map<string, ReactComponentMapping>();
  const entryPoints: EntryPointInfo[] = [];

  // 1. Detect project structure
  const detectedPaths = await detectProjectStructure(rootPath);
  console.log(
    `   📂 Detected paths: ${detectedPaths.entryDirs.length} entry dirs, ${detectedPaths.componentDirs.length} component dirs (${detectedPaths.integrationPattern})`
  );

  // 2. Analyze entry point files from all detected directories
  for (const entryDir of detectedPaths.entryDirs) {
    const fullEntryDir = path.join(rootPath, entryDir);
    try {
      await fs.access(fullEntryDir);
      const entryFiles = await glob('**/*.{tsx,ts,jsx,js}', {
        cwd: fullEntryDir,
        nodir: true,
        ignore: ['**/*.d.ts', '**/*.test.*', '**/*.spec.*'],
      });

      for (const file of entryFiles) {
        const entryInfo = await parseEntryPoint(path.join(fullEntryDir, file), file, entryDir);
        if (entryInfo) {
          entryPoints.push(entryInfo);

          // Create or update component mapping
          if (entryInfo.componentName) {
            const existing = components.get(entryInfo.componentName);
            if (existing) {
              existing.entryFile = path.join(entryDir, file);
              existing.importPath = entryInfo.imports[0];
            } else {
              components.set(entryInfo.componentName, {
                name: entryInfo.componentName,
                entryFile: path.join(entryDir, file),
                importPath: entryInfo.imports[0],
                ssr: false,
                usedIn: [],
              });
            }
          }
        }
      }
    } catch {
      // Entry directory doesn't exist
    }
  }

  // 3. Analyze view files for React component usage
  const viewsPath = path.join(rootPath, 'app/views');
  try {
    await fs.access(viewsPath);
    const viewFiles = await glob('**/*.{haml,erb,html.haml,html.erb,slim}', {
      cwd: viewsPath,
      nodir: true,
    });

    for (const viewFile of viewFiles) {
      const usages = await findReactUsageInView(path.join(viewsPath, viewFile), viewFile);
      for (const usage of usages) {
        const existing = components.get(usage.componentName);
        if (existing) {
          existing.usedIn.push({
            viewPath: viewFile,
            controller: usage.controller,
            action: usage.action,
            propsVar: usage.propsVar,
            line: usage.line,
            pattern: usage.pattern,
          });
          if (usage.ssr) existing.ssr = true;
        } else {
          components.set(usage.componentName, {
            name: usage.componentName,
            ssr: usage.ssr,
            usedIn: [
              {
                viewPath: viewFile,
                controller: usage.controller,
                action: usage.action,
                propsVar: usage.propsVar,
                line: usage.line,
                pattern: usage.pattern,
              },
            ],
          });
        }
      }
    }
  } catch {
    // Views directory doesn't exist
  }

  // 4. Try to resolve source files for components
  await resolveSourceFiles(rootPath, components, detectedPaths.componentDirs);

  const componentList = Array.from(components.values());
  const ssrCount = componentList.filter((c) => c.ssr).length;

  return {
    components: componentList,
    entryPoints,
    detectedPaths,
    summary: {
      totalComponents: componentList.length,
      totalEntryPoints: entryPoints.length,
      ssrComponents: ssrCount,
      clientComponents: componentList.length - ssrCount,
    },
  };
}

/**
 * Auto-detect project structure for React integration
 */
async function detectProjectStructure(rootPath: string): Promise<DetectedPaths> {
  const entryDirs: string[] = [];
  const componentDirs: string[] = [];
  let integrationPattern: DetectedPaths['integrationPattern'] = 'unknown';

  // Check for entry point directories
  for (const pattern of COMMON_ENTRY_PATTERNS) {
    const fullPath = path.join(rootPath, pattern);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        entryDirs.push(pattern);
      }
    } catch {
      // Directory doesn't exist
    }
  }

  // Check for component directories
  for (const pattern of COMMON_COMPONENT_PATTERNS) {
    const fullPath = path.join(rootPath, pattern);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        componentDirs.push(pattern);
      }
    } catch {
      // Directory doesn't exist
    }
  }

  // Detect integration pattern
  integrationPattern = await detectIntegrationPattern(rootPath);

  // If no entry dirs found, try to find any directory with React entry patterns
  if (entryDirs.length === 0) {
    const fallbackDirs = await findEntryPointDirectories(rootPath);
    entryDirs.push(...fallbackDirs);
  }

  // If no component dirs found, use entry dirs as fallback
  if (componentDirs.length === 0 && entryDirs.length > 0) {
    componentDirs.push(...entryDirs);
  }

  return { entryDirs, componentDirs, integrationPattern };
}

/**
 * Detect which React-Rails integration pattern is used
 */
async function detectIntegrationPattern(
  rootPath: string
): Promise<DetectedPaths['integrationPattern']> {
  try {
    // Check Gemfile for gem detection
    const gemfilePath = path.join(rootPath, 'Gemfile');
    const gemfile = await fs.readFile(gemfilePath, 'utf-8');

    if (gemfile.includes('react_on_rails')) return 'react_on_rails';
    if (gemfile.includes('react-rails')) return 'react-rails';
    if (gemfile.includes('vite_rails') || gemfile.includes('vite_ruby')) return 'vite';
    if (gemfile.includes('webpacker')) return 'webpacker';

    // Check for vite.config
    try {
      await fs.access(path.join(rootPath, 'vite.config.ts'));
      return 'vite';
    } catch {
      // No vite config
    }
    try {
      await fs.access(path.join(rootPath, 'vite.config.js'));
      return 'vite';
    } catch {
      // No vite config
    }

    return 'custom';
  } catch {
    return 'unknown';
  }
}

/**
 * Find directories that contain React entry point files
 */
async function findEntryPointDirectories(rootPath: string): Promise<string[]> {
  const dirs: string[] = [];

  // Search for directories that look like entry points
  const searchPatterns = [
    'app/**/entries',
    'app/**/packs',
    'frontend/**/entries',
    'client/**/entries',
    'src/**/entries',
  ];

  for (const pattern of searchPatterns) {
    try {
      const matches = await glob(pattern, {
        cwd: rootPath,
        nodir: false,
      });
      // Filter to only include directories
      for (const match of matches) {
        const fullPath = path.join(rootPath, match);
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isDirectory()) {
            dirs.push(match);
          }
        } catch {
          // Skip if can't stat
        }
      }
    } catch {
      // Glob error
    }
  }

  return dirs;
}

async function parseEntryPoint(
  fullPath: string,
  relativePath: string,
  entryDir: string
): Promise<EntryPointInfo | null> {
  try {
    const content = await fs.readFile(fullPath, 'utf-8');

    // Find component name from various selector patterns
    const selectorPatterns = [
      /\[data-react-component[=:][\s]*["']?([A-Za-z0-9_]+)["']?\]/,
      /\[data-component[=:][\s]*["']?([A-Za-z0-9_]+)["']?\]/,
      /\[data-react-class[=:][\s]*["']?([A-Za-z0-9_]+)["']?\]/,
      /getElementById\s*\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/,
      /querySelector\s*\(\s*["']#([A-Za-z0-9_-]+)["']\s*\)/,
    ];

    let componentName: string | null = null;
    let selector: string | undefined;

    for (const pattern of selectorPatterns) {
      const match = content.match(pattern);
      if (match) {
        componentName = match[1];
        selector = match[0];
        break;
      }
    }

    // Try to extract component name from file name if not found
    if (!componentName) {
      const baseName = path.basename(relativePath, path.extname(relativePath));
      // Convert snake_case or kebab-case to PascalCase
      componentName = baseName
        .split(/[-_]/)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join('');
    }

    // Find imports that look like React components
    const imports: string[] = [];
    const importMatches = content.matchAll(
      /import\s+(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g
    );
    for (const match of importMatches) {
      const importPath = match[1];
      // Filter for likely component imports
      if (
        importPath.includes('/react/') ||
        importPath.includes('/components/') ||
        importPath.includes('/containers/') ||
        importPath.includes('/bundles/') ||
        importPath.includes('/pages/') ||
        importPath.match(/\/[A-Z][a-zA-Z0-9]*/)
      ) {
        imports.push(importPath);
      }
    }

    // Also check for require statements (CommonJS)
    const requireMatches = content.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g);
    for (const match of requireMatches) {
      const requirePath = match[1];
      if (
        requirePath.includes('/react/') ||
        requirePath.includes('/components/') ||
        requirePath.includes('/containers/')
      ) {
        imports.push(requirePath);
      }
    }

    if (!componentName && imports.length === 0) return null;

    return {
      file: relativePath,
      fullPath: path.join(entryDir, relativePath),
      componentName: componentName || '',
      imports,
      selector,
    };
  } catch {
    return null;
  }
}

interface ViewUsage {
  componentName: string;
  controller: string;
  action: string;
  propsVar?: string;
  line?: number;
  pattern: ReactMountPattern;
  ssr: boolean;
}

async function findReactUsageInView(fullPath: string, relativePath: string): Promise<ViewUsage[]> {
  const usages: ViewUsage[] = [];

  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');

    // Parse controller and action from path
    const parts = relativePath.split('/');
    const fileName = parts.pop() || '';
    const controller = parts.join('/') || 'application';
    const action = fileName.split('.')[0].replace(/^_/, '');

    let lineNum = 0;
    for (const line of lines) {
      lineNum++;

      // Pattern 1: data: { react_component: "ComponentName" } (react-rails)
      const dataMatches = line.matchAll(VIEW_PATTERNS.dataReactComponent);
      for (const match of dataMatches) {
        const propsMatch = line.match(/react_component_props:\s*(@?\w+(?:\.\w+)*)/);
        usages.push({
          componentName: match[1],
          controller,
          action,
          propsVar: propsMatch ? propsMatch[1] : undefined,
          line: lineNum,
          pattern: 'data-react-component',
          ssr: false,
        });
      }

      // Pattern 2: render_react_component("ComponentName", ...) (react-rails)
      const renderMatch = line.match(VIEW_PATTERNS.renderReactComponent);
      if (renderMatch) {
        const ssrMatch = line.match(/ssr:\s*(true|false|@\w+)/);
        usages.push({
          componentName: renderMatch[1],
          controller,
          action,
          line: lineNum,
          pattern: 'render_react_component',
          ssr: ssrMatch ? ssrMatch[1] === 'true' || ssrMatch[1].startsWith('@') : false,
        });
      }

      // Pattern 3: react_component("ComponentName", ...) (react_on_rails)
      const reactOnRailsMatch = line.match(VIEW_PATTERNS.reactComponent);
      if (reactOnRailsMatch) {
        const propsMatch = line.match(/props:\s*(@?\w+(?:\.\w+)*)/);
        const prerenderMatch = line.match(/prerender:\s*(true|false)/);
        usages.push({
          componentName: reactOnRailsMatch[1],
          controller,
          action,
          propsVar: propsMatch ? propsMatch[1] : undefined,
          line: lineNum,
          pattern: 'react_component',
          ssr: prerenderMatch ? prerenderMatch[1] === 'true' : false,
        });
      }

      // Pattern 4: redux_store("StoreName", ...) (react_on_rails)
      const reduxMatch = line.match(VIEW_PATTERNS.reduxStore);
      if (reduxMatch) {
        usages.push({
          componentName: reduxMatch[1],
          controller,
          action,
          line: lineNum,
          pattern: 'redux_store',
          ssr: false,
        });
      }

      // Pattern 5: data-component="ComponentName" (generic)
      const dataCompMatch = line.match(VIEW_PATTERNS.dataComponent);
      if (dataCompMatch) {
        usages.push({
          componentName: dataCompMatch[1],
          controller,
          action,
          line: lineNum,
          pattern: 'data-react-component',
          ssr: false,
        });
      }

      // Pattern 6: data-react-class="ComponentName" (legacy react-rails)
      const reactClassMatch = line.match(VIEW_PATTERNS.dataReactClass);
      if (reactClassMatch) {
        usages.push({
          componentName: reactClassMatch[1],
          controller,
          action,
          line: lineNum,
          pattern: 'data-react-component',
          ssr: false,
        });
      }
    }
  } catch {
    // Error reading file
  }

  return usages;
}

async function resolveSourceFiles(
  rootPath: string,
  components: Map<string, ReactComponentMapping>,
  componentDirs: string[]
): Promise<void> {
  for (const [name, component] of components) {
    // Skip if name is invalid
    if (!name || typeof name !== 'string') continue;

    if (component.importPath && typeof component.importPath === 'string') {
      // Resolve from import path
      const cleanPath = component.importPath
        .replace(/\.js$/, '')
        .replace(/\.tsx?$/, '')
        .replace(/^\.\.\//, '')
        .replace(/^\.\//, '');
      component.sourceFile = cleanPath;
    } else if (!component.sourceFile) {
      // Try to find by component name in all component directories
      const extensions = ['.tsx', '.ts', '.jsx', '.js'];
      const namingPatterns = [
        name, // PascalCase
        toSnakeCase(name), // snake_case
        toKebabCase(name), // kebab-case
      ].filter(Boolean);

      let found = false;
      for (const dir of componentDirs) {
        if (found) break;

        for (const naming of namingPatterns) {
          if (found) break;

          for (const ext of extensions) {
            const possiblePaths = [
              path.join(rootPath, dir, naming, `index${ext}`),
              path.join(rootPath, dir, naming, `${naming}${ext}`),
              path.join(rootPath, dir, `${naming}${ext}`),
              path.join(rootPath, dir, 'components', `${naming}${ext}`),
              path.join(rootPath, dir, 'containers', `${naming}${ext}`),
            ];

            for (const possiblePath of possiblePaths) {
              try {
                await fs.access(possiblePath);
                component.sourceFile = path.relative(rootPath, possiblePath);
                found = true;
                break;
              } catch {
                // File doesn't exist, try next
              }
            }
          }
        }
      }
    }
  }
}

// Helper functions for case conversion
function toSnakeCase(str: string | undefined): string {
  if (!str) return '';
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

function toKebabCase(str: string | undefined): string {
  if (!str) return '';
  return str
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
}
