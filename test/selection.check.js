/**
 * Headless regression check for Smart Select ranges and the extension
 * manifest/settings they depend on.
 * Run with: npm test   (compiles first, then runs this file)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JaiTokenizer } = require('../out/tokenizer');
const { buildOutline, normalizedIdentifierText, splitIdentifierSegments } = require('../out/outline');
const { buildSelectionRanges, splitIdentifierParts } = require('../out/selectionRanges');

const grammarPath = path.join(__dirname, '..', 'syntaxes', 'jai.tmLanguage.json');
const tokenizer = new JaiTokenizer(grammarPath);

async function rangesFor(source, position) {
    const lines = source.split('\n');
    const tokenized = await tokenizer.tokenizeLines(lines);
    const outline = buildOutline(tokenized);
    return { ranges: buildSelectionRanges(tokenized, outline, position), lines };
}

function texts(ranges, lines) {
    return ranges.map((r) => {
        if (r.start.line === r.end.line) {
            return lines[r.start.line].substring(r.start.character, r.end.character);
        }
        const parts = [];
        for (let ln = r.start.line; ln <= r.end.line; ln++) {
            if (ln === r.start.line) parts.push(lines[ln].substring(r.start.character));
            else if (ln === r.end.line) parts.push(lines[ln].substring(0, r.end.character));
            else parts.push(lines[ln]);
        }
        return parts.join('\n');
    });
}

async function main() {
    // ---- manifest contributes no commands or menus ----------------------------
    const pkg = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    );
    assert.strictEqual(pkg.contributes.commands, undefined, 'commands still contributed');
    assert.strictEqual(pkg.contributes.menus, undefined, 'menus still contributed');

    // ---- outline visibility settings are contributed -------------------------
    const props = pkg.contributes.configuration?.properties ?? {};
    const expectedSettings = [
        ['showGlobalProcedures', true],
        ['showNonGlobalProcedures', true],
        ['showOperatorOverloads', true],
        ['showStructs', true],
        ['showEnums', true],
        ['showEnumMembers', true],
        ['showStructFields', false],
        ['showConstants', true],
        ['showGlobalConstants', true],
        ['showGlobalVariables', true],
        ['showLocalVariables', false],
        ['showLoopVariables', false],
        ['showParameters', false],
        ['showTypeParameters', false],
        ['showInterfaces', true],
        ['showTypeAliases', true],
    ];
    for (const [suffix, expectedDefault] of expectedSettings) {
        const key = `jai.outline.${suffix}`;
        assert(props[key], `missing setting: ${key}`);
        assert.strictEqual(props[key].type, 'boolean', `${key}: not boolean`);
        assert.strictEqual(
            props[key].default,
            expectedDefault,
            `${key}: default should be ${expectedDefault}`,
        );
        assert.strictEqual(
            props[key].scope,
            'language-overridable',
            `${key}: should be language-overridable`,
        );
    }
    assert(!props['jai.outline.showProcedures'], 'old showProcedures setting remains');
    assert(
        !props['jai.outline.showNestedProcedures'],
        'old showNestedProcedures setting remains',
    );

    // ---- workspace symbol settings + activation -------------------------------
    assert.strictEqual(props['jai.workspaceSymbols.enabled']?.default, true);
    assert.strictEqual(props['jai.workspaceSymbols.enabled']?.scope, 'resource');
    assert.strictEqual(props['jai.workspaceSymbols.maxWorkers']?.default, 0);
    assert.strictEqual(props['jai.workspaceSymbols.maxWorkers']?.scope, 'window');
    assert.strictEqual(props['jai.workspaceSymbols.maxFileSizeKiB']?.default, 0);
    assert.strictEqual(props['jai.workspaceSymbols.maxFileSizeKiB']?.minimum, 0);
    assert.deepStrictEqual(props['jai.workspaceSymbols.exclude']?.default, []);
    assert(
        pkg.activationEvents.includes('workspaceContains:**/*.jai'),
        'workspace symbols must be reachable before any Jai file is opened',
    );

    // ---- identifier splitting --------------------------------------------------
    const partTexts = (w) => splitIdentifierParts(w).map((p) => p.text);
    assert.deepStrictEqual(partTexts('hello_world'), ['hello', '_', 'world']);
    assert.deepStrictEqual(partTexts('helloWorld'), ['hello', 'World']);
    assert.deepStrictEqual(partTexts('HelloWorld'), ['Hello', 'World']);
    assert.deepStrictEqual(partTexts('HTTPServer'), ['HTTP', 'Server']);
    assert.deepStrictEqual(partTexts('HELLO_WORLD'), ['HELLO', '_', 'WORLD']);
    // Digits attach to the characters before them and never form their own
    // part (unless a separator puts them at the start of one).
    assert.deepStrictEqual(partTexts('float32'), ['float32']);
    assert.deepStrictEqual(partTexts('Vector3'), ['Vector3']);
    assert.deepStrictEqual(partTexts('Matrix4x4'), ['Matrix4x4']);
    assert.deepStrictEqual(partTexts('version_2'), ['version', '_', '2']);
    assert.deepStrictEqual(partTexts('a'), ['a']);

    // ---- snake_case sub-selection ---------------------------------------------
    {
        const source = 'hello_world :: 42;';
        // Cursor inside "hello"
        let { ranges, lines } = await rangesFor(source, { line: 0, character: 2 });
        let t = texts(ranges, lines);
        assert.strictEqual(t[0], 'hello', `hello part: got ${JSON.stringify(t.slice(0, 3))}`);
        assert.strictEqual(t[1], 'hello_world', `whole ident: got ${JSON.stringify(t.slice(0, 3))}`);
        // Caret between "hello" and "_" belongs to the part on its left.
        ({ ranges, lines } = await rangesFor(source, { line: 0, character: 5 }));
        t = texts(ranges, lines);
        assert.strictEqual(t[0], 'hello', `left part at boundary: got ${JSON.stringify(t.slice(0, 3))}`);
        assert.strictEqual(t[1], 'hello_world');
        // Caret between "_" and "world" belongs to the "_" part.
        ({ ranges, lines } = await rangesFor(source, { line: 0, character: 6 }));
        t = texts(ranges, lines);
        assert.strictEqual(t[0], '_', `underscore part: got ${JSON.stringify(t.slice(0, 3))}`);
        assert.strictEqual(t[1], 'hello_world');
        // Cursor inside "world"
        ({ ranges, lines } = await rangesFor(source, { line: 0, character: 8 }));
        t = texts(ranges, lines);
        assert.strictEqual(t[0], 'world', `world part: got ${JSON.stringify(t.slice(0, 3))}`);
        assert.strictEqual(t[1], 'hello_world');

        // Boundary case: global|<cursor>_name must select `global`, not `_`.
        const global = 'global_name := "mutable global";';
        const g = await rangesFor(global, { line: 0, character: 6 });
        const gt = texts(g.ranges, g.lines);
        assert.strictEqual(gt[0], 'global', `global|_name: got ${JSON.stringify(gt.slice(0, 3))}`);
        assert.strictEqual(gt[1], 'global_name');
    }

    // ---- trailing digits attach to the identifier ----------------------------
    {
        const source = 'p: Vector3;';
        // Cursor at the very start of `Vector3` must select all of it,
        // not `Vector` with the `3` left over.
        let { ranges, lines } = await rangesFor(source, { line: 0, character: 3 });
        let t = texts(ranges, lines);
        assert.strictEqual(t[0], 'Vector3', `<cursor>Vector3: got ${JSON.stringify(t.slice(0, 3))}`);
        assert(!t.includes('Vector'), `bare Vector part leaked: ${JSON.stringify(t)}`);
        // Cursor on the digit itself also selects the whole identifier.
        ({ ranges, lines } = await rangesFor(source, { line: 0, character: 9 }));
        t = texts(ranges, lines);
        assert.strictEqual(t[0], 'Vector3', `cursor on digit: got ${JSON.stringify(t.slice(0, 3))}`);
    }

    // ---- backslash-continued identifiers -------------------------------------
    {
        // The compiler-visible name drops `\` and the padding spaces.
        assert.strictEqual(normalizedIdentifierText('left\\_margin'), 'left_margin');
        assert.strictEqual(normalizedIdentifierText('free\\   variable'), 'freevariable');
        assert.strictEqual(normalizedIdentifierText('short\\   '), 'short');
        assert.deepStrictEqual(
            splitIdentifierSegments('free\\   variable').map((s) => s.text),
            ['free', 'variable'],
        );

        const source = ['free\\   variable := 2;', 'left\\_margin := 1;'].join('\n');
        const lines0 = source.split('\n');
        // Cursor in either segment — or in the padding gap — selects the
        // whole raw identifier first (`freevariable` is a single part).
        for (const ch of [2, lines0[0].indexOf('variable') + 2, 6]) {
            const { ranges, lines } = await rangesFor(source, { line: 0, character: ch });
            const t = texts(ranges, lines);
            assert.strictEqual(
                t[0],
                'free\\   variable',
                `continued ident @${ch}: got ${JSON.stringify(t.slice(0, 3))}`,
            );
            assert(!t.includes('variable'), `segment leaked as its own range @${ch}`);
        }
        // Parts are computed on the normalized name (`left_margin`) and
        // mapped back: cursor in `margin` selects `margin`, then the whole
        // raw identifier including the backslash.
        const marginCol = lines0[1].indexOf('margin') + 2;
        const m = await rangesFor(source, { line: 1, character: marginCol });
        const tm = texts(m.ranges, m.lines);
        assert.strictEqual(tm[0], 'margin', `margin part: got ${JSON.stringify(tm.slice(0, 3))}`);
        assert.strictEqual(tm[1], 'left\\_margin', `whole continued ident: got ${JSON.stringify(tm.slice(0, 3))}`);
        // Caret just after the `_` selects the `_` part (left-belonging rule).
        const u = await rangesFor(source, { line: 1, character: lines0[1].indexOf('_') + 1 });
        const tu = texts(u.ranges, u.lines);
        assert.strictEqual(tu[0], '_', `underscore part: got ${JSON.stringify(tu.slice(0, 3))}`);
        assert.strictEqual(tu[1], 'left\\_margin');
    }

    // ---- composite literal members ----------------------------------------------
    {
        const source = [
            'operator * :: (a: Vector3, s: float) -> Vector3 {',
            '    return .{a.x * s, a.y * s, a.z * s};',
            '}',
        ].join('\n');
        const line1 = source.split('\n')[1];
        // Cursor on the first member's `a`
        const aCol = line1.indexOf('a.x');
        const { ranges, lines } = await rangesFor(source, { line: 1, character: aCol + 1 });
        const t = texts(ranges, lines);
        const memberIdx = t.indexOf('a.x * s');
        const allIdx = t.indexOf('a.x * s, a.y * s, a.z * s');
        const literalIdx = t.indexOf('.{a.x * s, a.y * s, a.z * s}');
        assert(t.includes('a.x'), `member chain missing: ${JSON.stringify(t)}`);
        assert(memberIdx >= 0, `first member missing: ${JSON.stringify(t)}`);
        assert(allIdx > memberIdx, `members must expand after first member: ${JSON.stringify(t)}`);
        assert(literalIdx > allIdx, `literal must expand after members: ${JSON.stringify(t)}`);
        // Cursor on the second member's `y` -> its own segment first
        const yCol = line1.indexOf('a.y') + 2;
        const second = await rangesFor(source, { line: 1, character: yCol });
        const t2 = texts(second.ranges, second.lines);
        assert(t2.includes('a.y'), `second member chain: ${JSON.stringify(t2)}`);
        assert(t2.includes('a.y * s'), `second member segment: ${JSON.stringify(t2)}`);
        assert(
            t2.indexOf('a.y * s') < t2.indexOf('a.x * s, a.y * s, a.z * s'),
            `second member before all: ${JSON.stringify(t2)}`,
        );

        // Cursor in the gap right after the first comma must NOT produce a
        // cross-member range like `s, a.y`; the first expansion is the whole
        // member list (the contents of the braces).
        const commaCol = line1.indexOf(', a.y');
        const gap = await rangesFor(source, { line: 1, character: commaCol + 1 });
        const tg = texts(gap.ranges, gap.lines);
        assert(!tg.includes('s, a.y'), `cross-member range leaked: ${JSON.stringify(tg)}`);
        assert.strictEqual(
            tg[0],
            'a.x * s, a.y * s, a.z * s',
            `gap cursor first selection: ${JSON.stringify(tg.slice(0, 3))}`,
        );
    }

    // ---- chain validity: every range strictly contains the previous --------------
    {
        const source = [
            'main :: () {',
            '    value := compute_something(first_value, second_value + 2);',
            '}',
        ].join('\n');
        const line1 = source.split('\n')[1];
        const col = line1.indexOf('first_value') + 3;
        const { ranges } = await rangesFor(source, { line: 1, character: col });
        for (let i = 1; i < ranges.length; i++) {
            const prev = ranges[i - 1];
            const cur = ranges[i];
            const contains =
                (cur.start.line < prev.start.line ||
                    (cur.start.line === prev.start.line &&
                        cur.start.character <= prev.start.character)) &&
                (cur.end.line > prev.end.line ||
                    (cur.end.line === prev.end.line && cur.end.character >= prev.end.character));
            assert(contains, `range ${i} does not contain range ${i - 1}`);
            const equal =
                cur.start.line === prev.start.line &&
                cur.start.character === prev.start.character &&
                cur.end.line === prev.end.line &&
                cur.end.character === prev.end.character;
            assert(!equal, `duplicate range at ${i}`);
        }
        const t = texts(ranges, source.split('\n'));
        assert(t.includes('first'), `subword of arg: ${JSON.stringify(t)}`);
        assert(t.includes('first_value'), `arg identifier: ${JSON.stringify(t)}`);
        assert(t.includes('first_value, second_value + 2'), `all args: ${JSON.stringify(t)}`);
    }

    console.log('selection.check: OK');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
