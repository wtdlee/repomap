/**
 * Ruby Parser using web-tree-sitter
 */

import { Parser, Node, Tree, Language } from 'web-tree-sitter';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Create require for ESM compatibility
const require = createRequire(import.meta.url);

// Re-export types for compatibility
export type SyntaxNode = Node;
export { Tree };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let parserInitialized = false;
let rubyLanguage: Language | null = null;
let parser: Parser | null = null;

/**
 * Initialize the Ruby parser
 */
export async function initRubyParser(): Promise<Parser> {
  if (parser && rubyLanguage) {
    return parser;
  }

  if (!parserInitialized) {
    await Parser.init();
    parserInitialized = true;
  }

  parser = new Parser();

  // Find WASM file using Node.js module resolution
  let wasmPath: string | null = null;

  try {
    // Best approach: Use require.resolve to find the package location
    const wasmPkgPath = require.resolve('tree-sitter-ruby/package.json');
    wasmPath = path.join(path.dirname(wasmPkgPath), 'tree-sitter-ruby.wasm');
  } catch {
    // Fallback: Try cwd for development environments
    const cwdPath = path.join(
      process.cwd(),
      'node_modules/tree-sitter-ruby/tree-sitter-ruby.wasm'
    );
    if (fs.existsSync(cwdPath)) {
      wasmPath = cwdPath;
    }
  }

  if (!wasmPath || !fs.existsSync(wasmPath)) {
    throw new Error(
      'tree-sitter-ruby.wasm not found. Please ensure tree-sitter-ruby package is installed.'
    );
  }

  rubyLanguage = await Language.load(wasmPath);
  parser.setLanguage(rubyLanguage);

  return parser;
}

/**
 * Parse Ruby code
 */
export async function parseRuby(code: string): Promise<Tree> {
  const p = await initRubyParser();
  const tree = p.parse(code);
  if (!tree) {
    throw new Error('Failed to parse Ruby code');
  }
  return tree;
}

/**
 * Parse Ruby file
 */
export async function parseRubyFile(filePath: string): Promise<Tree> {
  const code = fs.readFileSync(filePath, 'utf-8');
  return parseRuby(code);
}

/**
 * Find all nodes of a specific type
 */
export function findNodes(node: SyntaxNode, type: string): SyntaxNode[] {
  const results: SyntaxNode[] = [];

  if (node.type === type) {
    results.push(node);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      results.push(...findNodes(child, type));
    }
  }

  return results;
}

/**
 * Find all nodes matching multiple types
 */
export function findNodesByTypes(node: SyntaxNode, types: string[]): SyntaxNode[] {
  const results: SyntaxNode[] = [];

  if (types.includes(node.type)) {
    results.push(node);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      results.push(...findNodesByTypes(child, types));
    }
  }

  return results;
}

/**
 * Get the text of a named child
 */
export function getChildText(node: SyntaxNode, fieldName: string): string | null {
  const child = node.childForFieldName(fieldName);
  return child ? child.text : null;
}

/**
 * Get the first child of a specific type
 */
export function getChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === type) {
      return child;
    }
  }
  return null;
}

/**
 * Get all children of a specific type
 */
export function getChildrenByType(node: SyntaxNode, type: string): SyntaxNode[] {
  const results: SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === type) {
      results.push(child);
    }
  }
  return results;
}

/**
 * Extract method call arguments
 */
export function getCallArguments(callNode: SyntaxNode): SyntaxNode[] {
  const args = callNode.childForFieldName('arguments');
  if (!args) return [];

  const results: SyntaxNode[] = [];
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (child && child.type !== '(' && child.type !== ')' && child.type !== ',') {
      results.push(child);
    }
  }
  return results;
}

/**
 * Check if node is inside a specific block type
 */
export function isInsideBlock(node: SyntaxNode, blockType: string): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === blockType) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Get the class name from a class node
 */
export function getClassName(classNode: SyntaxNode): string | null {
  const nameNode = classNode.childForFieldName('name');
  return nameNode ? nameNode.text : null;
}

/**
 * Get the superclass from a class node
 */
export function getSuperclass(classNode: SyntaxNode): string | null {
  const superclassNode = classNode.childForFieldName('superclass');
  if (!superclassNode) return null;

  // superclass node contains "< ClassName", extract just the class name
  const constantNode =
    getChildByType(superclassNode, 'constant') ||
    getChildByType(superclassNode, 'scope_resolution');
  return constantNode ? constantNode.text : null;
}

/**
 * Get method name from a method node
 */
export function getMethodName(methodNode: SyntaxNode): string | null {
  const nameNode = methodNode.childForFieldName('name');
  return nameNode ? nameNode.text : null;
}

/**
 * Get method parameters
 */
export function getMethodParameters(methodNode: SyntaxNode): string[] {
  const paramsNode = methodNode.childForFieldName('parameters');
  if (!paramsNode) return [];

  const params: string[] = [];
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (
      child &&
      (child.type === 'identifier' ||
        child.type === 'keyword_parameter' ||
        child.type === 'optional_parameter' ||
        child.type === 'splat_parameter')
    ) {
      // Extract the parameter name
      const nameNode = child.childForFieldName('name') || child;
      if (nameNode.type === 'identifier') {
        params.push(nameNode.text);
      } else {
        params.push(child.text);
      }
    }
  }
  return params;
}
