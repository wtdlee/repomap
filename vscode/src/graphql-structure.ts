import type * as vscode from 'vscode';
import {
  type DefinitionNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type FragmentSpreadNode,
  type InlineFragmentNode,
  type OperationDefinitionNode,
  Kind,
  parse,
  visit,
} from 'graphql';

export type GraphqlSpan = { start: number; end: number };

export type GraphqlTreeNode = {
  id: string;
  label: string;
  kind: 'field' | 'fragment' | 'inlineFragment' | 'root' | 'note';
  span?: GraphqlSpan; // span of the node "name" inside the GraphQL source text
  children?: GraphqlTreeNode[];
};

export type ExtractedGraphql = {
  sourceText: string; // GraphQL text (without backticks)
  sourceSpanInDoc: GraphqlSpan; // where sourceText lives in the VSCode document text
};

function isEscapedBacktick(text: string, i: number): boolean {
  // Treat \` as escaped. Count preceding backslashes.
  let bs = 0;
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) bs++;
  return bs % 2 === 1;
}

function findTaggedTemplateRanges(
  text: string
): Array<{ contentStart: number; contentEnd: number }> {
  const ranges: Array<{ contentStart: number; contentEnd: number }> = [];
  // Support:
  // - tagged template: gql`...` / graphql`...`
  // - function call: gql(/* GraphQL */ `...`) / graphql(`...`)
  // - comment-only: /* GraphQL */ `...`
  const patterns = [
    /(?:\b(?:gql|graphql)\b)\s*`/g,
    /\b(?:gql|graphql)\b\s*\(\s*(?:\/\*\s*GraphQL\s*\*\/\s*)?`/g,
    /\/\*\s*GraphQL\s*\*\/\s*`/g,
  ];

  for (const re of patterns) {
    while (re.exec(text)) {
      const openTickIdx = re.lastIndex - 1;
      const contentStart = openTickIdx + 1;
      let i = contentStart;
      let hasInterpolation = false;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (ch === '`' && !isEscapedBacktick(text, i)) break;
        if (ch === '$' && text[i + 1] === '{') {
          hasInterpolation = true;
          break;
        }
      }
      if (i >= text.length) continue;
      if (hasInterpolation) continue; // skip interpolated templates (hard to map reliably)
      ranges.push({ contentStart, contentEnd: i });
      re.lastIndex = i + 1;
    }
  }
  // Deduplicate (multiple patterns may match the same backtick).
  const key = (r: { contentStart: number; contentEnd: number }) =>
    `${r.contentStart}:${r.contentEnd}`;
  const uniq = new Map<string, { contentStart: number; contentEnd: number }>();
  for (const r of ranges) uniq.set(key(r), r);
  return Array.from(uniq.values()).sort((a, b) => a.contentStart - b.contentStart);
}

export function extractGraphqlTemplatesFromText(text: string): ExtractedGraphql[] {
  return findTaggedTemplateRanges(text).map((r) => ({
    sourceText: text.slice(r.contentStart, r.contentEnd),
    sourceSpanInDoc: { start: r.contentStart, end: r.contentEnd },
  }));
}

export function extractGraphqlFromEditor(args: {
  document: vscode.TextDocument;
  selection: vscode.Selection;
}): { extracted: ExtractedGraphql | null; reason?: string } {
  const text = args.document.getText();
  const sel = args.selection;
  const selIsEmpty = sel.isEmpty;

  if (!selIsEmpty) {
    const selected = args.document.getText(sel);
    if (/\b(fragment|query|mutation|subscription)\b/.test(selected)) {
      const start = args.document.offsetAt(sel.start);
      const end = args.document.offsetAt(sel.end);
      return {
        extracted: { sourceText: selected, sourceSpanInDoc: { start, end } },
      };
    }
  }

  const cursorOffset = args.document.offsetAt(sel.active);
  const ranges = findTaggedTemplateRanges(text);
  const containing = ranges
    .filter((r) => cursorOffset >= r.contentStart && cursorOffset <= r.contentEnd)
    .sort((a, b) => a.contentEnd - a.contentStart - (b.contentEnd - b.contentStart));

  const picked = containing[0] ?? (ranges.length === 1 ? ranges[0] : null);
  if (!picked) {
    return { extracted: null, reason: 'No GraphQL selection or gql`...` template found.' };
  }

  const sourceText = text.slice(picked.contentStart, picked.contentEnd);
  return {
    extracted: {
      sourceText,
      sourceSpanInDoc: { start: picked.contentStart, end: picked.contentEnd },
    },
  };
}

