# Jai for VS Code

An unofficial Visual Studio Code extension for the Jai programming language.

It provides syntax highlighting, a nested document outline, workspace-wide symbol search, and structure-aware Smart Select for `.jai` files. The symbol features are reconstructed from the same TextMate grammar used for highlighting; the extension does not invoke the Jai compiler.

> **Status:** pre-release. The extension is distributed as a `.vsix` file rather than through the VS Code Marketplace.

## Features

- **Syntax highlighting** for `.jai` files, including backslash-continued identifiers.
- **Nested outline** for procedures, types, fields, enum members, constants, variables, parameters, and related declarations.
- **Precise outline filtering** through `jai.outline.show*` settings, with separate controls for globals, locals, loop variables, parameters, nested procedures, and other categories.
- **Workspace symbol search** with `Ctrl+T`, backed by a lazy, incremental index that searches every open workspace folder.
- **Smart Select** (`Shift+Alt+Right` / `Shift+Alt+Left`) that expands through identifier parts, expressions, comma-separated members, delimiter pairs, statements, and enclosing symbols.
- **No contributed commands or menus.** The providers activate automatically for Jai documents and for workspaces containing `.jai` files.

## Requirements

- Visual Studio Code 1.85 or newer.
- No Jai compiler installation is required for highlighting or symbol navigation.

For development, Node.js and npm are also required.

## Installation

### Install a packaged VSIX

1. Download the `.vsix` file from the project's GitHub Releases page.
2. In VS Code, open the Extensions view.
3. Select **… → Install from VSIX…** and choose the downloaded file.

The same installation can be performed from a terminal:

```bash
code --install-extension "jai-vscode-dev-<version>.vsix"
```

Replace `<version>` with the version in the downloaded file name.

### Build and run from source

```bash
npm install
npm test
```

Then open this folder in VS Code and press `F5`. The included launch configuration starts an Extension Development Host with `examples/sample.jai` open.

## Using the symbol features

Open any `.jai` file and use:

- **Outline view** for the nested definition tree.
- `Ctrl+Shift+O` for Go to Symbol in Editor.
- Breadcrumbs and Sticky Scroll for navigation within nested definitions.
- `Ctrl+T` for Go to Symbol in Workspace.
- `Shift+Alt+Right` and `Shift+Alt+Left` for Expand/Shrink Selection. On macOS, use `Shift+Option+Right` and `Shift+Option+Left`, or run the **Expand Selection** and **Shrink Selection** commands.

## Outline

The outline contains definitions, not every syntactic construct. Function calls, type references, control-flow blocks, imports, and directives are intentionally excluded because including them would mix them with real definitions in the symbol views.

| Jai construct | VS Code symbol kind |
| --- | --- |
| Procedures and assigned anonymous procedures | `Function` |
| Operator overloads | `Operator` |
| Structs and unions | `Struct` |
| Enums and `enum_flags` | `Enum` |
| Enum members | `EnumMember` |
| Struct fields | `Field` |
| `name :: value` constants | `Constant` |
| Global, local, and loop variables | `Variable` |
| Procedure and struct parameters | `Variable` |
| `$T` and `T: Type` parameters | `TypeParameter` |
| Interfaces and `#type` aliases | `Interface` |

Nesting follows the structure of the source: procedures can contain nested procedures and types, structs contain fields and nested types, enums contain members, and procedures contain their parameters and locals. A symbol's full range covers its definition; its selection range covers only its name.

### Scope and declaration classification

Jai treats declaration form and scope as separate concepts:

- `name :: value` creates a constant binding. Types, interfaces, and `#type` aliases bound with `::` use their own outline categories.
- `name := value` and `name: Type` create variable bindings.
- Either form can be global or non-global. A plain constant at file scope is a global constant; a plain constant inside a procedure, `#run` block, or type is a non-global constant. Procedures use the same scope split: a file-scope procedure is a global procedure, while a procedure inside another procedure, a `#run` block, or a type/interface body is a non-global procedure.

Scope classification follows Jai's distinction between data and imperative scopes:

- File scope is a data scope.
- `#if` and `else` do not introduce a scope of their own. A declaration directly inside a top-level `#if` branch remains global, and a declaration inside a struct branch remains a field.
- Procedure bodies are imperative scopes.
- A `#run` block is also imperative. Declarations inside a top-level `#run { ... }` block are local to that block, whether they use `:=` or `::`; in particular, a procedure declared directly in that block is a non-global procedure even though it is not inside another procedure.
- A declaration directly prefixed by `#run`, such as `#run value := 12;`, is local to the surrounding imperative execution.
- Using `#run` only in an initializer, such as `value := #run compute();`, does not change the scope of the outer declaration.

