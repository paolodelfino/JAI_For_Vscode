# AGENTS.md

Guidance for coding agents and contributors working in this repository.

## Project summary

This is a VS Code extension for the Jai programming language. It provides:

- TextMate syntax highlighting;
- a nested `DocumentSymbol` outline;
- structure-aware Smart Select;
- lazy, incremental workspace symbol search (`Ctrl+T`).

The extension does not invoke or embed the Jai compiler. VS Code does not expose its internal TextMate tokenization, so the extension bundles `vscode-textmate` and `vscode-oniguruma` and reconstructs symbols from the same grammar used for highlighting.

## Repository map

- `package.json` — extension manifest, activation events, settings, scripts.
- `language-configuration.json` — brackets, comments, indentation, and `wordPattern`.
- `syntaxes/jai.tmLanguage.json` — TextMate grammar (`source.jai`).
- `src/extension.ts` — VS Code activation and the DocumentSymbol, SelectionRange, and WorkspaceSymbol providers.
- `src/tokenizer.ts` — VS Code-independent TextMate/Oniguruma tokenizer.
- `src/outline.ts` — token stream to nested outline tree; also contains the shared lexeme and backslash-identifier logic.
- `src/selectionRanges.ts` — Smart Select range construction.
- `src/workspaceSymbolCore.ts` — flat workspace records and relaxed query matching.
- `src/workspaceSymbols.ts` — lazy incremental workspace index and VS Code event handling.
- `src/workspaceWorker.ts` — worker-thread batch processor.
- `src/workspaceWorkerPool.ts` — bounded, reusable worker pool with failure signalling for main-thread fallback.
- `src/tokenDump.ts`, `src/cli.ts` — headless development tools only.
- `examples/sample.jai` — extension regression fixture and its generated token/outline dumps.
- `test/*.check.js` — headless regression checks.
- `test/fixtures/*.jai` — focused regression fixtures.

## Commands

Install dependencies:

```bash
npm install
```

Run the full check suite:

```bash
npm test
```

Compile only:

```bash
npm run compile
```

Regenerate the sample token and outline artifacts after changing the sample, grammar, tokenizer, or outline reconstruction:

```bash
npm run compile
node ./out/cli.js examples/sample.jai --out examples/sample
node ./out/cli.js examples/sample.jai --outline > examples/sample.outline.txt
```

Package the extension:

```bash
npx --yes @vscode/vsce package
```

Never package with `--no-dependencies`. The VSIX must contain the production dependencies, especially `node_modules/vscode-oniguruma/release/onig.wasm`, and `out/workspaceWorker.js`.

When bumping the version, keep `package.json` and `package-lock.json` in sync, for example with:

```bash
npm install --package-lock-only --ignore-scripts
```

Then run `npm test`, package, and verify that the VSIX manifest reports the intended version.

## Architectural invariants

### Providers and activation

- Do not contribute VS Code commands or menus. The token-dump and outline-printing tools are headless CLI utilities only.
- Keep both activation paths:
  - `onLanguage:jai` for open Jai documents;
  - `workspaceContains:**/*.jai` so workspace symbols are available before a Jai file is opened.
- `src/extension.ts` is the VS Code integration layer. Keep the reusable tokenizer, outline, selection, and workspace-record logic independent of VS Code where it already is.

### Outline construction

- Preserve the inclusion rule: a category is outlined only when it can be hidden without hiding unrelated definitions, either through its `SymbolKind` or through a precise `jai.outline.show*` category.
- Do not add function calls, type references, control-flow blocks, imports, or directives as outline symbols.
- Filtering must remain provider-side and non-mutating. `filterOutlineSymbols` returns copies; Smart Select must continue to receive the full unfiltered tree.
- In the pure outline filter, only an explicit `false` hides a category; missing visibility entries mean “shown”. The VS Code layer supplies the manifest defaults, some of which are `false`.
- Hiding a symbol prunes its entire subtree.

### Jai scope classification

Declaration form and scope are independent:

- `name :: value` is a constant binding; `name := value` and `name: Type` are variable bindings.
- Either form can be global or non-global. Plain value constants therefore use `globalConstant` at file scope and `localConstant` in non-global scopes.
- Procedures likewise use `globalProcedure` at file scope and `nonGlobalProcedure` outside file scope. Do not use a separate “nested procedure” concept: a procedure directly inside a top-level `#run` block is non-global even though no other procedure encloses it.
- Structs, enums, interfaces, and `#type` aliases bound with `::` keep their specific semantic categories; do not collapse them into the plain-constant categories.
- `jai.outline.showConstants` controls non-global constants, while `jai.outline.showGlobalConstants` controls file-scope constants. Hiding local variables must not hide a non-global constant.
- Preserve the current default visibility: local variables, loop variables, parameters, struct fields, and type parameters default to hidden; the other outline categories (including non-global constants) default to shown.

