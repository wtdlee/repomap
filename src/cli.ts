#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs/promises';
import { DocGeneratorEngine } from './core/engine.js';
import { DocServer } from './server/doc-server.js';
import type {
  DocGeneratorConfig,
  RepositoryConfig,
  DocumentationReport,
  AnalyzerType,
} from './types.js';

const program = new Command();

program
  .name('repomap')
  .description('Interactive documentation generator for code repositories')
  .version('0.1.0');

/**
 * Auto-detect project type and settings
 */
async function detectProject(dir: string): Promise<RepositoryConfig | null> {
  const dirName = path.basename(dir);
  let isRails = false;

  // Check for Rails project first
  const gemfilePath = path.join(dir, 'Gemfile');
  const routesPath = path.join(dir, 'config', 'routes.rb');

  try {
    await fs.access(gemfilePath);
    await fs.access(routesPath);

    // This is a Rails project
    const gemfile = await fs.readFile(gemfilePath, 'utf-8');
    isRails = gemfile.includes("gem 'rails'") || gemfile.includes('gem "rails"');
  } catch {
    // Not a Rails project, continue checking
  }

  const packageJsonPath = path.join(dir, 'package.json');
  let hasReact = false;
  let hasNextjs = false;
  const settings: Record<string, string> = {};

  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

    // Detect project type
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    hasReact = !!deps['react'];
    hasNextjs = !!deps['next'];

    // Check common Next.js structures
    const possiblePagesDirs = ['src/pages', 'pages', 'app', 'src/app', 'frontend/src'];
    for (const pagesDir of possiblePagesDirs) {
      try {
        await fs.access(path.join(dir, pagesDir));
        settings.pagesDir = pagesDir;
        break;
      } catch {}
    }

    // Check for features directory
    const possibleFeaturesDirs = [
      'src/features',
      'features',
      'src/modules',
      'modules',
      'frontend/src',
    ];
    for (const featuresDir of possibleFeaturesDirs) {
      try {
        await fs.access(path.join(dir, featuresDir));
        settings.featuresDir = featuresDir;
        break;
      } catch {}
    }

    // Check for components directory
    const possibleComponentsDirs = [
      'src/components',
      'components',
      'src/common/components',
      'frontend/src',
    ];
    for (const componentsDir of possibleComponentsDirs) {
      try {
        await fs.access(path.join(dir, componentsDir));
        settings.componentsDir = componentsDir;
        break;
      } catch {}
    }
  } catch {
    // No package.json
  }

  // Build analyzers list based on detected environments
  const analyzers: AnalyzerType[] = [];

  // Add frontend analyzers if React/Next.js detected
  if (hasReact || hasNextjs) {
    analyzers.push('pages', 'graphql', 'dataflow', 'rest-api');
  }

  // Rails analyzers are handled separately via Rails analysis

  // Determine project type
  let type: 'nextjs' | 'rails' | 'generic' = 'generic';
  if (hasNextjs) {
    type = 'nextjs';
  } else if (isRails) {
    type = 'rails';
  }

  // If nothing detected, return null
  if (!isRails && !hasReact && !hasNextjs) {
    return null;
  }

  return {
    name: dirName,
    displayName: dirName,
    description:
      isRails && hasReact ? 'Rails + React application' : isRails ? 'Rails application' : '',
    path: dir,
    branch: 'main',
    type,
    analyzers,
    settings,
  };
}

/**
 * Create default config for current directory
 */
async function createDefaultConfig(cwd: string): Promise<DocGeneratorConfig> {
  const project = await detectProject(cwd);

  if (!project) {
    throw new Error(
      "Could not detect project. Please create a repomap.config.ts file or run 'repomap init'."
    );
  }

  return {
    outputDir: './.repomap',
    site: {
      title: `${project.displayName} Documentation`,
      description: 'Auto-generated documentation',
      baseUrl: '/docs',
    },
    repositories: [project],
    analysis: {
      include: ['**/*.tsx', '**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/__tests__/**',
        '**/*.test.*',
        '**/*.spec.*',
        '**/dist/**',
        '**/.next/**',
      ],
      maxDepth: 5,
    },
    diagrams: {
      enabled: true,
      types: ['flowchart', 'sequence'],
      theme: 'default',
    },
    watch: {
      enabled: false,
      debounce: 1000,
    },
    integrations: {
      github: { enabled: false, organization: '' },
      slack: { enabled: false },
    },
  };
}

/**
 * Load config from file or auto-detect
 */
