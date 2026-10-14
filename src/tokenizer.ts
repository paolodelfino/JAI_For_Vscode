import * as fs from 'fs';
import * as path from 'path';
import * as textmate from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';

/** One TextMate token. Line/columns are 0-based, end is exclusive (VS Code convention). */
export interface TokenRecord {
    /** 0-based line index. */
    line: number;
    /** 0-based start character index within the line. */
    startIndex: number;
    /** 0-based end character index within the line (exclusive). */
    endIndex: number;
    /** Exact source text covered by this token. */
    text: string;
    /** Scope stack, outermost first (e.g. ["source.jai", "entity.name.function.jai"]). */
    scopes: string[];
}

export interface TokenizedLine {
    /** 0-based line index. */
    line: number;
    /** Raw line text (no line terminator). */
    text: string;
    tokens: TokenRecord[];
}

export type CancelCheck = () => boolean;

let onigLibPromise: Promise<textmate.IOnigLib> | undefined;

function getOnigLib(wasmPath: string): Promise<textmate.IOnigLib> {
    if (!onigLibPromise) {
        const wasmBin = fs.readFileSync(wasmPath).buffer as ArrayBuffer;
        onigLibPromise = oniguruma.loadWASM(wasmBin).then(() => ({
            createOnigScanner(sources: string[]) {
                return oniguruma.createOnigScanner(sources);
            },
            createOnigString(str: string) {
                return oniguruma.createOnigString(str);
            },
        }));
    }
    return onigLibPromise;
}

function defaultWasmPath(): string {
    try {
        return require.resolve('vscode-oniguruma/release/onig.wasm');
    } catch {
        return path.join(__dirname, '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm');
    }
}

/**
 * Tokenizes Jai source with the very same grammar file that VS Code uses
 * for syntax highlighting (syntaxes/jai.tmLanguage.json).
 *
 * This class only produces the raw token stream; symbol reconstruction
 * lives in src/outline.ts.
 */
export class JaiTokenizer {
    private grammarPromise: Promise<textmate.IGrammar | null> | undefined;

    constructor(
        private readonly grammarPath: string,
        private readonly wasmPath: string = defaultWasmPath(),
    ) {}

    private loadGrammar(): Promise<textmate.IGrammar | null> {
        if (!this.grammarPromise) {
            const registry = new textmate.Registry({
                onigLib: getOnigLib(this.wasmPath),
                loadGrammar: async (scopeName: string) => {
                    if (scopeName === 'source.jai') {
                        const content = await fs.promises.readFile(this.grammarPath, 'utf8');
                        return textmate.parseRawGrammar(content, this.grammarPath);
                    }
                    // The Jai grammar does not include external grammars.
                    return null;
                },
            });
            this.grammarPromise = registry.loadGrammar('source.jai');
        }
        return this.grammarPromise;
    }

    /** Tokenize an array of raw lines (without line terminators). */
    async tokenizeLines(lines: string[], isCancelled?: CancelCheck): Promise<TokenizedLine[]> {
        const grammar = await this.loadGrammar();
        if (!grammar) {
            throw new Error(`Failed to load TextMate grammar: ${this.grammarPath}`);
        }

        const result: TokenizedLine[] = [];
        let ruleStack: textmate.StateStack = textmate.INITIAL;

        for (let i = 0; i < lines.length; i++) {
            if (isCancelled && i % 200 === 0 && isCancelled()) {
                break;
            }
            const text = lines[i];
            const tokenized = grammar.tokenizeLine(text, ruleStack);
            ruleStack = tokenized.ruleStack;
            result.push({
                line: i,
                text,
                tokens: tokenized.tokens.map((t) => ({
                    line: i,
                    startIndex: t.startIndex,
                    endIndex: t.endIndex,
                    text: text.substring(t.startIndex, t.endIndex),
                    scopes: [...t.scopes],
                })),
            });
        }
        return result;
    }
}
