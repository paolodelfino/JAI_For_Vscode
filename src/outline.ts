import type { TokenizedLine } from './tokenizer';

/**
 * Token-stream -> nested outline reconstruction for Jai.
 *
 * Inclusion policy (per the "hideable" rule): a category of definition is
 * outlined only if users can hide it without hiding real definitions —
 * either because it maps to a dedicated vscode.SymbolKind (hideable via the
 * built-in `outline.show<Kind>` settings) or because it has its own semantic
 * category below (hideable via the extension's `jai.outline.show*` settings,
 * which is how categories sharing one kind — globals/locals/loops/params
 * are all Variable — stay separable). Categories that could not be hidden
 * separately at all (function calls -> Function, type references -> Struct,
 * control-flow blocks -> anything) are NOT outlined.
 *
 * Mapping used here:
 *   procedure `N :: (...)`            -> Function     (file scope: showGlobalProcedures;
 *                                                       non-global: showNonGlobalProcedures)
 *   operator overload `operator * ::` -> Operator     (outline.showOperators)
 *   struct / union `N :: struct`      -> Struct       (outline.showStructs)
 *   enum / enum_flags                 -> Enum         (outline.showEnums)
 *   enum members                      -> EnumMember   (outline.showEnumMembers)
 *   struct fields                     -> Field        (outline.showFields)
 *   `N :: value` constants            -> Constant     (file scope: outline.showGlobalConstants;
 *                                                       non-global: outline.showConstants)
 *   variables / locals / loop vars    -> Variable     (outline.showVariables)
 *   procedure & struct parameters     -> Variable (or TypeParameter for $T / T: Type)
 *   `#type` aliases                   -> Interface    (outline.showInterfaces)
 *   anonymous proc assigned to a name -> Function
 */

export type OutlineKindName =
    | 'Function'
    | 'Operator'
    | 'Struct'
    | 'Enum'
    | 'EnumMember'
    | 'Field'
    | 'Constant'
    | 'Variable'
    | 'TypeParameter'
    | 'Interface';

/**
 * Semantic category of a definition — finer-grained than the SymbolKind it
 * maps to, because several distinct categories share one kind (globals,
 * locals, loop variables and parameters are all `Variable`). This is what
 * the extension's own `jai.outline.show*` settings filter on, which the
 * built-in `outline.show<Kind>` settings cannot express.
 *
 * Declaration form and scope are separate concepts in Jai: `::` creates a
 * constant binding, while `:`/`:=` creates a variable binding; either can
 * appear at file scope or in a non-global scope. Plain value constants are
 * therefore split into `globalConstant` and `localConstant`, and procedures
 * into `globalProcedure` and `nonGlobalProcedure` (a procedure inside a
 * top-level `#run` block is non-global even though no procedure encloses
 * it). Types, interfaces, and aliases bound with `::` keep their more
 * specific semantic categories instead of being grouped with plain
 * constants.
 */
export type OutlineCategory =
    | 'globalProcedure'
    | 'nonGlobalProcedure'
    | 'operatorOverload'
    | 'struct'
    | 'enum'
    | 'enumMember'
    | 'field'
    | 'globalConstant'
    | 'localConstant'
    | 'globalVariable'
    | 'localVariable'
    | 'loopVariable'
    | 'parameter'
    | 'typeParameter'
    | 'interface'
    | 'typeAlias';

/** Per-category visibility: a category maps to `false` to hide it; anything else shows it. */
export type OutlineVisibility = Partial<Record<OutlineCategory, boolean>>;

/**
 * Return a copy of the symbol tree with hidden categories pruned. Hiding a
 * node prunes its whole subtree (a hidden procedure takes its parameters and
 * locals with it). The input tree is not mutated, so callers can keep the
 * unfiltered tree for other consumers (e.g. Smart Select).
 */
export function filterOutlineSymbols(
    nodes: OutlineSymbolNode[],
    visibility: OutlineVisibility,
): OutlineSymbolNode[] {
    const out: OutlineSymbolNode[] = [];
    for (const node of nodes) {
        if (visibility[node.category] === false) {
            continue;
        }
        out.push({ ...node, children: filterOutlineSymbols(node.children, visibility) });
    }
    return out;
}

export interface OutlinePosition {
    line: number;
    character: number;
}

export interface OutlineSymbolNode {
    name: string;
    detail: string;
    kind: OutlineKindName;
    category: OutlineCategory;
    range: { start: OutlinePosition; end: OutlinePosition };
    selectionRange: { start: OutlinePosition; end: OutlinePosition };
    children: OutlineSymbolNode[];
}

// ---------------------------------------------------------------------------
// Lexemes: TextMate tokens are too coarse for structure (e.g. "() {" is one
// plain token, and "    IDLE" merges indentation with an identifier), so code
// tokens are split further. String/comment tokens stay opaque so braces and
// identifiers inside them can never be mistaken for structure/definitions.
// ---------------------------------------------------------------------------

export interface Lexeme {
    text: string;
    line: number;
    start: number;
    end: number;
    scopes: string[];
    leaf: string;
    opaque: boolean;
}

