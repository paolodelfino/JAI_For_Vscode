import * as vscode from 'vscode';
import { JaiTokenizer, type TokenizedLine } from './tokenizer';
import {
    buildOutline,
    filterOutlineSymbols,
    type OutlineKindName,
    type OutlineSymbolNode,
    type OutlineVisibility,
} from './outline';
import { buildSelectionRanges, type SelectionRangeLike } from './selectionRanges';
import { WorkspaceSymbolIndex } from './workspaceSymbols';

/**
 * Read the extension's precise outline visibility settings for a scope.
 * The settings are language-overridable, so a `"[jai]": { ... }` block (or a
 * workspace/folder value) wins; the manifest defaults hide the noisier
 * categories (locals, loop variables, parameters, fields, and type
 * parameters) unless the user explicitly enables them.
 * This filters the provider output, so it applies to the Outline view,
 * breadcrumbs, Go to Symbol and Sticky Scroll alike — unlike the built-in
 * `outline.show<Kind>` settings, which only filter the Outline view (and
 * cannot distinguish e.g. locals from globals). Both compose: a symbol must
 * pass this filter *and* the built-in kind filter to appear in the Outline.
 */
function outlineVisibilityFor(scope: vscode.ConfigurationScope): OutlineVisibility {
    const cfg = vscode.workspace.getConfiguration('jai', scope);
    const show = (key: string, defaultValue = true): boolean =>
        cfg.get<boolean>(key, defaultValue) !== false;
    return {
        globalProcedure: show('outline.showGlobalProcedures'),
        nonGlobalProcedure: show('outline.showNonGlobalProcedures'),
        operatorOverload: show('outline.showOperatorOverloads'),
        struct: show('outline.showStructs'),
        enum: show('outline.showEnums'),
        enumMember: show('outline.showEnumMembers'),
        field: show('outline.showStructFields', false),
        globalConstant: show('outline.showGlobalConstants'),
        localConstant: show('outline.showConstants'),
        globalVariable: show('outline.showGlobalVariables'),
        localVariable: show('outline.showLocalVariables', false),
        loopVariable: show('outline.showLoopVariables', false),
        parameter: show('outline.showParameters', false),
        typeParameter: show('outline.showTypeParameters', false),
        interface: show('outline.showInterfaces'),
        typeAlias: show('outline.showTypeAliases'),
    };
}

const KIND_MAP: Record<OutlineKindName, vscode.SymbolKind> = {
    Function: vscode.SymbolKind.Function,
    Operator: vscode.SymbolKind.Operator,
    Struct: vscode.SymbolKind.Struct,
    Enum: vscode.SymbolKind.Enum,
    EnumMember: vscode.SymbolKind.EnumMember,
    Field: vscode.SymbolKind.Field,
    Constant: vscode.SymbolKind.Constant,
    Variable: vscode.SymbolKind.Variable,
    TypeParameter: vscode.SymbolKind.TypeParameter,
    Interface: vscode.SymbolKind.Interface,
};

function toDocumentSymbol(node: OutlineSymbolNode): vscode.DocumentSymbol {
    const symbol = new vscode.DocumentSymbol(
        node.name,
        node.detail,
        KIND_MAP[node.kind],
        new vscode.Range(
            node.range.start.line,
            node.range.start.character,
            node.range.end.line,
            node.range.end.character,
        ),
        new vscode.Range(
            node.selectionRange.start.line,
            node.selectionRange.start.character,
            node.selectionRange.end.line,
            node.selectionRange.end.character,
        ),
    );
    symbol.children = node.children.map(toDocumentSymbol);
    return symbol;
}

function toVscodeRange(range: SelectionRangeLike): vscode.Range {
    return new vscode.Range(
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character,
    );
}

/** Convert innermost-first ranges into a parent-linked SelectionRange chain. */
function toSelectionRange(ranges: SelectionRangeLike[]): vscode.SelectionRange | undefined {
    let parent: vscode.SelectionRange | undefined;
    for (let i = ranges.length - 1; i >= 0; i--) {
        parent = new vscode.SelectionRange(toVscodeRange(ranges[i]), parent);
    }
    return parent;
}

