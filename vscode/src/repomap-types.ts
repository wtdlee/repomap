// Minimal types for report.json consumed by the VS Code extension.
// Keep these small and resilient to schema changes.

export type AnalysisResult = {
  repository?: string;
  timestamp?: string;
  version?: string;
  commitHash?: string;
  pages?: PageInfo[];
  graphqlOperations?: GraphQLOperation[];
  apiCalls?: APICall[];
  components?: ComponentInfo[];
  dataFlows?: DataFlow[];
  apiEndpoints?: APIEndpoint[];
  models?: ModelInfo[];
};

export type PageInfo = {
  path: string;
  filePath: string;
  component?: string;
  linkedPages?: string[];
};

export type GraphQLOperation = {
  name: string;
  type: 'query' | 'mutation' | 'subscription' | 'fragment';
  filePath: string;
  line?: number;
  column?: number;
  usedIn?: string[];
  // Codegen variable names referencing this operation (e.g. FooDocument, FOO_QUERY)
  variableNames?: string[];
};

export type APICall = {
  id: string;
  method?: string;
  url?: string;
  filePath: string;
  line?: number;
  containingFunction?: string;
  usedIn?: string[];
};

export type ComponentInfo = {
  name: string;
  filePath: string;
  type?: string;
  dependencies?: string[];
  dependents?: string[];
};

export type DataFlow = {
  id: string;
  name: string;
  description?: string;
  operations?: string[];
};

export type APIEndpoint = {
  method: string;
  path: string;
  controller?: string;
  action?: string;
};

export type ModelInfo = {
  name: string;
  filePath: string;
  tableName?: string;
};
