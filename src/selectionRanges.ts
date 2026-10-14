import type { TokenizedLine } from './tokenizer';
import {
    lexJaiLines,
    normalizedIdentifierText,
    splitIdentifierSegments,
    type Lexeme,
    type OutlinePosition,
    type OutlineSymbolNode,
} from './outline';

/**
 * Smart Select (Shift+Alt+Right/Left) support for Jai.
 *
 * VS Code's built-in fallback is word + bracket ranges only, which is why
 * expanding inside `.{a.x * s, a.y * s}` used to jump straight to the whole
 * brace block. This module builds a proper containment hierarchy for a
 * cursor position, innermost first:
 *
 *   identifier part (snake_case / camelCase / acronym; '_' itself is a
 *   selectable part and digits attach to the part before them) -> whole
 *   identifier -> member/call/index chain ->
 *   operator sub-expression -> comma-separated segment -> delimiter inner ->
 *   delimiter outer (incl. `.{`, callee, index targets) -> statement ->
 *   enclosing outline symbols -> line -> whole document.
 *
 * Ranges that merely share a SymbolKind with definitions are irrelevant
 * here; every range is derived from tokens/structure, not from semantics.
 */

export interface SelectionRangeLike {
    start: OutlinePosition;
    end: OutlinePosition;
}

export interface IdentifierPart {
    start: number;
    end: number;
    text: string;
}

type CharKind = 'sep' | 'digit' | 'upper' | 'lower' | 'other';

function charKind(ch: string): CharKind {
    if (ch === '_') {
        return 'sep';
    }
    if (ch >= '0' && ch <= '9') {
        return 'digit';
    }
    if (/^\p{L}$/u.test(ch)) {
        if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) {
            return 'upper';
        }
        if (ch === ch.toLowerCase() && ch !== ch.toUpperCase()) {
            return 'lower';
        }
    }
    return 'other';
}

/**
 * Split an identifier into selectable parts:
 * `hello_world` -> hello | _ | world, `helloWorld` -> hello | World,
 * `HTTPServer` -> HTTP | Server.
 *
 * Digits are transparent — they never start or end a part, so a number
 * attaches to the characters before it: `Vector3` and `float32` are single
 * parts, as is `Matrix4x4`. This mirrors VS Code's own subword scanning
 * (which only breaks at separators and case transitions). Only a separator
 * can put digits at the start of a part: `version_2` -> version | _ | 2.
 */
export function splitIdentifierParts(word: string): IdentifierPart[] {
    if (word.length === 0) {
        return [];
    }
    const kinds: CharKind[] = [];
    for (let i = 0; i < word.length; i++) {
        kinds.push(charKind(word[i]));
    }
    const parts: IdentifierPart[] = [];
    let start = 0;
    for (let i = 1; i < word.length; i++) {
        const prev = kinds[i - 1];
        const cur = kinds[i];
        const next = i + 1 < word.length ? kinds[i + 1] : undefined;
        let split = false;
        if (cur === 'sep' || prev === 'sep') {
            split = cur !== prev;
        } else if (prev === 'lower' && cur === 'upper') {
            split = true;
        } else if (prev === 'upper' && cur === 'upper' && next === 'lower') {
            split = true; // acronym boundary: HTTP|Server
        }
        if (split) {
            parts.push({ start, end: i, text: word.substring(start, i) });
            start = i;
        }
    }
    parts.push({ start, end: word.length, text: word.substring(start) });
    return parts;
}

// ---------------------------------------------------------------------------

function cmpPos(a: OutlinePosition, b: OutlinePosition): number {
    return a.line - b.line || a.character - b.character;
}

function containsPos(range: SelectionRangeLike, pos: OutlinePosition): boolean {
    return cmpPos(range.start, pos) <= 0 && cmpPos(pos, range.end) <= 0;
}

function containsRange(outer: SelectionRangeLike, inner: SelectionRangeLike): boolean {
    return cmpPos(outer.start, inner.start) <= 0 && cmpPos(inner.end, outer.end) <= 0;
}

