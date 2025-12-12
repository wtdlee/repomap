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
  StepInfo,
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
    const steps = this.extractSteps(sourceFile);

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
      steps: steps.length > 0 ? steps : undefined,
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
      const name = defaultExport.getName();
      // Handle 'default' export name
      if (name !== 'default') {
        return name;
      }
    }

    // Check for export default function/const
    const exportAssignment = sourceFile.getExportAssignment((e) => !e.isExportEquals());
    if (exportAssignment) {
      const expr = exportAssignment.getExpression();
      if (expr) {
        const text = expr.getText();
        // If it's a simple identifier, return it
        if (/^[A-Z][a-zA-Z0-9]*$/.test(text)) {
          return text;
        }
        // If it's a function expression, try to find the function name
        if (Node.isFunctionExpression(expr) || Node.isArrowFunction(expr)) {
          return 'default';
        }
      }
    }

    // Find export default function declaration
    const functions = sourceFile.getFunctions();
    for (const func of functions) {
      if (func.isDefaultExport()) {
        return func.getName() || 'default';
      }
    }

    // Find Page variable
    const pageVar = sourceFile.getVariableDeclaration('Page');
    if (pageVar) {
      return 'Page';
    }

    // Find NextPage typed variable (even without default export)
    const varDeclarations = sourceFile.getVariableDeclarations();
    for (const varDecl of varDeclarations) {
      const typeNode = varDecl.getTypeNode();
      if (typeNode) {
        const typeText = typeNode.getText();
        if (
          typeText.includes('NextPage') ||
          typeText.includes('FC') ||
          typeText.includes('React.FC')
        ) {
          return varDecl.getName();
        }
      }
    }

    // Find any PascalCase exported function/const that looks like a component
    for (const varDecl of varDeclarations) {
      const name = varDecl.getName();
      if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
        const init = varDecl.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          // Check if it returns JSX
          const text = init.getText();
          if (text.includes('return') && (text.includes('<') || text.includes('jsx'))) {
            return name;
          }
        }
      }
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
      // Look for common auth/permission wrapper components (generic patterns)
      const authPatterns = [
        'RequiredCondition',
        'ProtectedRoute',
        'AuthGuard',
        'PrivateRoute',
        'WithAuth',
        'RequireAuth',
        'Authenticated',
        'Authorized',
      ];

      const authWrapper = sourceFile
        .getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
        .find((node) => {
          const tagName = node.getTagNameNode().getText();
          return authPatterns.some((pattern) => tagName.includes(pattern));
        });

      if (authWrapper) {
        // Has additional permission requirements beyond basic auth
        result.condition = 'Additional permissions required';

        // Extract condition/roles - safely iterate attributes
        const attributes = authWrapper.getAttributes();
        for (const attr of attributes) {
          if (attr.isKind(SyntaxKind.JsxAttribute)) {
            try {
              const name = attr.getNameNode().getText();
              // Common attribute names for conditions/roles
              if (
                ['condition', 'roles', 'permissions', 'requiredRoles', 'allowedRoles'].includes(
                  name
                )
              ) {
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

    // Generic patterns for role extraction:
    // - EnumName.RoleName (e.g., UserRole.Admin, MembershipRole.Owner)
    // - 'role-name' or "role-name" string literals
    // - ROLE_NAME constants

    // Pattern 1: Enum-style roles (SomeEnum.RoleName)
    const enumRoleRegex = /(\w+Role|\w+Permission)\.(\w+)/g;
    let match;
    while ((match = enumRoleRegex.exec(condition)) !== null) {
      roles.push(match[2]);
    }

    // Pattern 2: String literals containing 'admin', 'user', 'owner', etc.
    const stringRoleRegex = /['"]([a-zA-Z_-]+)['"]/g;
    while ((match = stringRoleRegex.exec(condition)) !== null) {
      const val = match[1];
      // Only add if it looks like a role
      if (/admin|user|owner|member|guest|manager|editor|viewer/i.test(val)) {
        roles.push(val);
      }
    }

    // Pattern 3: UPPER_CASE constants
    const constRoleRegex = /\b(ROLE_\w+|[A-Z]+_ROLE)\b/g;
    while ((match = constRoleRegex.exec(condition)) !== null) {
      roles.push(match[1]);
    }

    return [...new Set(roles)]; // Remove duplicates
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

    // Build a map of imported GraphQL hooks (including aliases)
    // e.g., import { useQuery as getQuery } from '@apollo/client'
    const apolloHookAliases = new Map<string, string>();
    const apolloHooks = ['useQuery', 'useMutation', 'useLazyQuery', 'useSubscription'];

    for (const imp of sourceFile.getImportDeclarations()) {
      const moduleSpec = imp.getModuleSpecifierValue();
      if (moduleSpec.includes('@apollo/client') || moduleSpec.includes('apollo')) {
        for (const named of imp.getNamedImports()) {
          const originalName = named.getName();
          const alias = named.getAliasNode()?.getText() || originalName;
          if (apolloHooks.includes(originalName)) {
            apolloHookAliases.set(alias, originalName);
          }
        }
      }
    }

    // Check if this file uses Apollo Client
    const hasApolloImport =
      apolloHookAliases.size > 0 ||
      sourceFile.getImportDeclarations().some((imp) => {
        const moduleSpecifier = imp.getModuleSpecifierValue();
        return moduleSpecifier.includes('@apollo/client') || moduleSpecifier.includes('apollo');
      });

    // Find GraphQL hook calls - including aliases and custom hooks that wrap Apollo hooks
    const graphqlHookCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => {
        const expression = call.getExpression().getText();

        // Direct Apollo hook or alias
        if (apolloHookAliases.has(expression) || apolloHooks.includes(expression)) {
          return true;
        }

        // Custom hooks pattern: use*Query, use*Mutation (e.g., useUserQuery, useFetchPosts)
        // But exclude non-GraphQL hooks like useQueryParams, useQueryString
        if (
          /^use[A-Z].*Query$/.test(expression) &&
          !expression.includes('Params') &&
          !expression.includes('String')
        ) {
          return true;
        }
        if (/^use[A-Z].*Mutation$/.test(expression)) {
          return true;
        }

        return false;
      });

    for (const call of graphqlHookCalls) {
      const hookName = call.getExpression().getText();

      // Determine the actual type (resolve alias to original name)
      let resolvedType: DataFetchingInfo['type'];
      if (apolloHookAliases.has(hookName)) {
        resolvedType = apolloHookAliases.get(hookName) as DataFetchingInfo['type'];
      } else if (hookName.includes('Mutation')) {
        resolvedType = 'useMutation';
      } else if (hookName.includes('Lazy')) {
        resolvedType = 'useLazyQuery';
      } else {
        resolvedType = 'useQuery';
      }

      const args = call.getArguments();

      // Custom hooks might not have arguments (they encapsulate the query)
      if (args.length === 0) {
        // For custom hooks like useUserQuery(), extract name from hook name
        if (/^use[A-Z]/.test(hookName)) {
          const operationName = hookName.replace(/^use/, '').replace(/Query$|Mutation$/, '');
          dataFetching.push({ type: resolvedType, operationName, variables: [] });
        }
        continue;
      }

      const firstArg = args[0];
      const firstArgText = firstArg.getText();

      // Skip if first argument is:
      // - An array literal: ['key', ...]
      // - An object literal: { queryKey: ... }
      // - A string literal: 'queryKey'
      // These are React Query/TanStack Query patterns, not Apollo
      if (
        firstArgText.startsWith('[') ||
        firstArgText.startsWith('{') ||
        firstArgText.startsWith("'") ||
        firstArgText.startsWith('"') ||
        firstArgText.startsWith('`')
      ) {
        continue;
      }

      // Apollo Client pattern: first arg should be a Document identifier
      // Valid patterns: GetUserDocument, GET_USER_QUERY, gql`...`
      const isApolloPattern =
        hasApolloImport ||
        firstArgText.endsWith('Document') ||
        firstArgText.endsWith('Query') ||
        firstArgText.endsWith('Mutation') ||
        firstArgText.includes('gql') ||
        /^[A-Z_]+$/.test(firstArgText); // SCREAMING_CASE constant

      if (!isApolloPattern) {
        continue;
      }

      const operationName = firstArgText.replace(/Document$/, '').replace(/Query$|Mutation$/, '');

      const variables: string[] = [];

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

      dataFetching.push({ type: resolvedType, operationName, variables });
    }

    // Find getServerSideProps and extract GraphQL queries
    const getServerSidePropsVar = sourceFile.getVariableDeclaration('getServerSideProps');
    const getServerSidePropsFunc = sourceFile.getFunction('getServerSideProps');
    const ssrNode = getServerSidePropsVar || getServerSidePropsFunc;

    if (ssrNode) {
      // Look for imported Document patterns (e.g., GetUserOnboardingUserDocument)
      const imports = sourceFile.getImportDeclarations();
      for (const imp of imports) {
        const namedImports = imp.getNamedImports();
        for (const named of namedImports) {
          const name = named.getName();
          if (name.endsWith('Document')) {
            // Check if this document is used in the file
            const usages = sourceFile
              .getDescendantsOfKind(SyntaxKind.Identifier)
              .filter((id) => id.getText() === name);
            if (usages.length > 0) {
              const operationName = name.replace(/Document$/, '');
              dataFetching.push({
                type: 'getServerSideProps',
                operationName: `→ ${operationName}`,
              });
            }
          }
        }
      }

      // Also look for inline query patterns: graphqlClient.query({ query: ... })
      const text = ssrNode.getText();
      const queryMatches = text.match(/query:\s*(\w+)/g);
      if (queryMatches) {
        for (const match of queryMatches) {
          const docName = match.replace(/query:\s*/, '');
          if (
            !dataFetching.some((d) => d.operationName?.includes(docName.replace(/Document$/, '')))
          ) {
            dataFetching.push({
              type: 'getServerSideProps',
              operationName: `→ ${docName.replace(/Document$/, '')}`,
            });
          }
        }
      }
    }

    // Find getStaticProps
    const getStaticPropsVar = sourceFile.getVariableDeclaration('getStaticProps');
    const getStaticPropsFunc = sourceFile.getFunction('getStaticProps');
    if (getStaticPropsVar || getStaticPropsFunc) {
      dataFetching.push({
        type: 'getStaticProps',
        operationName: 'getStaticProps',
      });
    }

    // Track component imports from relative paths (generic approach)
    // This captures any non-package imports that could contain data-fetching components
    const imports = sourceFile.getImportDeclarations();
    for (const imp of imports) {
      const moduleSpec = imp.getModuleSpecifierValue();

      // Skip external packages (node_modules) - only track relative imports
      const isRelativeImport = moduleSpec.startsWith('.') || moduleSpec.startsWith('/');
      const isInternalAlias =
        !moduleSpec.includes('node_modules') &&
        !moduleSpec.startsWith('@types/') &&
        moduleSpec.startsWith('@') === false; // Skip scoped packages

      if (isRelativeImport || isInternalAlias) {
        // Check named imports for component-like names (PascalCase)
        const namedImports = imp.getNamedImports();
        for (const named of namedImports) {
          const name = named.getName();
          // Detect PascalCase component names that might contain data fetching
          if (this.isComponentName(name)) {
            dataFetching.push({
              type: 'component',
              operationName: name,
              variables: [],
            });
          }
        }

        // Check default import
        const defaultImport = imp.getDefaultImport();
        if (defaultImport) {
          const name = defaultImport.getText();
          if (this.isComponentName(name)) {
            dataFetching.push({
              type: 'component',
              operationName: name,
              variables: [],
            });
          }
        }
      }
    }

    return dataFetching;
  }

  /**
   * Check if a name looks like a React component (PascalCase with common suffixes)
   */
  private isComponentName(name: string): boolean {
    // Must be PascalCase (start with uppercase)
    if (!/^[A-Z]/.test(name)) return false;

    // Exclude React/Next.js type definitions (not actual components)
    const typeDefinitions = new Set([
      'NextPage',
      'NextPageContext',
      'NextApiRequest',
      'NextApiResponse',
      'GetServerSideProps',
      'GetStaticProps',
      'GetStaticPaths',
      'InferGetServerSidePropsType',
      'InferGetStaticPropsType',
      'FC',
      'FunctionComponent',
      'VFC',
      'Component',
      'PureComponent',
      'ReactNode',
      'ReactElement',
      'PropsWithChildren',
      'ComponentProps',
      'ComponentType',
      'ElementType',
      'RefObject',
      'MutableRefObject',
      'Dispatch',
      'SetStateAction',
      'ChangeEvent',
      'MouseEvent',
      'KeyboardEvent',
      'FormEvent',
      'SyntheticEvent',
    ]);

    if (typeDefinitions.has(name)) {
      return false;
    }

    // Common component suffixes that likely contain data fetching
    const componentSuffixes = [
      'Container',
      'Page',
      'Screen',
      'View',
      'Form',
      'Modal',
      'Dialog',
      'Panel',
      'Root',
      'Provider',
      'Wrapper',
    ];

    // Check for suffix match
    if (componentSuffixes.some((suffix) => name.endsWith(suffix))) {
      return true;
    }

    // Also match if it ends with Page-like patterns
    if (/Page[A-Z]?\w*$/.test(name) || /Container[A-Z]?\w*$/.test(name)) {
      return true;
    }

    return false;
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

  /**
   * Extract multi-step flow information (wizard, stepper, onboarding)
   */
  private extractSteps(sourceFile: SourceFile): StepInfo[] {
    const steps: StepInfo[] = [];

    // Pattern 1: useState with step-like variable names
    const useStateCalls = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText() === 'useState');

    for (const call of useStateCalls) {
      const parent = call.getParent();
      if (!parent) continue;

      const parentText = parent.getText();
      // Match: const [step, setStep] = useState(0) or [currentStep, setCurrentStep]
      const stepMatch = parentText.match(
        /\[\s*(step|currentStep|activeStep|page|currentPage|phase|stage)\s*,/i
      );
      if (stepMatch) {
        // Found a step state, now look for step-related JSX or switch cases
        const stepVarName = stepMatch[1];

        // Look for switch statements or conditional rendering
        const switchStatements = sourceFile.getDescendantsOfKind(SyntaxKind.SwitchStatement);
        for (const switchStmt of switchStatements) {
          const expression = switchStmt.getExpression().getText();
          if (expression.includes(stepVarName)) {
            const caseBlocks = switchStmt.getClauses();
            caseBlocks.forEach((clause, idx) => {
              if (clause.isKind(SyntaxKind.CaseClause)) {
                const caseExpr = clause.getExpression()?.getText() || String(idx);
                // Try to find component name in case block
                const jsxElements = clause.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);
                const componentName =
                  jsxElements.length > 0 ? jsxElements[0].getTagNameNode().getText() : undefined;

                steps.push({
                  id: caseExpr.replace(/['"]/g, ''),
                  name: `Step ${caseExpr.replace(/['"]/g, '')}`,
                  component: componentName,
                });
              }
            });
          }
        }

        // Look for array of steps/components
        const arrayLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression);
        for (const arr of arrayLiterals) {
          const parentVar = arr.getParent();
          if (parentVar && parentVar.getText().match(/steps|pages|screens|views|components/i)) {
            const elements = arr.getElements();
            elements.forEach((el, idx) => {
              const elText = el.getText();
              // Could be component reference or object
              if (elText.startsWith('{')) {
                // Object literal, try to extract name/label
                const nameMatch = elText.match(/(?:name|label|title)\s*:\s*['"]([^'"]+)['"]/);
                const compMatch = elText.match(/(?:component|content)\s*:\s*<?\s*(\w+)/);
                steps.push({
                  id: idx + 1,
                  name: nameMatch ? nameMatch[1] : `Step ${idx + 1}`,
                  component: compMatch ? compMatch[1] : undefined,
                });
              } else if (/^[A-Z]/.test(elText)) {
                // Component reference
                steps.push({
                  id: idx + 1,
                  name: elText,
                  component: elText,
                });
              }
            });
          }
        }
      }
    }

    // Pattern 2: Stepper/Wizard component usage
    const jsxElements = sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);
    for (const jsx of jsxElements) {
      const tagName = jsx.getTagNameNode().getText();
      if (tagName.match(/Stepper|Wizard|Steps|TabPanel|FormStep/i)) {
        // Find Step children
        const parent = jsx.getParent();
        if (parent && parent.isKind(SyntaxKind.JsxElement)) {
          const children = parent.getJsxChildren();
          children.forEach((child, idx) => {
            if (
              child.isKind(SyntaxKind.JsxElement) ||
              child.isKind(SyntaxKind.JsxSelfClosingElement)
            ) {
              const childTag = child.isKind(SyntaxKind.JsxElement)
                ? child.getOpeningElement().getTagNameNode().getText()
                : child.getTagNameNode().getText();

              // Get label/title attribute
              const attrs = child.isKind(SyntaxKind.JsxElement)
                ? child.getOpeningElement().getAttributes()
                : child.getAttributes();

              let stepName = childTag;
              for (const attr of attrs) {
                if (attr.isKind(SyntaxKind.JsxAttribute)) {
                  const name = attr.getNameNode().getText();
                  if (name === 'label' || name === 'title' || name === 'name') {
                    const value = attr.getInitializer()?.getText();
                    if (value) {
                      stepName = value.replace(/['"{}]/g, '');
                      break;
                    }
                  }
                }
              }

              steps.push({
                id: idx + 1,
                name: stepName,
                component: childTag,
              });
            }
          });
        }
      }
    }

    // Pattern 3: Conditional rendering with step variable
    const conditionalExprs = sourceFile.getDescendantsOfKind(SyntaxKind.ConditionalExpression);
    for (const cond of conditionalExprs) {
      const condition = cond.getCondition().getText();
      if (condition.match(/step\s*===?\s*\d+|currentStep|activeStep/i)) {
        // Extract step number and components
        const whenTrue = cond.getWhenTrue();
        // Note: whenFalse (cond.getWhenFalse()) could be used for nested step detection

        const stepNumMatch = condition.match(/===?\s*(\d+)/);
        if (stepNumMatch && steps.length === 0) {
          // Only add if we haven't found steps through other patterns
          const trueJsx = whenTrue.getDescendantsOfKind(SyntaxKind.JsxOpeningElement);

          if (trueJsx.length > 0) {
            steps.push({
              id: parseInt(stepNumMatch[1]),
              component: trueJsx[0].getTagNameNode().getText(),
            });
          }
        }
      }
    }

    return steps;
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