const TOKEN_PARTS =
    /\s+|[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*|\d[\w.]*|::|:=|->|=>|\.\.\.|===|==|!=|<=|>=|&&|\|\||<<<|>>>|<<|>>|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\.\.|./g;

function isOpaqueToken(scopes: string[]): boolean {
    return scopes.some((s) => s.startsWith('string.') || s.startsWith('comment.'));
}

function lex(lines: TokenizedLine[]): Lexeme[] {
    const out: Lexeme[] = [];
    for (const line of lines) {
        for (const token of line.tokens) {
            if (token.text === '') {
                continue;
            }
            const leaf = token.scopes[token.scopes.length - 1] ?? 'source.jai';
            if (token.scopes.some((s) => s.startsWith('comment.'))) {
                continue; // comments are whitespace for structural purposes
            }
            if (isOpaqueToken(token.scopes)) {
                out.push({
                    text: token.text,
                    line: line.line,
                    start: token.startIndex,
                    end: token.endIndex,
                    scopes: token.scopes,
                    leaf,
                    opaque: true,
                });
                continue;
            }
            TOKEN_PARTS.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = TOKEN_PARTS.exec(token.text)) !== null) {
                const part = match[0];
                if (/^\s+$/.test(part)) {
                    continue;
                }
                const start = token.startIndex + match.index;
                out.push({
                    text: part,
                    line: line.line,
                    start,
                    end: start + part.length,
                    scopes: token.scopes,
                    leaf,
                    opaque: false,
                });
            }
        }
    }
    return mergeContinuedIdentifiers(out, lines.map((l) => l.text));
}

/** Shared lexeme stream (used by the outline and by selection ranges). */
export function lexJaiLines(lines: TokenizedLine[]): Lexeme[] {
    return lex(lines);
}

// ---------------------------------------------------------------------------
// Backslash-continued identifiers.
//
// Jai's lexer treats a `\` inside an identifier as a continuation: it eats
// the backslash and any spaces after it and keeps appending identifier
// characters, so `left\_margin` and `free\   variable` are SINGLE
// identifiers (named `left_margin` and `freevariable` — the backslash and
// the padding spaces are not part of the name). This exists so declarations
// can be padded for vertical alignment. A trailing continuation that is not
// followed by more identifier characters (`short\    := 1;`) still belongs
// to the identifier token in the compiler, but contributes nothing to the
// name, so we simply drop it.
// ---------------------------------------------------------------------------

export interface IdentifierSegment {
    /** Offset of the segment's first character within the raw source text. */
    start: number;
    /** Offset just past the segment's last character. */
    end: number;
    text: string;
}

/** Split raw source text of a (possibly backslash-continued) identifier into its character segments. */
export function splitIdentifierSegments(raw: string): IdentifierSegment[] {
    const segments: IdentifierSegment[] = [];
    const re = /[A-Za-z0-9_\u0080-\uFFFF]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
        segments.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
    return segments;
}

/** The compiler-visible name of a raw identifier: segments concatenated, `\` + padding dropped. */
export function normalizedIdentifierText(raw: string): string {
    return splitIdentifierSegments(raw)
        .map((s) => s.text)
        .join('');
}

const CONTINUES_IDENTIFIER = /^[A-Za-z0-9_\u0080-\uFFFF]/;

/**
 * Merge lexeme sequences `ident` + `\` + spaces + `segment` (which the
 * TextMate grammar may deliver as several tokens/lexemes) into one lexeme
 * whose text is the normalized identifier name and whose span covers the
 * whole raw source text. Without this, the outline would see only the last
 * segment (e.g. declare `variable` for `free\   variable := 2;`).
 */
function mergeContinuedIdentifiers(lexemes: Lexeme[], sourceLines: string[]): Lexeme[] {
    const merged: Lexeme[] = [];
    let awaitingSegment = false;
    let backslashStart = -1;
    for (const l of lexemes) {
        const last = merged[merged.length - 1];
        if (
            awaitingSegment &&
            last &&
            l.line === last.line &&
            !l.opaque &&
            CONTINUES_IDENTIFIER.test(l.text) &&
            /^ *$/.test((sourceLines[l.line] ?? '').substring(last.end, l.start))
        ) {
            last.text += l.text;
            last.end = l.end;
            // Adopt a meaningful name scope from a later segment when the
            // first segment was plain (the grammar scopes the segment next
            // to the `:`/`:=`, which is usually the last one).
            if (
                last.leaf === 'source.jai' &&
                l.leaf !== 'source.jai' &&
                !l.leaf.startsWith('constant.numeric')
            ) {
                last.scopes = l.scopes;
                last.leaf = l.leaf;
            }
            awaitingSegment = false;
            continue;
        }
        if (awaitingSegment && last) {
            // The continuation was trailing padding only (`short\   :=`):
            // it is not part of the name or of its selection span.
            last.end = backslashStart;
            awaitingSegment = false;
        }
        if (
            l.text === '\\' &&
            last &&
            !last.opaque &&
            l.line === last.line &&
            last.end === l.start &&
            /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*$/.test(last.text)
        ) {
            backslashStart = l.start;
            last.end = l.end;
            awaitingSegment = true;
            continue;
        }
        merged.push({ ...l });
    }
    const last = merged[merged.length - 1];
    if (awaitingSegment && last) {
        last.end = backslashStart;
    }
    return merged;
}

const KEYWORDS = new Set([
    'if', 'ifx', 'then', 'else', 'case', 'for', 'while', 'break', 'continue',
    'return', 'remove', 'defer', 'push_context', 'using', 'struct', 'union',
    'enum', 'enum_flags', 'inline', 'no_inline', 'operator', 'cast', 'xx',
    'true', 'false', 'null',
]);

const IDENTIFIER = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*$/;

type ContextType = 'root' | 'struct' | 'enum' | 'function' | 'none';

