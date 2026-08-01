// VS Code extension: three sidebar sections -- the project folders Claude Code
// has sessions for, the sessions in the chosen folder, and the branch graph.

import * as vscode from 'vscode';
import {
  loadProject,
  projectDir,
  listProjects,
  setClaudeHome,
  keepSet,
  type Detail,
  type Graph,
  type Node,
  type ProjectDir,
} from './parse.ts';
import { layout } from './layout.ts';
import { windowStart } from './render.ts';
import { page, type Block, type SessionChoice } from './webview.ts';

function workspaceDir(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Root sessions, newest first: one entry per tree. */
function roots(g: Graph): Node[] {
  return g.roots.map((id) => g.nodes.get(id)!).sort((a, b) => b.ts.localeCompare(a.ts));
}

/**
 * Rows to draw. With sessions ticked, only their turns survive -- a branch
 * relation between two ticked sessions still shows, because the unticked turns
 * between them collapse into the connector rather than being cut.
 */
function keepFor(g: Graph, selected: Set<string>, detail: Detail): Set<string> {
  const keep = keepSet(g, detail);
  if (!selected.size) return keep;
  for (const id of [...keep]) if (!selected.has(g.nodes.get(id)!.session)) keep.delete(id);
  return keep;
}

/** Kept nodes with no kept ancestor: each starts its own drawn tree. */
function displayRoots(g: Graph, keep: Set<string>): string[] {
  const out: string[] = [];
  for (const id of keep) {
    let p = g.nodes.get(id)!.parent;
    while (p && !keep.has(p)) p = g.nodes.get(p)!.parent;
    if (!p) out.push(id);
  }
  return out.sort((a, b) => g.nodes.get(b)!.ts.localeCompare(g.nodes.get(a)!.ts));
}

/** What the three views share: which folder is open and which sessions are ticked. */
class State {
  dir?: string;
  selected = new Set<string>();
  graph?: Graph;
  folders: ProjectDir[] = [];
  private changed = new vscode.EventEmitter<void>();
  readonly onChange = this.changed.event;
  private watcher?: vscode.FileSystemWatcher;
  private pending?: ReturnType<typeof setTimeout>;

  settings() {
    return vscode.workspace.getConfiguration('claudeSessionGraph');
  }

  /** Reload when the folder's transcripts change; a live session appends often. */
  private watch() {
    this.watcher?.dispose();
    if (!this.dir || !this.settings().get<boolean>('autoRefresh', true)) return;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.dir), '*.jsonl'),
    );
    const touch = () => {
      clearTimeout(this.pending);
      this.pending = setTimeout(() => this.reload(), 1500);
    };
    this.watcher.onDidChange(touch);
    this.watcher.onDidCreate(touch);
    this.watcher.onDidDelete(touch);
  }

  dispose() {
    this.watcher?.dispose();
    clearTimeout(this.pending);
  }

  reload() {
    const cfg = vscode.workspace.getConfiguration('claudeSessionGraph');
    const home = cfg.get<string>('claudeHome');
    if (typeof home === 'string' && home.trim()) setClaudeHome(home.trim());
    this.folders = listProjects();
    const cwd = workspaceDir();
    this.dir ??= cwd ? projectDir(cwd) : this.folders[0]?.dir;
    if (this.dir && !this.folders.some((f) => f.dir === this.dir)) this.dir = this.folders[0]?.dir;
    try {
      this.graph = this.dir ? loadProject(this.dir) : undefined;
    } catch {
      this.graph = undefined;
    }
    this.watch();
    this.changed.fire();
  }

  setDir(dir: string) {
    this.dir = dir;
    this.selected.clear();
    this.reload();
  }

  /** Sessions in the current folder, titled and newest first. */
  choices(): SessionChoice[] {
    const g = this.graph;
    if (!g) return [];
    const own = new Map<string, Node[]>();
    for (const n of g.nodes.values()) {
      const list = own.get(n.session) ?? [];
      list.push(n);
      own.set(n.session, list);
    }
    return [...g.sessionStart]
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([id, start]) => {
        const mine = own.get(id) ?? [];
        // The transcript's own title beats the first prompt, and some sessions
        // have no surviving user turn to fall back on at all.
        const label =
          g.sessionTitle.get(id) ||
          mine.find((n) => n.kind === 'user' && n.text)?.text ||
          mine.find((n) => n.text)?.text ||
          '(no turns)';
        return { id, label, start, turns: mine.length };
      });
  }
}

