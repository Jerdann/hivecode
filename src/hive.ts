// HiveCode core. Runtime-agnostic: the Cloudflare and Node entry points both call
// interaction(), api() and tick() and supply their own database.
import { tally, verdict, winner, type Tally } from './votes.ts';

export interface Env {
  DISCORD_APP_ID: string;
  DISCORD_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string; // owner/repo
  PUBLIC_URL?: string;
}

// The slice of a SQLite client HiveCode needs. D1 and node:sqlite both fit it.
export interface Db {
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  run(sql: string, ...params: unknown[]): Promise<number>; // rows changed
}

// The response for Discord, plus slow work to run after responding (Discord wants an answer in 3s).
export interface Reply { body: unknown; after?: () => Promise<void> }

type Status =
  | 'discussing' | 'voting' | 'pending_owner' | 'approved' | 'building'
  | 'review' | 'shipping_vote' | 'shipped' | 'rejected' | 'vetoed';

export interface Guild {
  guild_id: string; forum_id: string; tags: string;
  worker_role_id: string; manager_role_id: string | null; mind_role_id: string | null;
  voter_role_id: string | null; changelog_id: string | null;
  min_votes: number; approve_pct: number; discuss_hours: number; vote_hours: number;
  approval: 'vote' | 'vote+owner' | 'owner' | 'auto';
  builder: 'manual' | 'action' | 'workers';
  merge: 'owner' | 'vote' | 'auto';
  options_by: 'author' | 'anyone';
}

export interface Idea {
  thread_id: string; guild_id: string; author_id: string; title: string;
  options: string; // JSON Opt[]
  status: Status; phase_ends: number | null; winner: number | null;
  issue: number | null; pr: number | null;
  claimed_by: string | null; claimed_at: number | null;
  merge_state: 'auto' | 'manual' | null;
}

interface Opt { text: string; by: string }

const HOUR = 3_600_000;
const CLAIM_HOURS = 6;
const MAX_OPTIONS = 4;
const MAX_OPEN_IDEAS = 3;
const COLOR = 0x4a64ff;
const HONEY = 0xf5b700;
const AMBER = 0xff8c1a;
const MANAGE_GUILD = 0x20n;
const SEND = 1n << 11n, MANAGE_THREADS = 1n << 34n, SEND_IN_THREADS = 1n << 38n;

const TAGS = {
  discussing: ['Discussing', '💬'], voting: ['Voting', '📊'], approved: ['Approved', '✅'],
  building: ['Building', '🔨'], review: ['Review', '👀'], shipped: ['Shipped', '🚀'], rejected: ['Rejected', '❌'],
} as const;
const TAG_OF: Record<Status, keyof typeof TAGS> = {
  discussing: 'discussing', voting: 'voting', pending_owner: 'voting', approved: 'approved', building: 'building',
  review: 'review', shipping_vote: 'review', shipped: 'shipped', rejected: 'rejected', vetoed: 'rejected',
};
const VETOABLE: Status[] = ['discussing', 'voting', 'pending_owner', 'approved'];
const SETTINGS = ['approval', 'min_votes', 'approve_pct', 'discuss_hours', 'vote_hours', 'builder', 'merge', 'options_by'];

const options = (i: Idea): Opt[] => JSON.parse(i.options);
const letter = (i: number) => String.fromCharCode(65 + i);
const when = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;
const usesVoting = (g: Guild) => g.approval === 'vote' || g.approval === 'vote+owner';
const link = (env: Env, kind: 'issues' | 'pull', n: number) => `[#${n}](https://github.com/${env.GITHUB_REPO}/${kind}/${n})`;

// ---------- REST ----------

