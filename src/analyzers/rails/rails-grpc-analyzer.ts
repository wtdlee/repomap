/**
 * Rails gRPC Service Analyzer using tree-sitter
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import {
  parseRubyFile,
  findNodes,
  getClassName,
  getSuperclass,
  getMethodName,
  getMethodParameters,
  type SyntaxNode,
} from './ruby-parser.js';

export interface GrpcServiceInfo {
  name: string;
  filePath: string;
  className: string;
  parentClass: string;
  namespace?: string;
  protoService?: string;
  rpcs: RpcMethodInfo[];
  policies: string[];
  serializers: string[];
  concerns: string[];
  line: number;
}

export interface RpcMethodInfo {
  name: string;
  requestType?: string;
  responseType?: string;
  streaming?: 'none' | 'server' | 'client' | 'bidirectional';
  policyMethod?: string;
  modelsUsed: string[];
  servicesUsed: string[];
  line: number;
}

export interface RailsGrpcResult {
  services: GrpcServiceInfo[];
  totalRpcs: number;
  namespaces: string[];
  errors: string[];
}

export class RailsGrpcAnalyzer {
  private grpcDir: string;
  private services: GrpcServiceInfo[] = [];
  private errors: string[] = [];

  constructor(private rootPath: string) {
    this.grpcDir = path.join(rootPath, 'app', 'grpc_services');
  }

  async analyze(): Promise<RailsGrpcResult> {
    if (!fs.existsSync(this.grpcDir)) {
      return {
        services: [],
        totalRpcs: 0,
        namespaces: [],
        errors: [`gRPC services directory not found at ${this.grpcDir}`],
      };
    }

    const serviceFiles = await glob('**/*_grpc_service.rb', {
      cwd: this.grpcDir,
    });

    for (const file of serviceFiles) {
      const fullPath = path.join(this.grpcDir, file);
      try {
        const service = await this.parseServiceFile(fullPath, file);
        if (service) {
          this.services.push(service);
        }
      } catch (error) {
        this.errors.push(`Error parsing ${file}: ${error}`);
      }
    }

    const namespaces = [
      ...new Set(this.services.filter((s) => s.namespace).map((s) => s.namespace as string)),
    ];

    const totalRpcs = this.services.reduce((sum, s) => sum + s.rpcs.length, 0);

    return {
      services: this.services,
      totalRpcs,
      namespaces,
      errors: this.errors,
    };
  }

  private async parseServiceFile(
    filePath: string,
    relativePath: string
  ): Promise<GrpcServiceInfo | null> {
    const tree = await parseRubyFile(filePath);
    const rootNode = tree.rootNode;

    // Extract namespace from path
    const pathParts = relativePath.replace(/_grpc_service\.rb$/, '').split('/');
    const namespace = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : undefined;
    const serviceName = pathParts[pathParts.length - 1];

    // Find class definition
    const classNodes = findNodes(rootNode, 'class');
    if (classNodes.length === 0) return null;

    const classNode = classNodes[0];
    const className = getClassName(classNode);
    const parentClass = getSuperclass(classNode);

    if (!className) return null;

    const service: GrpcServiceInfo = {
      name: serviceName,
      filePath: relativePath,
      className,
      parentClass: parentClass || 'Unknown',
      namespace,
      rpcs: [],
      policies: [],
      serializers: [],
      concerns: [],
      line: classNode.startPosition.row + 1,
    };

    // Extract proto service from parent class
    if (parentClass) {
      // e.g., Visit::ConversationPb::ConversationService::Service
      const protoMatch = parentClass.match(/(\w+)::Service$/);
      if (protoMatch) {
        service.protoService = parentClass.replace('::Service', '');
      }
    }

    // Find include statements (concerns)
    const calls = findNodes(classNode, 'call');
    for (const call of calls) {
      const methodNode = call.childForFieldName('method');
      if (methodNode?.text === 'include') {
        const args = this.getCallArguments(call);
        for (const arg of args) {
          if (arg.type === 'constant' || arg.type === 'scope_resolution') {
            service.concerns.push(arg.text);
          }
        }
      }
    }

    // Find method definitions (RPC methods)
    const _methods = findNodes(classNode, 'method');
    let currentVisibility: 'public' | 'private' | 'protected' = 'public';

    const bodyStatement = classNode.childForFieldName('body');
    if (bodyStatement) {
      for (let i = 0; i < bodyStatement.childCount; i++) {
        const child = bodyStatement.child(i);
        if (!child) continue;

        if (child.type === 'identifier') {
          const text = child.text;
          if (text === 'private') currentVisibility = 'private';
          else if (text === 'protected') currentVisibility = 'protected';
          else if (text === 'public') currentVisibility = 'public';
        } else if (child.type === 'method' && currentVisibility === 'public') {
          const rpc = this.parseRpcMethod(child);
          if (rpc) {
            // Extract policies and serializers from method body
            const methodCalls = findNodes(child, 'call');
            for (const mc of methodCalls) {
              const methodName = mc.childForFieldName('method')?.text;
              const receiver = mc.childForFieldName('receiver')?.text;

              // Policy patterns
              if (methodName === 'authorize!' || methodName === 'new') {
                if (receiver?.includes('Policy')) {
                  if (!service.policies.includes(receiver)) {
                    service.policies.push(receiver);
                  }
                  rpc.policyMethod = 'authorize!';
                }
              }

              // Serializer patterns
              if (receiver?.includes('Serializer') && methodName === 'new') {
                if (!service.serializers.includes(receiver)) {
                  service.serializers.push(receiver);
                }
              }
            }

            service.rpcs.push(rpc);
          }
        }
      }
    }

    return service;
  }

  private parseRpcMethod(methodNode: SyntaxNode): RpcMethodInfo | null {
    const name = getMethodName(methodNode);
    if (!name) return null;

    // Skip common non-RPC methods
    const skipMethods = ['initialize', 'to_s', 'inspect', 'call', 'perform', 'execute'];
    if (skipMethods.includes(name)) return null;

    const _params = getMethodParameters(methodNode);
    const methodBody = methodNode.text;

    const rpc: RpcMethodInfo = {
      name,
      line: methodNode.startPosition.row + 1,
      streaming: 'none',
      modelsUsed: [],
      servicesUsed: [],
    };

    // Try to extract request/response types from comments or code
    // @param [Visit::ConversationPb::GetConversationRequest] req
    const requestMatch = methodBody.match(/@param\s+\[([^\]]+)\]\s+req/);
    if (requestMatch) {
      rpc.requestType = requestMatch[1];
    }

    // @return [Visit::ConversationPb::Conversation]
    const responseMatch = methodBody.match(/@return\s+\[([^\]]+)\]/);
    if (responseMatch) {
      rpc.responseType = responseMatch[1];
    }

    // Extract models used (ActiveRecord patterns)
    const modelMatches = methodBody.matchAll(
      /\b([A-Z][a-zA-Z]+)\.(find|find_by|where|all|first|last|create|joins|includes)\b/g
    );
    for (const match of modelMatches) {
      const modelName = match[1];
      if (
        !['Rails', 'ActiveRecord', 'GRPC', 'Visit', 'Google'].includes(modelName) &&
        !rpc.modelsUsed.includes(modelName)
      ) {
        rpc.modelsUsed.push(modelName);
      }
    }

    // Extract services used
    const serviceMatches = methodBody.matchAll(/\b(\w+Service)\.(call|new|perform)\b/g);
    for (const match of serviceMatches) {
      const serviceName = match[1];
      if (!rpc.servicesUsed.includes(serviceName)) {
        rpc.servicesUsed.push(serviceName);
      }
    }

    return rpc;
  }

  private getCallArguments(call: SyntaxNode): SyntaxNode[] {
    const args = call.childForFieldName('arguments');
    if (!args) {
      const results: SyntaxNode[] = [];
      for (let i = 0; i < call.childCount; i++) {
        const child = call.child(i);
        if (child && !['identifier', '(', ')', ',', 'call'].includes(child.type)) {
          if (
            child !== call.childForFieldName('method') &&
            child !== call.childForFieldName('receiver')
          ) {
            results.push(child);
          }
        }
      }
      return results;
    }

    const results: SyntaxNode[] = [];
    for (let i = 0; i < args.childCount; i++) {
      const child = args.child(i);
      if (child && child.type !== '(' && child.type !== ')' && child.type !== ',') {
        results.push(child);
      }
    }
    return results;
  }
}

