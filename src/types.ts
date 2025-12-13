/**
 * Type definitions for the documentation generator
 */

export interface DocGeneratorConfig {
  outputDir: string;
  site: SiteConfig;
  repositories: RepositoryConfig[];
  analysis: AnalysisConfig;
  diagrams: DiagramConfig;
  watch: WatchConfig;
  integrations: IntegrationsConfig;
}

export interface SiteConfig {
  title: string;
  description: string;
  baseUrl: string;
}

export interface RepositoryConfig {
  name: string;
  displayName: string;
  description: string;
  path: string;
  remote?: string;
  branch: string;
  type: 'nextjs' | 'rails' | 'generic';
  analyzers: AnalyzerType[];
  settings: Record<string, string>;
}

export type AnalyzerType =
  | 'pages'
  | 'graphql'
  | 'components'
  | 'dataflow'
  | 'rest-api'
  | 'api-endpoints'
  | 'graphql-schema'
  | 'models'
  | 'controllers'
  | 'routes'
  | 'grpc';

export interface AnalysisConfig {
  include: string[];
  exclude: string[];
  maxDepth: number;
}

export interface DiagramConfig {
  enabled: boolean;
  types: DiagramType[];
  theme: string;
}

export type DiagramType = 'flowchart' | 'sequence' | 'er' | 'class';

export interface WatchConfig {
  enabled: boolean;
  debounce: number;
}

export interface IntegrationsConfig {
  github: {
    enabled: boolean;
    organization: string;
  };
  slack: {
    enabled: boolean;
    webhook?: string;
  };
}

// Analysis Results
export interface AnalysisResult {
  repository: string;
  timestamp: string;
  version: string;
  commitHash: string;
  /** Coverage / observability metrics to prevent silent omissions */
  coverage?: CoverageMetrics;
  pages: PageInfo[];
  graphqlOperations: GraphQLOperation[];
  apiCalls: APICall[];
  components: ComponentInfo[];
  dataFlows: DataFlow[];
  apiEndpoints: APIEndpoint[];
  models: ModelInfo[];
  crossRepoLinks: CrossRepoLink[];
}

export interface CoverageMetrics {
  /** Number of TS/TSX/JS/JSX files scanned by analyzers (best-effort) */
  tsFilesScanned: number;
  /** Number of source files that failed to parse (SWC/TS parser failures) */
  tsParseFailures: number;
  /** Number of GraphQL parse failures (graphql parse errors) */
  graphqlParseFailures: number;
  /** Number of codegen files detected (best-effort) */
  codegenFilesDetected: number;
  /** Number of codegen files successfully parsed by AST */
  codegenFilesParsed: number;
  /** Number of Document exports extracted from codegen outputs */
  codegenExportsFound: number;
}

/**
 * Frontend API call information
 */
export interface APICall {
  /** Unique identifier */
  id: string;
  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'unknown';
  /** URL or endpoint path */
  url: string;
  /** Type of API call (fetch, axios, useSWR, etc.) */
  callType: 'fetch' | 'axios' | 'useSWR' | 'useQuery' | 'custom';
  /** File path where the call is made */
  filePath: string;
  /** Line number in the file */
  line: number;
  /** Component or function name containing the call */
  containingFunction: string;
  /** Pages or components using this API call */
  usedIn: string[];
  /** Request body type if available */
  requestType?: string;
  /** Response type if available */
  responseType?: string;
  /** Whether authentication is required */
  requiresAuth: boolean;
  /** Additional options or headers */
  options?: Record<string, unknown>;
  /** API category (e.g., 'HubSpot', 'AWS S3', 'Internal API') */
  category?: string;
}

export interface PageInfo {
  path: string;
  filePath: string;
  component: string;
  params: string[];
  layout?: string;
  authentication: AuthRequirement;
  permissions: string[];
  dataFetching: DataFetchingInfo[];
  navigation: NavigationInfo;
  linkedPages: string[];
  /** Multi-step flow information (wizard, onboarding, etc.) */
  steps?: StepInfo[];
}

export interface StepInfo {
  /** Step number or identifier */
  id: number | string;
  /** Step name/label if available */
  name?: string;
  /** Component or content rendered in this step */
  component?: string;
  /** Condition to show this step */
  condition?: string;
}

export interface AuthRequirement {
  required: boolean;
  roles?: string[];
  condition?: string;
}