async function call(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const where = url.replace(/^https:\/\/[^/]+/, '').replace(/webhooks\/\d+\/[^/]+/, 'webhooks/…');
    throw new Error(`${init.method} ${where} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// ponytail: no 429 retry; fine at community scale, add Retry-After handling if bursts hit limits.
const discord = (env: Env, method: string, path: string, body?: unknown): Promise<any> =>
  call(`https://discord.com/api/v10${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  });

const github = (env: Env, method: string, path: string, body?: unknown): Promise<any> =>
  call(`https://api.github.com${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'User-Agent': 'hivecode', 'X-GitHub-Api-Version': '2022-11-28',
    },
  });

// By default any user or role mentioned pings. When the message includes text someone typed, pass
// `users` so only those people can be pinged.
const say = (env: Env, channel: string, content: string, users?: string[]) =>
  discord(env, 'POST', `/channels/${channel}/messages`, { content, allowed_mentions: users ? { users } : { parse: ['users', 'roles'] } });

// ---------- Spec card ----------

function rules(g: Guild) {
  const yes = g.approve_pct ? `${g.approve_pct}% yes` : 'a yes majority';
  return g.min_votes ? `Passes as soon as it has ${g.min_votes}+ votes and ${yes}` : `Passes with ${yes} when voting closes`;
}

function statusLine(env: Env, i: Idea, g: Guild): string {
  switch (i.status) {
    case 'discussing': return i.phase_ends ? `💬 Discussing. Voting opens ${when(i.phase_ends)}` : '💬 Discussing. A maintainer will pick an option.';
    case 'voting': return `📊 Voting closes ${when(i.phase_ends!)}\n${rules(g)}`;
    case 'pending_owner': return `⏳ The hive ${options(i).length > 1 ? `picked **Option ${letter(i.winner!)}**` : 'voted yes'}. Waiting for a maintainer to confirm.`;
    case 'approved':
      if (!i.issue) return '✅ Approved. Creating the GitHub issue…';
      return `✅ Approved as ${link(env, 'issues', i.issue)}. ${g.builder === 'workers' ? 'Waiting for a Hive Worker to claim it.' : 'Waiting for a maintainer to build it.'}`;
    case 'building': return `🔨 Building ${link(env, 'issues', i.issue!)}${i.claimed_by ? `, claimed by <@${i.claimed_by}>` : ''}`;
    case 'review': return `👀 In review: ${link(env, 'pull', i.pr!)}. ${i.merge_state === 'auto' ? 'Merging once checks pass.' : 'Waiting for a maintainer to merge.'}`;
    case 'shipping_vote': return `📊 Ship vote on ${link(env, 'pull', i.pr!)} closes ${when(i.phase_ends!)}\n${rules(g)}`;
    case 'shipped': return `🚀 Shipped${i.pr ? ` in ${link(env, 'pull', i.pr)}` : ''}`;
    case 'rejected': return '❌ Rejected';
    case 'vetoed': return '⛔ Vetoed by a maintainer';
  }
}

const btn = (custom_id: string, label: string, style = 2) => ({ type: 2, custom_id, label, style });
const row = (...components: unknown[]) => ({ type: 1, components });

function controls(i: Idea, g: Guild, t: Tally) {
  const opts = options(i);
  const single = opts.length === 1;
  const all = opts.map((_, n) => n);
  // Maintainer tools: approve (per option when there are several) or veto, any time before it's decided.
  const decide = (which: number[]) => row(
    ...which.map((n) => btn(`approve:${n}`, single ? '✅ Approve' : `✅ Approve ${letter(n)}`, 3)),
    btn('veto', '⛔ Veto', 4),
  );
  switch (i.status) {
    case 'discussing': return usesVoting(g) ? [row(btn('open', 'Open voting now')), decide(all)] : [decide(all)];
    case 'voting': return [
      row(...(single
        ? [btn('vote:0', `👍 Yes · ${t.counts[0]}`, 1), btn('vote:-1', `👎 No · ${t.reject}`)]
        : [...opts.map((_, n) => btn(`vote:${n}`, `Option ${letter(n)} · ${t.counts[n]}`, 1)), btn('vote:-1', `Reject · ${t.reject}`)])),
      decide(all),
    ];
    case 'pending_owner': return [decide([i.winner!])];
    case 'shipping_vote': return [row(btn('ship:0', `Ship it · ${t.counts[0]}`, 3), btn('ship:-1', `Not yet · ${t.reject}`, 4))];
    default: return [];
  }
}

async function tallyOf(db: Db, i: Idea, round: 'idea' | 'ship') {
  const votes = await db.all<{ choice: number }>('SELECT choice FROM votes WHERE thread_id = ? AND round = ?', i.thread_id, round);
  return tally(votes, round === 'ship' ? 1 : options(i).length);
}

async function view(env: Env, db: Db, i: Idea, g: Guild) {
  const t = await tallyOf(db, i, i.status === 'shipping_vote' ? 'ship' : 'idea');
  const opts = options(i);
  // The post already shows the title, so the card is just the spec. Options only get labels once there are two.
  // (Headings live in the description rather than embed fields, which cap at 1024 characters.)
  const description = opts.length === 1 ? `**Idea description**\n${opts[0].text}` : opts
    .map((o, n) => `${i.winner === n ? '✅ ' : ''}**Option ${letter(n)}**${n ? `  _suggested by <@${o.by}>_` : ''}\n${o.text}`)
    .join('\n\n');
  const footer = i.status === 'discussing' ? 'Reply below to discuss · to add another option, right-click a reply → Apps → Add as option' : 'HiveCode';
  return {
    embeds: [{ description, color: COLOR, fields: [{ name: 'Status', value: statusLine(env, i, g) }], footer: { text: `🐝 ${footer}` } }],
    components: controls(i, g, t),
  };
}

// Re-render the card and the forum tag. Rejected ideas get locked.
async function refresh(env: Env, db: Db, i: Idea, g: Guild) {
  const tags = JSON.parse(g.tags);
  const locked = i.status === 'rejected' || i.status === 'vetoed';
  await discord(env, 'PATCH', `/channels/${i.thread_id}`, { archived: false, locked, applied_tags: [tags[TAG_OF[i.status]]] });
  await discord(env, 'PATCH', `/channels/${i.thread_id}/messages/${i.thread_id}`, await view(env, db, i, g));
}

// ---------- State transitions ----------

// Atomic: only moves if the idea is still in one of `from`. Returns the updated idea, or null if someone beat us to it.
async function move(db: Db, i: Idea, from: Status[], to: Status, set: Partial<Idea> = {}): Promise<Idea | null> {
  const fields: Record<string, unknown> = { ...set, status: to };
  const keys = Object.keys(fields);
  const changed = await db.run(
    `UPDATE ideas SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE thread_id = ? AND status IN (${from.map(() => '?').join(', ')})`,
    ...keys.map((k) => fields[k] ?? null), i.thread_id, ...from,
  );
  return changed ? ({ ...i, ...fields } as Idea) : null;
}

async function openVoting(env: Env, db: Db, i: Idea, g: Guild) {
  const next = await move(db, i, ['discussing'], 'voting', { phase_ends: Date.now() + g.vote_hours * HOUR });
  if (!next) return;
  await refresh(env, db, next, g);
  await say(env, i.thread_id, '📊 Voting is open!');
}

async function approve(env: Env, db: Db, i: Idea, g: Guild, choice: number, byOwner: boolean) {
  if (g.approval === 'vote+owner' && !byOwner) {
    const next = await move(db, i, ['voting'], 'pending_owner', { winner: choice, phase_ends: null });
    if (!next) return;
    await refresh(env, db, next, g);
    const maintainers = [g.mind_role_id, g.manager_role_id].filter(Boolean).map((r) => `<@&${r}>`).join(' ');
    await say(env, i.thread_id, `⏳ The hive ${options(i).length > 1 ? `picked **Option ${letter(choice)}**` : 'voted yes'}. ${maintainers || 'A maintainer'}: please confirm with ✅ Approve or ⛔ Veto.`);
    return;
  }
  const next = await move(db, i, ['discussing', 'voting', 'pending_owner'], 'approved', { winner: choice, phase_ends: null });
  if (!next) return;
  await refresh(env, db, next, g);
  try {
    await ensureIssue(env, db, next, g);
  } catch (e) {
    await say(env, i.thread_id, `⚠️ Couldn't create the GitHub issue, retrying every minute. ${(e as Error).message.slice(0, 200)}`);
  }
}

// Creates the GitHub issue for an approved idea. issue = 0 acts as a lock so a retry can't double-create.
async function ensureIssue(env: Env, db: Db, i: Idea, g: Guild) {
  if (!(await db.run('UPDATE ideas SET issue = 0 WHERE thread_id = ? AND issue IS NULL', i.thread_id))) return;
  let issue: number;
  try {
    const res = await github(env, 'POST', `/repos/${env.GITHUB_REPO}/issues`, {
      title: i.title,
      body: `${options(i)[i.winner ?? 0].text}\n\n---\n🐝 Approved by the hive on Discord: https://discord.com/channels/${i.guild_id}/${i.thread_id}`,
      labels: ['hive:approved'],
    });
    issue = res.number;
  } catch (e) {
    await db.run('UPDATE ideas SET issue = NULL WHERE thread_id = ?', i.thread_id);
    throw e;
  }
  const status: Status = g.builder === 'action' ? 'building' : 'approved';
  await db.run('UPDATE ideas SET issue = ?, status = ? WHERE thread_id = ?', issue, status, i.thread_id);
  // A separate label call so the `issues: labeled` workflow trigger always fires.
  if (g.builder === 'action') await github(env, 'POST', `/repos/${env.GITHUB_REPO}/issues/${issue}/labels`, { labels: ['hive:build'] });
  await refresh(env, db, { ...i, issue, status }, g);
  const l = link(env, 'issues', issue);
  await say(env, i.thread_id,
    g.builder === 'workers' ? `<@&${g.worker_role_id}> 🐝 New task: ${l}. Claim it with \`node hive-worker.mts work ${issue}\`.`
    : g.builder === 'action' ? `🔨 Sent to the AI agent: ${l}`
    : `✅ Created ${l} for the maintainer to build.`);
}

async function reject(env: Env, db: Db, i: Idea, g: Guild, to: 'rejected' | 'vetoed', from: Status[], note: string, users?: string[]) {
  const next = await move(db, i, from, to, { phase_ends: null });
  if (!next) return;
  await say(env, i.thread_id, note, users);
  await refresh(env, db, next, g);
  if (next.issue) await github(env, 'PATCH', `/repos/${env.GITHUB_REPO}/issues/${next.issue}`, { state: 'closed', state_reason: 'not_planned' });
}

async function release(env: Env, db: Db, i: Idea, g: Guild, note: string) {
  const next = await move(db, i, ['building'], 'approved', { claimed_by: null, claimed_at: null });
  if (!next) return;
  await github(env, 'DELETE', `/repos/${env.GITHUB_REPO}/issues/${i.issue}/labels/hive%3Aclaimed`).catch(() => {});
  await refresh(env, db, next, g);
  await say(env, i.thread_id, note);
}

async function prOpened(env: Env, db: Db, i: Idea, g: Guild, pr: number) {
  const vote = g.merge === 'vote';
  const next = await move(db, i, ['approved', 'building'], vote ? 'shipping_vote' : 'review', {
    pr, phase_ends: vote ? Date.now() + g.vote_hours * HOUR : null, merge_state: vote ? null : g.merge === 'auto' ? 'auto' : 'manual',
  });
  if (!next) return;
  await refresh(env, db, next, g);
  await say(env, i.thread_id, `👀 ${link(env, 'pull', pr)} is up${vote ? '. Vote below to ship it!' : ' for review.'}`);
  if (next.merge_state === 'auto') await tryMerge(env, db, next, g);
}

async function prClosed(env: Env, db: Db, i: Idea, g: Guild) {
  const next = await move(db, i, ['review', 'shipping_vote'], 'approved', { pr: null, claimed_by: null, claimed_at: null, phase_ends: null, merge_state: null });
  if (!next) return;
  await db.run("DELETE FROM votes WHERE thread_id = ? AND round = 'ship'", i.thread_id);
  await github(env, 'DELETE', `/repos/${env.GITHUB_REPO}/issues/${i.issue}/labels/hive%3Aclaimed`).catch(() => {});
  await refresh(env, db, next, g);
  await say(env, i.thread_id, `🔁 PR #${i.pr} was closed without merging. ${
    g.builder === 'workers' ? 'The task is back in the queue.' : g.builder === 'action' ? 'Re-add the `hive:build` label on the issue to retry.' : 'Back to the maintainer.'}`);
}

async function shipVoteDone(env: Env, db: Db, i: Idea, g: Guild, pass: boolean) {
  const next = await move(db, i, ['shipping_vote'], 'review', { phase_ends: null, merge_state: pass ? 'auto' : 'manual' });
  if (!next) return;
  await refresh(env, db, next, g);
  await say(env, i.thread_id, pass ? '✅ The hive says ship it! Merging once checks pass.' : '🤔 The hive said not yet. A maintainer decides what happens next.');
  if (pass) await tryMerge(env, db, next, g);
}

// Merges once GitHub says the PR is clean. PRs touching .github/ always need a human:
// a workflow change merged by vote could leak the repo's secrets.
async function tryMerge(env: Env, db: Db, i: Idea, g: Guild) {
  const repo = env.GITHUB_REPO;
  const pr = await github(env, 'GET', `/repos/${repo}/pulls/${i.pr}`);
  if (pr.merged) return ship(env, db, i, g);
  if (pr.mergeable_state !== 'clean') return; // checks pending or failing; try again next tick
  const files: { filename: string }[] = await github(env, 'GET', `/repos/${repo}/pulls/${i.pr}/files?per_page=100`);
  if (files.length >= 100 || files.some((f) => f.filename.startsWith('.github/'))) {
    const next = await move(db, i, ['review'], 'review', { merge_state: 'manual' });
    if (next) {
      await refresh(env, db, next, g);
      await say(env, i.thread_id, '🛡️ This PR changes `.github/` (or too many files to check), so a maintainer has to merge it.');
    }
    return;
  }
  await github(env, 'PUT', `/repos/${repo}/pulls/${i.pr}/merge`, { merge_method: 'squash' });
  await ship(env, db, i, g);
}

async function ship(env: Env, db: Db, i: Idea, g: Guild) {
  const next = await move(db, i, ['approved', 'building', 'review', 'shipping_vote'], 'shipped', { phase_ends: null });
  if (!next) return;
  await refresh(env, db, next, g);
  await say(env, i.thread_id, `🚀 Shipped! Thanks <@${i.author_id}> for the idea.`);
  if (g.changelog_id) {
    const where = i.pr ? link(env, 'pull', i.pr) : link(env, 'issues', i.issue!);
    await discord(env, 'POST', `/channels/${g.changelog_id}/messages`, {
      content: `🚀 **${i.title}** shipped in ${where}. Idea by <@${i.author_id}> · <#${i.thread_id}>`,
      allowed_mentions: { parse: [] },
    });
  }
}

// ---------- Discord interactions ----------

const msg = (content: string): Reply => ({ body: { type: 4, data: { content, flags: 64 } } });

// Acknowledge now, finish the work after, then replace the "thinking…" message with the result.
function deferred(env: Env, ix: any, work: () => Promise<string | object>): Reply {
  return {
    body: { type: 5, data: { flags: 64 } },
    after: async () => {
      let data: object;
      try {
        const result = await work();
        data = typeof result === 'string' ? { content: result } : result;
      } catch (e) {
        console.error(e);
        data = { content: `⚠️ ${(e as Error).message}`.slice(0, 1900) };
      }
      await discord(env, 'PATCH', `/webhooks/${env.DISCORD_APP_ID}/${ix.token}/messages/@original`, data);
    },
  };
}

// Modal values, for both the classic action-row layout and the newer label layout.
function fields(ix: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of ix.data.components) for (const x of c.components ?? [c.component]) if (x?.custom_id) out[x.custom_id] = x.value;
  return out;
}