export type ParsedGraphql = {
  doc: DocumentNode;
  definitions: Array<{
    id: string;
    label: string;
    kind: 'operation' | 'fragment';
    name?: string;
    node: OperationDefinitionNode | FragmentDefinitionNode;
  }>;
  fragmentsByName: Map<string, FragmentDefinitionNode>;
};

function defLabel(
  d: DefinitionNode
): { kind: 'operation' | 'fragment'; label: string; name?: string } | null {
  if (d.kind === Kind.OPERATION_DEFINITION) {
    const op = d.operation;
    const name = d.name?.value;
    return { kind: 'operation', label: name ? `${op}: ${name}` : `${op}: (anonymous)`, name };
  }
  if (d.kind === Kind.FRAGMENT_DEFINITION) {
    const name = d.name.value;
    const type = d.typeCondition.name.value;
    return { kind: 'fragment', label: `fragment ${name} on ${type}`, name };
  }
  return null;
}

export function parseGraphqlSource(sourceText: string): {
  parsed: ParsedGraphql | null;
  error?: string;
} {
  try {
    const doc = parse(sourceText, { noLocation: false });
    const defs: ParsedGraphql['definitions'] = [];
    const fragmentsByName = new Map<string, FragmentDefinitionNode>();

    let idx = 0;
    for (const d of doc.definitions) {
      const meta = defLabel(d);
      if (!meta) continue;
      if (d.kind === Kind.FRAGMENT_DEFINITION) {
        fragmentsByName.set(d.name.value, d);
      }
      defs.push({
        id: String(idx++),
        label: meta.label,
        kind: meta.kind,
        name: meta.name,
        node: d as OperationDefinitionNode | FragmentDefinitionNode,
      });
    }

    return { parsed: { doc, definitions: defs, fragmentsByName } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { parsed: null, error: msg };
  }
}

export type BuildTreeResult = {
  root: GraphqlTreeNode;
  spansById: Map<string, GraphqlSpan>;
  allFieldNameSpans: GraphqlSpan[];
};

function spanOfName(node: {
  name?: { loc?: { start: number; end: number } };
}): GraphqlSpan | undefined {
  const loc = node.name?.loc;
  if (!loc) return undefined;
  return { start: loc.start, end: loc.end };
}

function mkId(path: string[]): string {
  return path.join('/');
}

function buildSelectionChildren(args: {
  parentPath: string[];
  selections:
    | ReadonlyArray<FieldNode | FragmentSpreadNode | InlineFragmentNode>
    | ReadonlyArray<unknown>;
  fragmentsByName: Map<string, FragmentDefinitionNode>;
  spansById: Map<string, GraphqlSpan>;
  allFieldNameSpans: GraphqlSpan[];
  visitedFragments: Set<string>;
}): GraphqlTreeNode[] {
  const out: GraphqlTreeNode[] = [];

  for (const sel of args.selections as ReadonlyArray<{ kind?: unknown }>) {
    if (!sel || typeof sel !== 'object') continue;
    if (sel.kind === Kind.FIELD) {
      const field = sel as FieldNode;
      const name = field.name.value;
      const alias = field.alias?.value;
      const label = alias ? `${alias}: ${name}` : name;
      const id = mkId([...args.parentPath, `field:${label}`]);
      // If alias exists, select the full "alias: name" span for better UX.
      const aliasLoc = field.alias?.loc;
      const nameLoc = field.name?.loc;
      const span =
        aliasLoc && nameLoc
          ? { start: aliasLoc.start, end: nameLoc.end }
          : spanOfName({ name: field.name });
      if (span) {
        args.spansById.set(id, span);
        // For "all fields" highlight, keep it tight to the field name token when possible.
        if (nameLoc) {
          args.allFieldNameSpans.push({ start: nameLoc.start, end: nameLoc.end });
        } else {
          args.allFieldNameSpans.push(span);
        }
      }
      const children = field.selectionSet
        ? buildSelectionChildren({
            parentPath: [...args.parentPath, `field:${label}`],
            selections: field.selectionSet.selections,
            fragmentsByName: args.fragmentsByName,
            spansById: args.spansById,
            allFieldNameSpans: args.allFieldNameSpans,
            visitedFragments: args.visitedFragments,
          })
        : undefined;
      out.push({ id, kind: 'field', label, span, children });
      continue;
    }

    if (sel.kind === Kind.INLINE_FRAGMENT) {
      const inf = sel as InlineFragmentNode;
      const type = inf.typeCondition?.name.value;
      const label = type ? `... on ${type}` : '...';
      const id = mkId([...args.parentPath, `inline:${label}`]);
      const children = buildSelectionChildren({
        parentPath: [...args.parentPath, `inline:${label}`],
        selections: inf.selectionSet.selections,
        fragmentsByName: args.fragmentsByName,
        spansById: args.spansById,
        allFieldNameSpans: args.allFieldNameSpans,
        visitedFragments: args.visitedFragments,
      });
      out.push({ id, kind: 'inlineFragment', label, children });
      continue;
    }

    if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const fs = sel as FragmentSpreadNode;
      const name = fs.name.value;
      const label = `...${name}`;
      const id = mkId([...args.parentPath, `fragment:${name}`]);
      const nameSpan = spanOfName({ name: fs.name });
      if (nameSpan) args.spansById.set(id, nameSpan);

      if (args.visitedFragments.has(name)) {
        out.push({
          id,
          kind: 'fragment',
          label,
          span: nameSpan,
          children: [{ id: id + '/cycle', kind: 'note', label: '↩ cycle' }],
        });
        continue;
      }

      const def = args.fragmentsByName.get(name);
      if (!def) {
        out.push({
          id,
          kind: 'fragment',
          label,
          span: nameSpan,
          children: [{ id: id + '/missing', kind: 'note', label: 'Missing fragment definition' }],
        });
        continue;
      }

      args.visitedFragments.add(name);
      const children = buildSelectionChildren({
        parentPath: [...args.parentPath, `fragment:${name}`],
        selections: def.selectionSet.selections,
        fragmentsByName: args.fragmentsByName,
        spansById: args.spansById,
        allFieldNameSpans: args.allFieldNameSpans,
        visitedFragments: args.visitedFragments,
      });
      args.visitedFragments.delete(name);
      out.push({ id, kind: 'fragment', label, span: nameSpan, children });
      continue;
    }
  }

  return out;
}

export function buildGraphqlStructureTree(args: {
  definition: OperationDefinitionNode | FragmentDefinitionNode;
  definitionLabel: string;
  fragmentsByName: Map<string, FragmentDefinitionNode>;
}): BuildTreeResult {
  const spansById = new Map<string, GraphqlSpan>();
  const allFieldNameSpans: GraphqlSpan[] = [];

  const rootId = mkId(['root', args.definitionLabel]);
  const children = args.definition.selectionSet
    ? buildSelectionChildren({
        parentPath: ['root', args.definitionLabel],
        selections: args.definition.selectionSet.selections,
        fragmentsByName: args.fragmentsByName,
        spansById,
        allFieldNameSpans,
        visitedFragments: new Set<string>(),
      })
    : [];

  const root: GraphqlTreeNode = {
    id: rootId,
    kind: 'root',
    label: args.definitionLabel,
    children,
  };

  return { root, spansById, allFieldNameSpans };
}

export function collectFragmentSpreadNamesFromDefinition(
  definition: OperationDefinitionNode | FragmentDefinitionNode
): Set<string> {
  const out = new Set<string>();
  visit(definition, {
    FragmentSpread(node) {
      out.add(node.name.value);
    },
  });
  return out;
}
