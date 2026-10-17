import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { api, interaction, tick, type Db, type Env } from '../src/hive.ts';
import { tally, verdict, winner } from '../src/votes.ts';

test('vote math', () => {
  const t = tally([{ choice: 0 }, { choice: 1 }, { choice: 1 }, { choice: -1 }], 2);
  assert.deepEqual(t, { counts: [1, 2], reject: 1, yes: 3, total: 4 });
  assert.equal(winner(t.counts), 1);
  assert.equal(winner([2, 2]), 0, 'ties go to the earlier option');

  assert.equal(verdict(t, { min_votes: 4, approve_pct: 60 }, false), 'pass', 'early pass once both bars are met');
  assert.equal(verdict(t, { min_votes: 5, approve_pct: 60 }, false), 'open');
  assert.equal(verdict(t, { min_votes: 5, approve_pct: 60 }, true), 'fail');
  assert.equal(verdict(t, { min_votes: 0, approve_pct: 60 }, false), 'open', 'no minimum = wait for the window');
  assert.equal(verdict(t, { min_votes: 0, approve_pct: 60 }, true), 'pass');
  assert.equal(verdict(t, { min_votes: 0, approve_pct: 80 }, true), 'fail');
  assert.equal(verdict(tally([], 1), { min_votes: 0, approve_pct: 0 }, true), 'fail', 'zero votes never pass');
  const split = tally([{ choice: 0 }, { choice: -1 }, { choice: -1 }], 1);
  assert.equal(verdict(split, { min_votes: 3, approve_pct: 0 }, true), 'fail', 'pct 0 = simple majority');
});