const input = (custom_id: string, label: string, style: number, max_length: number, value?: string, required = true) =>
  row({ type: 4, custom_id, label, style, max_length, required, ...(value ? { value } : {}) });

// New ideas can come with up to two alternatives, which become options B and C. Editing only touches the main one.
const ideaModal = (custom_id: string, title: string, idea?: Idea) => ({
  body: {
    type: 9,
    data: {
      custom_id, title, components: [
        input('title', 'Title', 1, 90, idea?.title),
        input('spec', 'What should be built?', 2, 1500, idea && options(idea)[0].text),
        ...(idea ? [] : [
          input('alt1', 'Another way to do it (optional)', 2, 500, undefined, false),
          input('alt2', 'A third way (optional)', 2, 500, undefined, false),
        ]),
      ],
    },
  },
});

export async function interaction(ix: any, env: Env, db: Db): Promise<Reply> {
  if (!ix.guild_id) return msg('HiveCode only works inside a server.');
  const g = await db.first<Guild>('SELECT * FROM guilds WHERE guild_id = ?', ix.guild_id);
  const user: string = ix.member.user.id;
  // admin (setup + decisions): Manage Server or Hive Mind. owner (decisions: approve, veto, open voting): admins and Hive Managers.
  const has = (role: string | null | undefined) => !!role && ix.member.roles.includes(role);
  const admin = (BigInt(ix.member.permissions) & MANAGE_GUILD) !== 0n || has(g?.mind_role_id);
  const owner = admin || has(g?.manager_role_id);

  if (ix.type === 2 && ix.data.name === 'hive') {
    const sub = ix.data.options[0];
    if (sub.name === 'setup') return admin ? deferred(env, ix, () => setup(env, db, ix, g, sub.options ?? [])) : msg('Only the Hive Mind role (or Manage Server) can run setup.');
    if (!g) return msg('Ask a server manager to run `/hive setup` first.');
    if (sub.name === 'worker') return workerToken(env, db, ix, g);
    if (sub.name === 'edit') {
      const idea = await db.first<Idea>('SELECT * FROM ideas WHERE thread_id = ?', ix.channel_id);
      if (!idea || idea.author_id !== user) return msg('Run this inside your own idea post.');
      if (idea.status !== 'discussing') return msg('Ideas are frozen once voting starts.');
      return ideaModal('edit', 'Edit your idea', idea);
    }
  }
  if (!g) return msg('Ask a server manager to run `/hive setup` first.');

  if (ix.type === 2 && ix.data.name === 'idea') {
    const open = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM ideas WHERE guild_id = ? AND author_id = ? AND status IN ('discussing', 'voting', 'pending_owner')", ix.guild_id, user);
    if (!owner && open!.n >= MAX_OPEN_IDEAS) return msg(`You already have ${MAX_OPEN_IDEAS} ideas in discussion or voting. Let those finish first.`);
    return ideaModal('idea', 'Suggest an idea');
  }
  if (ix.type === 2 && ix.data.type === 3) return addOption(env, db, ix, g, owner);
  if (ix.type === 5 && ix.data.custom_id === 'idea') return deferred(env, ix, () => createIdea(env, db, ix, g));
  if (ix.type === 5 && ix.data.custom_id === 'edit') return deferred(env, ix, () => saveEdit(env, db, ix, g));
  if (ix.type === 5 && /^(veto|approve:\d+)$/.test(ix.data.custom_id)) return decide(env, db, ix, g, owner);
  if (ix.type === 3 && String(ix.data.custom_id).startsWith('setup:')) return setupStep(db, ix, g, admin);
  if (ix.type === 3) return button(env, db, ix, g, owner);
  return msg('Unknown command.');
}