/**
 * Jai has two fundamentally different kinds of scope:
 * - `data`: the file scope and type bodies (struct/enum/interface). `#if`
 *   blocks create no scope of their own, so a declaration directly inside a
 *   top-level `#if` branch is still in data scope — a *global* variable.
 * - `imperative`: procedure bodies and `#run` blocks. `#run` executes
 *   ordinary imperative code at compile time, so declarations inside a
 *   top-level `#run { ... }` block are *local* variables even though no
 *   procedure lexically encloses them. A `#run` directly prefixing a single
 *   declaration (`#run a := 12;`) likewise makes that declaration a local;
 *   that case has no braces, so it is recognised separately
 *   (isRunPrefixedDeclaration).
 */
type ScopeMode = 'data' | 'imperative';

interface WorkingNode {
    name: string;
    detail: string;
    kind: OutlineKindName;
    category: OutlineCategory;
    start: OutlinePosition;
    selStart: OutlinePosition;
    selEnd: OutlinePosition;
    end?: OutlinePosition;
    children: WorkingNode[];
    parent: WorkingNode | null;
    statementGroup: number;
    /** True once this node's range is bound to a `{ ... }` body (proc/struct/loop). */
    bodyBound: boolean;
}

interface BraceFrame {
    contextSymbol: WorkingNode | null;
    contextType: ContextType;
    scopeMode: ScopeMode;
    finalize: WorkingNode[];
}

interface PendingBody {
    nodes: WorkingNode[];
    mode: 'symbol' | 'context' | 'finalizeOnly';
    contextType?: ContextType;
    contextNode?: WorkingNode;
}

interface StatementEntry {
    node: WorkingNode;
    braceDepth: number;
}

// ---------------------------------------------------------------------------

