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

const TAG_NAMES = ['Discussing', 'Voting', 'Approved', 'Building', 'Review', 'Shipped', 'Rejected'];

// A fake Discord + GitHub good enough to drive the whole bot, and helpers to send it interactions.
function harness(replies: Record<string, unknown> = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const db: Db = {
    all: async (sql, ...p) => sqlite.prepare(sql).all(...(p as SQLInputValue[])) as any[],
    first: async (sql, ...p) => (sqlite.prepare(sql).get(...(p as SQLInputValue[])) ?? null) as any,
    run: async (sql, ...p) => Number(sqlite.prepare(sql).run(...(p as SQLInputValue[])).changes),
  };
  const env: Env = { DISCORD_APP_ID: 'app', DISCORD_TOKEN: 'bot', GITHUB_TOKEN: 'gh', GITHUB_REPO: 'o/r', PUBLIC_URL: 'https://hive.test' };
  const calls: string[] = [];
  const sent: Record<string, any[]> = {}; // request bodies per route
  const counters = { role: 0, thread: 0, issue: 0, other: 0 };
  replies = { 'GET /guilds/g/roles': [{ id: 'role1', position: 4 }, { id: 'role2', position: 3 }, { id: 'role3', position: 2 }, { id: 'role4', position: 1 }], ...replies };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${String(url).replace(/^https:\/\/[^/]+(\/api\/v10)?/, '')}`;
    calls.push(key);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (body !== undefined) (sent[key] ??= []).push(body);
    if (replies[key] === 404) return new Response('{"message":"Unknown Channel"}', { status: 404 });
    if (key in replies) return Response.json(replies[key]);
    if (key === 'POST /guilds/g/roles') return Response.json({ id: `role${++counters.role}` });
    if (key.endsWith('/threads')) return Response.json({ id: `thread${++counters.thread}` });
    if (key === 'POST /repos/o/r/issues') return Response.json({ number: 6 + ++counters.issue });
    // New channels get their name as id; forums echo their tags back with ids.
    if (key === 'POST /guilds/g/channels') {
      return Response.json({ id: body.name, available_tags: (body.available_tags ?? []).map((t: any, k: number) => ({ ...t, id: `tag${k}` })) });
    }
    return Response.json({ id: `id${++counters.other}` });
  }) as typeof fetch;

  const member = (id: string, permissions = '0', roles: string[] = []) => ({ user: { id }, permissions, roles });
  const send = async (ix: any) => {
    const reply = await interaction({ guild_id: 'g', token: 'tok', ...ix }, env, db);
    await reply.after?.();
    return reply.body as any;
  };
  const get = (sql: string, ...p: SQLInputValue[]): any => ({ ...sqlite.prepare(sql).get(...p) });
  const original = () => sent['PATCH /webhooks/app/tok/messages/@original'].at(-1);
  return { db, env, calls, sent, member, send, get, original, replies };
}

test('setup → idea → vote → issue → worker → PR → ship, plus maintainer tools', async () => {
  const { db, env, calls, sent, member, send, get, original, replies } = harness({
    'GET /guilds/g/members/worker': { roles: ['role1'] },
    'GET /guilds/g/members/rival': { roles: ['role1'] },
    'GET /repos/o/r/pulls/9': { number: 9, merged: false, mergeable_state: 'clean', head: { ref: 'hive/issue-7' } },
    'GET /repos/o/r/pulls/9/files?per_page=100': [{ filename: 'src/dark.css' }],
    'GET /repos/o/r/issues?labels=hive%3Aapproved&state=all&sort=updated&per_page=100': [{ number: 7, state: 'open' }],
    'GET /repos/o/r/pulls?state=open&per_page=100': [{ number: 9, head: { ref: 'hive/issue-7' }, body: 'Closes #7' }],
  });
  const status = (id = 'thread1') => get('SELECT status FROM ideas WHERE thread_id = ?', id).status;

  // Owner sets up with shortcuts: 2+ votes at 60%, no discussion phase, Hive Workers build, auto-merge.
  await send({ type: 2, member: member('owner', '32'), data: { name: 'hive', options: [{ name: 'setup', options: [
    { name: 'min_votes', value: 2 }, { name: 'approve_pct', value: 60 }, { name: 'discuss_hours', value: 0 },
    { name: 'builder', value: 'workers' }, { name: 'merge', value: 'auto' },
  ] }] } });
  assert.equal(get('SELECT builder FROM guilds').builder, 'workers');

  // Roles: Worker, Manager, Mind, Pollinator, each landing at the bottom, then sorted; the person running setup gets Hive Mind.
  assert.deepEqual(get('SELECT worker_role_id, manager_role_id, mind_role_id, pollinator_role_id FROM guilds'),
    { worker_role_id: 'role1', manager_role_id: 'role2', mind_role_id: 'role3', pollinator_role_id: 'role4' });
  assert.deepEqual(sent['PATCH /guilds/g/roles'][0],
    [{ id: 'role3', position: 4 }, { id: 'role2', position: 3 }, { id: 'role1', position: 2 }, { id: 'role4', position: 1 }]);
  assert.ok(calls.includes('PUT /guilds/g/members/owner/roles/role3'), 'whoever runs setup gets Hive Mind');
  assert.deepEqual(sent['PUT /channels/hive-ideas/permissions/role2'][0], { type: 0, allow: String(1n << 34n) }, 'managers moderate the forum');

  // Channels: a category with the guide, the forum, stats and a private workers channel, each with its post.
  assert.deepEqual(sent['POST /guilds/g/channels'].map((c) => c.name), ['🐝 HiveCode', 'hive-guide', 'hive-ideas', 'hive-stats', 'hive-workers']);
  const workersChannel = sent['POST /guilds/g/channels'][4];
  assert.equal(workersChannel.permission_overwrites[0].deny, String(1n << 10n), 'only workers and maintainers can see #hive-workers');
  assert.equal(sent['POST /channels/hive-guide/messages'][0].embeds[0].title, '🐝 How ideas work here');
  assert.equal(sent['POST /channels/hive-stats/messages'][0].embeds[0].title, '📊 Hive stats');
  assert.equal(sent['POST /channels/hive-workers/messages'][0].embeds[0].title, '🐝 Welcome, Hive Worker');
  const guideMessage = get('SELECT guide_message_id FROM guilds').guide_message_id;
  assert.ok(guideMessage, 'the guide message id is saved so it can be edited later');

  // First idea: one option, voted through.
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
  const login = async (id: string) =>
    (await send({ type: 2, member: member(id, '0', ['role1']), data: { name: 'hive', options: [{ name: 'worker' }] } })).data.content.match(/hive_[0-9a-f]+/)[0];
  const as = (token: string) => (method: string, path: string, body?: unknown) =>
    api(new Request(`https://hive.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), env, db);
  const call = as(await login('worker'));
  const rival = as(await login('rival'));
  assert.equal(((await (await call('GET', '/api/tasks')).json()) as any)[0].issue, 7);
  assert.equal((await call('POST', '/api/tasks/7/claim')).status, 200);
  assert.equal((await rival('POST', '/api/tasks/7/claim')).status, 409, 'nobody else can take a claimed task');
  assert.equal((await call('POST', '/api/tasks/7/claim')).status, 200, 'claiming again yourself is harmless');
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
  assert.equal(JSON.parse(get("SELECT options FROM ideas WHERE thread_id = 'thread2'").options).length, 2, 'empty alternatives are skipped');
  const click = (who: any, custom_id: string, extra = {}) => send({ type: 3, channel_id: 'thread2', member: who, data: { custom_id, ...extra } });
  assert.equal((await click(member('alice'), 'approve:1')).data.flags, 64, 'only maintainers can approve');
  assert.equal((await click(member('owner', '32'), 'approve:1')).type, 9, 'approve asks for a reason');
  await send({ type: 5, channel_id: 'thread2', member: member('owner', '32'), data: { custom_id: 'approve:1', components: [
    { type: 1, components: [{ type: 4, custom_id: 'reason', value: 'Ship the fun one' }] },
  ] } });
  assert.equal(status('thread2'), 'approved');
  assert.equal(get("SELECT winner FROM ideas WHERE thread_id = 'thread2'").winner, 1);
  const note = sent['POST /channels/thread2/messages'].find((m) => m.content.includes('Ship the fun one'));
  assert.equal(note?.content, '✅ Approved option **B** by <@owner>: Ship the fun one');
  assert.deepEqual(note.allowed_mentions, { users: ['owner'] }, 'typed reasons can only ping the maintainer');

  // Role powers: Hive Mind and Hive Manager can veto; only Hive Mind can change setup.
  const mindy = member('mindy', '0', ['role3']), manny = member('manny', '0', ['role2']);
  assert.equal((await click(mindy, 'veto')).type, 9, 'Hive Mind can veto');
  assert.equal((await click(manny, 'veto')).type, 9, 'Hive Manager can veto');
  assert.equal((await send({ type: 3, member: mindy, data: { custom_id: 'setup:go:0' } })).type, 7, 'Hive Mind can open setup');
  assert.equal((await send({ type: 3, member: manny, data: { custom_id: 'setup:go:0' } })).data.flags, 64, 'Hive Manager cannot');

  // A maintainer assigns the approved idea to a specific Hive Worker.
  const picker = await click(member('owner', '32'), 'assign');
  assert.equal(picker.data.components[0].components[0].type, 5, 'assign opens a member picker');
  const notWorker = await click(member('owner', '32'), 'assignto', { values: ['alice'], resolved: { members: { alice: { roles: [] } } } });
  assert.match(notWorker.data.content, /doesn't have the Hive Worker role/);
  assert.equal(status('thread2'), 'approved');
  await click(member('owner', '32'), 'assignto', { values: ['worker'], resolved: { members: { worker: { roles: ['role1'] } } } });
  assert.deepEqual(get("SELECT status, claimed_by FROM ideas WHERE thread_id = 'thread2'"), { status: 'building', claimed_by: 'worker' });
  const tasks = (await (await call('GET', '/api/tasks')).json()) as any[];
  assert.deepEqual(tasks.map((t) => [t.issue, t.assigned]), [[8, true]], 'the worker sees their assignment');
  assert.equal((await call('POST', '/api/tasks/8/claim')).status, 200, 'and can start it');

  // Guided setup: no options opens the wizard; picks save right away, update the guide, and hide steps that no longer apply.
  await send({ type: 2, member: member('owner', '32', ['role3']), data: { name: 'hive', options: [{ name: 'setup' }] } });
  assert.equal(original().embeds[0].title, '🐝 HiveCode setup · step 1 of 6');
  const picked = await send({ type: 3, member: member('owner', '32'), data: { custom_id: 'setup:0:approval', values: ['owner'] } });
  assert.equal(get('SELECT approval FROM guilds').approval, 'owner');
  assert.equal(picked.data.embeds[0].title, '🐝 HiveCode setup · step 1 of 4', 'voting steps hidden when maintainers decide');
  assert.match(sent[`PATCH /channels/hive-guide/messages/${guideMessage}`].at(-1).embeds[0].description, /A maintainer picks/, 'the guide follows the rules');
  await send({ type: 3, member: member('owner', '32'), data: { custom_id: 'setup:5:changelog_id', values: [] } });
  assert.equal(get('SELECT changelog_id FROM guilds').changelog_id, null, 'clearing a dropdown clears the setting');
  assert.equal((await send({ type: 3, member: member('owner', '32'), data: { custom_id: 'setup:mkchangelog:5' } })).type, 6);
  assert.equal(get('SELECT changelog_id FROM guilds').changelog_id, 'hive-changelog', 'the wizard can create a changelog channel');
  const done = await send({ type: 3, member: member('owner', '32'), data: { custom_id: 'setup:done' } });
  assert.match(done.data.content, /HiveCode is ready/);
  assert.equal((await send({ type: 3, member: member('alice'), data: { custom_id: 'setup:go:1' } })).data.flags, 64, 'members cannot change setup');

  // Someone deleted #hive-stats: the next setup notices and recreates it.
  replies['GET /channels/hive-stats'] = 404;
  await send({ type: 2, member: member('owner', '32'), data: { name: 'hive', options: [{ name: 'setup' }] } });
  assert.equal(sent['POST /guilds/g/channels'].filter((c) => c.name === 'hive-stats').length, 2);
});