// ---------- Setup ----------

// With options it applies them directly; without, it opens the step-by-step wizard.
async function setup(env: Env, db: Db, ix: any, g: Guild | null, opts: { name: string; value: string | number }[]): Promise<string | object> {
  // Older installs lack the newer role columns. Adding one errors when it already exists, which is fine.
  for (const col of ['mind_role_id', 'manager_role_id']) await db.run(`ALTER TABLE guilds ADD COLUMN ${col} TEXT`).catch(() => {});
  const o = Object.fromEntries(opts.map((x) => [x.name, x.value]));
  const roles = await ensureRoles(env, db, ix, g);
  let forumId = g?.forum_id;
  if (!g) {
    const forum = await discord(env, 'POST', `/guilds/${ix.guild_id}/channels`, {
      name: 'hive-ideas', type: 15, default_auto_archive_duration: 10080,
      topic: 'Suggest features with /idea. The hive discusses, votes, and the AI builds.',
      available_tags: Object.values(TAGS).map(([name, emoji_name]) => ({ name, emoji_name })),
      // Posts only come through /idea (so they're tracked); everyone can still reply.
      permission_overwrites: [
        { id: ix.guild_id, type: 0, deny: String(SEND), allow: String(SEND_IN_THREADS) },
        { id: env.DISCORD_APP_ID, type: 1, allow: String(SEND | SEND_IN_THREADS | MANAGE_THREADS) },
      ],
    });
    const tags = Object.fromEntries(Object.entries(TAGS).map(([k, [name]]) => [k, forum.available_tags.find((t: any) => t.name === name).id]));
    await db.run('INSERT INTO guilds (guild_id, forum_id, worker_role_id, manager_role_id, mind_role_id, tags) VALUES (?, ?, ?, ?, ?, ?)',
      ix.guild_id, forum.id, roles.worker, roles.manager, roles.mind, JSON.stringify(tags));
    forumId = forum.id;
  }
  if (roles.newManager) {
    // Light moderation for Hive Managers, scoped to the ideas forum: lock, close, pin and delete posts.
    await discord(env, 'PUT', `/channels/${forumId}/permissions/${roles.manager}`, { type: 0, allow: String(MANAGE_THREADS) })
      .catch((e) => console.error('Giving Hive Manager forum permissions failed:', e));
  }
  const set: Record<string, unknown> = Object.fromEntries(SETTINGS.filter((k) => k in o).map((k) => [k, o[k]]));
  if ('voter_role' in o) set.voter_role_id = o.voter_role === ix.guild_id ? null : o.voter_role; // @everyone = no restriction
  if ('changelog' in o) set.changelog_id = o.changelog;
  const keys = Object.keys(set);
  if (keys.length) await db.run(`UPDATE guilds SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE guild_id = ?`, ...keys.map((k) => set[k]), ix.guild_id);

  const s = (await db.first<Guild>('SELECT * FROM guilds WHERE guild_id = ?', ix.guild_id))!;
  return opts.length ? summary(s) : wizard(s, 0);
}

