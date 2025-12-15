// This file is a local debugging script.
// It is intentionally parameterized (no hard-coded absolute paths) so it can run on any machine.
import { Project, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import { existsSync } from 'node:fs';

type CliArgs = {
  tsconfig: string;
  page: string;
  moduleSpec: string;
};

function parseArgs(argv: string[]): Partial<CliArgs> {
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tsconfig') out.tsconfig = argv[++i];
    else if (a === '--page') out.page = argv[++i];
    else if (a === '--moduleSpec') out.moduleSpec = argv[++i];
  }
  return out;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm -s tsx test-full.ts --tsconfig /abs/path/to/tsconfig.json --page /abs/path/to/page.tsx --moduleSpec ../../path/to/Component',
    '',
    'Env fallback:',
    '  REPOMAP_TEST_TSCONFIG, REPOMAP_TEST_PAGE, REPOMAP_TEST_MODULE_SPEC',
  ].join('\n');
}

const cli = parseArgs(process.argv.slice(2));
const tsConfigFilePath = cli.tsconfig ?? process.env.REPOMAP_TEST_TSCONFIG;
const pageFilePath = cli.page ?? process.env.REPOMAP_TEST_PAGE;
const moduleSpec = cli.moduleSpec ?? process.env.REPOMAP_TEST_MODULE_SPEC;

if (!tsConfigFilePath || !pageFilePath || !moduleSpec) {
  console.error(usage());
  process.exit(2);
}

const project = new Project({
  tsConfigFilePath,
  skipAddingFilesFromTsConfig: true,
});

const sourceFileDir = path.dirname(pageFilePath);

console.log('=== Simulating analyzeImportedComponent ===\n');

// Resolve path
const resolvedPath = path.resolve(sourceFileDir, moduleSpec);
const candidates = [
  resolvedPath,
  `${resolvedPath}.tsx`,
  `${resolvedPath}.ts`,
  path.join(resolvedPath, 'index.tsx'),
  path.join(resolvedPath, 'index.ts'),
];
const componentFilePath = candidates.find((p) => existsSync(p));
if (!componentFilePath) {
  console.error('Component file not found. Tried:\n' + candidates.map((c) => `- ${c}`).join('\n'));
  process.exit(1);
}

const componentFile = project.addSourceFileAtPath(componentFilePath);

console.log('File loaded:', componentFile.getFilePath().split('/').pop());

// Check GraphQL imports
const hasGraphQLImport = componentFile.getImportDeclarations().some((imp) => {
  const spec = imp.getModuleSpecifierValue();
  return (
    spec.includes('@apollo/client') ||
    spec.includes('gql') ||
    spec.includes('graphql') ||
    spec.includes('__generated__')
  );
});

console.log('hasGraphQLImport:', hasGraphQLImport);

if (hasGraphQLImport) {
  // Find hook calls
  const hookCalls = componentFile.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    const expression = call.getExpression().getText();
    return ['useQuery', 'useMutation', 'useLazyQuery'].includes(expression);
  });

  console.log(`\nFound ${hookCalls.length} direct hook calls:\n`);

  for (const call of hookCalls) {
    const hookName = call.getExpression().getText();
    const args = call.getArguments();
    if (args.length > 0) {
      const firstArg = args[0].getText();
      console.log(`${hookName}(${firstArg}, ...)`);

      // Try to find operation name
      const varDecl = componentFile.getVariableDeclaration(firstArg);
      if (varDecl) {
        const init = varDecl.getInitializer();
        if (init) {
          const text = init.getText();
          const match = text.match(/(?:query|mutation|subscription)\s+(\w+)/);
          if (match) {
            console.log(`  → Extracted: ${match[1]}`);
          } else {
            console.log(`  → Could not extract operation name`);
            console.log(`  → Initializer: ${text.substring(0, 100)}...`);
          }
        }
      } else {
        console.log(`  → Variable declaration NOT FOUND`);
      }
    }
  }
}
