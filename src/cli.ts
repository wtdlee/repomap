#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs/promises';
import { DocGeneratorEngine } from './core/engine.js';
import { DocServer } from './server/doc-server.js';
import type { DocGeneratorConfig, RepositoryConfig, DocumentationReport } from './types.js';

const program = new Command();

program
  .name('repomap')
  .description('Interactive documentation generator for code repositories')
  .version('0.1.0');

/**
 * Auto-detect project type and settings
 */
async function detectProject(dir: string): Promise<RepositoryConfig | null> {
  const packageJsonPath = path.join(dir, 'package.json');

  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

    // Detect project type
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    let type: 'nextjs' | 'rails' | 'generic' = 'generic';

    if (deps['next']) {
      type = 'nextjs';
    }

    // Detect directories
    const settings: Record<string, string> = {};

    // Check common Next.js structures
    const possiblePagesDirs = ['src/pages', 'pages', 'app', 'src/app'];
    for (const pagesDir of possiblePagesDirs) {
      try {
        await fs.access(path.join(dir, pagesDir));
        settings.pagesDir = pagesDir;
        break;
      } catch {}
    }

    // Check for features directory
    const possibleFeaturesDirs = ['src/features', 'features', 'src/modules', 'modules'];
    for (const featuresDir of possibleFeaturesDirs) {
      try {
        await fs.access(path.join(dir, featuresDir));
        settings.featuresDir = featuresDir;
        break;
      } catch {}
    }

    // Check for components directory
    const possibleComponentsDirs = ['src/components', 'components', 'src/common/components'];
    for (const componentsDir of possibleComponentsDirs) {
      try {
        await fs.access(path.join(dir, componentsDir));
        settings.componentsDir = componentsDir;
        break;
      } catch {}
    }

    // Use directory name as the repository name (not package.json name)
    const dirName = path.basename(dir);
    return {
      name: dirName,
      displayName: dirName,
      description: packageJson.description || '',
      path: dir,
      branch: 'main',
      type,
      analyzers: ['pages', 'graphql', 'components', 'dataflow', 'rest-api'],
      settings,
    };
  } catch {
    return null;
  }
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
  .action(async (options) => {
    console.log(chalk.blue.bold('\n📚 Repomap - Documentation Generator\n'));

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
      const engine = new DocGeneratorEngine(config);

      if (options.watch) {
        console.log(chalk.yellow('\n👀 Watch mode enabled. Press Ctrl+C to stop.\n'));
        await watchAndGenerate(engine, config);
      } else {
        const report = await engine.generate();
        printSummary(report);
      }
    } catch (error) {
      console.error(chalk.red('\n❌ Error:'), (error as Error).message);
      process.exit(1);
    }
  });

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
  .action(async (options) => {
    console.log(chalk.blue.bold('\n🌐 Repomap - Documentation Server\n'));

    try {
      const targetPath = options.path || process.cwd();
      const config = await loadConfig(options.config, targetPath);

      const server = new DocServer(config, parseInt(options.port));
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