// Hive Mind (owners), Hive Manager (moderators) and Hive Worker (builders), each shown as its own group in the
// member list, in that order. Whoever runs setup gets Hive Mind.
async function ensureRoles(env: Env, db: Db, ix: any, g: Guild | null) {
  const guild = ix.guild_id;
  const make = async (name: string, color: number): Promise<string> =>
    (await discord(env, 'POST', `/guilds/${guild}/roles`, { name, color, hoist: true, mentionable: true })).id;
  const worker = g?.worker_role_id || await make('Hive Worker', COLOR);
  const manager = g?.manager_role_id || await make('Hive Manager', AMBER);
  const mind = g?.mind_role_id || await make('Hive Mind', HONEY);
  const newManager = !g?.manager_role_id;
  if (newManager || !g?.mind_role_id) {
    if (g) await db.run('UPDATE guilds SET manager_role_id = ?, mind_role_id = ? WHERE guild_id = ?', manager, mind, guild);
    // New roles land at the bottom of the list. Reuse the three roles' slots in order: Mind, Manager, Worker. Cosmetic: never fatal.
    try {
      await discord(env, 'PATCH', `/guilds/${guild}/roles/${worker}`, { hoist: true }); // older installs made it without
      const all: { id: string; position: number }[] = await discord(env, 'GET', `/guilds/${guild}/roles`);
      const ids = [mind, manager, worker];
      const slots = ids.map((id) => all.find((r) => r.id === id)?.position ?? 0).sort((a, b) => b - a);
      await discord(env, 'PATCH', `/guilds/${guild}/roles`, ids.map((id, n) => ({ id, position: slots[n] })));
    } catch (e) {
      console.error('Sorting the Hive roles failed:', e);
    }
  }
  if (!ix.member.roles.includes(mind)) {
    await discord(env, 'PUT', `/guilds/${guild}/members/${ix.member.user.id}/roles/${mind}`).catch((e) => console.error('Giving Hive Mind failed:', e));
  }
  return { worker, manager, mind, newManager };
}

type Choice = [value: string | number, label: string, description?: string];
export const CHOICES: Record<string, Choice[]> = {
  approval: [
    ['vote', 'Community vote', 'Members vote; it passes when it clears your bar'],
    ['vote+owner', 'Community vote + maintainer OK', 'Members vote, then a maintainer confirms'],
    ['owner', 'Maintainers decide', 'No voting: a maintainer approves or vetoes'],
    ['auto', 'Approve everything (chaos)', 'Every idea goes straight to the builder'],
  ],
  min_votes: [[0, 'No vote minimum', 'Decided when voting closes'], [3, 'Needs 3 votes'], [5, 'Needs 5 votes'], [10, 'Needs 10 votes'], [20, 'Needs 20 votes'], [50, 'Needs 50 votes']],
  approve_pct: [[0, 'Simple majority', 'More yes than no'], [60, '60% yes'], [66, 'Two thirds yes'], [75, '75% yes'], [90, '90% yes']],
  discuss_hours: [[0, 'No discussion', 'Voting opens right away'], [1, 'Discuss for 1 hour'], [6, 'Discuss for 6 hours'], [12, 'Discuss for 12 hours'],
    [24, 'Discuss for 1 day'], [48, 'Discuss for 2 days'], [72, 'Discuss for 3 days'], [168, 'Discuss for 1 week']],
  vote_hours: [[1, 'Vote for 1 hour'], [6, 'Vote for 6 hours'], [12, 'Vote for 12 hours'], [24, 'Vote for 1 day'], [48, 'Vote for 2 days'],
    [72, 'Vote for 3 days'], [168, 'Vote for 1 week']],
  options_by: [['author', 'Idea author + maintainers add options'], ['anyone', 'Anyone can add options']],
  builder: [
    ['manual', 'You build it', 'HiveCode just creates the GitHub issue'],
    ['action', 'AI agent (GitHub Action)', 'Claude Code or Codex builds it and opens a PR'],
    ['workers', 'Hive Workers', 'Members with the Hive Worker role claim and build it'],
  ],
  merge: [
    ['owner', 'A maintainer merges', 'You review and merge the PR on GitHub'],
    ['vote', 'Community ship vote', 'Members vote on the finished PR'],
    ['auto', 'Auto-merge (chaos)', 'Merged as soon as checks pass'],
  ],
};
const NUMBERS = ['min_votes', 'approve_pct', 'discuss_hours', 'vote_hours'];
const WIZARD_FIELDS = [...SETTINGS, 'voter_role_id', 'changelog_id'];
const label = (field: string, value: unknown) => CHOICES[field].find(([v]) => String(v) === String(value))?.[1] ?? String(value);

// A dropdown for one setting, with the current value preselected (custom values from slash options included).
function pick(at: number, field: string, g: Guild) {
  const current = (g as any)[field];
  const list = CHOICES[field].some(([v]) => String(v) === String(current)) ? CHOICES[field] : [[current, `${current} (custom)`] as Choice, ...CHOICES[field]];
  return row({
    type: 3, custom_id: `setup:${at}:${field}`,
    options: list.map(([value, text, description]) => ({ label: text, value: String(value), ...(description ? { description } : {}), default: String(value) === String(current) })),
  });
}

const STEPS: { title: string; about: string; when?: (g: Guild) => boolean; rows: (g: Guild, at: number) => unknown[] }[] = [
  {
    title: 'How do ideas get approved?',
    about: 'Pick who has the final say. Hive Mind and Hive Manager can always approve or veto any idea by hand.',
    rows: (g, at) => [pick(at, 'approval', g)],
  },
  {
    title: 'What does an idea need to pass?',
    about: 'With a vote minimum, an idea passes the moment it clears both bars. With no minimum, it is decided when voting closes.',
    when: usesVoting, rows: (g, at) => [pick(at, 'min_votes', g), pick(at, 'approve_pct', g)],
  },
  {
    title: 'How long do discussion and voting last?',
    about: 'During discussion people reply and add alternative options. The idea freezes when voting opens.',
    when: usesVoting, rows: (g, at) => [pick(at, 'discuss_hours', g), pick(at, 'vote_hours', g)],
  },
  {
    title: 'Who can vote and add options?',
    about: 'Leave the role empty to let everyone vote. Options get added by right-clicking a reply → Apps → Add as option.',
    rows: (g, at) => [
      ...(usesVoting(g) ? [row({ type: 6, custom_id: `setup:${at}:voter_role_id`, placeholder: 'Everyone can vote (or pick a role)', min_values: 0, max_values: 1,
        default_values: g.voter_role_id ? [{ id: g.voter_role_id, type: 'role' }] : [] })] : []),
      pick(at, 'options_by', g),
    ],
  },
  {
    title: 'Who builds approved ideas, and who merges them?',
    about: '**AI agent** needs a workflow file and an AI key in your project repo. **Hive Workers** need `PUBLIC_URL` set. The README walks through both.',
    rows: (g, at) => [pick(at, 'builder', g), pick(at, 'merge', g)],
  },
  {
    title: 'Where should shipped ideas be announced?',
    about: 'Optional: pick a channel that gets a post every time an idea ships, or leave it empty.',
    rows: (g, at) => [row({ type: 8, custom_id: `setup:${at}:changelog_id`, placeholder: 'No changelog channel', channel_types: [0, 5], min_values: 0, max_values: 1,
      default_values: g.changelog_id ? [{ id: g.changelog_id, type: 'channel' }] : [] })],
  },
];