### Precise outline filtering

VS Code's built-in `outline.show*` settings filter by symbol kind. That cannot distinguish several Jai categories that all use `Variable`, so this extension also provides category-specific settings.

By default, the outline favours structural/global definitions: local variables, loop variables, parameters, struct fields, and type parameters are hidden, while procedures (global and non-global), constants (global and non-global), types, enums, enum members, global variables, interfaces, operator overloads, and type aliases are shown.

For example, to additionally show locals, loop variables, and parameters:

```json
{
  "[jai]": {
    "jai.outline.showLocalVariables": true,
    "jai.outline.showLoopVariables": true,
    "jai.outline.showParameters": true
  }
}
```

Hiding a symbol also hides its subtree. These settings filter the provider result, so they affect the Outline view, Breadcrumbs, Go to Symbol in Editor, Sticky Scroll, and workspace symbol results. Smart Select always uses the unfiltered internal symbol tree.

Because global and non-global constants have separate settings, setting `jai.outline.showConstants` to `false` hides constants inside procedures, `#run` blocks, and types while leaving file-scope constants visible unless `jai.outline.showGlobalConstants` is also `false`. Likewise, `jai.outline.showLocalVariables` controls non-global variables, not non-global constants.

<details>
<summary>All <code>jai.outline.show*</code> settings</summary>

| Setting | Default | Controls |
| --- | ---: | --- |
| `jai.outline.showGlobalProcedures` | `true` | File-scope procedures, including assigned anonymous procedures |
| `jai.outline.showNonGlobalProcedures` | `true` | Procedures outside file scope, including procedures in procedures, `#run` blocks, or type/interface bodies |
| `jai.outline.showOperatorOverloads` | `true` | Operator overloads |
| `jai.outline.showStructs` | `true` | Structs and unions |
| `jai.outline.showEnums` | `true` | Enums and `enum_flags` |
| `jai.outline.showEnumMembers` | `true` | Individual enum members |
| `jai.outline.showStructFields` | `false` | Struct fields |
| `jai.outline.showConstants` | `true` | Non-global `name :: value` constants (inside procedures, `#run` blocks, or types) |
| `jai.outline.showGlobalConstants` | `true` | File-scope `name :: value` constants |
| `jai.outline.showGlobalVariables` | `true` | Variables outside procedures and types |
| `jai.outline.showLocalVariables` | `false` | Variables inside imperative scopes |
| `jai.outline.showLoopVariables` | `false` | `for` loop variables and iterators |
| `jai.outline.showParameters` | `false` | Procedure and struct parameters |
| `jai.outline.showTypeParameters` | `false` | `$T` and `T: Type` parameters |
| `jai.outline.showInterfaces` | `true` | Interfaces |
| `jai.outline.showTypeAliases` | `true` | `#type` aliases |

All of these settings are language-overridable.

</details>

VS Code does not provide an API that forces the Outline view to request symbols again. After changing these settings, the updated result appears on the next symbol request, such as after an edit, an editor switch, reopening the file, or reloading the window.

## Workspace symbols

`Ctrl+T` searches the same definitions shown by the document outline, subject to the same `jai.outline.show*` visibility settings. Non-global symbols retain their container path.

The workspace index has the following behavior:

- It is built lazily on the first workspace-symbol request; activation alone does not scan the workspace.
- Every open workspace folder is searched. If no folder is open, the index contains the open Jai documents.
- Open and dirty documents take precedence over their contents on disk.
- File-system and document events update individual files incrementally.
- Queries use relaxed, case-insensitive subsequence matching: `rfbmp` can match `rebuild_flag_bitmap`.
- Large batches can be processed by a bounded worker-thread pool. If workers cannot start, indexing falls back to the extension-host thread.
- The index is kept in memory for the current session and is not persisted to disk.

### Workspace settings

| Setting | Default | Description |
| --- | ---: | --- |
| `jai.workspaceSymbols.enabled` | `true` | Enables the workspace symbol index. |
| `jai.workspaceSymbols.maxWorkers` | `0` | Maximum worker threads. `0` selects an automatic CPU-based count, capped at 8. |
| `jai.workspaceSymbols.maxFileSizeKiB` | `0` | Skips files larger than the given size. `0` means unlimited. |
| `jai.workspaceSymbols.exclude` | `[]` | Glob patterns excluded from indexing. Empty means no extension-level exclusions. |

