import { Project, SourceFile, SyntaxKind, Node } from 'ts-morph';
import fg from 'fast-glob';
import * as path from 'path';
import { BaseAnalyzer } from './base-analyzer.js';
import type {
  AnalysisResult,
  PageInfo,
  AuthRequirement,
  DataFetchingInfo,
  NavigationInfo,
  RepositoryConfig,
} from '../types.js';

/**
 * Analyzer for Next.js pages
 * Next.jsページの分析器
 */
export class PagesAnalyzer extends BaseAnalyzer {
  private project: Project;

  constructor(config: RepositoryConfig) {
    super(config);
    this.project = new Project({
      tsConfigFilePath: this.resolvePath('tsconfig.json'),
      skipAddingFilesFromTsConfig: true,
    });
  }

  getName(): string {
    return 'PagesAnalyzer';
  }

  async analyze(): Promise<Partial<AnalysisResult>> {
    this.log('Starting page analysis...');

    const pagesDir = this.getSetting('pagesDir', 'src/pages');
    const pagesPath = this.resolvePath(pagesDir);

    // Find all page files
    const pageFiles = await fg(['**/*.tsx', '**/*.ts'], {
      cwd: pagesPath,
      ignore: ['_app.tsx', '_document.tsx', 'api/**'],
      absolute: true,
    });

    this.log(`Found ${pageFiles.length} page files`);

    const pages: PageInfo[] = [];

    for (const filePath of pageFiles) {
      try {
        const pageInfo = await this.analyzePageFile(filePath, pagesPath);
        if (pageInfo) {
          pages.push(pageInfo);
        }
      } catch (error) {
        this.warn(`Failed to analyze ${filePath}: ${(error as Error).message}`);
      }
    }

    this.log(`Analyzed ${pages.length} pages successfully`);

    return { pages };
  }

  private async analyzePageFile(filePath: string, pagesPath: string): Promise<PageInfo | null> {
    const sourceFile = this.project.addSourceFileAtPath(filePath);
    const relativePath = path.relative(pagesPath, filePath);
    const routePath = this.filePathToRoutePath(relativePath);

    // Extract page component
    const pageComponent = this.findPageComponent(sourceFile);
    if (!pageComponent) {
      return null;
    }

    // Extract various page information
    const params = this.extractRouteParams(routePath);
    const layout = this.extractLayout(sourceFile);
    const authentication = this.extractAuthRequirement(sourceFile);
    const permissions = this.extractPermissions(sourceFile);
    const dataFetching = this.extractDataFetching(sourceFile);
    const navigation = this.extractNavigation(sourceFile);
    const linkedPages = this.extractLinkedPages(sourceFile);

    return {
      path: routePath,
      filePath: relativePath,
      component: pageComponent,
      params,
      layout,
      authentication,
      permissions,
      dataFetching,
      navigation,
      linkedPages,
    };
  }

  private filePathToRoutePath(filePath: string): string {
    return (
      '/' +
      filePath
        .replace(/\.tsx?$/, '')
        .replace(/\/index$/, '')
        .replace(/\[\.\.\.(\w+)\]/g, '*')
        .replace(/\[(\w+)\]/g, ':$1')
    );
  }

  private extractRouteParams(routePath: string): string[] {
    const params: string[] = [];
    const paramRegex = /:(\w+)/g;
    let match;
    while ((match = paramRegex.exec(routePath)) !== null) {
      params.push(match[1]);
    }
    return params;
  }

  private findPageComponent(sourceFile: SourceFile): string | null {
    // Find default export
    const defaultExport = sourceFile.getDefaultExportSymbol();
    if (defaultExport) {
      return defaultExport.getName();
    }

    // Find Page variable
    const pageVar = sourceFile.getVariableDeclaration('Page');
    if (pageVar) {
      return 'Page';
    }

    return null;
  }

  private extractLayout(sourceFile: SourceFile): string | undefined {
    // Look for getLayout property
    const getLayoutAssignment = sourceFile
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .find((node) => node.getName() === 'getLayout');

    if (getLayoutAssignment) {
      const parent = getLayoutAssignment.getParent();
      if (Node.isBinaryExpression(parent)) {
        const right = parent.getRight();
        // Extract layout component name from the function
        const jsxElements = right.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);
        if (jsxElements.length > 0) {
          return jsxElements[0].getTagNameNode().getText();
        }
      }
    }