async function loadConfig(configPath: string | null, cwd: string): Promise<DocGeneratorConfig> {
  // Try to load config file
  const configFiles = configPath
    ? [configPath]
    : ['repomap.config.ts', 'repomap.config.js', 'repomap.config.mjs'];

  for (const file of configFiles) {
    const fullPath = path.resolve(cwd, file);
    try {
      await fs.access(fullPath);
      console.log(chalk.gray(`Loading config from: ${fullPath}`));
      const module = await import(fullPath);
      return module.config || module.default;
    } catch {}
  }

  // No config file, auto-detect
  console.log(chalk.gray('No config file found, auto-detecting project...'));
  return createDefaultConfig(cwd);
}

/**
 * Generate command - generates documentation
 */
program
  .command('generate')
  .description('Generate documentation from source code')
  .option('-c, --config <path>', 'Path to config file')
  .option('-o, --output <path>', 'Output directory')
  .option('--repo <name>', 'Analyze specific repository only')
  .option('--watch', 'Watch for changes and regenerate')
  .option('--no-cache', 'Disable caching (always analyze from scratch)')
  .option('--format <type>', 'Output format: json, html, markdown (default: all)', 'all')
  .option('--ci', 'CI mode: minimal output, exit codes for errors')
  .option('--static', 'Generate standalone HTML files (for GitHub Pages)')
  .action(async (options) => {
    const isCI = options.ci || process.env.CI === 'true';

    if (!isCI) {
      console.log(chalk.blue.bold('\n📚 Repomap - Documentation Generator\n'));
    }

    try {
      const cwd = process.cwd();
      const config = await loadConfig(options.config, cwd);

      // Override output if specified
      if (options.output) {
        config.outputDir = options.output;
      }

      // Filter repositories if specified
      if (options.repo) {
        config.repositories = config.repositories.filter((r) => r.name === options.repo);
        if (config.repositories.length === 0) {
          console.error(chalk.red(`Repository "${options.repo}" not found in config`));
          process.exit(1);
        }
      }

      // Create engine and generate
      const engine = new DocGeneratorEngine(config, { noCache: !options.cache });

      if (options.watch) {
        console.log(chalk.yellow('\n👀 Watch mode enabled. Press Ctrl+C to stop.\n'));
        await watchAndGenerate(engine, config);
      } else {
        const report = await engine.generate();

        // Handle different output formats
        if (options.format === 'json' || options.static) {
          const jsonPath = path.join(config.outputDir, 'report.json');
          await fs.mkdir(config.outputDir, { recursive: true });
          await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
          if (!isCI) console.log(chalk.green(`📄 JSON report: ${jsonPath}`));
        }

        // Generate static HTML files for GitHub Pages
        if (options.static) {
          await generateStaticSite(config, report, isCI);
        }

        if (!isCI) {
          printSummary(report);
        } else {
          // CI mode: minimal output
          const totalPages = report.repositories.reduce(
            (sum: number, r: { summary: { totalPages: number } }) => sum + r.summary.totalPages,
            0
          );
          console.log(`✅ Generated: ${totalPages} pages, ${report.repositories.length} repos`);
        }
      }
    } catch (error) {
      console.error(
        isCI ? `Error: ${(error as Error).message}` : chalk.red('\n❌ Error:'),
        (error as Error).message
      );
      process.exit(1);
    }
  });

/**
 * Generate static HTML site for GitHub Pages deployment
 */