function wizard(g: Guild, at: number) {
  const shown = STEPS.flatMap((s, i) => (!s.when || s.when(g) ? [i] : []));
  if (!shown.includes(at)) at = shown.find((i) => i > at) ?? shown[shown.length - 1]; // the step got hidden by a change
  const n = shown.indexOf(at);
  const prev = shown[n - 1], next = shown[n + 1];
  return {
    content: '',
    embeds: [{
      title: `🐝 HiveCode setup · step ${n + 1} of ${shown.length}`, description: `**${STEPS[at].title}**\n${STEPS[at].about}`,
      color: COLOR, footer: { text: 'Changes save as soon as you pick them.' },
    }],
    components: [...STEPS[at].rows(g, at), row(
      ...(prev === undefined ? [] : [btn(`setup:go:${prev}`, '◀ Back')]),
      next === undefined ? btn('setup:done', '✅ Finish', 3) : btn(`setup:go:${next}`, 'Next ▶', 1),
    )],
  };
}

async function setupStep(db: Db, ix: any, g: Guild, admin: boolean): Promise<Reply> {
  if (!admin) return msg('Only the Hive Mind role (or Manage Server) can change setup.');
  const [, a, b] = String(ix.data.custom_id).split(':');
  if (a === 'done') return { body: { type: 7, data: { content: summary(g), embeds: [], components: [] } } };
  if (a === 'go') return { body: { type: 7, data: wizard(g, Number(b)) } };
  if (!WIZARD_FIELDS.includes(b)) return msg('Unknown setting.');
  const raw: string | undefined = ix.data.values?.[0];
  const value = raw === undefined ? null : NUMBERS.includes(b) ? Number(raw) : raw;
  await db.run(`UPDATE guilds SET ${b} = ? WHERE guild_id = ?`, value, g.guild_id);
  return { body: { type: 7, data: wizard({ ...g, [b]: value } as Guild, Number(a)) } };
}

function summary(s: Guild) {
  const voting = usesVoting(s);
  return [
    `🐝 **HiveCode is ready** in <#${s.forum_id}>.`,
    `**Roles:** <@&${s.mind_role_id}> owners (setup + decisions) · <@&${s.manager_role_id}> managers (approve, veto, moderate the forum) · <@&${s.worker_role_id}> builders (claim tasks with their own AI)`,
    `**Approval:** ${label('approval', s.approval)}${voting ? `. ${rules(s)}` : ''}`,
    voting ? `**Timing:** ${label('discuss_hours', s.discuss_hours)}, then ${label('vote_hours', s.vote_hours).toLowerCase()}` : '',
    voting ? `**Who votes:** ${s.voter_role_id ? `<@&${s.voter_role_id}>` : 'everyone'}` : '',
    `**New options:** ${label('options_by', s.options_by)}`,
    `**Builder:** ${label('builder', s.builder)} · **Merge:** ${label('merge', s.merge)}`,
    s.changelog_id ? `**Changelog:** <#${s.changelog_id}>` : '',
    'Run `/hive setup` any time to change these.',
  ].filter(Boolean).join('\n');
}

async function createIdea(env: Env, db: Db, ix: any, g: Guild): Promise<string> {
  const f = fields(ix);
  const user: string = ix.member.user.id;
  const now = Date.now();
  let status: Status = 'discussing';
  let phase_ends: number | null = null;
  if (usesVoting(g)) {
    if (g.discuss_hours > 0) phase_ends = now + g.discuss_hours * HOUR;
    else { status = 'voting'; phase_ends = now + g.vote_hours * HOUR; }
  }
  const idea: Idea = {
    thread_id: '', guild_id: ix.guild_id, author_id: user, title: f.title.trim(),
    options: JSON.stringify([f.spec, f.alt1, f.alt2].map((t) => t?.trim()).filter(Boolean).map((text) => ({ text, by: user }))),
    status, phase_ends,
    winner: null, issue: null, pr: null, claimed_by: null, claimed_at: null, merge_state: null,
  };
  const thread = await discord(env, 'POST', `/channels/${g.forum_id}/threads`, {
    name: idea.title,
    applied_tags: [JSON.parse(g.tags)[TAG_OF[status]]],
    message: { content: `💡 Idea by <@${user}>`, allowed_mentions: { users: [user] }, ...(await view(env, db, idea, g)) },
  });
  idea.thread_id = thread.id;
  await db.run(
    'INSERT INTO ideas (thread_id, guild_id, author_id, title, options, status, phase_ends) VALUES (?, ?, ?, ?, ?, ?, ?)',
    idea.thread_id, idea.guild_id, idea.author_id, idea.title, idea.options, idea.status, idea.phase_ends,
  );
  if (g.approval === 'auto') await approve(env, db, idea, g, 0, true);
  return `🐝 Posted <#${thread.id}>`;
}

async function saveEdit(env: Env, db: Db, ix: any, g: Guild): Promise<string> {
  const idea = await db.first<Idea>('SELECT * FROM ideas WHERE thread_id = ?', ix.channel_id);
  if (!idea || idea.author_id !== ix.member.user.id) return 'Run this inside your own idea post.';
  const f = fields(ix);
  const opts = options(idea);
  opts[0].text = f.spec.trim();
  const next = await move(db, idea, ['discussing'], 'discussing', { title: f.title.trim(), options: JSON.stringify(opts) });
  if (!next) return 'Too late: voting has started, so the idea is frozen.';
  if (next.title !== idea.title) await discord(env, 'PATCH', `/channels/${idea.thread_id}`, { name: next.title });
  await refresh(env, db, next, g);
  return 'Updated.';
}

