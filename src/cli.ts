#!/usr/bin/env node
// `git log --graph` style view of one Claude Code session and everything that
// branched off it: rewinds, session branches, file checkpoints. Read-only.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadProject, projectDir, listProjects, setClaudeHome, keepSet, type Node } from './parse.ts';
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
  console.log(`csg (claude session graph) -- a Git Graph style view of Claude
Code session history.

USAGE
  csg [<session>] [<project>] [options]

  <session>   which conversation to draw. Any of:
                - a session id, or any prefix of one   (e.g. 65111cdd)
                - a phrase from a message in it        (e.g. "pricing endpoint")
              A session that branched off another resolves to the whole tree,
              so it does not matter which one you name.

  <project>   the directory you were using Claude Code in. Sessions are
              recorded per working directory. Defaults to the current one, so
              this is only needed to look at another project:
                csg --list ..
                csg 65111cdd ~/some/other/project
              Same as --dir; a path is recognised by being one.

WHAT YOU ARE LOOKING AT
  Each row is one turn. Lanes run top to bottom; a lane splits only where the
  history actually diverged.

    o + dotted lane   retry -- you rewound to an earlier turn and asked again,
                      in the same session. The tag names the turn you went back
                      to. One-turn rewinds that went nowhere are hidden unless
                      --abandoned.
    * + solid lane    branch -- a separate session was started from that turn.
                      The tag names it and the turn it split from.
    # [3f]            a checkpoint: that turn wrote files, 3 of them. The
                      backups live under <claude home>/file-history/.

  Colour follows the session, not the column: a lane is reused once its line
  ends, so colour is what keeps a thread traceable.

OPTIONS
  --list          list every session in the project and exit
  --dir <path>    project working dir, or <claude home>/projects/<slug>
  --home <path>   where Claude Code keeps its state
                  default: $CLAUDE_CONFIG_DIR, else ~/.claude

  --all           draw every message, Claude's tool calls included
  --topology      draw only branch points and checkpoints
  --abandoned     also draw rewinds that were dropped after a single turn
  --limit <n>     draw only the last N turns of the main line. default: 30,
                  0 draws everything. Branches show only what falls inside
                  that window, so they can appear shorter than N.

  --width <n>     message text width, in characters. default: 25
  --ascii         ASCII-only glyphs, for terminals without box drawing
  --no-color      no colour
  -h, --help      this

EXAMPLES
  csg --list                     what was recorded for this directory
  csg 65111cdd                   draw that session and anything branched off it
  csg "milvus" --all             find it by message, with tool calls shown
  csg --list ..                  sessions of the parent project
  csg 65111cdd .. --limit 0      that session in full, no window

  Read-only. It never writes to your transcripts.`);
  process.exit(has('-h') || has('--help') ? 0 : 1);
}

const color = !has('--no-color') && process.stdout.isTTY === true;
const WIDTH = Number(val('--width') ?? 25);
const cut = (s: string) => (s.length > WIDTH ? s.slice(0, WIDTH - 1) + '…' : s);

const C = (n: number, s: string) => (color ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = (s: string) => C(90, s);
const LANE = [36, 33, 35, 32, 34, 31, 96, 93];

if (val('--home')) setClaudeHome(val('--home')!);

// A bare path where a session id is expected is meant as the project, not as a
// search term: `csg --list ~/some/project` and `csg ~/some/project` both work.
const pathArg = positional.findIndex((a) => {
  const p = a.replace(/^~(?=$|\/)/, homedir());
  return (a.startsWith('/') || a.startsWith('~') || a.startsWith('.')) && existsSync(p) && statSync(p).isDirectory();
});
// The slug is built from an absolute path, so `..` and `~` have to go first.
const rawDir = resolve(
  (val('--dir') ?? (pathArg >= 0 ? positional.splice(pathArg, 1)[0] : process.cwd())).replace(
    /^~(?=$|\/)/,
    homedir(),
  ),
);
const dir = rawDir.includes('/.claude/projects/') ? rawDir : projectDir(rawDir);

// Sessions are recorded per working directory, so the usual mistake is running
// this somewhere Claude Code has never been. Say which directories it has.
const known = listProjects();
const g = (() => {
  try {
    return loadProject(dir);
  } catch {
    console.error(`no Claude Code sessions recorded for ${rawDir}`);
    if (!known.length) {
      console.error(`nothing found under ${dir.split('/projects/')[0]} either -- is --home right?`);
    } else {
      console.error('\nprojects with sessions:');
      for (const p of known.slice(0, 12)) console.error(`  ${String(p.sessions).padStart(3)}  ${p.cwd}`);
      if (known.length > 12) console.error(`  ... and ${known.length - 12} more`);
      console.error('\nrun csg from one of those, or pass --dir <path>');
    }
    process.exit(1);
  }
})();

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
// 0 means the whole thing; the help says so, and the extension agrees.
const limit = Number(val('--limit') ?? 30);
const start = limit > 0 ? windowStart(g, laid, root.session, limit) : 0;
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
// No lane legend: columns are recycled once a line ends, so listing the
// columns a session touched says nothing useful. Colour carries the session.
console.log(dim(`${shown} of ${total} turns · ${laid.lanes.size} sessions`));
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
