/**
 * Rails Analyzers - Index
 * Rails分析モジュールのエクスポート
 */

export { RailsRoutesAnalyzer, type RailsRoute, type RailsRoutesResult, type ResourceInfo, type MountedEngine } from './rails-routes-analyzer.js';
export { RailsControllerAnalyzer, type ControllerInfo, type ActionInfo, type FilterInfo, type RailsControllersResult } from './rails-controller-analyzer.js';
export { RailsModelAnalyzer, type ModelInfo, type AssociationInfo, type ValidationInfo, type RailsModelsResult } from './rails-model-analyzer.js';
export { initRubyParser, parseRuby, parseRubyFile, findNodes, type SyntaxNode, type Tree } from './ruby-parser.js';

import { RailsRoutesAnalyzer, type RailsRoutesResult } from './rails-routes-analyzer.js';
import { RailsControllerAnalyzer, type RailsControllersResult } from './rails-controller-analyzer.js';
import { RailsModelAnalyzer, type RailsModelsResult } from './rails-model-analyzer.js';

export interface RailsAnalysisResult {
  routes: RailsRoutesResult;
  controllers: RailsControllersResult;
  models: RailsModelsResult;
  summary: RailsSummary;
}

export interface RailsSummary {
  totalRoutes: number;
  totalControllers: number;
  totalActions: number;
  totalModels: number;
  totalAssociations: number;
  totalValidations: number;
  namespaces: string[];
  concerns: string[];
}

/**
 * Analyze a complete Rails application
 */
export async function analyzeRailsApp(rootPath: string): Promise<RailsAnalysisResult> {
  console.log(`\n📦 Analyzing Rails application at: ${rootPath}\n`);
  
  // Routes
  console.log('🔄 Analyzing routes...');
  const routesAnalyzer = new RailsRoutesAnalyzer(rootPath);
  const routes = await routesAnalyzer.analyze();
  console.log(`   ✅ Found ${routes.routes.length} routes`);
  
  // Controllers
  console.log('🔄 Analyzing controllers...');
  const controllersAnalyzer = new RailsControllerAnalyzer(rootPath);
  const controllers = await controllersAnalyzer.analyze();
  console.log(`   ✅ Found ${controllers.controllers.length} controllers with ${controllers.totalActions} actions`);
  
  // Models
  console.log('🔄 Analyzing models...');
  const modelsAnalyzer = new RailsModelAnalyzer(rootPath);
  const models = await modelsAnalyzer.analyze();
  console.log(`   ✅ Found ${models.models.length} models with ${models.totalAssociations} associations`);

  // Combine all namespaces
  const allNamespaces = [...new Set([
    ...routes.namespaces,
    ...controllers.namespaces,
    ...models.namespaces,
  ])];

  // Combine all concerns
  const allConcerns = [...new Set([
    ...controllers.concerns,
    ...models.concerns,
  ])];

  const summary: RailsSummary = {
    totalRoutes: routes.routes.length,
    totalControllers: controllers.controllers.length,
    totalActions: controllers.totalActions,
    totalModels: models.models.length,
    totalAssociations: models.totalAssociations,
    totalValidations: models.totalValidations,
    namespaces: allNamespaces,
    concerns: allConcerns,
  };

  return {
    routes,
    controllers,
    models,
    summary,
  };
}

// Standalone execution for full analysis
async function main() {
  const targetPath = process.argv[2] || process.cwd();
  
  const result = await analyzeRailsApp(targetPath);
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 RAILS APPLICATION ANALYSIS SUMMARY');
  console.log('='.repeat(60) + '\n');
  
  console.log('┌─────────────────────────────────────────────────────┐');
  console.log('│ Routes                                              │');
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  Total routes:         ${String(result.summary.totalRoutes).padStart(6)}                      │`);
  console.log(`│  Resources:            ${String(result.routes.resources.length).padStart(6)}                      │`);
  console.log(`│  Mounted engines:      ${String(result.routes.mountedEngines.length).padStart(6)}                      │`);
  console.log(`│  External files:       ${String(result.routes.drawnFiles.length).padStart(6)}                      │`);
  console.log('└─────────────────────────────────────────────────────┘');
  
  console.log('┌─────────────────────────────────────────────────────┐');
  console.log('│ Controllers                                         │');
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  Total controllers:    ${String(result.summary.totalControllers).padStart(6)}                      │`);
  console.log(`│  Total actions:        ${String(result.summary.totalActions).padStart(6)}                      │`);
  console.log(`│  Namespaces:           ${String(result.controllers.namespaces.length).padStart(6)}                      │`);
  console.log('└─────────────────────────────────────────────────────┘');
  
  console.log('┌─────────────────────────────────────────────────────┐');
  console.log('│ Models                                              │');
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  Total models:         ${String(result.summary.totalModels).padStart(6)}                      │`);
  console.log(`│  Associations:         ${String(result.summary.totalAssociations).padStart(6)}                      │`);
  console.log(`│  Validations:          ${String(result.summary.totalValidations).padStart(6)}                      │`);
  console.log('└─────────────────────────────────────────────────────┘');
  
  console.log('┌─────────────────────────────────────────────────────┐');
  console.log('│ Shared                                              │');
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  Total namespaces:     ${String(result.summary.namespaces.length).padStart(6)}                      │`);
  console.log(`│  Total concerns:       ${String(result.summary.concerns.length).padStart(6)}                      │`);
  console.log('└─────────────────────────────────────────────────────┘');
  
  // Errors summary
  const totalErrors = result.routes.errors.length + 
                      result.controllers.errors.length + 
                      result.models.errors.length;
  
  if (totalErrors > 0) {
    console.log(`\n⚠️  Total errors: ${totalErrors}`);
  } else {
    console.log('\n✅ Analysis completed without errors!');
  }
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(console.error);
}

