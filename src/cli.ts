#!/usr/bin/env node --experimental-strip-types
// `git log --graph` style view of one Claude Code session and everything that
// branched off it: rewinds, session branches, file checkpoints. Read-only.

import { loadProject, projectDir, setClaudeHome, keepSet, type Node } from './parse.ts';
import { layout } from './layout.ts';
import { render, windowStart, UNICODE, ASCII, type RenderRow } from './render.ts';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => {
  const i = argv.indexOf(f);
  return i === -1 ? undefined : argv[i + 1];
};
const flagsWithValue = ['--dir', '--limit', '--width', '--home'];
const positional = argv.filter((a, i) => !a.startsWith('-') && !flagsWithValue.includes(argv[i - 1]));

if (has('-h') || has('--help') || (positional.length === 0 && !has('--list'))) {
  console.log(`csg <session> [options]

  <session>     session id or prefix, or a substring of one of its messages.
                Any session in the tree works -- branches resolve to the root.

  --dir <path>  project working dir, or <claude home>/projects/<slug>. default: cwd
  --home <path> Claude Code state dir. default: $CLAUDE_CONFIG_DIR or ~/.claude
  --list        list sessions in the project and exit
  --all         every message, Claude's tool calls included
  --topology    branch points and checkpoints only
  --abandoned   also show rewinds that were dropped after a single turn
  --limit <n>   show only the last N turns of the main session. default: 30
  --width <n>   message text width. default: 25
  --ascii       ASCII-only glyphs
  --no-color    disable color`);
  process.exit(has('-h') || has('--help') ? 0 : 1);
}

const color = !has('--no-color') && process.stdout.isTTY !== false;
const WIDTH = Number(val('--width') ?? 25);
const cut = (s: string) => (s.length > WIDTH ? s.slice(0, WIDTH - 1) + '…' : s);

const C = (n: number, s: string) => (color ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = (s: string) => C(90, s);
const LANE = [36, 33, 35, 32, 34, 31, 96, 93];

if (val('--home')) setClaudeHome(val('--home')!);
const rawDir = val('--dir') ?? process.cwd();
const dir = rawDir.includes('/.claude/projects/') ? rawDir : projectDir(rawDir);
const g = loadProject(dir);

if (has('--list')) {
  for (const [s, ts] of [...g.sessionStart].sort((a, b) => a[1].localeCompare(b[1]))) {
    const n = [...g.nodes.values()].find((x) => x.session === s);
    console.log(`${s}  ${ts.slice(0, 16).replace('T', ' ')}  ${n ? cut(n.text) : dim('(no turns)')}`);
  }
  process.exit(0);
}

// --- resolve the requested session to the root of its tree -------------------
const q = positional[0].toLowerCase();
const hit =
  [...g.nodes.values()].find((n) => n.session.toLowerCase().startsWith(q)) ??
  [...g.nodes.values()].find((n) => n.id.toLowerCase().startsWith(q)) ??
  [...g.nodes.values()].find((n) => n.text.toLowerCase().includes(q));
if (!hit) {
  console.error(`no session matching "${positional[0]}" in ${dir}\ntry: csg --list --dir ${rawDir}`);
  process.exit(1);
}
let root = hit;
while (root.parent) root = g.nodes.get(root.parent)!;

const detail = has('--all') ? 'all' : has('--topology') ? 'topology' : 'user';
const keep = keepSet(g, detail);
keep.add(root.id);
const laid = layout(g, keep, root.id, has('--abandoned'));
const start = windowStart(g, laid, root.session, Number(val('--limit') ?? 30));
const view = render(g, laid, start, has('--ascii') ? ASCII : UNICODE);

const hue = new Map<string, number>();
for (const [s] of laid.lanes) hue.set(s, LANE[hue.size % LANE.length]);
// Columns get recycled, so colour follows the session of the row, not the lane.
const rowSession = new Map<number, string>();
laid.rows.forEach((r, i) => {
  if (r.kind === 'node') rowSession.set(r.col, g.nodes.get(r.id!)!.session);
});
const laneColor = (col: number) => hue.get(rowSession.get(col) ?? '') ?? 37;

function label(n: Node, lane: number, dead: boolean): string {
  const time = n.ts ? n.ts.slice(2, 16).replace(/[-T:]/g, '') : '';
  const ck = n.ckpt ? C(32, ` [${n.ckpt.files.length}f]`) : '';
  const title = g.titles.get(n.id);
  // Only surviving user turns carry text; a dead end and a Claude turn are both
  // here for structure alone. A dead end's id is struck through (SGR 9).
  const body = dead
    ? ''
    : n.kind === 'user'
      ? title
        ? C(1, cut(title))
        : n.text
          ? cut(n.text)
          : dim('(empty)')
      : dim('claude');
  const id = color && dead ? `\x1b[9m${n.id.slice(0, 8)}\x1b[29m` : n.id.slice(0, 8);
  return `${C(lane, id)} ${C(lane, time)}${body ? ' ' + body : ''}${ck}`;
}

const gutter = (row: RenderRow) =>
  row.cells.map((c) => (c.lane < 0 ? dim(c.ch) : C(laneColor(c.lane), c.ch))).join('');

const shown = view.filter((r) => r.node).length;
const total = laid.rows.filter((r) => r.kind === 'node').length;
console.log(dim(`${shown} of ${total} turns · ${laid.lanes.size} sessions · ${laid.width} lanes`));
for (const [session, cols] of laid.lanes) {
  const startTs = g.sessionStart.get(session)?.slice(0, 16).replace('T', ' ') ?? '';
  console.log(`${C(hue.get(session)!, UNICODE.node)} ${dim(`${session}  ${startTs}  lane ${cols.join(',')}`)}`);
}
console.log();

for (const row of view) {
  const gut = gutter(row);
  if (!row.node) {
    console.log(gut);
    continue;
  }
  const c = laneColor(row.col);
  const from = row.headFrom ? ` from ${row.headFrom.slice(0, 8)}` : '';
  const tag =
    row.head === 'branch'
      ? C(c, `  branch ${row.node.session.slice(0, 8)}${from}`)
      : row.head === 'retry'
        ? C(c, `  retry${from}`)
        : row.head === 'abandoned'
          ? C(c, `  abandoned${from}`)
          : '';
  // Stagger the text by lane, so a row's indent says which line it belongs to.
  console.log(`${gut} ${' '.repeat(2 * row.col)}${label(row.node, c, row.head === 'abandoned')}${tag}`);
}