export function buildOutline(lines: TokenizedLine[]): OutlineSymbolNode[] {
    const lexemes = lex(lines);
    const sourceLines = lines.map((l) => l.text);
    const roots: WorkingNode[] = [];
    const consumed = new Set<number>();
    const braceStack: BraceFrame[] = [];
    let pendingBodies: PendingBody[] = [];
    let statementNodes: StatementEntry[] = [];
    let parenDepth = 0;
    let bracketDepth = 0;
    let inForHeader = false;
    let nextStatementGroup = 1;

    const pos = (l: Lexeme, which: 'start' | 'end'): OutlinePosition => ({
        line: l.line,
        character: which === 'start' ? l.start : l.end,
    });
    const isId = (l: Lexeme | undefined): boolean =>
        !!l && !l.opaque && IDENTIFIER.test(l.text);
    const currentSymbol = (): WorkingNode | null =>
        braceStack.length > 0 ? braceStack[braceStack.length - 1].contextSymbol : null;
    const currentContext = (): ContextType =>
        braceStack.length > 0 ? braceStack[braceStack.length - 1].contextType : 'root';
    const currentScopeMode = (): ScopeMode =>
        braceStack.length > 0 ? braceStack[braceStack.length - 1].scopeMode : 'data';

    function sliceText(start: OutlinePosition, end: OutlinePosition): string {
        if (start.line === end.line) {
            return sourceLines[start.line]?.substring(start.character, end.character) ?? '';
        }
        const parts: string[] = [];
        for (let ln = start.line; ln <= end.line; ln++) {
            const text = sourceLines[ln] ?? '';
            if (ln === start.line) {
                parts.push(text.substring(start.character));
            } else if (ln === end.line) {
                parts.push(text.substring(0, end.character));
            } else {
                parts.push(text);
            }
        }
        return parts.join(' ');
    }
    const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const truncate = (s: string, max = 80): string =>
        s.length > max ? `${s.substring(0, max - 1)}…` : s;
    /** Detail text spanning lexemes [fromIdx, toIdx) of the significant stream. */
    function detailBetween(fromIdx: number, toIdx: number, max = 80): string {
        if (fromIdx >= toIdx || fromIdx < 0 || toIdx > lexemes.length) {
            return '';
        }
        return truncate(
            collapse(
                sliceText(pos(lexemes[fromIdx], 'start'), pos(lexemes[toIdx - 1], 'end')),
            ),
            max,
        );
    }

    function makeNode(
        name: string,
        detail: string,
        kind: OutlineKindName,
        category: OutlineCategory,
        sel: Lexeme,
        startLex: Lexeme = sel,
        selEndLex: Lexeme = sel,
    ): WorkingNode {
        return {
            name,
            detail,
            kind,
            category,
            start: pos(startLex, 'start'),
            selStart: pos(sel, 'start'),
            selEnd: pos(selEndLex, 'end'),
            children: [],
            parent: null,
            statementGroup: 0,
            bodyBound: false,
        };
    }

    function attach(node: WorkingNode, beforeIdx?: number): void {
        const parent = currentSymbol();
        node.parent = parent;
        // A new sibling statement starting means any previous sibling that
        // never saw its terminating ';' (e.g. a here-string constant) ends
        // just before this statement begins.
        if (beforeIdx !== undefined && beforeIdx > 0) {
            const endPos = pos(lexemes[beforeIdx - 1], 'end');
            const finished = new Set<WorkingNode>();
            statementNodes = statementNodes.filter((entry) => {
                if (
                    entry.node.parent === parent &&
                    entry.node.statementGroup !== node.statementGroup &&
                    !entry.node.end &&
                    !entry.node.bodyBound
                ) {
                    finish(entry.node, endPos);
                    finished.add(entry.node);
                    return false;
                }
                return true;
            });
            if (finished.size > 0) {
                removePendingFor(finished);
            }
        }
        if (parent) {
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }

    function assignGroup(nodes: WorkingNode[]): void {
        const group = nextStatementGroup++;
        for (const node of nodes) {
            node.statementGroup = group;
        }
    }

    function finish(node: WorkingNode, endPos: OutlinePosition): void {
        if (!node.end) {
            node.end = endPos;
        }
    }

    function addStatement(node: WorkingNode): void {
        statementNodes.push({ node, braceDepth: braceStack.length });
    }

    function removePendingFor(finished: Set<WorkingNode>): void {
        pendingBodies = pendingBodies.filter(
            (p) => !p.nodes.some((n) => finished.has(n)),
        );
    }

    /** Index of the matching close delimiter for the opener at openIdx, or -1. */
    function findMatching(openIdx: number): number {
        const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
        const open = lexemes[openIdx]?.text;
        const close = pairs[open ?? ''];
        if (!close) {
            return -1;
        }
        let depth = 0;
        for (let j = openIdx; j < lexemes.length; j++) {
            const l = lexemes[j];
            if (l.opaque) {
                continue;
            }
            if (l.text === open) {
                depth++;
            } else if (l.text === close) {
                depth--;
                if (depth === 0) {
                    return j;
                }
            }
        }
        return -1;
    }

    /** Index of the `{`/`;`/unmatched `}` that terminates a header starting at fromIdx. */
    function findHeaderEnd(fromIdx: number): number {
        let p = 0;
        let b = 0;
        let br = 0;
        for (let j = fromIdx; j < lexemes.length; j++) {
            const l = lexemes[j];
            if (l.opaque) {
                continue;
            }
            if (l.text === '(') p++;
            else if (l.text === ')') p--;
            else if (l.text === '[') b++;
            else if (l.text === ']') b--;
            else if (l.text === '{') {
                if (p === 0 && b === 0 && br === 0) return j;
                br++;
            } else if (l.text === '}') {
                if (p === 0 && b === 0 && br === 0) return j;
                br--;
            } else if (l.text === ';' && p === 0 && b === 0 && br === 0) {
                return j;
            }
        }
        return lexemes.length;
    }

    function kindToContext(kind: OutlineKindName): ContextType {
        switch (kind) {
            case 'Struct':
                return 'struct';
            case 'Enum':
                return 'enum';
            case 'Function':
            case 'Operator':
            case 'Interface':
                return 'function';
            default:
                return 'root';
        }
    }

    /** Parse a parenthesised parameter list into child symbols of `parent`. */
    function parseParams(openIdx: number, parent: WorkingNode): void {
        const closeIdx = findMatching(openIdx);
        if (closeIdx < 0) {
            return;
        }
        // Split into top-level comma-separated segments.
        const segments: Array<[number, number]> = [];
        let segStart = openIdx + 1;
        let p = 0;
        let b = 0;
        let br = 0;
        for (let j = openIdx + 1; j < closeIdx; j++) {
            const l = lexemes[j];
            if (l.opaque) continue;
            if (l.text === '(') p++;
            else if (l.text === ')') p--;
            else if (l.text === '[') b++;
            else if (l.text === ']') b--;
            else if (l.text === '{') br++;
            else if (l.text === '}') br--;
            else if (l.text === ',' && p === 0 && b === 0 && br === 0) {
                segments.push([segStart, j]);
                segStart = j + 1;
            }
        }
        segments.push([segStart, closeIdx]);

        for (const [s, e] of segments) {
            // Find the declared name: first depth-0 identifier followed by
            // ':'/'::', carrying a $-prefix, or scoped as a type parameter.
            let candidate = -1;
            let dp = 0;
            let db = 0;
            for (let j = s; j < e; j++) {
                const l = lexemes[j];
                if (l.opaque) continue;
                if (l.text === '(') dp++;
                else if (l.text === ')') dp--;
                else if (l.text === '[') db++;
                else if (l.text === ']') db--;
                if (dp !== 0 || db !== 0) continue;
                if (l.text === '=') break; // default value: no name after this
                if (!isId(l) || KEYWORDS.has(l.text)) continue;
                const next = lexemes[j + 1];
                const prev = lexemes[j - 1];
                if (
                    l.leaf === 'entity.name.type.parameter.jai' ||
                    prev?.text === '$' ||
                    next?.text === ':' ||
                    next?.text === '::'
                ) {
                    candidate = j;
                    break;
                }
            }
            if (candidate < 0) {
                continue; // unnamed / type-only parameter, e.g. (int, string)
            }
            const nameLex = lexemes[candidate];
            consumed.add(candidate);
            // Annotation = text after ':' up to '=' (default) or segment end.
            let detail = '';
            let kind: OutlineKindName = 'Variable';
            if (lexemes[candidate + 1]?.text === ':' || lexemes[candidate + 1]?.text === '::') {
                let annEnd = e;
                let d = 0;
                for (let j = candidate + 2; j < e; j++) {
                    const l = lexemes[j];
                    if (l.opaque) continue;
                    if (l.text === '(' || l.text === '[') d++;
                    else if (l.text === ')' || l.text === ']') d--;
                    else if (l.text === '=' && d === 0) {
                        annEnd = j;
                        break;
                    }
                }
                detail = detailBetween(candidate + 2, annEnd, 60);
            }
            if (
                nameLex.leaf === 'entity.name.type.parameter.jai' ||
                lexemes[candidate - 1]?.text === '$' ||
                detail === 'Type'
            ) {
                kind = 'TypeParameter';
            }
            const node = makeNode(
                nameLex.text,
                detail,
                kind,
                kind === 'TypeParameter' ? 'typeParameter' : 'parameter',
                nameLex,
            );
            node.end = pos(lexemes[e - 1] ?? nameLex, 'end');
            node.parent = parent;
            parent.children.push(node);
        }
    }

    function isRunDirectiveAt(idx: number): boolean {
        return (
            lexemes[idx]?.text === '#run' ||
            (lexemes[idx]?.text === 'run' && lexemes[idx - 1]?.text === '#')
        );
    }

    /**
     * Is the `{` at openIdx the block payload of a `#run` directive?
     * Accepts `#run {`, `#run,stallable {`, `#run,host {`, the
     * value-producing form `#run -> Return_Type {`, and an anonymous
     * procedure run inline, `#run (params) -> Return_Type {`. (The lexeme
     * splitter delivers `#run` as `#` + `run`, hence isRunDirectiveAt.)
     */
    function isRunBlockOpen(openIdx: number): boolean {
        let cursor = openIdx - 1;
        // Optional `-> Return_Type` between the directive and the block:
        // scan backwards over the type (tracking balanced ()/[]) to its `->`.
        let paren = 0;
        let bracket = 0;
        let arrow = -1;
        for (let j = cursor; j >= 0; j--) {
            const t = lexemes[j].text;
            if (t === ')') paren++;
            else if (t === '(') {
                if (paren === 0) break;
                paren--;
            } else if (t === ']') bracket++;
            else if (t === '[') {
                if (bracket === 0) break;
                bracket--;
            } else if (paren === 0 && bracket === 0) {
                if (t === '->') {
                    arrow = j;
                    break;
                }
                if (t === ';' || t === '{' || t === '}' || t === '=' || t === '::' || t === ':=') {
                    break;
                }
            }
        }
        if (arrow >= 0) {
            cursor = arrow - 1;
            // Anonymous-procedure form: skip its balanced parameter list so
            // the directive/modifiers before `(` can be checked below.
            if (lexemes[cursor]?.text === ')') {
                let depth = 0;
                let open = -1;
                for (let j = cursor; j >= 0; j--) {
                    if (lexemes[j].text === ')') depth++;
                    else if (lexemes[j].text === '(') {
                        depth--;
                        if (depth === 0) {
                            open = j;
                            break;
                        }
                    }
                }
                if (open >= 0) {
                    cursor = open - 1;
                }
            }
        }
        // Skip comma-separated directive modifiers (`#run,stallable,host`).
        while (cursor >= 0 && !isRunDirectiveAt(cursor)) {
            if (isId(lexemes[cursor]) && lexemes[cursor - 1]?.text === ',') {
                cursor -= 2;
                continue;
            }
            break;
        }
        return isRunDirectiveAt(cursor);
    }

    /**
     * Is the declaration whose first declarator is at firstNameIdx directly
     * prefixed by a `#run` directive (`#run a := 12;`, `#run,stallable b: int;`)?
     * The directive's payload may be a single declaration instead of a block;
     * that declaration is executed at compile time and is therefore a local,
     * not a global. Comma-separated directive modifiers are skipped.
     */
    function isRunPrefixedDeclaration(firstNameIdx: number): boolean {
        let cursor = firstNameIdx - 1;
        while (cursor >= 0 && !isRunDirectiveAt(cursor)) {
            if (isId(lexemes[cursor]) && lexemes[cursor - 1]?.text === ',') {
                cursor -= 2; // directive modifier, e.g. `stallable` in `#run,stallable`
                continue;
            }
            break;
        }
        return isRunDirectiveAt(cursor);
    }

    /**
     * Is a declaration at firstNameIdx in file scope? `#if` branches inherit
     * the enclosing scope, so declarations directly inside a top-level `#if`
     * still count as file-scope. Procedures/constants in `#run` blocks,
     * procedure bodies, or type bodies do not.
     */
    function isFileScopeDeclaration(firstNameIdx: number): boolean {
        return (
            currentContext() === 'root' &&
            currentScopeMode() === 'data' &&
            !isRunPrefixedDeclaration(firstNameIdx)
        );
    }

    function openBrace(lexIndex: number): void {
        const enclosing = currentSymbol();
        const enclosingCtx = currentContext();
        const enclosingMode = currentScopeMode();
        let frame: BraceFrame;
        const pending =
            parenDepth === 0 && bracketDepth === 0 ? pendingBodies.pop() : undefined;
        if (pending) {
            for (const node of pending.nodes) {
                node.bodyBound = true;
            }
            if (pending.mode === 'symbol') {
                const primary = pending.nodes[0];
                frame = {
                    contextSymbol: primary,
                    contextType: kindToContext(primary.kind),
                    // Procedure bodies are imperative scopes; type bodies
                    // (struct/enum/interface) are data scopes.
                    scopeMode:
                        primary.kind === 'Function' || primary.kind === 'Operator'
                            ? 'imperative'
                            : 'data',
                    finalize: [...pending.nodes],
                };
            } else if (pending.mode === 'context') {
                frame = {
                    contextSymbol: pending.contextNode ?? pending.nodes[0],
                    contextType: pending.contextType ?? 'struct',
                    scopeMode: 'data',
                    finalize: [],
                };
            } else {
                frame = {
                    contextSymbol: enclosing,
                    contextType: enclosingCtx,
                    scopeMode: enclosingMode,
                    finalize: [...pending.nodes],
                };
            }
        } else {
            const prev = lexemes[lexIndex - 1];
            const isInitializer =
                parenDepth > 0 ||
                bracketDepth > 0 ||
                (prev && ['=', '.', ',', '(', '[', 'return'].includes(prev.text));
            // A `#run { ... }` block switches to an imperative scope even in
            // the middle of a data scope (file scope, or inside an `#if`
            // branch there): its declarations are locals, not globals. It
            // gets no outline parent of its own — in an imperative scope it
            // stays under the enclosing procedure; in a data scope its
            // declarations are roots with localVariable category. `#if`
            // braces need no such handling: they inherit the enclosing mode
            // unchanged because `#if` creates no scope of its own.
            const runBlock = isRunBlockOpen(lexIndex);
            frame = {
                contextSymbol: runBlock
                    ? enclosingMode === 'imperative'
                        ? enclosing
                        : null
                    : enclosing,
                contextType: runBlock ? 'function' : isInitializer ? 'none' : enclosingCtx,
                scopeMode: runBlock ? 'imperative' : enclosingMode,
                finalize: [],
            };
        }
        braceStack.push(frame);
        inForHeader = false;
    }

    function closeBrace(lex: Lexeme): void {
        const frame = braceStack.pop();
        if (!frame) {
            return;
        }
        for (const node of frame.finalize) {
            finish(node, pos(lex, 'end'));
        }
        // Statement symbols opened directly inside this frame but never
        // terminated (malformed code) end at the closing brace.
        const depthInside = braceStack.length + 1;
        const finished = new Set<WorkingNode>();
        statementNodes = statementNodes.filter((entry) => {
            if (entry.braceDepth === depthInside && !entry.node.end) {
                finish(entry.node, pos(lex, 'start'));
                finished.add(entry.node);
                return false;
            }
            return true;
        });
        if (finished.size > 0) {
            removePendingFor(finished);
        }
    }

    function onSemicolon(lex: Lexeme): void {
        const finished = new Set<WorkingNode>();
        statementNodes = statementNodes.filter((entry) => {
            if (entry.braceDepth === braceStack.length) {
                finish(entry.node, pos(lex, 'end'));
                finished.add(entry.node);
                return false;
            }
            return true;
        });
        if (finished.size > 0) {
            removePendingFor(finished);
        }
        inForHeader = false;
    }

    // -- Main scan -----------------------------------------------------------

    for (let i = 0; i < lexemes.length; i++) {
        const lexeme = lexemes[i];
        if (lexeme.opaque) {
            continue;
        }
        const text = lexeme.text;

        // Structural tracking.
        if (text === '(') { parenDepth++; continue; }
        if (text === ')') { parenDepth = Math.max(0, parenDepth - 1); continue; }
        if (text === '[') { bracketDepth++; continue; }
        if (text === ']') { bracketDepth = Math.max(0, bracketDepth - 1); continue; }
        if (text === '{') { openBrace(i); continue; }
        if (text === '}') { closeBrace(lexeme); continue; }
        if (text === ';') {
            if (parenDepth === 0 && bracketDepth === 0) {
                onSemicolon(lexeme);
            }
            continue;
        }
        if (parenDepth > 0 || bracketDepth > 0) {
            // Allow the iterator of a parenthesised `for (i: ...)` header.
            const isForVar =
                inForHeader &&
                parenDepth === 1 &&
                bracketDepth === 0 &&
                isId(lexeme) &&
                lexemes[i + 1]?.text === ':';
            if (!isForVar) {
                continue;
            }
        }
        if (text === 'for' && lexeme.leaf.startsWith('keyword.control')) {
            inForHeader = true;
            continue;
        }
        const ctx = currentContext();
        if (ctx === 'none') {
            continue;
        }
        if (!isId(lexeme) && text !== 'operator') {
            continue;
        }

        const next = lexemes[i + 1];
        const prev = lexemes[i - 1];

        // -- operator overload: `operator * :: (.....)` ----------------------
        if (text === 'operator' && next && next.text !== '(' && next.text !== '::') {
            let opEnd = i + 1;
            if (next.text === '[' && lexemes[i + 2]?.text === ']') {
                opEnd = i + 2;
            }
            if (lexemes[opEnd + 1]?.text === '::' && lexemes[opEnd + 2]?.text === '(') {
                const opLex = lexemes[i + 1];
                const openParen = opEnd + 2;
                const headerEnd = findHeaderEnd(openParen);
                const node = makeNode(
                    `operator ${lexemes.slice(i + 1, opEnd + 1).map((l) => l.text).join('')}`,
                    detailBetween(openParen, headerEnd, 90),
                    'Operator',
                    'operatorOverload',
                    opLex,
                    lexeme,
                    lexemes[opEnd],
                );
                assignGroup([node]);
                attach(node, i);
                parseParams(openParen, node);
                addStatement(node);
                pendingBodies.push({ nodes: [node], mode: 'symbol' });
                consumed.add(i);
                continue;
            }
        }

        if (!isId(lexeme) || KEYWORDS.has(text) || consumed.has(i)) {
            continue;
        }

        // -- enum members -----------------------------------------------------
        if (
            ctx === 'enum' &&
            (!prev || prev.text === '{' || prev.text === ';' || prev.text === ',')
        ) {
            let detail = '';
            if (next?.text === '::' || next?.text === '=') {
                const semi = findHeaderEnd(i + 2);
                detail = detailBetween(i + 2, semi, 60);
            }
            const node = makeNode(text, detail, 'EnumMember', 'enumMember', lexeme);
            assignGroup([node]);
            attach(node, i);
            addStatement(node);
            consumed.add(i);
            continue;
        }

        // -- named constant-style definitions: `Name :: ...` ------------------
        if (next?.text === '::' && prev?.text !== '.') {
            let rhs = i + 2;
            while (
                lexemes[rhs] &&
                (lexemes[rhs].text === 'inline' || lexemes[rhs].text === 'no_inline')
            ) {
                rhs++;
            }
            const rhsLex = lexemes[rhs];
            if (!rhsLex) {
                continue;
            }
            let kind: OutlineKindName = 'Constant';
            let detail = '';
            let paramParen = -1;

            if (rhsLex.text === 'struct' || rhsLex.text === 'union') {
                kind = 'Struct';
                const headerEnd = findHeaderEnd(rhs);
                detail = detailBetween(rhs, headerEnd, 60);
                if (lexemes[rhs + 1]?.text === '(') {
                    paramParen = rhs + 1;
                }
            } else if (rhsLex.text === 'enum' || rhsLex.text === 'enum_flags') {
                kind = 'Enum';
                const headerEnd = findHeaderEnd(rhs);
                detail = detailBetween(rhs, headerEnd, 60);
            } else if (rhsLex.text === '(') {
                kind = 'Function';
                paramParen = rhs;
                const headerEnd = findHeaderEnd(rhs);
                detail = detailBetween(rhs, headerEnd, 90);
            } else if (rhsLex.text === 'interface') {
                kind = 'Interface';
                detail = 'interface';
            } else if (rhsLex.text === '#' && lexemes[rhs + 1]?.text === 'type') {
                kind = 'Interface';
                const semi = findHeaderEnd(rhs);
                detail = detailBetween(rhs, semi, 60);
            } else if (rhsLex.text.startsWith('#string')) {
                // Here-string constant: detail is just `#string DELIMITER`;
                // the body must not leak into the detail (or the range).
                detail = detailBetween(rhs, rhs + 3, 60);
            } else {
                const end = findHeaderEnd(rhs);
                detail = detailBetween(rhs, end, 60);
            }

            // Plain value constants (`Name :: value`) are split by scope:
            // file scope is global, while constants inside procedures,
            // #run blocks, types, and other non-file scopes are local to
            // their enclosing scope. Procedures/types/interfaces/aliases
            // above keep their specific semantic categories.
            const isGlobalConstant =
                kind === 'Constant' && isFileScopeDeclaration(i);
            const procedureCategory: OutlineCategory = isFileScopeDeclaration(i)
                ? 'globalProcedure'
                : 'nonGlobalProcedure';
            const category: OutlineCategory =
                kind === 'Struct'
                    ? 'struct'
                    : kind === 'Enum'
                      ? 'enum'
                      : kind === 'Function'
                        ? procedureCategory
                        : kind === 'Interface'
                          ? rhsLex.text === '#'
                              ? 'typeAlias'
                              : 'interface'
                          : isGlobalConstant
                            ? 'globalConstant'
                            : 'localConstant';
            const node = makeNode(text, detail, kind, category, lexeme);
            assignGroup([node]);
            attach(node, i);
            if (paramParen >= 0 && (kind === 'Function' || kind === 'Struct')) {
                parseParams(paramParen, node);
            }
            addStatement(node);
            if (
                kind === 'Function' ||
                kind === 'Struct' ||
                kind === 'Enum' ||
                kind === 'Interface'
            ) {
                pendingBodies.push({ nodes: [node], mode: 'symbol' });
            }
            consumed.add(i);
            continue;
        }

        // -- variable / field declarations: `name := ...`, `name: T ...` ------
        if (
            (lexeme.leaf === 'variable.other.declaration.jai' || inForHeader) &&
            (next?.text === ':=' || next?.text === ':')
        ) {
            // Collect multi-declarator names: `x, y: float;`
            const nameIndices = [i];
            let cursor = i;
            while (
                lexemes[cursor - 1]?.text === ',' &&
                isId(lexemes[cursor - 2]) &&
                !consumed.has(cursor - 2)
            ) {
                cursor -= 2;
                nameIndices.unshift(cursor);
            }

            const opIdx = i + 1;
            const isAssignment = next.text === ':=';
            // Locate initializer (after '=' for annotated decls) and header end.
            let initIdx = isAssignment ? opIdx + 1 : -1;
            let annotationEnd = -1;
            if (!isAssignment) {
                let d = 0;
                annotationEnd = findHeaderEnd(opIdx + 1);
                for (let j = opIdx + 1; j < lexemes.length; j++) {
                    const l = lexemes[j];
                    if (l.opaque) continue;
                    if (l.text === '(' || l.text === '[' || l.text === '{') d++;
                    else if (l.text === ')' || l.text === ']' || l.text === '}') {
                        if (d === 0) break;
                        d--;
                    } else if (l.text === '=' && d === 0) {
                        initIdx = j + 1;
                        annotationEnd = j;
                        break;
                    } else if (l.text === ';' && d === 0) {
                        annotationEnd = j;
                        break;
                    }
                }
            }

            // Classify an initializer: anonymous proc / anonymous type?
            // For annotated declarations the anonymous type may be the
            // annotation itself (`rect: struct { ... };`, no '=' present).
            let upgraded: OutlineKindName | undefined;
            let procParen = -1;
            let anonTypeContext: ContextType | undefined;
            const typeSourceIdx = initIdx >= 0 ? initIdx : opIdx + 1;
            if (initIdx >= 0 && lexemes[initIdx]?.text === '(') {
                const closeParen = findMatching(initIdx);
                if (closeParen > 0) {
                    const headerEnd = findHeaderEnd(closeParen + 1);
                    if (lexemes[headerEnd]?.text === '{') {
                        upgraded = 'Function';
                        procParen = initIdx;
                    }
                }
            }
            if (!upgraded && typeSourceIdx >= 0) {
                const first = lexemes[typeSourceIdx];
                if (first?.text === 'struct' || first?.text === 'union') {
                    anonTypeContext = 'struct';
                    if (ctx !== 'struct') upgraded = 'Struct';
                } else if (first?.text === 'enum' || first?.text === 'enum_flags') {
                    anonTypeContext = 'enum';
                    if (ctx !== 'struct') upgraded = 'Enum';
                }
            }

            // A declaration directly prefixed by `#run` (no block) is a
            // compile-time local wherever it appears; in particular it is
            // never a struct field or a global.
            const runPrefixed = isRunPrefixedDeclaration(nameIndices[0]);
            const isGlobalProcedure =
                !runPrefixed &&
                currentContext() === 'root' &&
                currentScopeMode() === 'data';
            const isField = ctx === 'struct' && !upgraded && !runPrefixed;
            let kind: OutlineKindName = upgraded ?? (isField ? 'Field' : 'Variable');
            if (inForHeader) {
                kind = 'Variable';
            }

            let detail = '';
            if (upgraded === 'Function' && procParen >= 0) {
                const headerEnd = findHeaderEnd(procParen);
                detail = detailBetween(procParen, headerEnd, 90);
            } else if (upgraded === 'Struct' || upgraded === 'Enum') {
                detail = lexemes[typeSourceIdx]?.text ?? '';
            } else if (!isAssignment && annotationEnd > opIdx) {
                detail = detailBetween(opIdx + 1, annotationEnd, 60);
                if (detail.includes('{')) {
                    detail = detail.substring(0, detail.indexOf('{')).trim();
                }
            } else if (isAssignment && initIdx >= 0) {
                let end = findHeaderEnd(initIdx);
                if (lexemes[end]?.text === '{') {
                    const matching = findMatching(end);
                    if (matching > end) {
                        end = matching + 1; // e.g. `:= Local_Config.{ 1920, 1080 }`
                    }
                }
                detail = truncate(`:= ${detailBetween(initIdx, end, 58)}`, 60);
            }
            if (inForHeader && !isAssignment) {
                // Iteration expression ends at '{' / ';', or at the ')' that
                // closes a parenthesised `for (i: ...)` header.
                let end = opIdx + 1;
                let depth = 0;
                for (; end < lexemes.length; end++) {
                    const l = lexemes[end];
                    if (l.opaque) continue;
                    if (l.text === '(') depth++;
                    else if (l.text === ')') {
                        if (depth === 0) break;
                        depth--;
                    } else if ((l.text === '{' || l.text === ';') && depth === 0) {
                        break;
                    }
                }
                detail = detailBetween(opIdx + 1, end, 60);
            }

            const category: OutlineCategory =
                upgraded === 'Function'
                    ? isGlobalProcedure
                        ? 'globalProcedure'
                        : 'nonGlobalProcedure'
                    : upgraded === 'Struct'
                      ? 'struct'
                      : upgraded === 'Enum'
                        ? 'enum'
                        : isField
                          ? 'field'
                          : inForHeader
                            ? 'loopVariable'
                            : runPrefixed || currentScopeMode() === 'imperative'
                              ? 'localVariable'
                              : 'globalVariable';
            const nodes: WorkingNode[] = [];
            for (const nameIdx of nameIndices) {
                const nameLex = lexemes[nameIdx];
                const node = makeNode(nameLex.text, detail, kind, category, nameLex);
                // In `x, y: float;` every declarator except the last ends at
                // its comma instead of sharing the whole statement range.
                if (!upgraded && nameIdx !== nameIndices[nameIndices.length - 1]) {
                    const comma = lexemes[nameIdx + 1];
                    if (comma?.text === ',') {
                        node.end = pos(comma, 'end');
                    }
                }
                nodes.push(node);
                consumed.add(nameIdx);
                if (upgraded === 'Function' && procParen >= 0 && nameIdx === i) {
                    parseParams(procParen, node);
                }
            }
            assignGroup(nodes);
            for (const node of nodes) {
                attach(node, nameIndices[0]);
                addStatement(node);
            }
            if (upgraded === 'Function' || upgraded === 'Struct' || upgraded === 'Enum') {
                pendingBodies.push({ nodes, mode: 'symbol' });
            } else if (anonTypeContext && isField) {
                pendingBodies.push({
                    nodes,
                    mode: 'context',
                    contextType: anonTypeContext,
                    contextNode: nodes[0],
                });
            } else if (inForHeader) {
                pendingBodies.push({ nodes, mode: 'finalizeOnly' });
            }
            continue;
        }
    }

    // -- Finalize ranges ------------------------------------------------------

    function finalize(node: WorkingNode): OutlineSymbolNode {
        const children = node.children
            .map((child) => finalize(child))
            .sort(
                (a, b) =>
                    a.selectionRange.start.line - b.selectionRange.start.line ||
                    a.selectionRange.start.character - b.selectionRange.start.character,
            );
        let end = node.end ?? node.selEnd;
        for (const child of children) {
            if (
                child.range.end.line > end.line ||
                (child.range.end.line === end.line &&
                    child.range.end.character > end.character)
            ) {
                end = child.range.end;
            }
        }
        // A statement symbol that never saw its ';' (e.g. a here-string
        // constant) should not swallow the rest of the document.
        if (!node.end && end === node.selEnd) {
            end = node.selEnd;
        }
        return {
            name: node.name,
            detail: node.detail,
            kind: node.kind,
            category: node.category,
            range: { start: node.start, end },
            selectionRange: { start: node.selStart, end: node.selEnd },
            children,
        };
    }

    return roots
        .map((node) => finalize(node))
        .sort(
            (a, b) =>
                a.selectionRange.start.line - b.selectionRange.start.line ||
                a.selectionRange.start.character - b.selectionRange.start.character,
        );
}