For very large workspaces, use `jai.workspaceSymbols.exclude` or `jai.workspaceSymbols.maxFileSizeKiB` to limit indexing. For example:

```json
{
  "jai.workspaceSymbols.exclude": [
    "**/generated/**",
    "**/vendor/**"
  ]
}
```

Changing workspace-symbol settings or the set of workspace folders resets the index. It is rebuilt lazily on the next `Ctrl+T` request.

## Smart Select

Smart Select builds a strictly nested range hierarchy around the cursor. Depending on the position, expansion can proceed through:

1. Identifier parts, such as `hello`, `_`, and `world` in `hello_world`.
2. A complete identifier, including a backslash-continued identifier.
3. Member, call, and index chains.
4. Operator operands by precedence.
5. The comma-separated member containing the cursor.
6. Delimiter contents and then the complete delimiter pair, including forms such as `Type.{...}`, calls, indexing, and `if (...)` headers.
7. The containing statement and enclosing outline symbols.
8. The trimmed line and then the whole document.

A caret on an identifier-part boundary selects the part to its left. Digits remain attached to the preceding part, so `Vector3`, `float32`, and `Matrix4x4` are each treated as one identifier part unless a separator precedes the digits.

## How it works

VS Code does not expose its internal TextMate tokenization to extensions. This extension therefore bundles `vscode-textmate` and `vscode-oniguruma` and tokenizes Jai source with the same grammar file used for highlighting.

The resulting token stream drives:

- `src/outline.ts` — definition and nesting reconstruction;
- `src/selectionRanges.ts` — Smart Select hierarchies;
- `src/workspaceSymbols.ts` — the lazy workspace index.

String and comment tokens are opaque to structural analysis, so braces inside them do not affect nesting. Backslash-continued identifiers are normalized before outline construction, while their ranges still cover the complete source spelling.

## Scope and limitations

This is a token-based implementation, not a Jai compiler front end. It is designed to be resilient to incomplete code, but some constructs are handled only on a best-effort basis:

- Declarations inside parentheses, such as `if (x := ...)`, are not outlined.
- A here-string constant's range ends at its delimiter line rather than after a trailing semicolon.
- Unterminated definitions end at their name or at the enclosing closing brace.
- The extension focuses on highlighting and symbol navigation. It does not provide compiler-backed go-to-definition, find-references, diagnostics, or folding.

## Development

Install dependencies and run the complete regression suite:

```bash
npm install
npm test
```

`npm test` compiles the TypeScript sources and runs the outline, selection, and workspace checks.

Useful commands:

```bash
npm run compile       # Compile TypeScript to out/
npm run watch         # Compile on change
npm run dump:sample   # Print a token dump for examples/sample.jai
npm run outline:sample # Print the reconstructed outline for the sample
```

The headless CLI can also process another file:

```bash
node ./out/cli.js path/to/file.jai
node ./out/cli.js path/to/file.jai --outline
node ./out/cli.js path/to/file.jai --out path/to/dump-prefix
```

These are development tools only; they are not VS Code commands.

### Package a VSIX

```bash
npx @vscode/vsce package
```

This creates `jai-vscode-dev-<version>.vsix`. Do not use `--no-dependencies`: the packaged extension must include its production dependencies, including the Oniguruma WebAssembly binary.

## Project layout

```text
package.json                  Extension manifest and settings
language-configuration.json   Brackets, comments, indentation, and word pattern
syntaxes/                     TextMate grammar
src/extension.ts              VS Code providers and activation
src/tokenizer.ts              TextMate/Oniguruma tokenizer
src/outline.ts                Token stream to nested symbol tree
src/selectionRanges.ts        Smart Select range construction
src/workspaceSymbols.ts       Lazy incremental workspace index
src/workspaceWorker*.ts       Worker-thread indexing and pool
src/workspaceSymbolCore.ts    Flat records and query matching
src/cli.ts                    Headless token and outline tools
examples/sample.jai           Extension regression fixture
test/                         Headless regression checks and fixtures
```

## Contributing

Contributions are welcome. Please run `npm test` before submitting a change. Changes to grammar scopes, outline classification, selection behavior, or workspace indexing should include regression coverage in the existing checks or fixtures.

`examples/sample.jai` is an extension test fixture, not a Jai language tutorial. Add material to it only when it exercises tokenizer, outline, selection, or workspace-symbol behavior.

## License

MIT. See the `license` field in `package.json`.