test('first setup can use a forum the server already has', async () => {
  const { send, member, get, calls, sent, original } = harness({
    'GET /guilds/g/channels': [{ id: 'suggestions', type: 15 }, { id: 'general', type: 0 }],
    'GET /channels/suggestions': { id: 'suggestions', type: 15, available_tags: [{ id: 'bug', name: 'Bug' }] },
    'PATCH /channels/suggestions': { id: 'suggestions', available_tags: [{ id: 'bug', name: 'Bug' }, ...TAG_NAMES.map((name, k) => ({ id: `t${k}`, name }))] },
  });
  const owner = member('owner', '32');

  await send({ type: 2, member: owner, data: { name: 'hive', options: [{ name: 'setup' }] } });
  assert.deepEqual(original().components[0].components[0].channel_types, [15], 'asks which forum to use');
  assert.ok(!calls.includes('POST /guilds/g/roles'), 'nothing is created before the choice');

  assert.equal((await send({ type: 3, member: owner, data: { custom_id: 'setup:forum', values: ['suggestions'] } })).type, 6);
  assert.equal(get('SELECT forum_id FROM guilds').forum_id, 'suggestions');
  assert.equal(sent['PATCH /channels/suggestions'][0].available_tags.length, 8, 'keeps their tags and adds the 7 status tags');
  assert.equal(JSON.parse(get('SELECT tags FROM guilds').tags).discussing, 't0');
  assert.ok(calls.includes('PUT /channels/suggestions/permissions/app'), 'the bot can post there');
  assert.ok(!sent['POST /guilds/g/channels'].some((c) => c.name === 'hive-ideas'), 'no new forum');
  assert.equal(original().embeds[0].title, '🐝 HiveCode setup · step 1 of 6', 'then the guide continues');
});
