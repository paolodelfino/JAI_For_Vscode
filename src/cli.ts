/**
 * Headless token dump — runs the exact same tokenizer as the extension,
 * without VS Code. Useful to generate a token stream for analysis:
 *
 *   node ./out/cli.js examples/sample.jai                 # print token dump to stdout
 *   node ./out/cli.js examples/sample.jai --out dump       # write dump.tokens.txt + dump.tokens.json
 *   node ./out/cli.js examples/sample.jai --outline        # print the reconstructed outline tree
 */
import * as fs from 'fs';
import * as path from 'path';
import { JaiTokenizer } from './tokenizer';
import { formatTokenDump, tokenDumpToJson } from './tokenDump';
import { buildOutline, type OutlineSymbolNode } from './outline';

function printOutline(nodes: OutlineSymbolNode[], indent: string, out: string[]): void {
    for (const node of nodes) {
        const range = `${node.range.start.line + 1}:${node.range.start.character}-${node.range.end.line + 1}:${node.range.end.character}`;
        out.push(
            `${indent}${node.name}  [${node.kind}]${node.detail ? `  ${node.detail}` : ''}  (${range})`,
        );
        printOutline(node.children, `${indent}  `, out);
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith('--'));
    const outFlagIndex = args.indexOf('--out');
    const outPrefix = outFlagIndex >= 0 ? args[outFlagIndex + 1] : undefined;

    if (!file) {
        console.error('Usage: node ./out/cli.js <file.jai> [--outline | --out <prefix>]');
        process.exitCode = 1;
        return;
    }

    const grammarPath = path.join(__dirname, '..', 'syntaxes', 'jai.tmLanguage.json');
    const tokenizer = new JaiTokenizer(grammarPath);

    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    // A trailing newline produces a final empty line that is not a real line.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }

    const tokenized = await tokenizer.tokenizeLines(lines);

    if (args.includes('--outline')) {
        const out: string[] = [];
        printOutline(buildOutline(tokenized), '', out);
        process.stdout.write(`${out.join('\n')}\n`);
        return;
    }

    const tokenCount = tokenized.reduce((n, l) => n + l.tokens.length, 0);
    const header = {
        // Keep the path as supplied so generated dumps are reproducible
        // across machines instead of embedding a local absolute path.
        source: file,
        trigger: 'cli: node ./out/cli.js',
        lineCount: lines.length,
        tokenCount,
    };

    if (outPrefix) {
        fs.writeFileSync(`${outPrefix}.tokens.txt`, formatTokenDump(tokenized, header), 'utf8');
        fs.writeFileSync(`${outPrefix}.tokens.json`, tokenDumpToJson(tokenized, header), 'utf8');
        console.error(`Wrote ${outPrefix}.tokens.txt and ${outPrefix}.tokens.json`);
    } else {
        process.stdout.write(formatTokenDump(tokenized, header));
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
