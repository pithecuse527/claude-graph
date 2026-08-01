// The graph as it appears in the sidebar: a session picker on top, then a Git
// Graph style strip -- curved lane connectors in a fixed-width column, one row
// per turn. Our own topology (retries, branch sessions, checkpoints) drives it.

import type { Graph, Node } from './parse.ts';
import type { Laid } from './layout.ts';

const ROW = 24; // px per turn, matches the row height
const LANE = 13; // px between lanes
const PAD = 11; // px before the first lane

// Git Graph's lane palette.
const COLORS = ['#0085d9', '#d9008f', '#00d90a', '#d9c400', '#00d9d9', '#f14c4c', '#8f5fd9', '#d97a00'];

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPE[c]);

export interface SessionChoice {
  id: string;
  label: string;
  start: string;
  turns: number;
}

export interface Block {
  laid: Laid;
  cut: number;
  rootSession: string;
}

export function page(g: Graph, blocks: Block[], collapseStraight: boolean, csp: string): string {
  // One colour per session, shared across every tree in the folder.
  const sessions = [...g.sessionStart.keys()].sort((a, b) =>
    (g.sessionStart.get(a) ?? '').localeCompare(g.sessionStart.get(b) ?? ''),
  );
  const sessionIndex = new Map(sessions.map((s, i) => [s, i]));
  const hue = (session: string) => COLORS[(sessionIndex.get(session) ?? 0) % COLORS.length];

  const trees = blocks.map((b) => tree(g, b, hue, collapseStraight)).join('');
  const turns = blocks.reduce((n, b) => n + b.laid.rows.filter((r) => r.kind === 'node').length, 0);
  // Inline scripts need a nonce: the webview CSP allows extension resources
  // only, so without one every click handler is silently dropped.
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --row: ${ROW}px; --line: var(--vscode-panel-border, rgba(128,128,128,.3)); }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); font-size: 12px;
         color: var(--vscode-foreground); }
  .meta { padding: 5px 8px; opacity: .55; font-size: 11px; }
  .tree { border-top: 1px solid var(--line); }
  .tree > summary { display: flex; gap: 8px; align-items: baseline; cursor: pointer;
                    padding: 4px 8px; font-size: 11px; }
  .tree > summary:hover { background: var(--vscode-list-hoverBackground); }
  .tree[open] > summary { font-weight: 600; }
  .cid { font-family: var(--vscode-editor-font-family), monospace; opacity: .7; flex: none; }
  .ct { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .cm { opacity: .55; white-space: nowrap;
        font-family: var(--vscode-editor-font-family), monospace; }
  .cm b { color: var(--vscode-charts-orange, #d97a00); }
  .tree > div { padding-bottom: 6px; }
  svg { position: absolute; left: 0; pointer-events: none; }
  .row { display: grid; grid-template-columns: var(--graph) minmax(0, 1fr) auto;
         align-items: center; height: var(--row); }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .desc { display: flex; align-items: center; gap: 5px; min-width: 0; padding-right: 6px; }
  .msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dim .msg { opacity: .45; font-style: italic; }
  .time { opacity: .4; padding-right: 8px;
          font-family: var(--vscode-editor-font-family), monospace; font-size: 11px; }
  .ref { border: 1px solid; border-radius: 8px; padding: 0 5px; line-height: 15px;
         font-size: 10px; white-space: nowrap; }
  .ckpt { border-radius: 8px; padding: 0 5px; line-height: 15px; font-size: 10px; cursor: pointer;
          background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .ckpt:hover { outline: 1px solid var(--vscode-focusBorder); }
  path { fill: none; stroke-width: 1.8; }
</style></head><body>
<div class="meta">${blocks.length} trees · ${turns} turns</div>
${trees || '<div class="meta">nothing selected</div>'}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.ckpt').forEach((el) =>
    el.addEventListener('click', () => vscode.postMessage({ type: 'diff', id: el.dataset.id })));
</script>
</body></html>`;
}

/** One tree: its own SVG lane strip plus the rows beside it. */
function tree(g: Graph, block: Block, hue: (s: string) => string, collapseStraight: boolean): string {
  const { laid, cut, rootSession } = block;
  // Fan rows only exist to draw connectors in a character grid; SVG replaces them.
  const shown = laid.rows.map((r, i) => ({ r, i })).filter(({ r, i }) => r.kind === 'node' && i >= cut);
  const yOf = new Map(shown.map(({ i }, idx) => [i, idx * ROW + ROW / 2]));

  const hueOf = (rowIndex: number) => {
    const id = laid.rows[rowIndex]?.id;
    return hue(id ? g.nodes.get(id)!.session : rootSession);
  };

  const x = (col: number) => PAD + col * LANE;
  const graphW = PAD * 2 + Math.max(0, laid.width - 1) * LANE;
  const height = shown.length * ROW;

  const paths = laid.edges
    .map((e) => {
      const y1 = yOf.get(e.fromRow);
      const y2 = yOf.get(e.toRow);
      if (y1 === undefined || y2 === undefined) return '';
      const x1 = x(laid.rows[e.fromRow]?.col ?? e.col);
      const x2 = x(e.col);
      // Turn at the branch point: a one-row S-curve, then a straight drop down
      // the new lane. A curve stretched over the whole gap reads as a slash.
      const d =
        x1 === x2
          ? `M${x1} ${y1} V${y2}`
          : `M${x1} ${y1} C${x1} ${y1 + ROW * 0.55}, ${x2} ${y1 + ROW * 0.45}, ${x2} ${Math.min(y1 + ROW, y2)} V${y2}`;
      const dashed = laid.rows[e.toRow]?.head === 'retry' ? ' stroke-dasharray="3 3"' : '';
      return `<path d="${d}" stroke="${hueOf(e.toRow)}"${dashed}/>`;
    })
    .join('');

  const dots = shown
    .map(({ r, i }) => {
      const n = g.nodes.get(r.id!)!;
      const cx = x(r.col);
      const cy = yOf.get(i)!;
      const c = hue(n.session);
      if (n.ckpt)
        return `<rect x="${cx - 4}" y="${cy - 4}" width="8" height="8" transform="rotate(45 ${cx} ${cy})" fill="${c}"/>`;
      if (r.head === 'retry')
        return `<circle cx="${cx}" cy="${cy}" r="3.6" fill="none" stroke="${c}" stroke-width="2"/>`;
      return `<circle cx="${cx}" cy="${cy}" r="3.6" fill="${c}"/>`;
    })
    .join('');

  const label = (n: Node) => (n.kind === 'user' ? esc(g.titles.get(n.id) ?? n.text ?? '') : 'Claude');

  const rows = shown
    .map(({ r }) => {
      const n = g.nodes.get(r.id!)!;
      const c = hue(n.session);
      const from = r.headFrom ? esc(r.headFrom.slice(0, 8)) : '';
      const ref =
        r.head === 'branch'
          ? `<span class="ref" style="border-color:${c};color:${c}" title="branch session ${esc(n.session)} · from ${from}">⑂ ${esc(n.session.slice(0, 8))}</span>`
          : r.head === 'retry'
            ? `<span class="ref" style="border-color:${c};color:${c}" title="rewound to ${from}, then continued here">↺</span>`
            : '';
      const ck = n.ckpt
        ? `<span class="ckpt" data-id="${n.id}" title="${esc(n.ckpt.files.join('\n'))}">◆${n.ckpt.files.length}</span>`
        : '';
      const tip = `${n.id.slice(0, 8)}  ${n.ts.slice(0, 16).replace('T', ' ')}\n\n${n.text}`;
      return (
        `<div class="row${n.kind === 'assistant' ? ' dim' : ''}" title="${esc(tip)}">` +
        `<div></div><div class="desc">${ref}${ck}<span class="msg">${label(n)}</span></div>` +
        `<div class="time">${n.ts.slice(11, 16)}</div>` +
        `</div>`
      );
    })
    .join('');

  const title = g.sessionTitle.get(rootSession);
  const branched = laid.lanes.size > 1 || laid.width > 1;
  const cap =
    `<summary title="${esc(rootSession)}">` +
    `<span class="cid">${esc(rootSession.slice(0, 8))}</span>` +
    `<span class="ct">${esc(title ?? '')}</span>` +
    `<span class="cm">${shown.length}t${laid.lanes.size > 1 ? ` · ${laid.lanes.size}s` : ''}` +
    `${branched ? ' <b>⑂</b>' : ''}</span></summary>`;

  // Only trees that actually branched open on their own; a folder can hold
  // twenty straight-line sessions and stacking them all is unreadable.
  return (
    `<details class="tree" style="--graph:${graphW}px"${branched || !collapseStraight ? ' open' : ''}>` +
    cap +
    `<div style="position:relative">` +
    `<svg width="${graphW}" height="${height}">${paths}${dots}</svg>` +
    rows +
    `</div></details>`
  );
}