function sameRange(a: SelectionRangeLike, b: SelectionRangeLike): boolean {
    return cmpPos(a.start, b.start) === 0 && cmpPos(a.end, b.end) === 0;
}

const OPENERS = new Set(['(', '[', '{']);
const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const IDENTIFIER_RE = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*$/;

const BINARY_PRECEDENCE: Record<string, number> = {
    ':=': 1, '=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1,
    '||': 2,
    '&&': 3,
    '|': 4,
    '^': 5,
    '&': 6,
    '==': 7, '!=': 7,
    '<': 8, '>': 8, '<=': 8, '>=': 8,
    '<<': 9, '>>': 9, '<<<': 9, '>>>': 9, '..': 9,
    '+': 10, '-': 10,
    '*': 11, '/': 11, '%': 11,
};

export function buildSelectionRanges(
    lines: TokenizedLine[],
    outline: OutlineSymbolNode[],
    position: OutlinePosition,
): SelectionRangeLike[] {
    const sourceLines = lines.map((l) => l.text);
    const lexemes: Lexeme[] = lexJaiLines(lines);
    const candidates: SelectionRangeLike[] = [];

    const lexPos = (l: Lexeme, which: 'start' | 'end'): OutlinePosition => ({
        line: l.line,
        character: which === 'start' ? l.start : l.end,
    });

    function add(start: OutlinePosition, end: OutlinePosition): void {
        if (cmpPos(start, end) >= 0) {
            return;
        }
        const range = { start, end };
        if (!containsPos(range, position)) {
            return;
        }
        candidates.push(range);
    }
    function addLexRange(startIdx: number, endIdxExclusive: number): void {
        if (startIdx < 0 || endIdxExclusive <= startIdx || endIdxExclusive > lexemes.length) {
            return;
        }
        add(lexPos(lexemes[startIdx], 'start'), lexPos(lexemes[endIdxExclusive - 1], 'end'));
    }

    // -- delimiter matching ---------------------------------------------------
    const openToClose = new Map<number, number>();
    const closeToOpen = new Map<number, number>();
    {
        const stack: number[] = [];
        for (let i = 0; i < lexemes.length; i++) {
            const l = lexemes[i];
            if (l.opaque) continue;
            if (OPENERS.has(l.text)) {
                stack.push(i);
            } else if (CLOSER_TO_OPENER[l.text]) {
                // Find the nearest unmatched opener of the right kind.
                for (let j = stack.length - 1; j >= 0; j--) {
                    if (lexemes[stack[j]].text === CLOSER_TO_OPENER[l.text]) {
                        openToClose.set(stack[j], i);
                        closeToOpen.set(i, stack[j]);
                        stack.length = j;
                        break;
                    }
                }
            }
        }
    }
    interface Pair {
        open: number;
        close: number;
    }
    const pairs: Pair[] = [...openToClose.entries()].map(([open, close]) => ({ open, close }));

    // -- cursor lexeme ----------------------------------------------------------
    let cursorIdx = -1;
    for (let i = 0; i < lexemes.length; i++) {
        const l = lexemes[i];
        if (l.line !== position.line) continue;
        if (position.character >= l.start && position.character < l.end) {
            cursorIdx = i;
            break;
        }
        if (
            position.character === l.end &&
            (IDENTIFIER_RE.test(l.text) || /^\d/.test(l.text))
        ) {
            cursorIdx = i; // cursor right after a word still belongs to it
            break;
        }
    }

    // -- identifier parts -------------------------------------------------------
    {
        const lineText = sourceLines[position.line] ?? '';
        // Inside a string or comment a `\` is literal text, not an
        // identifier continuation, so fall back to plain word matching.
        const inOpaque = (lines.find((l) => l.line === position.line)?.tokens ?? []).some(
            (t) =>
                position.character >= t.startIndex &&
                position.character <= t.endIndex &&
                t.scopes.some((s) => s.startsWith('string.') || s.startsWith('comment.')),
        );
        // An identifier may be backslash-continued: `\` + spaces joins the
        // next segment into the same identifier (`free\   variable`), so the
        // raw match can contain gaps. Parts are computed on the normalized
        // name (segments concatenated) and mapped back to source columns.
        const wordRe = inOpaque
            ? /[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*/g
            : /[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*(?:\\ *[A-Za-z0-9_\u0080-\uFFFF]+)*/g;
        let match: RegExpExecArray | null;
        while ((match = wordRe.exec(lineText)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            const col = position.character;
            const isCandidate =
                (col >= start && col < end) ||
                (col === end && lineText[col] === undefined) ||
                (col === end && !/[A-Za-z0-9_\u0080-\uFFFF]/.test(lineText[col] ?? ''));
            if (!isCandidate) {
                continue;
            }
            const normalized = normalizedIdentifierText(match[0]);
            // normToSource[i] = source column of the i-th normalized char.
            const normToSource: number[] = [];
            for (const seg of splitIdentifierSegments(match[0])) {
                for (let k = seg.start; k < seg.end; k++) {
                    normToSource.push(start + k);
                }
            }
            const parts = splitIdentifierParts(normalized);
            for (const part of parts) {
                const pStart = normToSource[part.start];
                const pEnd = normToSource[part.end - 1] + 1;
                // A caret is a point *between* characters: at a part
                // boundary it belongs to the part on its left, so
                // `global|_name` selects `global` and `global_|name`
                // selects `_`. Strictly inside a part, that part wins.
                if (
                    (col > pStart && col <= pEnd) ||
                    (col === start && part.start === 0)
                ) {
                    add(
                        { line: position.line, character: pStart },
                        { line: position.line, character: pEnd },
                    );
                }
            }
            add(
                { line: position.line, character: start },
                { line: position.line, character: end },
            );
            if (start > 0 && lineText[start - 1] === '#') {
                add(
                    { line: position.line, character: start - 1 },
                    { line: position.line, character: end },
                );
            }
            break;
        }
    }

    // -- string literal (inner content, then whole literal) ---------------------
    {
        outer: for (const line of lines) {
            if (line.line !== position.line) continue;
            for (const token of line.tokens) {
                const isString = token.scopes.some((s) => s.startsWith('string.'));
                if (!isString) continue;
                if (position.character < token.startIndex || position.character > token.endIndex) {
                    continue;
                }
                // Expand to the contiguous run of string-scoped tokens on this line.
                const stringTokens = line.tokens.filter((t) =>
                    t.scopes.some((s) => s.startsWith('string.')),
                );
                const idx = stringTokens.indexOf(token);
                let first = idx;
                let last = idx;
                while (
                    first > 0 &&
                    stringTokens[first - 1].endIndex === stringTokens[first].startIndex
                ) {
                    first--;
                }
                while (
                    last < stringTokens.length - 1 &&
                    stringTokens[last + 1].startIndex === stringTokens[last].endIndex
                ) {
                    last++;
                }
                const firstTok = stringTokens[first];
                const lastTok = stringTokens[last];
                if (last > first && (firstTok.text === '"' || firstTok.text === "'")) {
                    add(
                        { line: line.line, character: firstTok.endIndex },
                        { line: line.line, character: lastTok.startIndex },
                    );
                }
                add(
                    { line: line.line, character: firstTok.startIndex },
                    { line: line.line, character: lastTok.endIndex },
                );
                break outer;
            }
        }
    }

    // -- postfix chain helpers ----------------------------------------------------
    function isOperandEnd(l: Lexeme | undefined): boolean {
        if (!l) return false;
        return (
            IDENTIFIER_RE.test(l.text) ||
            /^\d/.test(l.text) ||
            l.opaque ||
            l.text === ')' ||
            l.text === ']' ||
            l.text === '}'
        );
    }

    /** Start lexeme index of the postfix chain whose tail ends at endIdx (inclusive). */
    function chainStartEndingAt(endIdx: number): number {
        const l = lexemes[endIdx];
        if (!l) return endIdx;
        let start = endIdx;
        if (CLOSER_TO_OPENER[l.text]) {
            const open = closeToOpen.get(endIdx);
            if (open === undefined) return endIdx;
            start = open;
            if (isOperandEnd(lexemes[start - 1]) && lexemes[start - 1]?.text !== '}') {
                return chainStartEndingAt(start - 1);
            }
            return start;
        }
        if (lexemes[endIdx - 1]?.text === '.' && endIdx >= 2 && isOperandEnd(lexemes[endIdx - 2])) {
            return chainStartEndingAt(endIdx - 2);
        }
        return start;
    }

    function addPostfixChains(segStart: number, segEnd: number): void {
        let i = segStart;
        while (i < segEnd) {
            const l = lexemes[i];
            const isPrimary =
                IDENTIFIER_RE.test(l.text) ||
                /^\d/.test(l.text) ||
                l.opaque ||
                OPENERS.has(l.text) ||
                (l.text === '.' && OPENERS.has(lexemes[i + 1]?.text ?? ''));
            if (!isPrimary) {
                i++;
                continue;
            }
            let end: number;
            if (OPENERS.has(lexemes[i + (l.text === '.' ? 1 : 0)]?.text ?? '')) {
                const openIdx = l.text === '.' ? i + 1 : i;
                const close = openToClose.get(openIdx);
                end = close !== undefined ? close + 1 : i + 1;
            } else {
                end = i + 1;
            }
            const prefixes: Array<[number, number]> = [[i, end]];
            while (end < segEnd) {
                const t = lexemes[end]?.text;
                if (t === '.' && end + 1 < segEnd && IDENTIFIER_RE.test(lexemes[end + 1].text)) {
                    end += 2;
                } else if (t !== undefined && OPENERS.has(t)) {
                    const close = openToClose.get(end);
                    if (close === undefined) break;
                    end = close + 1;
                } else if (t === '.' && OPENERS.has(lexemes[end + 1]?.text ?? '')) {
                    const close = openToClose.get(end + 1);
                    if (close === undefined) break;
                    end = close + 1;
                } else {
                    break;
                }
                prefixes.push([i, end]);
            }
            if (cursorIdx >= i && cursorIdx < end) {
                for (const [s, e] of prefixes) {
                    addLexRange(s, e);
                }
            }
            i = Math.max(end, i + 1);
        }
    }

    // -- delimiter pairs, segments, extended outers -------------------------------
    interface Segment {
        startIdx: number;
        endIdx: number; // exclusive
    }
    const allSegments: Segment[] = [];

    function splitSegments(open: number, close: number, separators: Set<string>): Segment[] {
        const segments: Segment[] = [];
        let depth = 0;
        let segStart = open + 1;
        for (let j = open + 1; j < close; j++) {
            const l = lexemes[j];
            if (l.opaque) continue;
            if (OPENERS.has(l.text)) {
                depth++;
            } else if (CLOSER_TO_OPENER[l.text]) {
                depth--;
            } else if (depth === 0 && separators.has(l.text)) {
                if (segStart < j) segments.push({ startIdx: segStart, endIdx: j });
                segStart = j + 1;
            }
        }
        if (segStart < close) {
            segments.push({ startIdx: segStart, endIdx: close });
        }
        return segments;
    }

    for (const pair of pairs) {
        const openLex = lexemes[pair.open];
        const closeLex = lexemes[pair.close];
        const inner: SelectionRangeLike = {
            start: lexPos(openLex, 'end'),
            end: lexPos(closeLex, 'start'),
        };
        const outer: SelectionRangeLike = {
            start: lexPos(openLex, 'start'),
            end: lexPos(closeLex, 'end'),
        };
        if (!containsPos(outer, position)) {
            continue;
        }
        add(inner.start, inner.end);
        add(outer.start, outer.end);

        // Extended outer: `Type.{...}`, `foo(...)`, `a[...]`, `if (...)`.
        const prevIdx = pair.open - 1;
        const prev = lexemes[prevIdx];
        if (prev) {
            if (openLex.text === '{' && prev.text === '.' && prevIdx >= 1) {
                add(lexPos(prev, 'start'), lexPos(closeLex, 'end'));
                const chainStart = chainStartEndingAt(prevIdx - 1);
                add(lexPos(lexemes[chainStart], 'start'), lexPos(closeLex, 'end'));
            } else if (openLex.text === '(' || openLex.text === '[') {
                if (
                    ['if', 'ifx', 'for', 'while', 'case'].includes(prev.text) &&
                    !prev.opaque
                ) {
                    add(lexPos(prev, 'start'), lexPos(closeLex, 'end'));
                } else if (isOperandEnd(prev)) {
                    const chainStart = chainStartEndingAt(prevIdx);
                    add(lexPos(lexemes[chainStart], 'start'), lexPos(closeLex, 'end'));
                }
            }
        }

        const commaSegments = splitSegments(pair.open, pair.close, new Set([',']));
        for (const seg of commaSegments) {
            addLexRange(seg.startIdx, seg.endIdx);
            allSegments.push(seg);
        }
        if (openLex.text === '{') {
            const stmtSegments = splitSegments(pair.open, pair.close, new Set([';']));
            for (const seg of stmtSegments) {
                addLexRange(seg.startIdx, seg.endIdx);
                allSegments.push(seg);
            }
        }
    }

    // Root-level segment (between top-level semicolons) if no pair claimed one.
    {
        let segStart = 0;
        const rootSegments: Segment[] = [];
        let i = 0;
        while (i < lexemes.length) {
            const l = lexemes[i];
            const close = openToClose.get(i);
            if (!l.opaque && close !== undefined) {
                i = close + 1;
                continue;
            }
            if (!l.opaque && l.text === ';') {
                if (segStart < i) rootSegments.push({ startIdx: segStart, endIdx: i });
                segStart = i + 1;
            }
            i++;
        }
        if (segStart < lexemes.length) {
            rootSegments.push({ startIdx: segStart, endIdx: lexemes.length });
        }
        for (const seg of rootSegments) {
            if (seg.startIdx <= cursorIdx && cursorIdx < seg.endIdx) {
                allSegments.push(seg);
            }
        }
    }

    // -- expression sub-ranges inside the innermost segment -----------------------
    /**
     * Clip an interval to the comma-separated sub-segment containing the
     * cursor lexeme. Commas are hard expression boundaries: without this,
     * operator splitting on a container's whole contents (e.g. the inside
     * of `.{a.x * s, a.y * s}`) could invent cross-member "operands" like
     * `s, a.y` when the cursor sits in the gap after a comma. Returns
     * undefined when the cursor is not on a lexeme inside any sub-segment
     * (gap/comma/operator), in which case no operand ranges are produced.
     */
    function clipToCommaSegment(
        segStart: number,
        segEnd: number,
    ): [number, number] | undefined {
        if (cursorIdx < segStart || cursorIdx >= segEnd) {
            return undefined;
        }
        let start = segStart;
        let j = segStart;
        while (j < segEnd) {
            const l = lexemes[j];
            if (!l.opaque && OPENERS.has(l.text)) {
                const close = openToClose.get(j);
                if (close !== undefined && close < segEnd) {
                    j = close + 1;
                    continue;
                }
            }
            if (!l.opaque && l.text === ',') {
                if (cursorIdx < j) {
                    return [start, j];
                }
                if (cursorIdx === j) {
                    return undefined; // cursor on the comma itself
                }
                start = j + 1;
            }
            j++;
        }
        return [start, segEnd];
    }

    {
        // Pick the smallest segment containing the cursor.
        let best: Segment | undefined;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const seg of allSegments) {
            const range: SelectionRangeLike = {
                start: lexPos(lexemes[seg.startIdx], 'start'),
                end: lexPos(lexemes[seg.endIdx - 1], 'end'),
            };
            if (!containsPos(range, position)) continue;
            const score =
                (range.end.line - range.start.line) * 100000 +
                (range.end.line === range.start.line
                    ? range.end.character - range.start.character
                    : 50000);
            if (score < bestScore) {
                bestScore = score;
                best = seg;
            }
        }

        const clipped = best ? clipToCommaSegment(best.startIdx, best.endIdx) : undefined;
        if (best && clipped) {
            const operandIntervals: Array<[number, number]> = [clipped];
            let [curS, curE] = clipped;
            // Repeatedly split the current interval by its weakest top-level
            // binary operators and keep the operand containing the cursor.
            for (let guard = 0; guard < 32; guard++) {
                let minPrec = Number.POSITIVE_INFINITY;
                const ops: Array<{ idx: number; prec: number }> = [];
                let j = curS;
                while (j < curE) {
                    const l = lexemes[j];
                    if (!l.opaque && OPENERS.has(l.text)) {
                        const close = openToClose.get(j);
                        if (close !== undefined && close < curE) {
                            j = close + 1;
                            continue;
                        }
                    }
                    if (!l.opaque && BINARY_PRECEDENCE[l.text] !== undefined) {
                        const prevL = lexemes[j - 1];
                        const nextL = lexemes[j + 1];
                        if (j > curS && nextL && isOperandEnd(prevL)) {
                            const prec = BINARY_PRECEDENCE[l.text];
                            ops.push({ idx: j, prec });
                            if (prec < minPrec) minPrec = prec;
                        }
                    }
                    j++;
                }
                if (ops.length === 0) break;
                const splitOps = ops.filter((o) => o.prec === minPrec);
                // Build operand intervals around the split operators.
                const intervals: Array<[number, number]> = [];
                let s = curS;
                for (const op of splitOps) {
                    intervals.push([s, op.idx]);
                    s = op.idx + 1;
                }
                intervals.push([s, curE]);
                const chosen = intervals.find(
                    ([a, b]) =>
                        (cursorIdx >= a && cursorIdx < b) ||
                        (cursorIdx < 0 &&
                            containsPos(
                                {
                                    start: lexPos(lexemes[a], 'start'),
                                    end: lexPos(lexemes[b - 1], 'end'),
                                },
                                position,
                            )),
                );
                if (!chosen || (chosen[0] === curS && chosen[1] === curE)) break;
                addLexRange(chosen[0], chosen[1]);
                operandIntervals.push(chosen);
                [curS, curE] = chosen;
            }
            for (const [s, e] of operandIntervals) {
                addPostfixChains(s, e);
            }
        }
    }

    // -- enclosing outline symbols --------------------------------------------------
    {
        const visit = (nodes: OutlineSymbolNode[]): void => {
            for (const node of nodes) {
                add(node.range.start, node.range.end);
                visit(node.children);
            }
        };
        visit(outline);
    }

    // -- line and document ------------------------------------------------------------
    {
        const lineText = sourceLines[position.line] ?? '';
        const first = lineText.search(/\S/);
        if (first >= 0) {
            const last = lineText.replace(/\s+$/, '').length;
            add(
                { line: position.line, character: first },
                { line: position.line, character: last },
            );
        }
        if (sourceLines.length > 0) {
            add(
                { line: 0, character: 0 },
                {
                    line: sourceLines.length - 1,
                    character: sourceLines[sourceLines.length - 1].length,
                },
            );
        }
    }

    // -- sort innermost-first and keep a valid containment chain -----------------------
    candidates.sort((a, b) => {
        const byStart = cmpPos(b.start, a.start); // later start first
        if (byStart !== 0) return byStart;
        return cmpPos(a.end, b.end); // earlier end first
    });
    const result: SelectionRangeLike[] = [];
    for (const range of candidates) {
        const prev = result[result.length - 1];
        if (!prev || (containsRange(range, prev) && !sameRange(range, prev))) {
            result.push(range);
        }
    }
    return result;
}