class FolderTree implements vscode.TreeDataProvider<ProjectDir> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private state: State) {
    state.onChange(() => this.changed.fire());
  }
  getChildren = () => this.state.folders;
  getTreeItem(f: ProjectDir): vscode.TreeItem {
    const item = new vscode.TreeItem(f.cwd.split('/').pop() || f.cwd);
    item.description = `${f.sessions} sessions · ${f.modified.slice(0, 10)}`;
    item.tooltip = `${f.cwd}\n${f.dir}`;
    item.iconPath = new vscode.ThemeIcon(f.dir === this.state.dir ? 'folder-active' : 'folder');
    item.command = { command: 'csg.pickFolder', title: 'Select folder', arguments: [f.dir] };
    return item;
  }
}

class SessionTree implements vscode.TreeDataProvider<SessionChoice> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private state: State) {
    state.onChange(() => this.changed.fire());
  }
  getChildren = () => this.state.choices();
  getTreeItem(c: SessionChoice): vscode.TreeItem {
    // Titles repeat across branch sessions ("(Branch 3)" twice), so the id
    // leads: it is the only label that is unique.
    const item = new vscode.TreeItem(`${c.id.slice(0, 8)}  ${c.label}`);
    item.description = `${c.start.slice(5, 10)} · ${c.turns}t`;
    item.tooltip = `${c.id}\n${c.start}`;
    // Ticking narrows the graph; nothing ticked means every tree is shown.
    item.checkboxState = this.state.selected.has(c.id)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    return item;
  }
}

class GraphView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  constructor(private state: State) {
    state.onChange(() => this.render());
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'diff') this.diff(msg.id);
    });
    this.render();
  }

  render() {
    if (!this.view) return;
    const g = this.state.graph;
    if (!g) {
      this.view.webview.html = body('no Claude Code sessions recorded for this folder');
      return;
    }
    const cfg = this.state.settings();
    const keep = keepFor(g, this.state.selected, cfg.get<Detail>('detail', 'user'));
    const abandoned = cfg.get<boolean>('showAbandoned', false);
    const limit = cfg.get<number>('limit', 0);
    // No window: the sidebar scrolls, and truncating hides the branch points
    // the view exists to show. `--limit` stays a CLI concern.
    const blocks: Block[] = displayRoots(g, keep).map((id) => {
      const laid = layout(g, keep, id, abandoned);
      const session = g.nodes.get(id)!.session;
      return { laid, cut: limit > 0 ? windowStart(g, laid, session, limit) : 0, rootSession: session };
    });
    this.view.webview.html = page(g, blocks, cfg.get<boolean>('collapseStraightSessions', true), this.view.webview.cspSource);
  }

  private async diff(id: string) {
    const ckpt = this.state.graph?.nodes.get(id)?.ckpt;
    if (!ckpt) return;
    let file = ckpt.backups[0];
    if (ckpt.backups.length > 1) {
      const chosen = await vscode.window.showQuickPick(
        ckpt.backups.map((b) => b.path),
        { placeHolder: 'File to compare with its state now' },
      );
      if (!chosen) return;
      file = ckpt.backups.find((b) => b.path === chosen)!;
    }
    if (!file) return;
    const live = file.path.startsWith('/')
      ? file.path
      : vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, file.path).fsPath;
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(file.backup),
      vscode.Uri.file(live),
      `${file.path} @checkpoint <-> now`,
    );
  }
}

const body = (msg: string) =>
  `<body style="font-family:var(--vscode-font-family);padding:10px;opacity:.7">${msg}</body>`;

export function activate(context: vscode.ExtensionContext) {
  const state = new State();
  context.subscriptions.push({ dispose: () => state.dispose() });
  const sessions = new SessionTree(state);
  const sessionView = vscode.window.createTreeView('csg.sessions', { treeDataProvider: sessions });

  context.subscriptions.push(
    sessionView,
    vscode.window.registerTreeDataProvider('csg.folders', new FolderTree(state)),
    vscode.window.registerWebviewViewProvider('csg.graph', new GraphView(state)),
    sessionView.onDidChangeCheckboxState((e) => {
      for (const [item, checked] of e.items) {
        if (checked === vscode.TreeItemCheckboxState.Checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
      }
      state.reload();
    }),
    vscode.commands.registerCommand('csg.pickFolder', (dir: string) => state.setDir(dir)),
    vscode.commands.registerCommand('csg.refresh', () => state.reload()),
    vscode.commands.registerCommand('csg.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSessionGraph'),
    ),
    vscode.commands.registerCommand('csg.clearSelection', () => {
      state.selected.clear();
      state.reload();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeSessionGraph')) state.reload();
    }),
  );
  state.reload();
}

export function deactivate() {}