test('idea → vote → issue → worker claim → PR → auto-merge → shipped', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const db: Db = {
    all: async (sql, ...p) => sqlite.prepare(sql).all(...(p as SQLInputValue[])) as any[],
    first: async (sql, ...p) => (sqlite.prepare(sql).get(...(p as SQLInputValue[])) ?? null) as any,
    run: async (sql, ...p) => Number(sqlite.prepare(sql).run(...(p as SQLInputValue[])).changes),
  };
  const env: Env = { DISCORD_APP_ID: 'app', DISCORD_TOKEN: 'bot', GITHUB_TOKEN: 'gh', GITHUB_REPO: 'o/r', PUBLIC_URL: 'https://hive.test' };

  // Fake Discord + GitHub: just enough of each route.
  const calls: string[] = [];
  const sent: Record<string, any[]> = {}; // request bodies per route
  let threads = 0, roles = 0;
  const replies: Record<string, unknown> = {
    'GET /guilds/g/roles': [{ id: 'role1', position: 4 }, { id: 'role2', position: 3 }, { id: 'role3', position: 2 }, { id: 'role4', position: 1 }],
    'POST /repos/o/r/issues': { number: 7 },
    'GET /guilds/g/members/worker': { roles: ['role1'] },
    'GET /repos/o/r/pulls/9': { number: 9, merged: false, mergeable_state: 'clean', head: { ref: 'hive/issue-7' } },
    'GET /repos/o/r/pulls/9/files?per_page=100': [{ filename: 'src/dark.css' }],
    'GET /repos/o/r/issues?labels=hive%3Aapproved&state=all&sort=updated&per_page=100': [{ number: 7, state: 'open' }],
    'GET /repos/o/r/pulls?state=open&per_page=100': [{ number: 9, head: { ref: 'hive/issue-7' }, body: 'Closes #7' }],
  };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${String(url).replace(/^https:\/\/[^/]+(\/api\/v10)?/, '')}`;
    calls.push(key);
    if (init.body) (sent[key] ??= []).push(JSON.parse(String(init.body)));
    if (key === 'POST /guilds/g/roles') return Response.json({ id: `role${++roles}` });
    if (key === 'POST /channels/forum/threads') return Response.json({ id: `thread${++threads}` });
    if (key === 'POST /guilds/g/channels') {
      const tags = JSON.parse(String(init.body)).available_tags.map((t: any, n: number) => ({ ...t, id: `tag${n}` }));
      return Response.json({ id: 'forum', available_tags: tags });
    }
    return Response.json(replies[key] ?? {});
  }) as typeof fetch;

  const member = (id: string, permissions = '0', roles: string[] = []) => ({ user: { id }, permissions, roles });
  const send = async (ix: any) => {
    const reply = await interaction({ guild_id: 'g', token: 'tok', ...ix }, env, db);
    await reply.after?.();
    return reply.body as any;
  };
  const status = (id = 'thread1') => sqlite.prepare('SELECT status FROM ideas WHERE thread_id = ?').get(id)?.status;

  // Owner sets up: vote with 2+ votes at 60%, no discussion phase, Hive Workers build, auto-merge.
  await send({ type: 2, member: member('owner', '32'), data: { name: 'hive', options: [{ name: 'setup', options: [
    { name: 'min_votes', value: 2 }, { name: 'approve_pct', value: 60 }, { name: 'discuss_hours', value: 0 },
    { name: 'builder', value: 'workers' }, { name: 'merge', value: 'auto' },
  ] }] } });
  assert.equal(sqlite.prepare('SELECT builder FROM guilds').get()?.builder, 'workers');
  // Created Worker (role1), Manager (role2), Mind (role3), Pollinator (role4), each landing at the bottom; re-sorted.
  assert.deepEqual({ ...sqlite.prepare('SELECT worker_role_id, manager_role_id, mind_role_id FROM guilds').get() },
    { worker_role_id: 'role1', manager_role_id: 'role2', mind_role_id: 'role3' });
  assert.deepEqual(sent['PATCH /guilds/g/roles'][0], [{ id: 'role3', position: 4 }, { id: 'role2', position: 3 }, { id: 'role1', position: 2 }, { id: 'role4', position: 1 }]);
  assert.ok(calls.includes('PUT /guilds/g/members/owner/roles/role3'), 'whoever runs setup gets Hive Mind');
  assert.deepEqual(sent['PUT /channels/forum/permissions/role2'][0], { type: 0, allow: String(1n << 34n) }, 'managers can moderate the forum');

  assert.equal((await send({ type: 2, member: member('alice'), data: { name: 'idea' } })).type, 9, '/idea opens a modal');
  await send({ type: 5, member: member('alice'), data: { custom_id: 'idea', components: [
    { type: 1, components: [{ type: 4, custom_id: 'title', value: 'Dark mode' }] },
    { type: 1, components: [{ type: 4, custom_id: 'spec', value: 'Add a dark mode toggle' }] },
  ] } });
  assert.equal(status(), 'voting');

  const vote = (id: string, choice: number) => send({ type: 3, channel_id: 'thread1', member: member(id), data: { custom_id: `vote:${choice}` } });
  const first = await vote('alice', 0);
  assert.equal(first.type, 7, 'first vote just updates the card');
  assert.equal(first.data.components[0].components[0].label, '👍 Yes · 1', 'one option = plain yes/no, no "A"');
  await vote('bob', 0);
  assert.equal(status(), 'approved', 'second vote clears the bar');
  assert.ok(calls.includes('POST /repos/o/r/issues'));

  // A Hive Worker gets a token and works the task through the API.
  const { data } = await send({ type: 2, member: member('worker', '0', ['role1']), data: { name: 'hive', options: [{ name: 'worker' }] } });
  const token = data.content.match(/hive_[0-9a-f]+/)[0];
  const call = (method: string, path: string, body?: unknown) =>
    api(new Request(`https://hive.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), env, db);

  assert.equal(((await (await call('GET', '/api/tasks')).json()) as any)[0].issue, 7);
  assert.equal((await call('POST', '/api/tasks/7/claim')).status, 200);
  assert.equal((await call('POST', '/api/tasks/7/claim')).status, 409, 'no double claims');
  assert.equal(status(), 'building');
  assert.equal((await call('POST', '/api/tasks/7/submit', { pr: 9 })).status, 200);
  assert.ok(calls.includes('PUT /repos/o/r/pulls/9/merge'), 'auto-merges a clean PR');
  assert.equal(status(), 'shipped');
  assert.ok(calls.includes('PUT /guilds/g/members/alice/roles/role4'), 'the idea author becomes a Pollinator');
  const shipped = sent['POST /channels/thread1/messages'].find((m) => m.content.startsWith('🚀'));
  assert.deepEqual(shipped.allowed_mentions, { users: ['alice'] }, 'mentioning the role does not ping every Pollinator');

  await tick(env, db); // nothing left in flight; must not throw

  // Second idea with an alternative up front; a maintainer approves option B with a reason.
  await send({ type: 5, member: member('alice'), data: { custom_id: 'idea', components: [
    { type: 1, components: [{ type: 4, custom_id: 'title', value: 'Themes' }] },
    { type: 1, components: [{ type: 4, custom_id: 'spec', value: 'Light and dark themes' }] },
    { type: 1, components: [{ type: 4, custom_id: 'alt1', value: 'Full custom colors' }] },
    { type: 1, components: [{ type: 4, custom_id: 'alt2', value: '' }] },
  ] } });
  assert.equal(JSON.parse(String(sqlite.prepare("SELECT options FROM ideas WHERE thread_id = 'thread2'").get()?.options)).length, 2, 'empty alternatives are skipped');
  const click = (id: string, perms: string, custom_id: string) => send({ type: 3, channel_id: 'thread2', member: member(id, perms), data: { custom_id } });
  assert.equal((await click('alice', '0', 'approve:1')).data.flags, 64, 'only maintainers can approve');
  assert.equal((await click('owner', '32', 'approve:1')).type, 9, 'approve asks for a reason');
  await send({ type: 5, channel_id: 'thread2', member: member('owner', '32'), data: { custom_id: 'approve:1', components: [
    { type: 1, components: [{ type: 4, custom_id: 'reason', value: 'Ship the fun one' }] },
  ] } });
  assert.equal(status('thread2'), 'approved');
  assert.equal(sqlite.prepare("SELECT winner FROM ideas WHERE thread_id = 'thread2'").get()?.winner, 1);
  const note = sent['POST /channels/thread2/messages'].find((m) => m.content.includes('Ship the fun one'));
  assert.equal(note?.content, '✅ Approved option **B** by <@owner>: Ship the fun one');
  assert.deepEqual(note.allowed_mentions, { users: ['owner'] }, 'typed reasons can only ping the maintainer');

  // The Hive Mind role alone (no Manage Server) is enough to act as a maintainer.
  assert.equal((await send({ type: 3, channel_id: 'thread2', member: member('mindy', '0', ['role3']), data: { custom_id: 'veto' } })).type, 9,
    'Hive Mind can veto (an approved idea is still vetoable until someone builds it)');
  const mindSetup = await send({ type: 3, member: member('mindy', '0', ['role3']), data: { custom_id: 'setup:go:0' } });
  assert.equal(mindSetup.type, 7, 'Hive Mind can open the setup wizard');
  const manny = member('manny', '0', ['role2']);
  assert.equal((await send({ type: 3, channel_id: 'thread2', member: manny, data: { custom_id: 'veto' } })).type, 9, 'Hive Manager can veto');
  assert.equal((await send({ type: 3, member: manny, data: { custom_id: 'setup:go:0' } })).data.flags, 64, 'but cannot change setup');

  // Guided setup: no options opens the wizard; picks save right away and hide steps that no longer apply.
  await send({ type: 2, member: member('owner', '32', ['role3']), data: { name: 'hive', options: [{ name: 'setup' }] } });
  const opened = sent['PATCH /webhooks/app/tok/messages/@original'].at(-1);
  assert.equal(opened.embeds[0].title, '🐝 HiveCode setup · step 1 of 6');
  const picked = await send({ type: 3, member: member('owner', '32'), data: { custom_id: 'setup:0:approval', values: ['owner'] } });
  assert.equal(sqlite.prepare('SELECT approval FROM guilds').get()?.approval, 'owner');
  assert.equal(picked.data.embeds[0].title, '🐝 HiveCode setup · step 1 of 4', 'voting steps hidden when maintainers decide');
  await send({ type: 3, member: member('owner', '32'), data: { custom_id: 'setup:5:changelog_id', values: [] } });
  assert.equal(sqlite.prepare('SELECT changelog_id FROM guilds').get()?.changelog_id, null, 'clearing a dropdown clears the setting');
  const done = await send({ type: 3, member: member('owner', '32'), data: { custom_id: 'setup:done' } });
  assert.match(done.data.content, /HiveCode is ready/);
  assert.equal((await send({ type: 3, member: member('alice'), data: { custom_id: 'setup:go:1' } })).data.flags, 64, 'members cannot change setup');
});
