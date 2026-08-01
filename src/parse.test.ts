// node --experimental-strip-types src/parse.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { loadProject, keepSet } from './parse.ts';
import { layout } from './layout.ts';

const dir = mkdtempSync(join(tmpdir(), 'csg-'));
const J = (o: any) => JSON.stringify(o);
const asst = (uuid: string, parent: string | null, id: string, blocks: any[]) =>
  J({ type: 'assistant', uuid, parentUuid: parent, timestamp: `2026-01-01T00:00:0${uuid.length}Z`, message: { id, content: blocks } });
const user = (uuid: string, parent: string | null, text: string) =>
  J({ type: 'user', uuid, parentUuid: parent, timestamp: '2026-01-01T00:00:00Z', message: { content: text } });

writeFileSync(
  join(dir, 'aaaa.jsonl'),
  [
    user('u1', null, 'hello'),
    // one assistant turn split across two records by parallel tool calls
    asst('a1', 'u1', 'msg_1', [{ type: 'tool_use', name: 'Bash' }]),
    asst('a2', 'a1', 'msg_1', [{ type: 'tool_use', name: 'Read' }]),
    // tool_result carriers are transport, not turns
    J({ type: 'user', uuid: 'r1', parentUuid: 'a2', message: { content: [{ type: 'tool_result' }] } }),
    // an attachment in the middle must not orphan its descendants
    J({ type: 'attachment', uuid: 'x1', parentUuid: 'r1', timestamp: '2026-01-01T00:00:00Z' }),
    user('u2', 'x1', 'real rewind branch A'),
    user('u3', 'x1', 'real rewind branch B'),
    // a subagent sidechain must not register as a branch
    J({ type: 'assistant', uuid: 's1', parentUuid: 'x1', isSidechain: true, message: { id: 'msg_s', content: [] } }),
    J({
      type: 'file-history-snapshot',
      snapshot: { messageId: 'u2', timestamp: '2026-01-01T00:00:00Z', trackedFileBackups: { 'a.md': { backupFileName: 'h@v1', version: 1 } } },
    }),
  ].join('\n'),
);
// a fork copies the parent's prefix with identical uuids
writeFileSync(
  join(dir, 'bbbb.jsonl'),
  [
    J({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-01-01T00:00:00Z', forkedFrom: { sessionId: 'aaaa', messageUuid: 'u1' }, message: { content: 'hello' } }),
    asst('a1', 'u1', 'msg_1', [{ type: 'tool_use', name: 'Bash' }]),
    user('u9', 'a1', 'fork continues here'),
  ].join('\n'),
);

// a rewind on the first prompt branches off a filtered attachment record
writeFileSync(
  join(dir, 'cccc.jsonl'),
  [
    J({ type: 'attachment', uuid: 'p0', parentUuid: null, timestamp: '2026-01-02T00:00:00Z' }),
    user('c1', 'p0', 'first try'),
    user('c2', 'p0', 'edited retry'),
  ].join('\n'),
);

const g = loadProject(dir);

assert.equal(g.roots.length, 2, 'fork copies must not create a second root');
assert.ok(g.nodes.has('p0'), 'a filtered common ancestor is materialized, not dropped');
assert.deepEqual(g.nodes.get('p0')!.kids.sort(), ['c1', 'c2']);
assert.deepEqual([...g.nodes.keys()].sort(), ['a1', 'c1', 'c2', 'p0', 'u1', 'u2', 'u3', 'u9']);
assert.equal(g.nodes.get('a1')!.session, 'aaaa', 'original session wins the dedup, not the fork');
assert.deepEqual(g.nodes.get('a1')!.kids.sort(), ['u2', 'u3', 'u9'], 'rewind + fork are the same fanout');
assert.equal(g.stats.branchPoints, 2);
assert.equal(g.nodes.get('u2')!.ckpt?.files.length, 1, 'checkpoint joins by messageId');
assert.equal(g.nodes.get('u3')!.ckpt, undefined);

// collapse keeps roots, branch points, branch heads, checkpoints, tips
assert.deepEqual([...keepSet(g, 'topology')].sort(), ['a1', 'c1', 'c2', 'p0', 'u1', 'u2', 'u3', 'u9']);
assert.equal(keepSet(g, 'all').size, g.nodes.size);
// the default keeps every user turn on top of the topology
assert.ok(keepSet(g, 'user').has('u1'));

// lanes: one per session. A rewind stays in its session's lane; only the fork
// into session bbbb opens a second lane.
const laid = layout(g, keepSet(g, 'all'), 'u1', true);
const at = (id: string) => laid.rows.find((r) => r.kind === 'node' && r.id === id)!;
assert.equal(laid.width, 2, 'a one-row dead end costs no lane; only the branch opens one');
assert.equal(at('u1').col, 0);
assert.equal(at('u2').col, 0, 'the continuing line keeps the lane');
assert.equal(at('u3').col, 0, 'a dead end is drawn inline, in its parent lane');
assert.equal(at('u3').head, 'abandoned');
assert.equal(at('u9').col, 1, 'a branched session never takes the parent lane');
assert.equal(at('u9').head, 'branch');
assert.deepEqual(
  laid.rows.filter((r) => r.kind === 'fan').map((r) => [r.col, r.to, r.toKind]),
  [[0, [1], ['branch']]],
  'one connector out of lane 0, into the branch lane only',
);
assert.deepEqual(laid.lanes.get('bbbb'), [1], 'lane bookkeeping is per session');

// dead ends are hidden unless asked for; the trunk survives either way
const hidden = layout(g, keepSet(g, 'all'), 'u1');
assert.equal(hidden.rows.some((r) => r.id === 'u3'), false, 'dead end dropped by default');
assert.ok(hidden.rows.some((r) => r.id === 'u2'), 'the line that continued is never dropped');

console.log('ok');