    return undefined;
  }

  private extractAuthRequirement(sourceFile: SourceFile): AuthRequirement {
    const filePath = sourceFile.getFilePath();
    const fileName = filePath.split('/').pop() || '';

    // Pages that don't require authentication (exceptions)
    const publicPages = [
      '404.tsx',
      'permission-denied.tsx',
      '_app.tsx',
      '_document.tsx',
      '_error.tsx',
    ];
    const isPublicPage = publicPages.some((p) => fileName === p);

    // Default: ALL pages require authentication (because _app.tsx wraps everything with RequireAuthorization)
    const result: AuthRequirement = {
      required: !isPublicPage,
    };

    try {
      // Look for RequiredConditionWithSession for additional permission checks
      const requiredCondition = sourceFile
        .getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
        .find((node) => node.getTagNameNode().getText().includes('RequiredCondition'));

      if (requiredCondition) {
        // Has additional permission requirements beyond basic auth
        result.condition = 'Additional permissions required';

        // Extract condition - safely iterate attributes
        const attributes = requiredCondition.getAttributes();
        for (const attr of attributes) {
          if (attr.isKind(SyntaxKind.JsxAttribute)) {
            try {
              const name = attr.getNameNode().getText();
              if (name === 'condition') {
                const initializer = attr.getInitializer();
                if (initializer) {
                  result.condition = initializer.getText();

                  // Extract roles from condition
                  const roles = this.extractRolesFromCondition(initializer.getText());
                  if (roles.length > 0) {
                    result.roles = roles;
                  }
                }
              }
            } catch {
              // Skip this attribute
            }
          }
        }
      }
    } catch {
      // Return default on error
    }

    return result;
  }

  private extractRolesFromCondition(condition: string): string[] {
    const roles: string[] = [];
    const roleRegex = /MembershipVisitRole\.(\w+)/g;
    let match;
    while ((match = roleRegex.exec(condition)) !== null) {
      roles.push(match[1]);
    }
    return roles;
  }

  private extractPermissions(sourceFile: SourceFile): string[] {
    const permissions: string[] = [];

    // Look for permission checks in the code
    const permissionChecks = sourceFile
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .filter((node) => {
        const text = node.getText();
        return text.includes('Permission') || text.includes('Role') || text.includes('isAdmin');
      });

    for (const check of permissionChecks) {
      const text = check.getText();
      if (!permissions.includes(text)) {
        permissions.push(text);
      }
    }

    return permissions;
  }

  private extractDataFetching(sourceFile: SourceFile): DataFetchingInfo[] {
    const dataFetching: DataFetchingInfo[] = [];

    // Find useQuery calls
    const useQueryCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => {
        const expression = call.getExpression().getText();
        return ['useQuery', 'useMutation', 'useLazyQuery'].includes(expression);
      });

    for (const call of useQueryCalls) {
      const type = call.getExpression().getText() as DataFetchingInfo['type'];
      const args = call.getArguments();

      let operationName = 'unknown';
      const variables: string[] = [];

      if (args.length > 0) {
        operationName = args[0]
          .getText()
          .replace(/Document$/, '')
          .replace(/Query$|Mutation$/, '');
      }

      if (args.length > 1) {
        const optionsArg = args[1];
        const variablesProperty = optionsArg
          .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
          .find((prop) => {
            try {
              return prop.getName() === 'variables';
            } catch {
              return false;
            }
          });

        if (variablesProperty) {
          const initializer = variablesProperty.getInitializer();
          if (initializer) {
            // Extract variable names
            const props = initializer.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
            for (const prop of props) {
              try {
                variables.push(prop.getName());
              } catch {
                // Skip
              }
            }
          }
        }
      }

      dataFetching.push({ type, operationName, variables });
    }

    // Find getServerSideProps
    const getServerSideProps = sourceFile.getFunction('getServerSideProps');
    if (getServerSideProps) {
      dataFetching.push({
        type: 'getServerSideProps',
        operationName: 'getServerSideProps',
      });
    }

    // Find getStaticProps
    const getStaticProps = sourceFile.getFunction('getStaticProps');
    if (getStaticProps) {
      dataFetching.push({
        type: 'getStaticProps',
        operationName: 'getStaticProps',
      });
    }

    // Also extract feature component imports for context
    const imports = sourceFile.getImportDeclarations();
    for (const imp of imports) {
      const moduleSpec = imp.getModuleSpecifierValue();
      // Track imports from features directory
      if (moduleSpec.includes('/features/')) {
        const namedImports = imp.getNamedImports();
        for (const named of namedImports) {
          const name = named.getName();
          // Mark as feature component reference
          if (name.includes('Container') || name.includes('Page') || name.includes('Form')) {
            dataFetching.push({
              type: 'useQuery',
              operationName: `→ ${name}`,
              variables: [],
            });
          }
        }

        // Default import
        const defaultImport = imp.getDefaultImport();
        if (defaultImport) {
          const name = defaultImport.getText();
          if (name.includes('Container') || name.includes('Page') || name.includes('Form')) {
            dataFetching.push({
              type: 'useQuery',
              operationName: `→ ${name}`,
              variables: [],
            });
          }
        }
      }
    }

    return dataFetching;
  }

  private extractNavigation(sourceFile: SourceFile): NavigationInfo {
    const result: NavigationInfo = {
      visible: true,
      currentNavItem: null,
    };

    try {
      // Find globalNavigationStyle assignment
      const navStyleAssignment = sourceFile
        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
        .find((node) => {
          try {
            return node.getName() === 'globalNavigationStyle';
          } catch {
            return false;
          }
        });

      if (navStyleAssignment) {
        const parent = navStyleAssignment.getParent();
        if (Node.isBinaryExpression(parent)) {
          const right = parent.getRight();

          // Extract visible
          const visibleProp = right
            .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
            .find((prop) => {
              try {
                return prop.getName() === 'visible';
              } catch {
                return false;
              }
            });
          if (visibleProp) {
            result.visible = visibleProp.getInitializer()?.getText() === 'true';
          }

          // Extract currentNavItem
          const navItemProp = right
            .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
            .find((prop) => {
              try {
                return prop.getName() === 'currentNavItem';
              } catch {
                return false;
              }
            });
          if (navItemProp) {
            const value = navItemProp.getInitializer()?.getText();
            result.currentNavItem = value && value !== 'null' ? value.replace(/['"]/g, '') : null;
          }

          // Extract mini
          const miniProp = right
            .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
            .find((prop) => {
              try {
                return prop.getName() === 'mini';
              } catch {
                return false;
              }
            });
          if (miniProp) {
            result.mini = miniProp.getInitializer()?.getText() === 'true';
          }
        }
      }
    } catch {
      // Return default on error
    }

    return result;
  }

  private extractLinkedPages(sourceFile: SourceFile): string[] {
    const linkedPages: string[] = [];

    // Find router.push/replace calls
    const routerCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => {
        const text = call.getExpression().getText();
        return (
          text.includes('router.push') || text.includes('router.replace') || text.includes('Link')
        );
      });

    for (const call of routerCalls) {
      const args = call.getArguments();
      if (args.length > 0) {
        const pathArg = args[0].getText();
        // Extract path string
        const pathMatch = pathArg.match(/['"`]([^'"`]+)['"`]/);
        if (pathMatch && !linkedPages.includes(pathMatch[1])) {
          linkedPages.push(pathMatch[1]);
        }
      }
    }

    // Find Link components
    const linkElements = sourceFile
      .getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
      .filter((node) => node.getTagNameNode().getText() === 'Link');

    for (const link of linkElements) {
      try {
        // Get all attributes and filter for JsxAttribute type (not JsxSpreadAttribute)
        const attributes = link.getAttributes();
        for (const attr of attributes) {
          // Check if it's a JsxAttribute
          if (attr.isKind(SyntaxKind.JsxAttribute)) {
            const nameNode = attr.getNameNode();
            const name = nameNode.getText();
            if (name === 'href') {
              const value = attr.getInitializer()?.getText();
              if (value) {
                const pathMatch = value.match(/['"`]([^'"`]+)['"`]/);
                if (pathMatch && !linkedPages.includes(pathMatch[1])) {
                  linkedPages.push(pathMatch[1]);
                }
              }
            }
          }
        }
      } catch {
        // Skip if attribute extraction fails
      }
    }

    return linkedPages;
  }
}