const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
    { language: 'jai', scheme: 'file' },
    { language: 'jai', scheme: 'untitled' },
];

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('JAI');
    const grammarPath = context.asAbsolutePath('syntaxes/jai.tmLanguage.json');
    const tokenizer = new JaiTokenizer(grammarPath);
    /** Tokenized lines per document, invalidated by document version. */
    const tokenCache = new Map<string, { version: number; lines: TokenizedLine[] }>();
    /** Parsed outline per document, invalidated by document version. */
    const outlineCache = new Map<string, { version: number; nodes: OutlineSymbolNode[] }>();

    function textLines(document: vscode.TextDocument): string[] {
        const lines: string[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            lines.push(document.lineAt(i).text);
        }
        return lines;
    }

    async function getTokenized(
        document: vscode.TextDocument,
        cancellationToken: vscode.CancellationToken,
    ): Promise<TokenizedLine[]> {
        const key = document.uri.toString();
        const cached = tokenCache.get(key);
        if (cached && cached.version === document.version) {
            return cached.lines;
        }
        const tokenized = await tokenizer.tokenizeLines(textLines(document), () =>
            cancellationToken.isCancellationRequested,
        );
        if (!cancellationToken.isCancellationRequested) {
            tokenCache.set(key, { version: document.version, lines: tokenized });
        }
        return tokenized;
    }

    async function getOutline(
        document: vscode.TextDocument,
        cancellationToken: vscode.CancellationToken,
    ): Promise<{ tokenized: TokenizedLine[]; nodes: OutlineSymbolNode[] }> {
        const key = document.uri.toString();
        const tokenized = await getTokenized(document, cancellationToken);
        const cached = outlineCache.get(key);
        if (cached && cached.version === document.version) {
            return { tokenized, nodes: cached.nodes };
        }
        if (cancellationToken.isCancellationRequested) {
            return { tokenized, nodes: cached?.nodes ?? [] };
        }
        const nodes = buildOutline(tokenized);
        outlineCache.set(key, { version: document.version, nodes });
        return { tokenized, nodes };
    }

    // ------------------------------------------------------------------
    // WorkspaceSymbolProvider — Ctrl+T ("Go to Symbol in Workspace").
    //
    // The index (src/workspaceSymbols.ts) is built lazily on the first
    // workspace-symbol request — nothing is scanned or threaded at
    // activation — then kept incremental via file watcher and
    // open-document events. Tokenizing/outlining batches run on a small
    // worker-thread pool with a main-thread fallback. The same
    // `jai.outline.show*` category settings filter workspace results
    // (per file), so hidden locals/parameters stay out of Ctrl+T too.
    // ------------------------------------------------------------------
    const workspaceSymbolIndex = new WorkspaceSymbolIndex({
        grammarPath,
        workerScriptPath: context.asAbsolutePath('out/workspaceWorker.js'),
        tokenizer,
        // Explicit languageId: for unopened files a bare Uri carries no
        // language, and a `"[jai]": { ... }` override would be missed.
        getVisibility: (uri) => outlineVisibilityFor({ uri, languageId: 'jai' }),
        log: (message) => output.appendLine(message),
    });
    const workspaceSymbolProvider: vscode.WorkspaceSymbolProvider = {
        provideWorkspaceSymbols: (query, token) =>
            workspaceSymbolIndex.provideWorkspaceSymbols(query, token),
    };

    // ------------------------------------------------------------------
    // DocumentSymbolProvider — nested outline of Jai definitions.
    //
    // The token stream (same grammar as syntax highlighting) is rebuilt
    // into a DocumentSymbol tree by src/outline.ts. Inclusion policy:
    // a definition category is outlined only when it can be hidden without
    // hiding real definitions — via its SymbolKind or via its semantic
    // category (procedure, local variable, parameter, ...). The provider
    // prunes the tree by the extension's own `jai.outline.show*` settings
    // before converting; that is what makes filtering more precise than
    // the built-in `outline.show<Kind>` settings, which cannot tell
    // globals, locals, loop variables and parameters apart (all are
    // SymbolKind.Variable).
    // Calls and type references are never outlined: they would pollute the
    // Function/Struct kinds that real definitions rely on.
    //
    // The cached tree stays unfiltered: filtering happens here, per
    // request, so Smart Select below always sees the full structure.
    // ------------------------------------------------------------------
    const symbolProvider: vscode.DocumentSymbolProvider = {
        async provideDocumentSymbols(
            document: vscode.TextDocument,
            cancellationToken: vscode.CancellationToken,
        ): Promise<vscode.DocumentSymbol[]> {
            try {
                const { nodes } = await getOutline(document, cancellationToken);
                const visible = filterOutlineSymbols(nodes, outlineVisibilityFor(document));
                return visible.map(toDocumentSymbol);
            } catch (err) {
                output.appendLine(`[jai] Document symbol request failed: ${String(err)}`);
                return [];
            }
        },
    };

    // ------------------------------------------------------------------
    // SelectionRangeProvider — Smart Select (Shift+Alt+Right/Left).
    //
    // Without this, VS Code falls back to word + bracket ranges, so
    // expanding inside `.{a.x * s, ...}` jumped straight to the whole
    // brace block. src/selectionRanges.ts builds a containment hierarchy
    // instead: identifier parts (snake_case/camelCase, '_' selectable on
    // its own) -> identifier -> member/call chains -> operator operands
    // -> comma segments -> delimiter ranges -> statements -> outline
    // symbols -> line -> document. Note: once any provider is registered
    // for a language, VS Code no longer adds its bracket fallback, so
    // delimiter ranges are part of what we return.
    // ------------------------------------------------------------------
    const selectionRangeProvider: vscode.SelectionRangeProvider = {
        async provideSelectionRanges(
            document: vscode.TextDocument,
            positions: readonly vscode.Position[],
            cancellationToken: vscode.CancellationToken,
        ): Promise<vscode.SelectionRange[]> {
            try {
                const { tokenized, nodes } = await getOutline(document, cancellationToken);
                return positions.map((position) => {
                    const ranges = buildSelectionRanges(tokenized, nodes, {
                        line: position.line,
                        character: position.character,
                    });
                    return (
                        toSelectionRange(ranges) ??
                        new vscode.SelectionRange(
                            new vscode.Range(position, position),
                        )
                    );
                });
            } catch (err) {
                output.appendLine(`[jai] Selection range request failed: ${String(err)}`);
                return positions.map(
                    (position) =>
                        new vscode.SelectionRange(new vscode.Range(position, position)),
                );
            }
        },
    };

    context.subscriptions.push(
        output,
        workspaceSymbolIndex,
        ...workspaceSymbolIndex.registerEventHandlers(),
        // VS Code has no API to force the Outline view to re-request symbols,
        // so changed visibility settings take effect on the next symbol
        // request (edit, editor switch, reopen, or window reload).
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('jai.outline')) {
                workspaceSymbolIndex.refreshVisibility();
                output.appendLine(
                    '[jai] Outline visibility settings changed; they apply on the next document-symbol request.',
                );
            }
            if (e.affectsConfiguration('jai.workspaceSymbols')) {
                workspaceSymbolIndex.handleWorkspaceSettingsChanged();
                output.appendLine(
                    '[jai] Workspace symbol settings changed; the index rebuilds lazily on the next workspace-symbol request.',
                );
            }
        }),
        vscode.languages.registerDocumentSymbolProvider(DOCUMENT_SELECTOR, symbolProvider),
        vscode.languages.registerSelectionRangeProvider(
            DOCUMENT_SELECTOR,
            selectionRangeProvider,
        ),
        vscode.languages.registerWorkspaceSymbolProvider(workspaceSymbolProvider),
    );
}

export function deactivate(): void {
    // Nothing to tear down; subscriptions are disposed by VS Code.
}
