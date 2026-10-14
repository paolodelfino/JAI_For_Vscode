/**
 * Headless regression check for workspace-wide symbols (Ctrl+T).
 * Run with: npm test   (compiles first, then runs this file)
 *
 * Exercises the VS Code-free pieces: query matcher, outline flattening, and
 * the real worker-thread pool (tokenizer + outline off the main thread).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    flattenWorkspaceSymbols,
    matchesWorkspaceSymbolQuery,
} = require('../out/workspaceSymbolCore');
const { WorkspaceWorkerPool } = require('../out/workspaceWorkerPool');
const { JaiTokenizer } = require('../out/tokenizer');
const { buildOutline } = require('../out/outline');

const grammarPath = path.join(__dirname, '..', 'syntaxes', 'jai.tmLanguage.json');
const workerScript = path.join(__dirname, '..', 'out', 'workspaceWorker.js');

async function main() {
    // ---- query matcher: relaxed subsequence, case-insensitive ----------------
    assert.strictEqual(matchesWorkspaceSymbolQuery('Vector3', ''), true);
    assert.strictEqual(matchesWorkspaceSymbolQuery('Vector3', 'vec'), true);
    assert.strictEqual(matchesWorkspaceSymbolQuery('Vector3', 'v3'), true);
    assert.strictEqual(matchesWorkspaceSymbolQuery('Vector3', 'V3'), true);
    assert.strictEqual(matchesWorkspaceSymbolQuery('hello_world', 'hw'), true);
    assert.strictEqual(matchesWorkspaceSymbolQuery('Vector3', 'xyz'), false);
    assert.strictEqual(matchesWorkspaceSymbolQuery('Vector3', '3v'), false);

    // ---- flattening preserves container paths --------------------------------
    const sample = fs.readFileSync(path.join(__dirname, '..', 'examples', 'sample.jai'), 'utf8');
    const tokenizer = new JaiTokenizer(grammarPath);
    const tokenized = await tokenizer.tokenizeLines(sample.split('\n'));
    const records = flattenWorkspaceSymbols(buildOutline(tokenized));
    const byName = (name) => records.filter((r) => r.name === name);
    assert.strictEqual(byName('Vector3')[0].containerName, '');
    assert.strictEqual(byName('x').find((r) => r.containerName === 'Vector3').kind, 'Field');
    assert.strictEqual(byName('helper')[0].containerName, 'outer_procedure');
    assert.strictEqual(byName('helper')[0].category, 'nonGlobalProcedure');
    assert.strictEqual(byName('non_global_procedure')[0].category, 'nonGlobalProcedure');
    assert(byName('global_counter')[0].category === 'globalVariable');

    // ---- worker pool: same records as the main thread, per file --------------
    const backslash = fs.readFileSync(path.join(__dirname, 'fixtures', 'backslash.jai'), 'utf8');
    const pool = new WorkspaceWorkerPool(workerScript, grammarPath, 2);
    try {
        const results = await pool.run([
            { uri: 'file:///sample.jai', text: sample },
            { uri: 'file:///backslash.jai', text: backslash },
            { uri: 'file:///dup.jai', text: 'Dup :: struct { a: int; }\n' },
        ]);
        assert.strictEqual(results.length, 3);
        const sampleResult = results.find((r) => r.uri === 'file:///sample.jai');
        assert(!sampleResult.error, `worker sample error: ${sampleResult.error}`);
        assert.deepStrictEqual(sampleResult.records, records);
        const bsResult = results.find((r) => r.uri === 'file:///backslash.jai');
        assert(bsResult.records.some((r) => r.name === 'left_margin'));
        assert(bsResult.records.some((r) => r.name === 'freevariable'));
        const dupResult = results.find((r) => r.uri === 'file:///dup.jai');
        assert.strictEqual(dupResult.records[0].name, 'Dup');
        assert.strictEqual(dupResult.records[1].containerName, 'Dup');

        // A second batch reuses the same workers.
        const again = await pool.run([{ uri: 'file:///again.jai', text: 'Again :: 1;\n' }]);
        assert.strictEqual(again[0].records[0].name, 'Again');
    } finally {
        await pool.dispose();
    }

    // ---- a pool that cannot start its worker rejects (manager falls back) -----
    const broken = new WorkspaceWorkerPool(
        path.join(__dirname, '..', 'out', 'does-not-exist.js'),
        grammarPath,
        1,
    );
    await assert.rejects(() => broken.run([{ uri: 'file:///x.jai', text: 'x :: 1;\n' }]));
    await broken.dispose();

    console.log('workspace.check: OK');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
