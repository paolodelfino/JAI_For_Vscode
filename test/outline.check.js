/**
 * Headless regression check for the outline reconstruction.
 * Run with: npm test   (compiles first, then runs this file)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JaiTokenizer } = require('../out/tokenizer');
const { buildOutline, filterOutlineSymbols } = require('../out/outline');

const grammarPath = path.join(__dirname, '..', 'syntaxes', 'jai.tmLanguage.json');

async function outlineOf(file) {
    const tokenizer = new JaiTokenizer(grammarPath);
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const tokenized = await tokenizer.tokenizeLines(lines);
    return buildOutline(tokenized);
}

function flatten(nodes, parentPath = '', out = []) {
    for (const node of nodes) {
        const p = parentPath ? `${parentPath}/${node.name}` : node.name;
        out.push({ node, path: p });
        flatten(node.children, p, out);
    }
    return out;
}

function validateRanges(nodes, parent) {
    for (const node of nodes) {
        const { range, selectionRange } = node;
        assert(
            range.start.line < selectionRange.start.line ||
                (range.start.line === selectionRange.start.line &&
                    range.start.character <= selectionRange.start.character),
            `${node.name}: selection starts before range`,
        );
        assert(
            range.end.line > selectionRange.end.line ||
                (range.end.line === selectionRange.end.line &&
                    range.end.character >= selectionRange.end.character),
            `${node.name}: selection ends after range`,
        );
        if (parent) {
            assert(
                range.start.line > parent.range.start.line ||
                    (range.start.line === parent.range.start.line &&
                        range.start.character >= parent.range.start.character),
                `${node.name}: starts before parent ${parent.name}`,
            );
            assert(
                range.end.line < parent.range.end.line ||
                    (range.end.line === parent.range.end.line &&
                        range.end.character <= parent.range.end.character),
                `${node.name}: ends after parent ${parent.name}`,
            );
        }
        validateRanges(node.children, node);
    }
}

async function main() {
    // ---- grammar scope regression -------------------------------------------
    // `#exists` is classified with the other value-producing directives as
    // `support.constant.directive`.
    {
        const tokenizer = new JaiTokenizer(grammarPath);
        const tokenized = await tokenizer.tokenizeLines(['#if #exists(main) {', '}']);
        const exists = tokenized[0].tokens.find((t) => t.text === '#exists');
        assert(exists, 'grammar: #exists token missing');
        assert(
            exists.scopes.includes('support.constant.directive.jai'),
            `grammar: #exists scope is ${exists.scopes.join(' ')}`,
        );
    }

    // ---- sample.jai ---------------------------------------------------------
    const sample = await outlineOf(path.join(__dirname, '..', 'examples', 'sample.jai'));
    const flat = flatten(sample);
    const byPath = new Map(flat.map((e) => [e.path, e.node]));
    const kindAt = (p) => byPath.get(p)?.kind;

    const expected = [
        ['PI', 'Constant'],
        ['global_counter', 'Variable'],
        ['Vector3', 'Struct'],
        ['Vector3/x', 'Field'],
        ['Point2/x', 'Field'],
        ['Point2/y', 'Field'],
        ['Array_Of/T', 'TypeParameter'],
        ['Array_Of/data', 'Field'],
        ['Entity/Transform', 'Struct'],
        ['Entity/Transform/rotation', 'Field'],
        ['State/FALLING', 'EnumMember'],
        ['Entity_Flags/ALIVE', 'EnumMember'],
        ['Shape/rect', 'Field'],
        ['Shape/rect/w', 'Field'],
        ['Shape/rect/h', 'Field'],
        ['Alias_Type', 'Interface'],
        ['add/a', 'Variable'],
        ['add/result', 'Variable'],
        ['apply/T', 'TypeParameter'],
        ['apply/fn', 'Variable'],
        ['operator *', 'Operator'],
        ['outer_procedure/helper', 'Function'],
        ['outer_procedure/helper/inner_helper', 'Function'],
        ['outer_procedure/handler', 'Function'],
        ['outer_procedure/handler/message', 'Variable'],
        ['outer_procedure/Local_Config/width', 'Field'],
        ['outer_procedure/i', 'Variable'],
        ['outer_procedure/text', 'Variable'],
        ['run_block_value', 'Variable'],
        ['run_block_count', 'Variable'],
        ['direct_run_value', 'Variable'],
        ['both_global_and_constant', 'Constant'],
        ['only_a_constant', 'Constant'],
        ['non_global_procedure', 'Function'],
    ];
    for (const [p, kind] of expected) {
        assert(byPath.has(p), `missing symbol: ${p}`);
        assert.strictEqual(kindAt(p), kind, `${p}: kind ${kindAt(p)} != ${kind}`);
    }

    // Calls and type references must never become symbols.
    const names = flat.map((e) => e.node.name);
    assert(!names.includes('print'), 'call "print" was outlined');
    assert.strictEqual(
        names.filter((n) => n === 'Vector3').length,
        1,
        'type reference "Vector3" was outlined more than the definition itself',
    );

    // ---- semantic categories (drive the jai.outline.show* settings) ---------
    const categoryAt = (p) => byPath.get(p)?.category;
    const expectedCategories = [
        ['PI', 'globalConstant'],
        ['global_counter', 'globalVariable'],
        ['Vector3', 'struct'],
        ['Vector3/x', 'field'],
        ['State/FALLING', 'enumMember'],
        ['Alias_Type', 'typeAlias'],
        ['add', 'globalProcedure'],
        ['add/a', 'parameter'],
        ['add/result', 'localVariable'],
        ['apply/T', 'typeParameter'],
        ['operator *', 'operatorOverload'],
        ['outer_procedure/helper', 'nonGlobalProcedure'],
        ['outer_procedure/i', 'loopVariable'],
        // #run at file scope is imperative: its declarations are locals,
        // whether block-bodied or directly prefixed (`#run x := ...;`).
        ['run_block_value', 'localVariable'],
        ['run_block_count', 'localVariable'],
        ['direct_run_value', 'localVariable'],
        // `::` is the constant-binding form, but scope is independent:
        // a file-scope constant is global, while a constant inside the
        // sample's #run block is non-global.
        ['both_global_and_constant', 'globalConstant'],
        ['only_a_constant', 'localConstant'],
        // A procedure directly inside a top-level #run block is
        // non-global, even though it is not nested inside another
        // procedure.
        ['non_global_procedure', 'nonGlobalProcedure'],
    ];
    for (const [p, category] of expectedCategories) {
        assert.strictEqual(
            categoryAt(p),
            category,
            `${p}: category ${categoryAt(p)} != ${category}`,
        );
    }

    // Filtering prunes hidden categories (with subtrees) without mutating the
    // original tree: hiding locals/loops/parameters leaves procedures and
    // globals; hiding non-global procedures leaves file-scope ones.
    const cleanPaths = (nodes) => new Map(flatten(nodes).map((e) => [e.path, e.node]));
    const noNoise = cleanPaths(
        filterOutlineSymbols(sample, {
            localVariable: false,
            loopVariable: false,
            parameter: false,
        }),
    );
    assert(noNoise.has('add'), 'filter: procedure lost');
    assert(noNoise.has('global_counter'), 'filter: global lost');
    assert(!noNoise.has('add/a'), 'filter: parameter not hidden');
    assert(!noNoise.has('add/result'), 'filter: local not hidden');
    assert(!noNoise.has('outer_procedure/i'), 'filter: loop variable not hidden');
    assert(!noNoise.has('run_block_value'), 'filter: #run block local not hidden');
    assert(!noNoise.has('direct_run_value'), 'filter: direct #run local not hidden');
    assert(byPath.has('add/a'), 'filter mutated the original tree');
    const noNonGlobalProcs = cleanPaths(
        filterOutlineSymbols(sample, { nonGlobalProcedure: false }),
    );
    assert(noNonGlobalProcs.has('outer_procedure'), 'filter: global procedure lost');
    assert(
        !noNonGlobalProcs.has('outer_procedure/helper'),
        'filter: non-global procedure inside a procedure not hidden',
    );
    assert(
        !noNonGlobalProcs.has('non_global_procedure'),
        'filter: non-global procedure inside #run not hidden',
    );
    assert(noNonGlobalProcs.has('main'), 'filter: global main lost');
    const noGlobalProcs = cleanPaths(
        filterOutlineSymbols(sample, { globalProcedure: false }),
    );
    assert(!noGlobalProcs.has('add'), 'filter: global procedure not hidden');
    assert(!noGlobalProcs.has('main'), 'filter: global main not hidden');
    assert(
        noGlobalProcs.has('non_global_procedure'),
        'filter: non-global procedure hidden with global procedures',
    );
    // Constant scope and binding form are independent filters: hiding
    // non-global constants must not hide the file-scope constant, and
    // hiding locals must not hide a non-global constant merely because it
    // is non-global.
    const noNonGlobalConstants = cleanPaths(
        filterOutlineSymbols(sample, { localConstant: false }),
    );
    assert(
        noNonGlobalConstants.has('both_global_and_constant'),
        'filter: global constant hidden with non-global constants',
    );
    assert(
        !noNonGlobalConstants.has('only_a_constant'),
        'filter: non-global constant not hidden with constants',
    );
    const noGlobalConstants = cleanPaths(
        filterOutlineSymbols(sample, { globalConstant: false }),
    );
    assert(
        !noGlobalConstants.has('both_global_and_constant'),
        'filter: global constant not hidden with global constants',
    );
    assert(
        noGlobalConstants.has('only_a_constant'),
        'filter: non-global constant hidden with global constants',
    );
    assert(
        noNoise.has('only_a_constant'),
        'filter: non-global constant hidden with local variables',
    );

    // Braces inside strings/comments/here-strings must not close a procedure:
    // outer_procedure must still contain the loop variable declared after them,
    // and the loop variable must span its whole body.
    const loopVar = byPath.get('outer_procedure/i');
    const text = byPath.get('outer_procedure/text');
    assert(loopVar.range.end.line > text.range.start.line, 'loop variable range truncated');

    validateRanges(sample);

    // ---- edge.jai -----------------------------------------------------------
    const edge = await outlineOf(path.join(__dirname, 'fixtures', 'edge.jai'));
    const edgeFlat = flatten(edge);
    const edgeByPath = new Map(edgeFlat.map((e) => [e.path, e.node]));
    const edgeExpected = [
        ['One_Line/alpha', 'Field'],
        ['One_Enum/FIRST', 'EnumMember'],
        ['One_Enum/SECOND', 'EnumMember'],
        ['One_Enum/THIRD', 'EnumMember'],
        ['multiline_proc/first', 'Variable'],
        ['multiline_proc/second', 'Variable'],
        ['multiline_proc/local_type/value', 'Field'],
        ['gap_proc', 'Function'],
        ['with_blocks/deep_local', 'Variable'],
        ['with_blocks/deep_proc', 'Function'],
        ['with_blocks/idx', 'Variable'],
        ['with_blocks/loop_local', 'Variable'],
        ['with_blocks/thing', 'Struct'],
        ['with_blocks/thing/inner_field', 'Field'],
        ['Drawable', 'Interface'],
        ['Drawable/draw', 'Function'],
    ];
    for (const [p, kind] of edgeExpected) {
        assert(edgeByPath.has(p), `edge: missing symbol: ${p}`);
        assert.strictEqual(
            edgeByPath.get(p).kind,
            kind,
            `edge ${p}: kind ${edgeByPath.get(p).kind} != ${kind}`,
        );
    }
    assert.strictEqual(edgeByPath.get('Drawable')?.category, 'interface');
    assert.strictEqual(
        edgeByPath.get('Drawable/draw')?.category,
        'nonGlobalProcedure',
        'interface member procedure should be non-global',
    );
    validateRanges(edge);

    // ---- backslash.jai: backslash-continued identifiers ----------------------
    // `left\_margin` is one identifier named `left_margin`, `free\   variable`
    // is `freevariable`, a trailing continuation (`short\    : int;`) is just
    // padding, and `Vector\ 3` is the struct `Vector3`.
    const bs = await outlineOf(path.join(__dirname, 'fixtures', 'backslash.jai'));
    const bsFlat = flatten(bs);
    const bsByPath = new Map(bsFlat.map((e) => [e.path, e.node]));
    const bsExpected = [
        ['left_margin', 'Variable'],
        ['freevariable', 'Variable'],
        ['short', 'Variable'],
        ['Vector3', 'Struct'],
        ['Vector3/x', 'Field'],
        ['makething', 'Function'],
        ['makething/inputvalue', 'Variable'],
        ['makething/localvalue', 'Variable'],
    ];
    for (const [p, kind] of bsExpected) {
        assert(bsByPath.has(p), `backslash: missing symbol: ${p}`);
        assert.strictEqual(
            bsByPath.get(p).kind,
            kind,
            `backslash ${p}: kind ${bsByPath.get(p).kind} != ${kind}`,
        );
    }
    // The fragments must not appear as symbols of their own.
    const bsNames = bsFlat.map((e) => e.node.name);
    for (const fragment of ['left', '_margin', 'free', 'variable', 'Vector', 'make', 'thing']) {
        assert(!bsNames.includes(fragment), `backslash: fragment outlined: ${fragment}`);
    }
    validateRanges(bs);

    // ---- directives.jai: #if is scope-transparent, #run is imperative -------
    // Jai's file scope is a *data scope*; #if/#else blocks create no scope of
    // their own, so declarations directly in a top-level branch are globals.
    // A #run block, however, executes imperative code at compile time, so its
    // declarations are locals even though no procedure encloses them. In
    // particular, build-script declarations such as options/args inside
    // `#run,stallable` must be localVariable, never globalVariable.
    const directives = await outlineOf(path.join(__dirname, 'fixtures', 'directives.jai'));
    const dirFlat = flatten(directives);
    const dirByPath = new Map(dirFlat.map((e) => [e.path, e.node]));
    const dirCategoryAt = (p) => dirByPath.get(p)?.category;
    const expectedDirectiveCategories = [
        // Build-script shape: declarations inside `#run,stallable { ... }`.
        ['options', 'localVariable'],
        ['args', 'localVariable'],
        ['main', 'globalProcedure'],
        ['main/args', 'localVariable'],
        // #if creates no scope: direct branch declarations stay global...
        ['conditional_global', 'globalVariable'],
        ['extra_global', 'globalVariable'],
        ['fallback_global', 'globalVariable'],
        // ...but everything inside a #run block is local, however nested.
        ['standalone_run_local', 'localVariable'],
        ['block_local', 'localVariable'],
        ['if_local', 'localVariable'],
        ['i', 'loopVariable'],
        ['loop_local', 'localVariable'],
        // The imperative scope ends with the #run block.
        ['after_run_global', 'globalVariable'],
        // `#run` as an *expression* does not change the declaration's scope.
        ['computed_global', 'globalVariable'],
        ['after_computed_global', 'globalVariable'],
        // `#run` directly prefixing a declaration (no block) makes it a local.
        ['direct_run_local', 'localVariable'],
        ['direct_typed_local', 'localVariable'],
        ['direct_a', 'localVariable'],
        ['direct_b', 'localVariable'],
        ['after_direct_global', 'globalVariable'],
        // Value-producing `#run -> Type { ... }` block.
        ['PI_VALUE', 'globalConstant'],
        ['pi_local', 'localVariable'],
        ['RUN_RESULT', 'globalConstant'],
        ['run_lambda_local', 'localVariable'],
        // #if inside a struct stays a field scope.
        ['Conditional_Type/enabled_field', 'field'],
        ['Conditional_Type/fallback_field', 'field'],
        ['compute_value', 'globalProcedure'],
    ];
    for (const [p, category] of expectedDirectiveCategories) {
        assert(dirByPath.has(p), `directives: missing symbol: ${p}`);
        assert.strictEqual(
            dirCategoryAt(p),
            category,
            `directives ${p}: category ${dirCategoryAt(p)} != ${category}`,
        );
    }
    // User-visible consequence: hiding locals hides the #run temporaries but
    // keeps the genuine globals declared in #if branches.
    const noLocals = new Map(
        flatten(filterOutlineSymbols(directives, { localVariable: false })).map((e) => [
            e.path,
            e.node,
        ]),
    );
    assert(!noLocals.has('options'), 'directives filter: #run local not hidden with locals');
    assert(!noLocals.has('pi_local'), 'directives filter: #run -> block local not hidden');
    assert(!noLocals.has('direct_run_local'), 'directives filter: direct #run declaration not hidden with locals');
    assert(noLocals.has('conditional_global'), 'directives filter: #if global lost');
    assert(noLocals.has('after_direct_global'), 'directives filter: global after direct #run lost');
    validateRanges(directives);

    console.log(
        `outline.check: OK (sample: ${flat.length} symbols, edge: ${edgeFlat.length} symbols, backslash: ${bsFlat.length} symbols, directives: ${dirFlat.length} symbols)`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