export interface DataFetchingInfo {
  type:
    | 'useQuery'
    | 'useMutation'
    | 'useLazyQuery'
    | 'getServerSideProps'
    | 'getStaticProps'
    | 'component'
    | 'useSubscription';
  operationName: string;
  variables?: string[];
  source?: string; // Source component or hook name
  /**
   * Confidence for the mapping between page <-> hook <-> operation.
   * - 'certain': direct/close evidence
   * - 'likely': reachable but indirect evidence
   * - 'unknown': reachable via widely-shared/common modules (UI may display this as "Common" or omit it)
   */
  confidence?: 'certain' | 'likely' | 'unknown';
  /**
   * Evidence for why this operation is linked.
   * This is primarily for debugging missing/incorrect links.
   */
  evidence?: Array<{
    kind: 'import-edge' | 'operation-reference';
    file: string;
    line?: number;
    detail?: string;
  }>;
}

export interface NavigationInfo {
  visible: boolean;
  currentNavItem: string | null;
  mini?: boolean;
  mainPageStyle?: Record<string, unknown>;
}

export interface GraphQLOperation {
  name: string;
  type: 'query' | 'mutation' | 'subscription' | 'fragment';
  filePath: string;
  usedIn: string[];
  variables: VariableInfo[];
  returnType: string;
  fragments: string[];
  fields: GraphQLField[];
  /** Variable names that reference this operation (e.g., GET_USER_QUERY, GetUserDocument) */
  variableNames?: string[];
}

export interface GraphQLField {
  name: string;
  type?: string;
  fields?: GraphQLField[];
}

export interface VariableInfo {
  name: string;
  type: string;
  required: boolean;
}

export interface ComponentInfo {
  name: string;
  filePath: string;
  type: 'page' | 'container' | 'presentational' | 'layout' | 'hook';
  props: PropInfo[];
  dependencies: string[];
  dependents: string[];
  hooks: string[];
  stateManagement: string[];
  /**
   * Import information with resolved paths
   * Used for accurate GraphQL operation mapping
   */
  imports?: ImportInfo[];
}

export interface ImportInfo {
  /** Imported name (e.g., "Query", "useUserHook") */
  name: string;
  /** Import path (e.g., "../../features/profile/NewProfilePage") */
  path: string;
}

export interface PropInfo {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
}

export interface DataFlow {
  id: string;
  name: string;
  description: string;
  source: DataFlowNode;
  target: DataFlowNode;
  via: DataFlowNode[];
  operations: string[];
}

export interface DataFlowNode {
  type: 'component' | 'hook' | 'context' | 'api' | 'cache' | 'store';
  name: string;
  repository?: string;
}

export interface APIEndpoint {
  method: string;
  path: string;
  controller: string;
  action: string;
  authentication: boolean;
  permissions: string[];
  parameters: ParameterInfo[];
  responses: ResponseInfo[];
}

export interface ParameterInfo {
  name: string;
  type: string;
  location: 'path' | 'query' | 'body' | 'header';
  required: boolean;
}

export interface ResponseInfo {
  status: number;
  description: string;
  schema?: string;
}

export interface ModelInfo {
  name: string;
  tableName: string;
  filePath: string;
  attributes: AttributeInfo[];
  associations: AssociationInfo[];
  validations: string[];
  scopes: string[];
}

export interface AttributeInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
}

export interface AssociationInfo {
  type: 'belongs_to' | 'has_one' | 'has_many' | 'has_and_belongs_to_many';
  name: string;
  model: string;
  foreignKey?: string;
}

export interface CrossRepoLink {
  sourceRepo: string;
  sourcePath: string;
  targetRepo: string;
  targetPath: string;
  linkType: 'api-call' | 'shared-type' | 'graphql-operation' | 'navigation';
  description: string;
}

// Diagram types
export interface MermaidDiagram {
  type: DiagramType;
  title: string;
  content: string;
  relatedFiles: string[];
}

// Report types
export interface DocumentationReport {
  generatedAt: string;
  repositories: RepositoryReport[];
  crossRepoAnalysis: CrossRepoAnalysis;
  diagrams: MermaidDiagram[];
}

export interface RepositoryReport {
  name: string;
  displayName: string;
  version: string;
  commitHash: string;
  analysis: AnalysisResult;
  summary: RepositorySummary;
}

export interface RepositorySummary {
  totalPages: number;
  totalComponents: number;
  totalGraphQLOperations: number;
  totalDataFlows: number;
  authRequiredPages: number;
  publicPages: number;
}

export interface CrossRepoAnalysis {
  sharedTypes: string[];
  apiConnections: APIConnection[];
  navigationFlows: NavigationFlow[];
  dataFlowAcrossRepos: DataFlow[];
}

export interface APIConnection {
  frontend: string;
  backend: string;
  endpoint: string;
  operations: string[];
}

export interface NavigationFlow {
  from: { repo: string; page: string };
  to: { repo: string; page: string };
  trigger: string;
}
