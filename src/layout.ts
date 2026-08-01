// Lane layout, `git log --graph` style.
//
// A session's main line runs straight down one lane. A lane splits only where
// the history actually diverged:
//   - a rewind: the abandoned continuation moves to its own lane
//   - a fork:   the new session gets its own lane
// The line that carried the session forward keeps the lane, so the trunk never
// drifts sideways.

import type { Graph } from './parse.ts';

export interface Row {
  kind: 'node' | 'fan';
  id?: string;
  col: number;
  /** node rows that open a diverging line: why it diverged */
  head?: 'branch' | 'retry' | 'abandoned';
  /** node id the line diverged from, as drawn -- the nearest visible ancestor */
  headFrom?: string;
  /** fan rows: lanes the diverging lines start in, and why each diverged */
  to?: number[];
  toKind?: ('branch' | 'retry' | 'abandoned')[];
}

export interface Edge {
  fromRow: number;
  toRow: number;
  col: number;
}

export interface Laid {
  rows: Row[];
  edges: Edge[];
  width: number;
  /** session -> lanes it occupies, first one is its main line */
  lanes: Map<string, number[]>;
}

/** Nearest kept descendants of `id`. */
export function displayKids(g: Graph, keep: Set<string>, id: string): string[] {
  const out: string[] = [];
  const walk = (kid: string) => {
    if (keep.has(kid)) return void out.push(kid);
    for (const k of g.nodes.get(kid)!.kids) walk(k);
  };
  for (const k of g.nodes.get(id)!.kids) walk(k);
  return out;
}

/** `deadEnds` draws rewinds that were dropped after one turn; off by default. */
export function layout(g: Graph, keep: Set<string>, root: string, deadEnds = false): Laid {
  const rows: Row[] = [];
  const edges: Edge[] = [];
  const lanes: (string | null)[] = [root]; // col -> node waiting to be emitted
  const pending = new Map<string, Edge>();
  const used = new Map<string, number[]>();
  const headKind = new Map<string, 'branch' | 'retry' | 'abandoned'>();
  const headFrom = new Map<string, string>();

  const sizes = new Map<string, number>();
  const subtree = (id: string): number => {
    const hit = sizes.get(id);
    if (hit !== undefined) return hit;
    sizes.set(id, 1); // cycle guard
    let n = 1;
    for (const k of g.nodes.get(id)!.kids) n += subtree(k);
    sizes.set(id, n);
    return n;
  };

  // Reuse a lane once its line has ended, the way Git Graph compacts columns:
  // with vertical lines and one colour per session, a freed column never reads
  // as a continuation of what used to be there.
  const newLane = (): number => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && !live.has(i)) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  const kept = new Map<string, number>();
  const keptSize = (id: string): number => {
    const hit = kept.get(id);
    if (hit !== undefined) return hit;
    kept.set(id, 1);
    let n = keep.has(id) ? 1 : 0;
    for (const k of g.nodes.get(id)!.kids) n += keptSize(k);
    kept.set(id, n);
    return n;
  };

  // Columns still owed a node further down; those are not free to hand out.
  const live = new Set<number>();

  const ts = (id: string) => g.nodes.get(id)!.ts;

  for (;;) {
    let col = -1;
    for (let i = 0; i < lanes.length; i++) {
      const id = lanes[i];
      if (id === null) continue;
      if (col === -1 || ts(id) < ts(lanes[col]!)) col = i;
    }
    if (col === -1) break;

    const id = lanes[col]!;
    const node = g.nodes.get(id)!;
    const nodeRow = rows.length;
    rows.push({ kind: 'node', id, col, head: headKind.get(id), headFrom: headFrom.get(id) });
    const seen = used.get(node.session) ?? [];
    if (!seen.includes(col)) used.set(node.session, [...seen, col]);

    const e = pending.get(id);
    if (e) {
      e.toRow = nodeRow;
      pending.delete(id);
    }
    live.delete(col);

    // The session's own continuation keeps the lane; a forked session never
    // steals it, however large its subtree grows.
    const kids = displayKids(g, keep, id).sort((a, b) => {
      const sa = g.nodes.get(a)!.session === node.session ? 0 : 1;
      const sb = g.nodes.get(b)!.session === node.session ? 0 : 1;
      return sa - sb || subtree(b) - subtree(a);
    });

    lanes[col] = null;
    const kidCols: number[] = [];
    const diverged: number[] = [];
    const divergedKind: ('branch' | 'retry' | 'abandoned')[] = [];
    const dropped: string[] = [];
    kids.forEach((k, i) => {
      // A fork keeps its own lane even as an only child: by the time a session
      // forks, the parent session's own line has often already ended, so there
      // is no fanout to give the split away.
      const sameSession = g.nodes.get(k)!.session === node.session;
      // Same session = the user rewound and sent again; a different session =
      // a branch session started here. A rewind whose line stops right there
      // was thrown away; one that kept going is a real second thread.
      const why = !sameSession ? 'branch' : keptSize(k) > 1 ? 'retry' : 'abandoned';
      // A dead end is one row long. Giving it a column of its own widens the
      // graph for a line that goes nowhere, so draw it inline under the node it
      // split from.
      // Only a diverging line can be a dead end -- the child that carries the
      // lane forward is the conversation itself, however short it is.
      const continues = i === 0 && sameSession;
      if (why === 'abandoned' && !continues) {
        dropped.push(k);
        return;
      }
      const c = continues ? col : newLane();
      if (c !== col) {
        diverged.push(c);
        divergedKind.push(why);
        headKind.set(k, why);
        headFrom.set(k, id);
      }
      lanes[c] = k;
      live.add(c);
      const edge: Edge = { fromRow: nodeRow, toRow: -1, col: c };
      edges.push(edge);
      pending.set(k, edge);
      kidCols.push(c);
    });
    if (diverged.length) rows.push({ kind: 'fan', col, to: diverged, toKind: divergedKind });
    // Dead-end stubs come after the real branches so the trunk stays readable.
    if (deadEnds) for (const k of dropped) rows.push({ kind: 'node', id: k, col, head: 'abandoned', headFrom: id });
  }

  // Columns are recycled, so a lane is not a session and cannot carry its
  // colour -- `used` is kept only to list which columns a session passed
  // through. Renderers colour by the session of the node itself.
  for (const [s, cols] of used) used.set(s, [...new Set(cols)].sort((a, b) => a - b));

  return { rows, edges, width: lanes.length, lanes: used };
}
