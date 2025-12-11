/**
 * Type definitions for the documentation generator
 * ドキュメント生成ツールの型定義
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
  | 'controllers';

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
  pages: PageInfo[];
  graphqlOperations: GraphQLOperation[];
  apiCalls: APICall[];
  components: ComponentInfo[];
  dataFlows: DataFlow[];
  apiEndpoints: APIEndpoint[];
  models: ModelInfo[];
  crossRepoLinks: CrossRepoLink[];
}

/**
 * Frontend API call information
 * フロントエンドAPIコール情報
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
}

export interface AuthRequirement {
  required: boolean;
  roles?: string[];
  condition?: string;
}

export interface DataFetchingInfo {
  type: 'useQuery' | 'useMutation' | 'useLazyQuery' | 'getServerSideProps' | 'getStaticProps';
  operationName: string;
  variables?: string[];
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
