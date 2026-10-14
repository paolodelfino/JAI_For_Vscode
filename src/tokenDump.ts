import type { TokenizedLine, TokenRecord } from './tokenizer';

export interface DumpHeader {
    /** Display label, e.g. a file path. */
    source: string;
    /** CLI invocation that produced the dump. */
    trigger: string;
    lineCount: number;
    tokenCount: number;
}

/**
 * Scopes that identify the declaration/name tokens used by outline
 * reconstruction. The full token stream is still dumped; this is only an
 * index into it.
 */
function isDefinitionRelevant(token: TokenRecord): boolean {
    return token.scopes.some((s) =>
        s.startsWith('entity.name.') ||
        s.includes('.declaration.') ||
        s === 'storage.type.jai' ||
        s === 'keyword.operator.declaration.constant.jai',
    );
}

function pad(n: number, width: number): string {
    return String(n).padStart(width, ' ');
}

/**
 * Human-readable dump for stdout or a generated .tokens.txt file, e.g.:
 *
 *   L   4 | main :: () {
 *         |   4:0-4  "main"  source.jai entity.name.function.jai
 *
 * Lines are 1-based in the left margin (editor convention); the
 * "line:start-end" range after it is 0-based (VS Code convention).
 * Token text is JSON-escaped so whitespace/tabs/quotes stay visible.
 */
export function formatTokenDump(lines: TokenizedLine[], header: DumpHeader): string {
    const out: string[] = [];
    const lineWidth = String(Math.max(1, header.lineCount)).length;

    out.push('='.repeat(78));
    out.push('JAI TOKEN DUMP');
    out.push(`source : ${header.source}`);
    out.push(`trigger: ${header.trigger}`);
    out.push(`lines  : ${header.lineCount}`);
    out.push(`tokens : ${header.tokenCount}`);
    out.push('='.repeat(78));
    out.push('');

    for (const line of lines) {
        const shownText = line.text.replace(/\t/g, '\\t');
        out.push(`L ${pad(line.line + 1, lineWidth)} | ${shownText === '' ? '(empty line)' : shownText}`);
        for (const token of line.tokens) {
            const range = `${token.line}:${token.startIndex}-${token.endIndex}`;
            out.push(
                `${' '.repeat(lineWidth + 3)}|   ${range.padEnd(10)} ${JSON.stringify(token.text)}  ${token.scopes.join(' ')}`,
            );
        }
    }

    out.push('');
    out.push('-'.repeat(78));
    out.push('SCOPE HISTOGRAM (by innermost/leaf scope)');
    out.push('-'.repeat(78));
    const histogram = new Map<string, number>();
    for (const line of lines) {
        for (const token of line.tokens) {
            const leaf = token.scopes[token.scopes.length - 1] ?? '(none)';
            histogram.set(leaf, (histogram.get(leaf) ?? 0) + 1);
        }
    }
    for (const [scope, count] of [...histogram.entries()].sort((a, b) => b[1] - a[1])) {
        out.push(`${pad(count, 6)}  ${scope}`);
    }

    out.push('');
    out.push('-'.repeat(78));
    out.push('DEFINITION-RELEVANT TOKENS (entity.name.* / *.declaration.* / storage.type / ::)');
    out.push('These are the name/declaration tokens outline reconstruction keys off.');
    out.push('-'.repeat(78));
    let any = false;
    for (const line of lines) {
        for (const token of line.tokens) {
            if (isDefinitionRelevant(token)) {
                any = true;
                out.push(
                    `${pad(token.line + 1, lineWidth)}:${pad(token.startIndex, 3)}  ${JSON.stringify(token.text).padEnd(28)} ${token.scopes[token.scopes.length - 1]}`,
                );
            }
        }
    }
    if (!any) {
        out.push('(none found)');
    }
    out.push('');
    return out.join('\n');
}

/** Machine-readable dump (for saving to *.tokens.json and diffing/analysis). */
export function tokenDumpToJson(lines: TokenizedLine[], header: DumpHeader): string {
    return JSON.stringify(
        {
            source: header.source,
            trigger: header.trigger,
            lineCount: header.lineCount,
            tokenCount: header.tokenCount,
            lines: lines.map((l) => ({
                line: l.line,
                text: l.text,
                tokens: l.tokens.map((t) => ({
                    startIndex: t.startIndex,
                    endIndex: t.endIndex,
                    text: t.text,
                    scopes: t.scopes,
                })),
            })),
        },
        null,
        2,
    );
}
