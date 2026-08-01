// Turn a laid-out graph into paintable cells. No colours, no escape codes: the
// terminal and the webview each paint the same cells their own way.

import type { Graph, Node } from './parse.ts';
import type { Laid, Row } from './layout.ts';

export interface Cell {
  ch: string;
  /** lane index the glyph belongs to, or -1 for connector filler */
  lane: number;
}

export interface RenderRow {
  cells: Cell[];
  /** node rows only */
  node?: Node;
  col: number;
  head?: Row['head'];
  headFrom?: string;
}

export const UNICODE = {
  node: '●',
  retry: '○',
  ckpt: '◆',
  bar: '│',
  tee: '├',
  mid: '┬',
  end: '┐',
  fill: '─',
  dash: '┈',
  cross: '┼',
};

export const ASCII = {
  node: '*',
  retry: 'o',
  ckpt: '#',
  bar: '|',
  tee: '+',
  mid: '+',
  end: '+',
  fill: '-',
  dash: '.',
  cross: '+',
};

export type Glyphs = typeof UNICODE;

/** The run leading to a target is dotted for a rewind, solid for a branch. */
function fillFor(row: Row, c: number, G: Glyphs): string {
  let kind: 'branch' | 'retry' | 'abandoned' = 'branch';
  let best = Infinity;
  row.to!.forEach((t, i) => {
    if (t > c && t < best) {
      best = t;
      kind = row.toKind?.[i] ?? 'branch';
    }
  });
  return kind === 'branch' ? G.fill : G.dash;
}

/**
 * @param cut  index of the first row to draw; rows above it are outside the window
 */
export function render(g: Graph, laid: Laid, cut = 0, G: Glyphs = UNICODE): RenderRow[] {
  const { width, edges } = laid;
  const rows = laid.rows.slice(cut);

  // A lane's line runs from just below the parent row down to the child row.
  const occupied: Set<number>[] = rows.map(() => new Set<number>());
  for (const e of edges) {
    const to = e.toRow === -1 ? laid.rows.length - 1 : e.toRow;
    for (let r = Math.max(e.fromRow + 1, cut); r <= to; r++) occupied[r - cut]?.add(e.col);
  }

  return rows.map((row, r) => {
    const last = row.kind === 'fan' ? Math.max(...row.to!) : -1;
    const cells: Cell[] = [];
    for (let c = 0; c < width; c++) {
      const live = occupied[r].has(c);
      if (row.kind === 'node' && c === row.col) {
        const n = g.nodes.get(row.id!)!;
        // A dead end owns no lane: it hangs off its parent as a stub.
        if (row.head === 'abandoned') cells.push({ ch: G.tee, lane: c });
        else cells.push({ ch: n.ckpt ? G.ckpt : row.head === 'retry' ? G.retry : G.node, lane: c });
      } else if (row.kind === 'fan' && c === row.col) cells.push({ ch: G.tee, lane: c });
      else if (row.kind === 'fan' && c === last) cells.push({ ch: G.end, lane: c });
      else if (row.kind === 'fan' && row.to!.includes(c)) cells.push({ ch: G.mid, lane: c });
      else if (row.kind === 'fan' && c > row.col && c < last)
        cells.push(live ? { ch: G.cross, lane: c } : { ch: fillFor(row, c, G), lane: -1 });
      else cells.push({ ch: live ? G.bar : ' ', lane: live ? c : -1 });

      // Gap column. Emitted for the last lane too, so a stub in the rightmost
      // lane still has somewhere to draw its marker.
      if (row.kind === 'node' && row.head === 'abandoned' && c === row.col)
        cells.push({ ch: g.nodes.get(row.id!)!.ckpt ? G.ckpt : G.retry, lane: c });
      else if (c < width - 1)
        cells.push(
          row.kind === 'fan' && c >= row.col && c < last
            ? { ch: fillFor(row, c, G), lane: -1 }
            : { ch: ' ', lane: -1 },
        );
    }
    return {
      cells,
      node: row.kind === 'node' ? g.nodes.get(row.id!)! : undefined,
      col: row.col,
      head: row.head,
      headFrom: row.headFrom,
    };
  });
}

/** Index of the first row to draw so that only the last `limit` main turns show. */
export function windowStart(g: Graph, laid: Laid, session: string, limit: number): number {
  const main = laid.rows
    .map((r, i) => [r, i] as const)
    .filter(([r]) => r.kind === 'node' && g.nodes.get(r.id!)!.session === session);
  return main.length > limit ? main[main.length - limit][1] : 0;
}
