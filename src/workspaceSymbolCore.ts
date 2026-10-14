import type { OutlineCategory, OutlineKindName, OutlineSymbolNode } from './outline';

/**
 * One flattened workspace symbol (Ctrl+T / "Go to Symbol in Workspace").
 *
 * The document outline is a tree; workspace search is a flat list, so the
 * nesting survives only as `containerName` (the ancestor path, e.g.
 * `outer_procedure/helper` for the `helper` symbol itself). Only these flat
 * records are retained in the workspace index — token streams and outline
 * trees are discarded after indexing, which keeps memory bounded.
 */
export interface WorkspaceSymbolRecord {
    name: string;
    kind: OutlineKindName;
    category: OutlineCategory;
    containerName: string;
    selectionRange: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
}

/** Flatten an outline tree into workspace symbol records, preserving ancestor paths. */
export function flattenWorkspaceSymbols(
    nodes: OutlineSymbolNode[],
    containerName = '',
    out: WorkspaceSymbolRecord[] = [],
): WorkspaceSymbolRecord[] {
    for (const node of nodes) {
        out.push({
            name: node.name,
            kind: node.kind,
            category: node.category,
            containerName,
            selectionRange: {
                start: { ...node.selectionRange.start },
                end: { ...node.selectionRange.end },
            },
        });
        const childContainer = containerName ? `${containerName}/${node.name}` : node.name;
        flattenWorkspaceSymbols(node.children, childContainer, out);
    }
    return out;
}

/**
 * Relaxed workspace-symbol matching, per the VS Code API guidance: the query
 * matches when its characters appear in order in the candidate name
 * (case-insensitive). VS Code applies its own scoring/highlighting to what
 * we return, so strict prefix/substring matching would wrongly hide hits
 * like `v3` for `Vector3`... (subsequence: v, then 3).
 */
export function matchesWorkspaceSymbolQuery(name: string, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
        return true;
    }
    const n = name.toLowerCase();
    let qi = 0;
    for (let i = 0; i < n.length && qi < q.length; i++) {
        if (n[i] === q[qi]) {
            qi++;
        }
    }
    return qi === q.length;
}