async function generateStaticSite(
  config: DocGeneratorConfig,
  report: DocumentationReport,
  isCI: boolean
): Promise<void> {
  const { PageMapGenerator } = await import('./generators/page-map-generator.js');
  const { detectEnvironments } = await import('./utils/env-detector.js');

  const outputDir = config.outputDir;
  await fs.mkdir(outputDir, { recursive: true });

  // Detect environment for Rails support
  const rootPath = config.repositories[0]?.path || process.cwd();
  const envResult = await detectEnvironments(rootPath);

  let railsAnalysis = null;
  if (envResult.hasRails) {
    const { analyzeRailsApp } = await import('./analyzers/rails/index.js');
    railsAnalysis = await analyzeRailsApp(rootPath);
  }

  // Generate page-map.html
  const pageMapGenerator = new PageMapGenerator();
  const pageMapHtml = pageMapGenerator.generatePageMapHtml(report, {
    envResult,
    railsAnalysis,
    staticMode: true,
  });
  await fs.writeFile(path.join(outputDir, 'index.html'), pageMapHtml);
  if (!isCI) console.log(chalk.green(`📄 Static page map: ${path.join(outputDir, 'index.html')}`));

  // Generate rails-map.html if Rails detected
  if (railsAnalysis) {
    const { RailsMapGenerator } = await import('./generators/rails-map-generator.js');
    const railsGenerator = new RailsMapGenerator();
    const railsHtml = railsGenerator.generateFromResult(railsAnalysis);
    await fs.writeFile(path.join(outputDir, 'rails-map.html'), railsHtml);
    if (!isCI)
      console.log(chalk.green(`📄 Static Rails map: ${path.join(outputDir, 'rails-map.html')}`));
  }

  // Copy CSS assets
  const cssFiles = ['common.css', 'page-map.css', 'docs.css', 'rails-map.css'];
  const assetsDir = path.join(outputDir, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  for (const cssFile of cssFiles) {
    try {
      const cssPath = new URL(`./generators/assets/${cssFile}`, import.meta.url);
      const css = await fs.readFile(cssPath, 'utf-8');
      await fs.writeFile(path.join(assetsDir, cssFile), css);
    } catch {
      // CSS file not found, skip
    }
  }

  if (!isCI) {
    console.log(chalk.green(`\n✅ Static site generated in: ${outputDir}`));
    console.log(chalk.gray('   Deploy to GitHub Pages or any static hosting'));
  }
}

/**
 * Serve command - starts documentation server
 */
program
  .command('serve')
  .description('Start local documentation server with live reload')
  .option('-c, --config <path>', 'Path to config file')
  .option('--path <path>', 'Path to repository to analyze (auto-detect if no config)')
  .option('-p, --port <number>', 'Server port', '3030')
  .option('--no-open', "Don't open browser automatically")
  .option('--no-cache', 'Disable caching (always analyze from scratch)')
  .action(async (options) => {
    console.log(chalk.blue.bold('\n🌐 Repomap - Documentation Server\n'));

    try {
      const targetPath = options.path || process.cwd();
      const config = await loadConfig(options.config, targetPath);

      const server = new DocServer(config, parseInt(options.port), { noCache: !options.cache });
      await server.start(!options.open);
    } catch (error) {
      console.error(chalk.red('\n❌ Error:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * Init command - creates config file
 */
program
  .command('init')
  .description('Initialize repomap configuration')
  .option('-f, --force', 'Overwrite existing config')
  .action(async (options) => {
    const configPath = './repomap.config.ts';

    try {
      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);

      if (exists && !options.force) {
        console.log(chalk.yellow('Config file already exists. Use --force to overwrite.'));
        return;
      }

      // Detect current project
      const project = await detectProject(process.cwd());
      const projectName = project?.name || 'my-project';
      const projectType = project?.type || 'nextjs';
      const pagesDir = project?.settings.pagesDir || 'src/pages';
      const featuresDir = project?.settings.featuresDir || 'src/features';
      const componentsDir = project?.settings.componentsDir || 'src/components';

      const templateConfig = `import type { DocGeneratorConfig } from "repomap";

export const config: DocGeneratorConfig = {
  outputDir: "./.repomap",
  site: {
    title: "${projectName} Documentation",
    description: "Auto-generated documentation",
    baseUrl: "/docs",
  },
  repositories: [
    {
      name: "${projectName}",
      displayName: "${projectName}",
      description: "Main repository",
      path: ".",
      branch: "main",
      type: "${projectType}",
      analyzers: ["pages", "graphql", "components", "dataflow"],
      settings: {
        pagesDir: "${pagesDir}",
        featuresDir: "${featuresDir}",
        componentsDir: "${componentsDir}",
      },
    },
    // Add more repositories for cross-repo analysis:
    // {
    //   name: "other-repo",
    //   displayName: "Other Repository",
    //   description: "Another repository",
    //   path: "../other-repo",
    //   branch: "main",
    //   type: "nextjs",
    //   analyzers: ["pages", "graphql", "components", "dataflow"],
    //   settings: {},
    // },
  ],
  analysis: {
    include: ["**/*.tsx", "**/*.ts"],
    exclude: ["**/node_modules/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"],
    maxDepth: 5,
  },
  diagrams: {
    enabled: true,
    types: ["flowchart", "sequence"],
    theme: "default",
  },
  watch: {
    enabled: false,
    debounce: 1000,
  },
  integrations: {
    github: { enabled: false, organization: "" },
    slack: { enabled: false },
  },
};

export default config;
`;

      await fs.writeFile(configPath, templateConfig, 'utf-8');
      console.log(chalk.green(`✅ Created ${configPath}`));
      console.log(chalk.gray("\nRun 'npx repomap serve' to start the documentation server."));
    } catch (error) {
      console.error(chalk.red('Failed to create config:'), (error as Error).message);
    }
  });

/**
 * Rails command - analyze Rails application
 */
program
  .command('rails')
  .description('Analyze a Rails application and generate interactive map')
  .option('--path <path>', 'Path to Rails application')
  .option('-o, --output <path>', 'Output HTML file path')
  .action(async (options) => {
    console.log(chalk.blue.bold('\n🛤️ Repomap - Rails Analyzer\n'));

    try {
      const targetPath = options.path || process.cwd();

      // Verify it's a Rails project
      try {
        await fs.access(path.join(targetPath, 'config', 'routes.rb'));
      } catch {
        console.error(chalk.red('Not a Rails project (config/routes.rb not found)'));
        process.exit(1);
      }

      // Dynamically import Rails analyzer
      const { RailsMapGenerator } = await import('./generators/rails-map-generator.js');

      // Generate map
      const outputPath = options.output || path.join(targetPath, 'rails-map.html');
      const generator = new RailsMapGenerator(targetPath);
      await generator.generate({
        title: `${path.basename(targetPath)} - Rails Map`,
        outputPath,
      });

      console.log(chalk.green(`\n✅ Rails map generated: ${outputPath}`));

      // Open in browser
      const { exec } = await import('child_process');
      exec(`open "${outputPath}"`);
    } catch (error) {
      console.error(chalk.red('\n❌ Error:'), (error as Error).message);
      process.exit(1);
    }
  });

/**
 * Diff command - shows changes since last generation
 */
program
  .command('diff')
  .description('Show documentation changes since last generation')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    console.log(chalk.blue.bold('\n📊 Documentation Diff\n'));

    try {
      const cwd = process.cwd();
      const config = await loadConfig(options.config, cwd);

      const reportPath = path.join(config.outputDir, 'report.json');
      const reportExists = await fs
        .access(reportPath)
        .then(() => true)
        .catch(() => false);

      if (!reportExists) {
        console.log(chalk.yellow("No previous report found. Run 'generate' first."));
        return;
      }

      const previousReport = JSON.parse(await fs.readFile(reportPath, 'utf-8'));

      // Generate new report without writing
      const engine = new DocGeneratorEngine(config);
      const currentReport = await engine.generate();

      // Compare
      showDiff(previousReport, currentReport);
    } catch (error) {
      console.error(chalk.red('Failed to generate diff:'), (error as Error).message);
    }
  });

// Helper functions

async function watchAndGenerate(
  engine: DocGeneratorEngine,
  config: DocGeneratorConfig
): Promise<void> {
  // Initial generation
  await engine.generate();

  // Watch for changes using fs.watch
  const watchDirs = config.repositories.map((r) => r.path);

  for (const dir of watchDirs) {
    const watcher = fs.watch(dir, { recursive: true });

    let timeout: NodeJS.Timeout | null = null;

    for await (const event of watcher) {
      if (event.filename && (event.filename.endsWith('.ts') || event.filename.endsWith('.tsx'))) {
        if (timeout) clearTimeout(timeout);

        timeout = setTimeout(async () => {
          console.log(chalk.yellow(`\n🔄 Change detected: ${event.filename}`));
          await engine.generate();
        }, config.watch.debounce);
      }
    }
  }
}

function printSummary(report: DocumentationReport): void {
  console.log(chalk.green.bold('\n📈 Generation Summary\n'));

  for (const repo of report.repositories) {
    console.log(chalk.cyan(`  ${repo.displayName}:`));
    console.log(`    Pages: ${repo.summary.totalPages}`);
    console.log(`    Components: ${repo.summary.totalComponents}`);
    console.log(`    GraphQL Operations: ${repo.summary.totalGraphQLOperations}`);
    console.log(`    Data Flows: ${repo.summary.totalDataFlows}`);
    console.log();
  }

  console.log(chalk.gray(`  Generated at: ${report.generatedAt}`));
}

function showDiff(previous: DocumentationReport, current: DocumentationReport): void {
  console.log(chalk.cyan('Changes detected:\n'));

  for (const repo of current.repositories) {
    const prevRepo = previous.repositories.find((r) => r.name === repo.name);

    if (!prevRepo) {
      console.log(chalk.green(`  + New repository: ${repo.displayName}`));
      continue;
    }

    const pagesDiff = repo.summary.totalPages - prevRepo.summary.totalPages;
    const compDiff = repo.summary.totalComponents - prevRepo.summary.totalComponents;
    const gqlDiff = repo.summary.totalGraphQLOperations - prevRepo.summary.totalGraphQLOperations;

    if (pagesDiff !== 0 || compDiff !== 0 || gqlDiff !== 0) {
      console.log(chalk.yellow(`  ~ ${repo.displayName}:`));
      if (pagesDiff !== 0) {
        console.log(`    Pages: ${pagesDiff > 0 ? '+' : ''}${pagesDiff}`);
      }
      if (compDiff !== 0) {
        console.log(`    Components: ${compDiff > 0 ? '+' : ''}${compDiff}`);
      }
      if (gqlDiff !== 0) {
        console.log(`    GraphQL Ops: ${gqlDiff > 0 ? '+' : ''}${gqlDiff}`);
      }
    }
  }
}

program.parse();