Preserve the established scope model:

- File scope and type bodies are data scopes.
- `#if`/`else` are scope-transparent. Declarations directly in a top-level `#if` branch are globals; declarations directly in a struct `#if` branch are fields.
- Procedure bodies are imperative scopes.
- Block-form `#run` bodies are imperative, including `#run,stallable { ... }`, `#run -> Type { ... }`, and `#run (params) -> Type { ... }`.
- A declaration directly prefixed by `#run` (`#run a := 12;`) is a local, even without a block.
- An outer declaration initialized by a `#run` expression (`x := #run compute();`) keeps its enclosing scope.
- Do not treat `#run` as an ordinary expression in the first two cases, and do not treat the expression form as changing the outer declaration in the third.

The focused regression cases live in `test/fixtures/directives.jai` and `test/outline.check.js`.

### Backslash-continued identifiers

Jai permits a backslash inside an identifier; the backslash and following spaces are not part of the compiler-visible name.

Preserve this consistently in:

- grammar name patterns;
- `language-configuration.json` `wordPattern`;
- outline lexemes and symbol names;
- Smart Select part calculation and source mapping.

The outline displays normalized names over the complete raw source span. A backslash in a string or comment is literal text, not an identifier continuation.

### Smart Select

Preserve these behaviors:

- Every returned chain must be strictly nested and contain the cursor.
- Identifier-part boundaries belong to the part on the left (`global|_name` selects `global`).
- Digits attach to preceding characters and do not form their own part, except when a separator places digits at the start of a part (`version_2`).
- Commas are hard expression boundaries. Never return a range spanning parts of two comma-separated members.
- Registering a selection-range provider disables VS Code's bracket fallback for the language, so this provider must continue to emit delimiter ranges itself.

### Workspace symbols

Preserve the workspace-index design:

- Index lazily on the first workspace-symbol request; do not scan at activation.
- Search every open workspace folder explicitly. Only when no folder is open should the index consist solely of open Jai documents.
- `jai.workspaceSymbols.exclude` defaults to `[]` and must pass no extension-level exclusions in that case.
- `jai.workspaceSymbols.maxFileSizeKiB` defaults to `0`, and `0` means unlimited.
- Keep only flattened records and prebuilt `SymbolInformation` objects; do not retain token streams or outline trees in the index.
- Keep updates incremental through watcher and document events. Settings or workspace-folder changes may reset the index, but rebuilding must remain lazy.
- Use relaxed, case-insensitive subsequence matching.
- Apply per-file `jai.outline.show*` visibility to workspace results.
- Worker output must match main-thread output. `test/workspace.check.js` compares complete records; keep that parity check intact.
- Worker failure must fall back to main-thread indexing rather than breaking `Ctrl+T`.
- Do not add `resolveWorkspaceSymbol`; returned locations are already complete.

### Grammar scopes

TextMate scope names are user-visible API: themes and user customizations match against them.

- Do not rename scopes merely to make a particular theme paint a token differently.
- In particular, `#exists` is intentionally classified as `support.constant.directive.jai` with the other value-producing directives.
- Grammar changes require regenerating the sample token dumps and running the full test suite.

## Fixtures and examples

- `examples/sample.jai` is a regression fixture for this extension, not a Jai tutorial and not documentation of language semantics.
- Add sample material only when it exercises tokenizer, outline, Smart Select, or workspace-symbol behavior that needs coverage.
- Prefer focused fixtures under `test/fixtures/` for isolated semantics, and keep assertions in the corresponding `test/*.check.js` file.
- Keep `examples/sample.tokens.txt`, `examples/sample.tokens.json`, and `examples/sample.outline.txt` synchronized with `examples/sample.jai` and the current tokenizer/outline output.

## Code style

- TypeScript is compiled with `strict`, `noUnusedLocals`, and `noUnusedParameters`; keep the build warning-free.
- Keep comments focused on current behavior and non-obvious invariants. Do not leave development-stage notes such as “next step”, “future implementation”, or references to removed features as if they still exist.
- Avoid unrelated refactors when fixing grammar, outline, selection, or workspace behavior.
- Do not duplicate the `OutlineKindName` to `vscode.SymbolKind` mapping in new places without checking the existing provider code.

## Before finishing a change

1. Run `npm test`.
2. If the sample or grammar changed, regenerate the sample artifacts and run `npm test` again.
3. If packaging, verify the generated VSIX contains:
   - the intended `extension/package.json` version;
   - `extension/out/extension.js`;
   - `extension/out/workspaceWorker.js`;
   - `extension/syntaxes/jai.tmLanguage.json`;
   - `extension/node_modules/vscode-oniguruma/release/onig.wasm`.
4. Remove superseded local `.vsix` files when producing a replacement build.
