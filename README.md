# claude-graph

For people who ask Claude Code too many questions.

Every rewind, every branch, every file it touched — Claude Code kept all of it
and never showed you. This draws it, the way Git Graph draws commits.

**In VS Code**

![The sidebar: folders, sessions, and the graph](media/screenshot-vscode.png)

**In a terminal**

![csg in a terminal](media/screenshot-cli.png)

## Reading it

| Mark | Means |
| --- | --- |
| `●` | a turn |
| `○` + dotted lane | **retry** — you rewound and asked again, same session |
| `⑂` + solid lane | **branch** — a whole new session split off here |
| `◆` | files were written; click it in VS Code to diff that snapshot against now |

One colour per session. Straight down a lane means the conversation kept going;
anything sideways is where you changed your mind.

## VS Code

```bash
npx @vscode/vsce package
code --install-extension claude-graph-*.vsix
```

Open the Claude Sessions icon in the activity bar:

- **Folders** — every project Claude Code has run in. Pick one.
- **Sessions** — click one, or tick several.
- **Graph** — the picture.

## Terminal

```bash
npm i -g github:pithecuse527/claude-graph
```

Puts `csg` (**c**laude **s**ession **g**raph) on your PATH. Nothing is published
to npm; it just fetches the repo and builds it. One-off, no install:

```bash
npx github:pithecuse527/claude-graph --list
```

Run it inside the project you were using Claude in.

```bash
csg --list              # what sessions exist here
csg a3f2                # draw one, by any prefix of its id
csg "pricing endpoint"  # or by a phrase from a message
csg a3f2 <path>         # a project you are not currently in
```

`csg --help` for the rest.

## Settings

`claudeSessionGraph` in VS Code settings, or the gear on any section.

| Setting | Default | What it does |
| --- | --- | --- |
| `claudeHome` | `$CLAUDE_CONFIG_DIR`, else `~/.claude` | Where Claude Code keeps its state |
| `detail` | `user` | `user` = your prompts. `all` = tool calls too. `topology` = branch points only |
| `showAbandoned` | off | Show rewinds dropped after a single turn |
| `collapseStraightSessions` | on | Sessions that never branched start collapsed |
| `limit` | `0` | Last N turns per session. `0` = everything |
| `autoRefresh` | on | Redraw while a session is still running |

Read-only. It never writes to your transcripts.

MIT.