// Standalone execution for testing
async function main() {
  const targetPath = process.argv[2] || process.cwd();
  console.log(`Analyzing gRPC services in: ${targetPath}`);

  const analyzer = new RailsGrpcAnalyzer(targetPath);
  const result = await analyzer.analyze();

  console.log('\n=== Rails gRPC Services Analysis ===\n');
  console.log(`Total services: ${result.services.length}`);
  console.log(`Total RPCs: ${result.totalRpcs}`);
  console.log(`Namespaces: ${result.namespaces.join(', ') || '(none)'}`);

  if (result.errors.length > 0) {
    console.log(`\n--- Errors (${result.errors.length}) ---`);
    for (const error of result.errors.slice(0, 5)) {
      console.log(`  ❌ ${error}`);
    }
  }

  console.log('\n--- Sample Services (first 15) ---');
  for (const service of result.services.slice(0, 15)) {
    console.log(`\n  📡 ${service.className} (${service.filePath})`);
    console.log(`     Proto: ${service.protoService || 'unknown'}`);
    console.log(
      `     RPCs (${service.rpcs.length}): ${service.rpcs.map((r) => r.name).join(', ')}`
    );
    if (service.policies.length > 0) {
      console.log(`     Policies: ${service.policies.join(', ')}`);
    }
    if (service.serializers.length > 0) {
      console.log(`     Serializers: ${service.serializers.join(', ')}`);
    }
  }

  // RPC summary
  const allRpcs = result.services.flatMap((s) => s.rpcs);
  const rpcsWithModels = allRpcs.filter((r) => r.modelsUsed.length > 0);

  console.log('\n--- RPC Summary ---');
  console.log(`  Total RPCs: ${allRpcs.length}`);
  console.log(`  RPCs using models: ${rpcsWithModels.length}`);
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(console.error);
}