async function addOption(env: Env, db: Db, ix: any, g: Guild, owner: boolean): Promise<Reply> {
  const idea = await db.first<Idea>('SELECT * FROM ideas WHERE thread_id = ?', ix.channel_id);
  if (!idea) return msg('Use this on a reply inside a HiveCode idea post.');
  if (idea.status !== 'discussing') return msg('Options can only be added while the idea is being discussed.');
  if (g.options_by !== 'anyone' && !owner && ix.member.user.id !== idea.author_id) return msg('Only the idea author or a server manager can add options here.');
  const m = ix.data.resolved.messages[ix.data.target_id];
  const text = (m.content ?? '').trim().slice(0, 500);
  if (m.author.bot || !text) return msg('Pick a reply with some text in it.');
  const opts = options(idea);
  if (opts.length >= MAX_OPTIONS) return msg(`This idea already has ${MAX_OPTIONS} options.`);
  if (opts.some((o) => o.text === text)) return msg("That's already an option.");
  opts.push({ text, by: m.author.id });
  // Compare-and-swap on the options JSON so two people adding at once can't overwrite each other.
  const changed = await db.run("UPDATE ideas SET options = ? WHERE thread_id = ? AND status = 'discussing' AND options = ?", JSON.stringify(opts), idea.thread_id, idea.options);
  if (!changed) return msg('The idea just changed. Try again.');
  const next = { ...idea, options: JSON.stringify(opts) };
  return { body: { type: 4, data: { content: `Added as option **${letter(opts.length - 1)}**.`, flags: 64 } }, after: () => refresh(env, db, next, g) };
}

async function button(env: Env, db: Db, ix: any, g: Guild, owner: boolean): Promise<Reply> {
  const idea = await db.first<Idea>('SELECT * FROM ideas WHERE thread_id = ?', ix.channel_id);
  if (!idea) return msg('This idea is no longer tracked.');
  const [action, arg] = String(ix.data.custom_id).split(':');
  const n = Number(arg);

  if (action === 'vote' || action === 'ship') {
    const round = action === 'vote' ? 'idea' : 'ship';
    if (idea.status !== (round === 'idea' ? 'voting' : 'shipping_vote')) return msg('Voting is closed.');
    if (g.voter_role_id && !owner && !ix.member.roles.includes(g.voter_role_id)) return msg(`Only <@&${g.voter_role_id}> can vote.`);
    const count = round === 'idea' ? options(idea).length : 1;
    if (!Number.isInteger(n) || n < -1 || n >= count) return msg('Unknown option.');
    await db.run(
      'INSERT INTO votes (thread_id, round, user_id, choice) VALUES (?, ?, ?, ?) ON CONFLICT (thread_id, round, user_id) DO UPDATE SET choice = excluded.choice',
      idea.thread_id, round, ix.member.user.id, n,
    );
    const t = await tallyOf(db, idea, round);
    if (verdict(t, g, false) === 'pass') {
      // Ack without editing; the follow-up re-renders the card, so no stale update can land after it.
      return { body: { type: 6 }, after: () => round === 'idea' ? approve(env, db, idea, g, winner(t.counts), false) : shipVoteDone(env, db, idea, g, true) };
    }
    return { body: { type: 7, data: await view(env, db, idea, g) } };
  }

  if (!owner) return msg('Only Hive Mind and Hive Manager can use this button.');
  if (action === 'open') return { body: { type: 6 }, after: () => openVoting(env, db, idea, g) };
  // Approve and Veto first ask for an optional reason; decide() acts on the answer.
  if (action === 'veto') {
    if (!VETOABLE.includes(idea.status)) return msg("Too late to veto. It's already being built.");
    return reasonModal('veto', 'Veto this idea');
  }
  if (action === 'approve' && Number.isInteger(n) && n >= 0 && n < options(idea).length) {
    return reasonModal(`approve:${n}`, options(idea).length > 1 ? `Approve option ${letter(n)}` : 'Approve this idea');
  }
  return msg('Unknown button.');
}

const reasonModal = (custom_id: string, title: string): Reply => ({
  body: { type: 9, data: { custom_id, title, components: [input('reason', 'Reason (optional, posted in the thread)', 2, 500, undefined, false)] } },
});

async function decide(env: Env, db: Db, ix: any, g: Guild, owner: boolean): Promise<Reply> {
  if (!owner) return msg('Only Hive Mind and Hive Manager can do that.');
  const idea = await db.first<Idea>('SELECT * FROM ideas WHERE thread_id = ?', ix.channel_id);
  if (!idea) return msg('This idea is no longer tracked.');
  const by: string = ix.member.user.id;
  const reason = (fields(ix).reason ?? '').trim();
  const why = reason ? `: ${reason}` : '.';
  const [action, arg] = String(ix.data.custom_id).split(':');
  if (action === 'veto') {
    return { body: { type: 6 }, after: () => reject(env, db, idea, g, 'vetoed', VETOABLE, `⛔ Vetoed by <@${by}>${why}`, [by]) };
  }
  const n = Number(arg);
  if (!['discussing', 'voting', 'pending_owner'].includes(idea.status)) return msg('This idea has already been decided.');
  if (!(n >= 0 && n < options(idea).length)) return msg('Unknown option.');
  const which = options(idea).length > 1 ? ` option **${letter(n)}**` : '';
  return {
    body: { type: 6 },
    after: async () => {
      await say(env, idea.thread_id, `✅ Approved${which} by <@${by}>${why}`, [by]);
      await approve(env, db, idea, g, n, true);
    },
  };
}

async function workerToken(env: Env, db: Db, ix: any, g: Guild): Promise<Reply> {
  if (!ix.member.roles.includes(g.worker_role_id)) return msg(`You need the <@&${g.worker_role_id}> role first.`);
  const token = `hive_${hex(crypto.getRandomValues(new Uint8Array(24)))}`;
  await db.run('DELETE FROM workers WHERE guild_id = ? AND user_id = ?', ix.guild_id, ix.member.user.id);
  await db.run('INSERT INTO workers (token_hash, guild_id, user_id) VALUES (?, ?, ?)', await sha256(token), ix.guild_id, ix.member.user.id);
  const url = env.PUBLIC_URL || '<ask the server owner for the bot URL>';
  return msg([
    '🐝 **Your Hive Worker login.** It is shown once and replaces any old one. Keep it private.',
    '1. Install Node 24+, Git, the GitHub CLI (then run `gh auth login`) and Claude Code or Codex.',
    '2. Download the script: open https://github.com/Jerdann/hivecode/blob/main/worker/hive-worker.mts and click **Download raw file**. It lands in your Downloads folder.',
    '3. In a terminal, run `cd ~/Downloads`, then paste:',
    '```', `node hive-worker.mts login ${url} ${token}`, '```',
    '4. Run `node hive-worker.mts work` to claim and build a task. Full guide: https://github.com/Jerdann/hivecode#workers-hive-workers-the-hive-builds-it',
  ].join('\n'));
}

