import { Project, SyntaxKind, Node } from 'ts-morph';
import * as path from 'path';

const project = new Project({
  tsConfigFilePath: '/Users/leekyuhwan/wantedly-frontend/tsconfig.json',
  skipAddingFilesFromTsConfig: true,
});

const pageFilePath = '/Users/leekyuhwan/wantedly-frontend/src/pages/projects/index.tsx';
const sourceFileDir = path.dirname(pageFilePath);
const moduleSpec = '../../features/project-index/ProjectIndexPageJobPostsContainer';
const componentName = 'ProjectIndexPageJobPostsContainer';

console.log('=== Simulating analyzeImportedComponent ===\n');

// Resolve path
const resolvedPath = path.resolve(sourceFileDir, moduleSpec);
const componentFile = project.addSourceFileAtPath(`${resolvedPath}.tsx`);

console.log('File loaded:', componentFile.getFilePath().split('/').pop());

// Check GraphQL imports
const hasGraphQLImport = componentFile.getImportDeclarations().some((imp) => {
  const spec = imp.getModuleSpecifierValue();
  return spec.includes('@apollo/client') || spec.includes('gql') || 
         spec.includes('graphql') || spec.includes('__generated__');
});

console.log('hasGraphQLImport:', hasGraphQLImport);

if (hasGraphQLImport) {
  // Find hook calls
  const hookCalls = componentFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => {
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
