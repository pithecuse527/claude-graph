# claude-graph

A Git Graph style view of Claude Code's own history: where a conversation was
rewound, where a branch session split off, and which turns wrote files.

Claude Code stores every session as an append-only JSONL transcript. Rewinding
does not erase anything — the new message is appended with its `parentUuid`
pointing back at an older turn, so the file is a *tree*, not a log. This reads
that tree and draws it, as a VS Code sidebar and as a terminal graph.

```
●           66baebba 2607312156 you are the expert on @mil…
●           5116b067 2607312158 claude
├┈┐
● │         3de6b16f 2607312201 for distance to work, dim …
├─┼───┐
  │   ●     56555510 2607312243 ok, keep answers short     branch 9fc42d77 from 071f9737
  ○   │     27a72cad 2607312244 ok, short answers please   retry from 5116b067
```

## What it shows

| Mark | Meaning |
| --- | --- |
| `●` | a turn |
| `○` / dashed line | **retry** — rewound to an earlier turn and sent again, in the same session |
| `⑂` / solid line | **branch** — a new session started from that point (`forkedFrom`) |
| `◆` | a **checkpoint**: files backed up at that turn, diffable against their state now |

Colour follows the session, not the column, so a lane can be recycled without
losing the thread.

## VS Code extension

Three sidebar sections: **Folders** (every project Claude Code has sessions
for), **Sessions** (tick to narrow the graph), **Graph**.

```bash
npm install
npm run compile
code --extensionDevelopmentPath="$PWD" /path/to/your/project
```

Package it instead:

```bash
npx @vscode/vsce package
code --install-extension claude-graph-*.vsix
```

Setting `claudeSessionGraph.claudeHome` points at Claude Code's state directory
(default `~/.claude`, or `$CLAUDE_CONFIG_DIR`).

## CLI

Needs Node 22.6+ (runs the TypeScript directly, no build step).

```bash
node --experimental-strip-types src/cli.ts --list --dir ~/my/project
node --experimental-strip-types src/cli.ts <session-id-prefix> --dir ~/my/project
```

```
--dir <path>   project working dir, or <claude home>/projects/<slug>. default: cwd
--home <path>  Claude Code state dir. default: $CLAUDE_CONFIG_DIR or ~/.claude
--list         list sessions in the project and exit
--all          every message, Claude's tool calls included
--topology     branch points and checkpoints only
--abandoned    also show rewinds that were dropped after a single turn
--limit <n>    show only the last N turns of the main session. default: 30
--width <n>    message text width. default: 25
--ascii        ASCII-only glyphs
--no-color     disable color
```

## What the transcripts actually look like

Findings that shaped the parser — all of them cost a bug first:

- **Parallel tool calls share one `message.id`.** Keeping every record turns
  each parallel call into a fake branch: 292 branch points instead of 21.
- **Slash commands and skill loads are `user` records** anchored to a `system`
  record rather than to the previous message, so they fan out exactly like a
  rewind. They are filtered, and the turns below them are re-attached to the
  turn that preceded the removed record — all of them to the *same* anchor, or
  a real rewind's siblings would be strung into a chain.
- **A branch session copies its parent's prefix verbatim, uuids included.**
  Global uuid dedup turns a branch into the same fanout as a rewind, so no
  special handling is needed — but the copy also carries the parent's
  timestamps, so a session must be dated by the first turn it *owns*.
- **Interrupting Claude does not create a branch.** 13 interrupts, 2 branches;
  the rest continue in a straight line.
- **Session titles live in `ai-title` / `custom-title` records**, keyed by
  session id — not in the `summary` rows some transcripts lack entirely.
- **Checkpoints** are `file-history-snapshot` records joined to a turn by
  `messageId`; the backups sit in `<claude home>/file-history/<session>/`.
  A tracked file can have a `null` backup name.

## Layout

`src/parse.ts` builds the forest, `src/layout.ts` assigns lanes and edges,
`src/render.ts` turns those into character cells for the terminal, and
`src/webview.ts` turns the same lanes into SVG for the sidebar.

```bash
npm test   # synthetic fixtures covering each of the findings above
```

MIT.
