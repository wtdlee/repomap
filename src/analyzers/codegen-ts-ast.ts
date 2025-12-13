import ts from 'typescript';

export type CodegenOperationType = 'query' | 'mutation' | 'subscription' | 'fragment';

export interface CodegenDocumentExport {
  documentName: string; // e.g. GetUserDocument
  operationName: string; // e.g. GetUser
  operationType: Exclude<CodegenOperationType, 'fragment'>;
  document: unknown; // GraphQL Document-like object (kind: 'Document', definitions: [...])
  line: number; // 1-based
}

/**
 * Parse GraphQL Codegen outputs by TypeScript AST.
 *
 * This is intentionally NOT regex-based so it is resilient to formatting changes.
 *
 * Supported patterns (common codegen outputs):
 * - export const XxxDocument = {"kind":"Document",...} as unknown as DocumentNode;
 * - export const XxxDocument = {...} as unknown as TypedDocumentNode<...>;
 */
export function parseCodegenDocumentExports(
  tsContent: string,
  fileNameForTs: string
): CodegenDocumentExport[] {
  const sf = ts.createSourceFile(
    fileNameForTs,
    tsContent,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const exports: CodegenDocumentExport[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && hasExportModifier(node.modifiers)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;

        const varName = decl.name.text;
        if (!varName.endsWith('Document')) continue;
        if (!decl.initializer) continue;

        const base = unwrapExpression(decl.initializer);
        const docObj = tryExtractDocumentObject(base);
        if (!docObj) continue;

        const op = extractPrimaryOperation(docObj);
        if (!op) continue;

        const lc = ts.getLineAndCharacterOfPosition(sf, decl.name.getStart(sf));
        const line = lc.line + 1;

        exports.push({
          documentName: varName,
          operationName: op.operationName,
          operationType: op.operationType,
          document: docObj,
          line,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return exports;
}

function hasExportModifier(mods: readonly ts.ModifierLike[] | undefined): boolean {
  if (!mods) return false;
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let cur: ts.Expression = expr;
  while (true) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isAsExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    break;
  }
  return cur;
}

function tryExtractDocumentObject(expr: ts.Expression): unknown | null {
  if (!ts.isObjectLiteralExpression(expr)) return null;
  const obj = toJsValue(expr);
  if (!obj || typeof obj !== 'object') return null;

  // Narrow: kind === 'Document' and has definitions array
  const kind = (obj as Record<string, unknown>).kind;
  const defs = (obj as Record<string, unknown>).definitions;
  if (kind !== 'Document') return null;
  if (!Array.isArray(defs)) return null;
  return obj;
}

function extractPrimaryOperation(
  doc: unknown
): { operationName: string; operationType: 'query' | 'mutation' | 'subscription' } | null {
  const defs = (doc as Record<string, unknown>).definitions;
  if (!Array.isArray(defs) || defs.length === 0) return null;

  const first = defs[0];
  if (!first || typeof first !== 'object') return null;

  const kind = (first as Record<string, unknown>).kind;
  if (kind !== 'OperationDefinition') return null;

  const opType = (first as Record<string, unknown>).operation;
  const name = (first as Record<string, unknown>).name;

  const operationType =
    opType === 'mutation' || opType === 'subscription'
      ? (opType as 'mutation' | 'subscription')
      : 'query';

  let operationName = '';
  if (name && typeof name === 'object') {
    const value = (name as Record<string, unknown>).value;
    if (typeof value === 'string') operationName = value;
  }

  if (!operationName) return null;
  return { operationName, operationType };
}

function toJsValue(node: ts.Expression): unknown {
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const key = propertyNameToString(prop.name);
        if (!key) continue;
        out[key] = toJsValue(prop.initializer as ts.Expression);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        // Not expected in codegen outputs; ignore to stay safe.
        continue;
      }
      // SpreadAssignment etc. not expected; ignore.
    }
    return out;
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((e) => (ts.isExpression(e) ? toJsValue(e) : null));
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;

  // Keep unknown nodes as null to avoid throwing on unexpected constructs.
  return null;
}

function propertyNameToString(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return null;
  return null;
}