// ---------- Hive Worker API ----------

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
const json = (data: unknown, status = 200) => Response.json(data, { status });

export async function api(req: Request, env: Env, db: Db): Promise<Response> {
  try {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const w = token && await db.first<{ guild_id: string; user_id: string }>('SELECT * FROM workers WHERE token_hash = ?', await sha256(token));
    if (!w) return json({ error: 'Invalid token. Run /hive worker in Discord to get a new one.' }, 401);
    const g = await db.first<Guild>('SELECT * FROM guilds WHERE guild_id = ?', w.guild_id);
    if (!g) return json({ error: 'This server is not set up.' }, 404);
    const task = (i: Idea) => ({ issue: i.issue, title: i.title, spec: options(i)[i.winner ?? 0].text, repo: env.GITHUB_REPO, branch: `hive/issue-${i.issue}` });

    const { pathname } = new URL(req.url);
    if (req.method === 'GET' && pathname === '/api/tasks') {
      if (g.builder !== 'workers') return json([]);
      return json((await db.all<Idea>("SELECT * FROM ideas WHERE guild_id = ? AND status = 'approved' AND issue > 0", w.guild_id)).map(task));
    }
    const m = pathname.match(/^\/api\/tasks\/(\d+)\/(claim|submit|release)$/);
    if (!m || req.method !== 'POST') return json({ error: 'Not found' }, 404);
    const idea = await db.first<Idea>('SELECT * FROM ideas WHERE guild_id = ? AND issue = ?', w.guild_id, Number(m[1]));
    if (!idea) return json({ error: 'No such task.' }, 404);

    if (m[2] === 'claim') {
      if (g.builder !== 'workers') return json({ error: 'This server is not using Hive Workers right now.' }, 403);
      const member = await discord(env, 'GET', `/guilds/${g.guild_id}/members/${w.user_id}`);
      if (!member.roles.includes(g.worker_role_id)) return json({ error: 'You no longer have the Hive Worker role.' }, 403);
      const next = await move(db, idea, ['approved'], 'building', { claimed_by: w.user_id, claimed_at: Date.now() });
      if (!next) return json({ error: 'Already claimed, or no longer open.' }, 409);
      await github(env, 'POST', `/repos/${env.GITHUB_REPO}/issues/${idea.issue}/labels`, { labels: ['hive:claimed'] }).catch(console.error);
      await refresh(env, db, next, g).then(() => say(env, idea.thread_id, `🐝 <@${w.user_id}> claimed this and is building it.`)).catch(console.error);
      return json(task(next));
    }
    if (idea.claimed_by !== w.user_id || idea.status !== 'building') return json({ error: 'You have not claimed this task.' }, 403);
    if (m[2] === 'release') {
      await release(env, db, idea, g, `🔁 <@${w.user_id}> released this task. It's back in the queue.`);
      return json({ ok: true });
    }
    const { pr } = (await req.json()) as { pr: unknown };
    if (!Number.isInteger(pr)) return json({ error: 'Send { "pr": <number> }.' }, 400);
    const pull = await github(env, 'GET', `/repos/${env.GITHUB_REPO}/pulls/${pr}`);
    if (pull.head.ref !== `hive/issue-${idea.issue}`) return json({ error: `PR #${pr} is not from branch hive/issue-${idea.issue}.` }, 400);
    await prOpened(env, db, idea, g, pr as number);
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
}

// ---------- Every minute ----------

const closes = (body: string, n: number) => new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${n}\\b`, 'i').test(body);

export async function tick(env: Env, db: Db) {
  const now = Date.now();
  const guilds = new Map((await db.all<Guild>('SELECT * FROM guilds')).map((g) => [g.guild_id, g]));
  const each = async (ideas: Idea[], fn: (i: Idea, g: Guild) => Promise<unknown>) => {
    for (const i of ideas) {
      const g = guilds.get(i.guild_id);
      if (g) await fn(i, g).catch((e) => console.error(`hive tick ${i.thread_id}:`, e));
    }
  };

  await each(await db.all<Idea>("SELECT * FROM ideas WHERE phase_ends <= ? AND status IN ('discussing', 'voting', 'shipping_vote')", now), async (i, g) => {
    if (i.status === 'discussing') return openVoting(env, db, i, g);
    const t = await tallyOf(db, i, i.status === 'voting' ? 'idea' : 'ship');
    const pass = verdict(t, g, true) === 'pass';
    if (i.status === 'shipping_vote') return shipVoteDone(env, db, i, g, pass);
    if (pass) return approve(env, db, i, g, winner(t.counts), false);
    return reject(env, db, i, g, 'rejected', ['voting'], `❌ Didn't pass (${t.yes} for, ${t.reject} against).`);
  });
  await each(await db.all<Idea>("SELECT * FROM ideas WHERE status = 'approved' AND issue IS NULL"), (i, g) => ensureIssue(env, db, i, g));
  await each(await db.all<Idea>("SELECT * FROM ideas WHERE status = 'building' AND claimed_at < ?", now - CLAIM_HOURS * HOUR),
    (i, g) => release(env, db, i, g, `⏰ The claim expired after ${CLAIM_HOURS}h. Back in the queue.`));

  const active = await db.all<Idea>("SELECT * FROM ideas WHERE issue > 0 AND status IN ('approved', 'building', 'review', 'shipping_vote')");
  if (!active.length) return;
  const repo = env.GITHUB_REPO;
  // ponytail: one page of each (100); paginate if a server ever has 100+ ideas in flight.
  const [issues, pulls]: any[][] = await Promise.all([
    github(env, 'GET', `/repos/${repo}/issues?labels=hive%3Aapproved&state=all&sort=updated&per_page=100`),
    github(env, 'GET', `/repos/${repo}/pulls?state=open&per_page=100`),
  ]);
  await each(active, async (i, g) => {
    const issue = issues.find((x) => x.number === i.issue);
    if (issue?.state === 'closed') {
      if (issue.state_reason === 'completed') return ship(env, db, i, g);
      return reject(env, db, i, g, 'rejected', ['approved', 'building', 'review', 'shipping_vote'], '❌ The GitHub issue was closed.');
    }
    if (!i.pr) {
      const pr = pulls.find((p) => p.head.ref === `hive/issue-${i.issue}` || closes(p.body ?? '', i.issue!));
      return pr && prOpened(env, db, i, g, pr.number);
    }
    if (!pulls.some((p) => p.number === i.pr)) {
      const pr = await github(env, 'GET', `/repos/${repo}/pulls/${i.pr}`);
      return pr.merged ? ship(env, db, i, g) : prClosed(env, db, i, g);
    }
    if (i.status === 'review' && i.merge_state === 'auto') return tryMerge(env, db, i, g);
  });
}
