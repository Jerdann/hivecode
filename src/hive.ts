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
  worker_role_id: string; manager_role_id: string | null; mind_role_id: string | null; pollinator_role_id: string | null;
  category_id: string | null; guide_channel_id: string | null; guide_message_id: string | null;
  stats_channel_id: string | null; stats_message_id: string | null; workers_channel_id: string | null;
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
const BLOSSOM = 0xff7ab8;
const MANAGE_GUILD = 0x20n;
const VIEW = 1n << 10n, SEND = 1n << 11n, EMBED = 1n << 14n, MANAGE_THREADS = 1n << 34n, SEND_IN_THREADS = 1n << 38n;

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
    case 'approved': return [row(...(g.builder === 'workers' && i.issue ? [btn('assign', '👷 Assign to a worker', 1)] : []), btn('veto', '⛔ Veto', 4))];
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
  // The author earns Pollinator the first time one of their ideas ships.
  let earned = false;
  if (g.pollinator_role_id) {
    try {
      const author = await discord(env, 'GET', `/guilds/${g.guild_id}/members/${i.author_id}`);
      if (!(author.roles ?? []).includes(g.pollinator_role_id)) {
        await discord(env, 'PUT', `/guilds/${g.guild_id}/members/${i.author_id}/roles/${g.pollinator_role_id}`);
        earned = true;
      }
    } catch (e) {
      console.error('Giving Pollinator failed:', e); // e.g. the author left the server
    }
  }
  await say(env, i.thread_id, `🚀 Shipped! Thanks <@${i.author_id}> for the idea.${earned ? ` You're now a <@&${g.pollinator_role_id}> 🌸` : ''}`, [i.author_id]);
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

// Acknowledge now, finish the work after, then replace the "thinking…" message (or, with `update`, the
// message the clicked component is on) with the result.
function deferred(env: Env, ix: any, work: () => Promise<string | object>, update = false): Reply {
  return {
    body: update ? { type: 6 } : { type: 5, data: { flags: 64 } },
    after: async () => {
      let data: object;
      try {
        const result = await work();
        data = typeof result === 'string' ? { content: result, embeds: [], components: [] } : result;
      } catch (e) {
        console.error(e);
        data = { content: `⚠️ ${(e as Error).message}`.slice(0, 1900), embeds: [], components: [] };
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

  // The first-run forum choice arrives before the server is set up.
  if (ix.type === 3 && /^setup:(forum|newforum)$/.test(ix.data.custom_id)) {
    if (!admin) return msg('Only the Hive Mind role (or Manage Server) can run setup.');
    if (g) return msg('HiveCode is already set up here. Run `/hive setup` to change things.');
    const forum = ix.data.custom_id === 'setup:newforum' ? 'new' : ix.data.values[0];
    return deferred(env, ix, () => setup(env, db, ix, null, [], forum), true);
  }

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
  if (ix.type === 3 && String(ix.data.custom_id).startsWith('setup:')) return setupStep(env, db, ix, g, admin);
  if (ix.type === 3) return button(env, db, ix, g, owner);
  return msg('Unknown command.');
}

// ---------- Setup ----------

// With options it applies them directly; without, it opens the step-by-step wizard.
// Older installs lack newer columns. Adding one errors when it already exists, which is fine.
const NEW_COLUMNS = ['mind_role_id', 'manager_role_id', 'pollinator_role_id', 'category_id', 'guide_channel_id', 'guide_message_id',
  'stats_channel_id', 'stats_message_id', 'workers_channel_id'];

// forum: on a first run, an existing forum's id to use, or 'new' to create #hive-ideas.
async function setup(env: Env, db: Db, ix: any, g: Guild | null, opts: { name: string; value: string | number }[], forum?: string): Promise<string | object> {
  for (const col of NEW_COLUMNS) await db.run(`ALTER TABLE guilds ADD COLUMN ${col} TEXT`).catch(() => {});
  if (!g && !opts.length && !forum) {
    // First run in a server that already has a forum: ask where ideas go before creating anything.
    const channels: { type: number }[] = await discord(env, 'GET', `/guilds/${ix.guild_id}/channels`);
    if (channels.some((c) => c.type === 15)) return forumPicker();
  }
  const o = Object.fromEntries(opts.map((x) => [x.name, x.value]));
  const roles = await ensureRoles(env, ix, g);
  const ch = await ensureChannels(env, ix, g, roles, forum);
  if (!g) await db.run('INSERT INTO guilds (guild_id, forum_id, tags, worker_role_id) VALUES (?, ?, ?, ?)', ix.guild_id, ch.forum, ch.tags, roles.worker);
  await db.run(
    `UPDATE guilds SET forum_id = ?, tags = ?, manager_role_id = ?, mind_role_id = ?, pollinator_role_id = ?, category_id = ?,
      guide_channel_id = ?, stats_channel_id = ?, workers_channel_id = ? WHERE guild_id = ?`,
    ch.forum, ch.tags, roles.manager, roles.mind, roles.pollinator, ch.category, ch.guide, ch.stats, ch.workers, ix.guild_id,
  );
  if (roles.newManager) {
    // Light moderation for Hive Managers, scoped to the ideas forum: lock, close, pin and delete posts.
    await discord(env, 'PUT', `/channels/${ch.forum}/permissions/${roles.manager}`, { type: 0, allow: String(MANAGE_THREADS) })
      .catch((e) => console.error('Giving Hive Manager forum permissions failed:', e));
  }
  const set: Record<string, unknown> = Object.fromEntries(SETTINGS.filter((k) => k in o).map((k) => [k, o[k]]));
  if ('voter_role' in o) set.voter_role_id = o.voter_role === ix.guild_id ? null : o.voter_role; // @everyone = no restriction
  if ('changelog' in o) set.changelog_id = o.changelog;
  const keys = Object.keys(set);
  if (keys.length) await db.run(`UPDATE guilds SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE guild_id = ?`, ...keys.map((k) => set[k]), ix.guild_id);

  const s = (await db.first<Guild>('SELECT * FROM guilds WHERE guild_id = ?', ix.guild_id))!;
  await refreshGuide(env, db, s);
  await refreshStats(env, db, s);
  return opts.length ? summary(s) : wizard(s, 0);
}

// Members can read but not post; the bot and maintainers can.
const readOnly = (env: Env, guild: string, maintainers: (string | null)[]) => [
  { id: guild, type: 0, deny: String(SEND | SEND_IN_THREADS) },
  { id: env.DISCORD_APP_ID, type: 1, allow: String(VIEW | SEND | EMBED | SEND_IN_THREADS) },
  ...maintainers.filter(Boolean).map((id) => ({ id, type: 0, allow: String(SEND) })),
];

function forumPicker() {
  return {
    content: '',
    embeds: [{
      title: '🐝 HiveCode setup · where should ideas go?', color: COLOR,
      description: 'Your server already has a forum. Pick one to use for ideas, or let HiveCode create a fresh **#hive-ideas** forum.\n' +
        '*In an existing forum, HiveCode adds its status tags and only tracks posts made with `/idea`. Everything else stays as it is.*',
    }],
    components: [
      row({ type: 8, custom_id: 'setup:forum', placeholder: 'Use an existing forum', channel_types: [15], min_values: 1, max_values: 1 }),
      row(btn('setup:newforum', '➕ Create #hive-ideas', 3)),
    ],
  };
}

// Use a forum the server already has: add HiveCode's status tags next to its own and let the bot post and
// manage threads there. Members' permissions stay as they were.
async function adoptForum(env: Env, id: string) {
  const f = await discord(env, 'GET', `/channels/${id}`);
  const missing = Object.values(TAGS).filter(([name]) => !f.available_tags.some((t: any) => t.name === name));
  if (f.available_tags.length + missing.length > 20) {
    throw new Error(`That forum has ${f.available_tags.length} tags; HiveCode needs room for ${missing.length} more (Discord allows 20). Remove a few, or create a new forum.`);
  }
  const updated = missing.length
    ? await discord(env, 'PATCH', `/channels/${id}`, { available_tags: [...f.available_tags, ...missing.map(([name, emoji_name]) => ({ name, emoji_name }))] })
    : f;
  await discord(env, 'PUT', `/channels/${id}/permissions/${env.DISCORD_APP_ID}`, { type: 1, allow: String(VIEW | SEND | EMBED | SEND_IN_THREADS | MANAGE_THREADS) });
  return JSON.stringify(Object.fromEntries(Object.entries(TAGS).map(([k, [name]]) => [k, updated.available_tags.find((t: any) => t.name === name).id])));
}

// A 🐝 HiveCode category holding the guide, the ideas forum, stats, and a private channel for Hive Workers.
async function ensureChannels(env: Env, ix: any, g: Guild | null, roles: { worker: string; manager: string; mind: string }, existing?: string) {
  const guild = ix.guild_id;
  const create = (body: object): Promise<any> => discord(env, 'POST', `/guilds/${guild}/channels`, body);
  // A channel someone deleted gets recreated below.
  const alive = async (id: string | null | undefined) =>
    id ? discord(env, 'GET', `/channels/${id}`).then(() => id, (e) => (String(e).includes('→ 404') ? null : id)) : null;
  const locked = readOnly(env, guild, [roles.mind, roles.manager]);
  const hadCategory = await alive(g?.category_id);
  const category = hadCategory || (await create({ name: '🐝 HiveCode', type: 4 })).id;
  const guide = await alive(g?.guide_channel_id) || (await create({
    name: 'hive-guide', type: 0, parent_id: category, permission_overwrites: locked,
    topic: 'How HiveCode works in this server: the rules, the commands and the roles. Kept up to date by the bot.',
  })).id;
  let forum = await alive(g?.forum_id), tags = g?.tags;
  if (!forum && existing && existing !== 'new') {
    forum = existing;
    tags = await adoptForum(env, existing);
  } else if (!forum) {
    const f = await create({
      name: 'hive-ideas', type: 15, parent_id: category, default_auto_archive_duration: 10080,
      topic: 'Suggest features with /idea. The hive discusses, votes, and the AI builds.',
      available_tags: Object.values(TAGS).map(([name, emoji_name]) => ({ name, emoji_name })),
      // Posts only come through /idea (so they're tracked); everyone can still reply.
      permission_overwrites: [
        { id: guild, type: 0, deny: String(SEND), allow: String(SEND_IN_THREADS) },
        { id: env.DISCORD_APP_ID, type: 1, allow: String(SEND | SEND_IN_THREADS | MANAGE_THREADS) },
      ],
    });
    forum = f.id as string;
    tags = JSON.stringify(Object.fromEntries(Object.entries(TAGS).map(([k, [name]]) => [k, f.available_tags.find((t: any) => t.name === name).id])));
  } else if (!hadCategory && !existing) {
    await discord(env, 'PATCH', `/channels/${forum}`, { parent_id: category }).catch((e) => console.error('Moving the forum failed:', e));
  }
  const stats = await alive(g?.stats_channel_id) || (await create({
    name: 'hive-stats', type: 0, parent_id: category, permission_overwrites: locked, topic: 'Fun numbers about the hive. Updated every 15 minutes.',
  })).id;
  let workers = await alive(g?.workers_channel_id);
  if (!workers) {
    workers = (await create({
      name: 'hive-workers', type: 0, parent_id: category, topic: 'For Hive Workers: set up your AI agent, pick up tasks and coordinate.',
      permission_overwrites: [
        { id: guild, type: 0, deny: String(VIEW) },
        { id: env.DISCORD_APP_ID, type: 1, allow: String(VIEW | SEND | EMBED) },
        ...[roles.mind, roles.manager, roles.worker].map((id) => ({ id, type: 0, allow: String(VIEW | SEND) })),
      ],
    })).id as string;
    await discord(env, 'POST', `/channels/${workers}/messages`, { ...workerGuide(), allowed_mentions: { parse: [] } })
      .catch((e) => console.error('Posting the worker guide failed:', e));
  }
  return { category, guide, forum: forum!, tags: tags!, stats, workers };
}

// Hive Mind (owners), Hive Manager (moderators), Hive Worker (builders) and Pollinator (their idea shipped), each
// shown as its own group in the member list, in that order. Whoever runs setup gets Hive Mind.
async function ensureRoles(env: Env, ix: any, g: Guild | null) {
  const guild = ix.guild_id;
  const make = async (name: string, color: number, mentionable = true): Promise<string> =>
    (await discord(env, 'POST', `/guilds/${guild}/roles`, { name, color, hoist: true, mentionable })).id;
  const worker = g?.worker_role_id || await make('Hive Worker', COLOR);
  const manager = g?.manager_role_id || await make('Hive Manager', AMBER);
  const mind = g?.mind_role_id || await make('Hive Mind', HONEY);
  const pollinator = g?.pollinator_role_id || await make('Pollinator', BLOSSOM, false);
  const newManager = !g?.manager_role_id;
  if (newManager || !g?.mind_role_id || !g?.pollinator_role_id) {
    // New roles land at the bottom of the list. Reuse the roles' slots in order: Mind, Manager, Worker, Pollinator. Cosmetic: never fatal.
    try {
      await discord(env, 'PATCH', `/guilds/${guild}/roles/${worker}`, { hoist: true }); // older installs made it without
      const all: { id: string; position: number }[] = await discord(env, 'GET', `/guilds/${guild}/roles`);
      const ids = [mind, manager, worker, pollinator];
      const slots = ids.map((id) => all.find((r) => r.id === id)?.position ?? 0).sort((a, b) => b - a);
      await discord(env, 'PATCH', `/guilds/${guild}/roles`, ids.map((id, n) => ({ id, position: slots[n] })));
    } catch (e) {
      console.error('Sorting the Hive roles failed:', e);
    }
  }
  if (!ix.member.roles.includes(mind)) {
    await discord(env, 'PUT', `/guilds/${guild}/members/${ix.member.user.id}/roles/${mind}`).catch((e) => console.error('Giving Hive Mind failed:', e));
  }
  return { worker, manager, mind, pollinator, newManager };
}

type Choice = [value: string | number, label: string, description?: string];
export const CHOICES: Record<string, Choice[]> = {
  approval: [
    ['vote', 'Community vote', 'Members vote; it passes when it clears your bar'],
    ['vote+owner', 'Community vote + maintainer OK', 'Members vote, then a maintainer confirms'],
    ['owner', 'Maintainers decide', 'No voting: a maintainer approves or vetoes'],
    ['auto', 'Approve everything (risky)', 'Every idea goes straight to the builder'],
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
    ['auto', 'Auto-merge (risky)', 'Merged as soon as checks pass'],
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
    about: 'With a vote minimum, an idea passes the moment it clears both bars. With no minimum, it is decided when voting closes.\n' +
      '*Maintainers can always skip the vote: approve or veto any idea at any time.*',
    when: usesVoting, rows: (g, at) => [pick(at, 'min_votes', g), pick(at, 'approve_pct', g)],
  },
  {
    title: 'How long do discussion and voting last?',
    about: 'During discussion people reply and add alternative options. The idea freezes when voting opens.\n' +
      '*None of this binds maintainers: they can approve or veto any idea at any time, then build it themselves or assign it to a Hive Worker.*',
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
    about: 'Optional: pick a channel that gets a post every time an idea ships, leave it empty, or let HiveCode make one.',
    rows: (g, at) => [
      row({ type: 8, custom_id: `setup:${at}:changelog_id`, placeholder: 'No changelog channel', channel_types: [0, 5], min_values: 0, max_values: 1,
        default_values: g.changelog_id ? [{ id: g.changelog_id, type: 'channel' }] : [] }),
      ...(g.changelog_id ? [] : [row(btn(`setup:mkchangelog:${at}`, '➕ Create #hive-changelog', 3))]),
    ],
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

async function setupStep(env: Env, db: Db, ix: any, g: Guild, admin: boolean): Promise<Reply> {
  if (!admin) return msg('Only the Hive Mind role (or Manage Server) can change setup.');
  const [, a, b] = String(ix.data.custom_id).split(':');
  if (a === 'done') return { body: { type: 7, data: { content: summary(g), embeds: [], components: [] } } };
  if (a === 'go') return { body: { type: 7, data: wizard(g, Number(b)) } };
  if (a === 'mkchangelog') {
    return {
      body: { type: 6 },
      after: async () => {
        const ch = await discord(env, 'POST', `/guilds/${g.guild_id}/channels`, {
          name: 'hive-changelog', type: 0, topic: 'Every idea the hive ships.', permission_overwrites: readOnly(env, g.guild_id, [g.mind_role_id, g.manager_role_id]),
          ...(g.category_id ? { parent_id: g.category_id } : {}),
        });
        await db.run('UPDATE guilds SET changelog_id = ? WHERE guild_id = ?', ch.id, g.guild_id);
        const next = { ...g, changelog_id: ch.id };
        await discord(env, 'PATCH', `/webhooks/${env.DISCORD_APP_ID}/${ix.token}/messages/@original`, wizard(next, Number(b)));
        await refreshGuide(env, db, next);
      },
    };
  }
  if (!WIZARD_FIELDS.includes(b)) return msg('Unknown setting.');
  const raw: string | undefined = ix.data.values?.[0];
  const value = raw === undefined ? null : NUMBERS.includes(b) ? Number(raw) : raw;
  await db.run(`UPDATE guilds SET ${b} = ? WHERE guild_id = ?`, value, g.guild_id);
  const next = { ...g, [b]: value } as Guild;
  // The public guide shows the rules, so it follows every change.
  return { body: { type: 7, data: wizard(next, Number(a)) }, after: () => refreshGuide(env, db, next) };
}

// ---------- Guide, worker guide and stats posts ----------

// #hive-guide: the live rules, commands and roles. Re-rendered whenever a setting changes.
function guide(g: Guild) {
  const voting = usesVoting(g);
  const decide = {
    vote: `Members vote with the buttons on the post. ${rules(g)}.`,
    'vote+owner': `Members vote with the buttons on the post. ${rules(g)}; then a maintainer confirms.`,
    owner: 'A maintainer picks: ✅ Approve or ⛔ Veto.',
    auto: 'Every idea is approved automatically.',
  }[g.approval];
  const timing = voting ? ` Voting lasts ${label('vote_hours', g.vote_hours).replace('Vote for ', '')}${g.voter_role_id ? ` and is open to <@&${g.voter_role_id}>` : ''}.` : '';
  const discuss = !voting ? 'Reply in the post' : g.discuss_hours ? `${label('discuss_hours', g.discuss_hours)} by replying in the post` : 'There is no discussion phase, but you can reply in the post any time';
  const build = {
    manual: 'A maintainer builds it from the GitHub issue.',
    action: 'An AI agent (Claude Code or Codex) builds it automatically and opens a pull request.',
    workers: `A <@&${g.worker_role_id}> claims it (or a maintainer assigns it) and builds it with their own AI agent.`,
  }[g.builder];
  const merge = {
    owner: 'A maintainer reviews and merges the pull request.',
    vote: 'Members vote to ship the finished pull request.',
    auto: 'It merges automatically as soon as its checks pass.',
  }[g.merge];
  return {
    embeds: [
      {
        title: '🐝 How ideas work here', color: COLOR, timestamp: new Date().toISOString(), footer: { text: 'Updated automatically whenever the rules change' },
        description: [
          `**1. Suggest.** Type \`/idea\` in any channel: a title, a description and up to two alternatives. It becomes a post in <#${g.forum_id}>.`,
          `**2. Discuss.** ${discuss}. ${g.options_by === 'anyone' ? 'Anyone' : 'The idea\'s author or a maintainer'} can turn a good reply into an option: right-click it → **Apps** → **Add as option**.`,
          `**3. Decide.** ${decide}${timing}`,
          `**4. Build.** ${build}`,
          `**5. Merge.** ${merge}`,
          `**6. Ship.** 🚀 The author earns <@&${g.pollinator_role_id}>${g.changelog_id ? ` and it gets announced in <#${g.changelog_id}>` : ''}.`,
          '',
          '*Maintainers can always step in: they can approve or veto any idea at any time, whatever the voting rules say.*',
        ].join('\n'),
      },
      {
        title: '⌨️ Commands', color: COLOR,
        description: [
          '`/idea` Suggest something for the hive to build.',
          '**Right-click a reply → Apps → Add as option** Turn a reply into a competing option while the idea is being discussed.',
          '**Buttons on each post** Vote. Maintainers also get ✅ Approve, ⛔ Veto, Open voting now and 👷 Assign.',
          '`/hive edit` Edit your own idea while it is still being discussed (run it inside the post).',
          `\`/hive worker\` Hive Workers: get your login for the hive-worker tool${g.workers_channel_id ? ` (guide in <#${g.workers_channel_id}>)` : ''}.`,
          '`/hive setup` Hive Mind: change these rules.',
        ].join('\n'),
      },
      {
        title: '🎭 Roles', color: COLOR,
        description: [
          `<@&${g.mind_role_id}> Owners: setup and every decision.`,
          `<@&${g.manager_role_id}> Approve, veto, assign work and moderate <#${g.forum_id}>.`,
          `<@&${g.worker_role_id}> Build approved ideas with their own AI agent.`,
          `<@&${g.pollinator_role_id}> Had an idea shipped.`,
        ].join('\n'),
      },
    ],
  };
}

// #hive-workers: posted once when the channel is created.
function workerGuide() {
  return {
    embeds: [
      {
        title: '🐝 Welcome, Hive Worker', color: COLOR,
        description: 'You build the ideas the hive approves, with **your own AI agent** on **your own computer**. You work from your own fork on GitHub, so you never need access to the project repo.',
      },
      {
        title: '🛠️ Set up (once)', color: COLOR,
        description: [
          '1. Install **Node.js 24+** (nodejs.org), **Git** (git-scm.com), the **GitHub CLI** (cli.github.com) and an AI coding CLI: **Claude Code** or **Codex**.',
          '2. In a terminal, run `gh auth login` once and follow the prompts.',
          '3. Download the worker script: open https://github.com/Jerdann/hivecode/blob/main/worker/hive-worker.mts and click **Download raw file**. It lands in your Downloads folder.',
          '4. Type `/hive worker` in any channel. Only you see the reply: a login command with your personal token.',
          '5. In a terminal, run `cd ~/Downloads`, then paste that login command.',
        ].join('\n'),
      },
      {
        title: '📋 Getting work', color: COLOR,
        description: [
          '• **Pick one up:** `node hive-worker.mts list` shows open tasks; `node hive-worker.mts work` claims the next one, builds it and opens the pull request.',
          '• **Get handed one:** a maintainer can assign an idea to you. You get pinged in its post; run `node hive-worker.mts work` and your assigned task goes first.',
          `• Claims go back to the queue after ${CLAIM_HOURS} hours without a pull request, so nothing gets stuck.`,
          '• Say here what you are picking up, so two people don\'t build the same thing.',
        ].join('\n'),
      },
      {
        title: '⚠️ Know the risks', color: HONEY,
        description: [
          '• Each task was written by the community and approved by this server\'s maintainers, and it goes **straight to your AI**. You are trusting this server\'s Hive Mind.',
          '• hive-worker **shows you every task before you claim it**. Read it. If one asks for secrets, passwords or anything outside the project, say no and tell a maintainer.',
          '• The default agent command can **only edit files in the project folder**: no shell commands, no web access. Don\'t loosen it (for example by allowing Bash or skipping permissions) unless you fully trust this server.',
          '• Building uses **your** AI subscription or API credits.',
          '• Your fork and pull requests are **public** on GitHub.',
        ].join('\n'),
      },
      {
        title: '🛑 Stop or revoke any time', color: COLOR,
        description: [
          '• **Pause:** just stop running hive-worker. Nothing runs without you.',
          '• **Cut the bot off:** ask a maintainer to remove your Hive Worker role (your token can no longer claim tasks), or run `/hive worker` again to replace your token.',
          '• **Remove everything:** delete the `.hive` folder in your home folder (`C:\\Users\\<you>\\.hive` on Windows, `~/.hive` on Mac) and the downloaded `hive-worker.mts`. Optionally run `gh auth logout` and delete your fork on GitHub.',
        ].join('\n'),
      },
      {
        title: '🤝 Other ways to help', color: COLOR,
        description: '• Review open pull requests and test what ships.\n• Help shape ideas in the forum: reply with alternatives, and the author can turn them into options.',
      },
    ],
  };
}

// #hive-stats: refreshed every 15 minutes by tick().
async function statsPost(db: Db, g: Guild) {
  const G = g.guild_id;
  const byStatus: Record<string, number> = Object.fromEntries(
    (await db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM ideas WHERE guild_id = ? GROUP BY status', G)).map((r) => [r.status, r.n]));
  const count = (...s: string[]) => s.reduce((sum, k) => sum + (byStatus[k] ?? 0), 0);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const open = count('discussing', 'voting', 'pending_owner');
  const going = count('approved', 'building', 'review', 'shipping_vote');
  const shipped = count('shipped');
  const turnedDown = count('rejected', 'vetoed');
  const decided = going + shipped + turnedDown;
  const votes = (await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM votes v JOIN ideas i ON i.thread_id = v.thread_id WHERE i.guild_id = ?', G))!.n;
  const top = async (sql: string) => {
    const rows = await db.all<{ id: string; n: number }>(sql, G);
    return rows.length ? rows.map((r, k) => `${['🥇', '🥈', '🥉', '4.', '5.'][k]} <@${r.id}> · ${r.n}`).join('\n') : 'Nobody yet';
  };
  const builders = await top("SELECT claimed_by AS id, COUNT(*) AS n FROM ideas WHERE guild_id = ? AND status = 'shipped' AND claimed_by IS NOT NULL GROUP BY claimed_by ORDER BY n DESC LIMIT 5");
  const hot = await db.first<{ thread_id: string; n: number }>(
    'SELECT v.thread_id, COUNT(*) AS n FROM votes v JOIN ideas i ON i.thread_id = v.thread_id WHERE i.guild_id = ? GROUP BY v.thread_id ORDER BY n DESC LIMIT 1', G);
  const oldest = await db.first<{ thread_id: string }>(
    "SELECT thread_id FROM ideas WHERE guild_id = ? AND status IN ('discussing', 'voting', 'pending_owner') ORDER BY CAST(thread_id AS INTEGER) LIMIT 1", G);
  // Discord IDs encode their creation time.
  const posted = (id: string) => /^\d+$/.test(id) ? `, posted ${when(Number((BigInt(id) >> 22n) + 1420070400000n))}` : '';
  return {
    embeds: [{
      title: '📊 Hive stats', color: HONEY, timestamp: new Date().toISOString(), footer: { text: 'Updates every 15 minutes' },
      fields: [
        { name: '💡 Ideas', value: String(total), inline: true },
        { name: '💬 Open', value: String(open), inline: true },
        { name: '🔨 In progress', value: String(going), inline: true },
        { name: '🍯 Shipped', value: String(shipped), inline: true },
        { name: '❌ Turned down', value: String(turnedDown), inline: true },
        { name: '✅ Approval rate', value: decided ? `${Math.round(((going + shipped) / decided) * 100)}%` : '—', inline: true },
        { name: '🐝 Busiest bees (most ideas)', value: await top('SELECT author_id AS id, COUNT(*) AS n FROM ideas WHERE guild_id = ? GROUP BY author_id ORDER BY n DESC LIMIT 5'), inline: true },
        { name: '🌸 Top pollinators (most shipped)', value: await top("SELECT author_id AS id, COUNT(*) AS n FROM ideas WHERE guild_id = ? AND status = 'shipped' GROUP BY author_id ORDER BY n DESC LIMIT 5"), inline: true },
        { name: '📣 Loudest buzz (most votes)', value: await top('SELECT v.user_id AS id, COUNT(*) AS n FROM votes v JOIN ideas i ON i.thread_id = v.thread_id WHERE i.guild_id = ? GROUP BY v.user_id ORDER BY n DESC LIMIT 5'), inline: true },
        ...(g.builder === 'workers' || builders !== 'Nobody yet' ? [{ name: '🔨 Hardest workers (builds shipped)', value: builders, inline: true }] : []),
        { name: '🗳️ Votes cast', value: String(votes), inline: true },
        { name: '🔥 Hottest idea', value: hot ? `<#${hot.thread_id}> · ${hot.n} votes` : 'No votes yet' },
        { name: '🐢 Waiting longest', value: oldest ? `<#${oldest.thread_id}>${posted(oldest.thread_id)}` : 'Nothing waiting' },
      ],
    }],
  };
}

// Keeps one bot message per channel current: edits it, or posts a fresh one if it was deleted.
async function upsertPost(env: Env, db: Db, g: Guild, channel: string | null, column: 'guide_message_id' | 'stats_message_id', payload: object) {
  if (!channel) return;
  const id = g[column];
  if (id) {
    try {
      await discord(env, 'PATCH', `/channels/${channel}/messages/${id}`, payload);
      return;
    } catch (e) {
      if (!String(e).includes('→ 404')) throw e;
    }
  }
  const posted = await discord(env, 'POST', `/channels/${channel}/messages`, { ...payload, allowed_mentions: { parse: [] } });
  await db.run(`UPDATE guilds SET ${column} = ? WHERE guild_id = ?`, posted.id, g.guild_id);
  g[column] = posted.id;
}

const refreshGuide = (env: Env, db: Db, g: Guild) => upsertPost(env, db, g, g.guide_channel_id, 'guide_message_id', guide(g));
const refreshStats = async (env: Env, db: Db, g: Guild) => upsertPost(env, db, g, g.stats_channel_id, 'stats_message_id', await statsPost(db, g));

function summary(s: Guild) {
  const voting = usesVoting(s);
  return [
    `🐝 **HiveCode is ready** in <#${s.forum_id}>.`,
    s.guide_channel_id ? `**Channels:** <#${s.guide_channel_id}> (live rules) · <#${s.stats_channel_id}> · <#${s.workers_channel_id}> (Hive Workers only)` : '',
    `**Roles:** <@&${s.mind_role_id}> owners (setup + decisions) · <@&${s.manager_role_id}> managers (approve, veto, moderate the forum) · <@&${s.worker_role_id}> builders (claim tasks with their own AI) · <@&${s.pollinator_role_id}> had an idea shipped`,
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
  if (action === 'assign' || action === 'assignto') return assign(env, db, ix, g, idea, action === 'assign');
  return msg('Unknown button.');
}

// A maintainer hands an approved idea to a specific Hive Worker. It counts as their claim (and expires the same way).
async function assign(env: Env, db: Db, ix: any, g: Guild, idea: Idea, start: boolean): Promise<Reply> {
  if (idea.status !== 'approved' || !idea.issue) return msg('Only approved ideas that nobody has claimed yet can be assigned.');
  const picker = (note = '') => ({
    flags: 64, content: `${note}Who should build this? Pick someone with the <@&${g.worker_role_id}> role.`,
    components: [row({ type: 5, custom_id: 'assignto', placeholder: 'Pick a Hive Worker', min_values: 1, max_values: 1 })],
  });
  if (start) return { body: { type: 4, data: picker() } };
  const who: string = ix.data.values[0];
  if (!ix.data.resolved?.members?.[who]?.roles?.includes(g.worker_role_id)) {
    return { body: { type: 7, data: picker(`<@${who}> doesn't have the Hive Worker role yet (Server Settings → Members to add it). `) } };
  }
  const next = await move(db, idea, ['approved'], 'building', { claimed_by: who, claimed_at: Date.now() });
  if (!next) return { body: { type: 7, data: { content: 'Too late: someone already claimed it.', components: [] } } };
  return {
    body: { type: 7, data: { content: `👷 Assigned to <@${who}>.`, components: [] } },
    after: async () => {
      await github(env, 'POST', `/repos/${env.GITHUB_REPO}/issues/${idea.issue}/labels`, { labels: ['hive:claimed'] }).catch(console.error);
      await refresh(env, db, next, g);
      await say(env, idea.thread_id, `📌 <@${who}>, this one's yours (assigned by <@${ix.member.user.id}>). Run \`node hive-worker.mts work\` to start. ` +
        `If nothing happens within ${CLAIM_HOURS} hours, it goes back to the queue.`, [who]);
    },
  };
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
    `4. Run \`node hive-worker.mts work\` to claim and build a task. Full guide, including the risks: ${
      g.workers_channel_id ? `<#${g.workers_channel_id}>` : 'https://github.com/Jerdann/hivecode#workers-hive-workers-the-hive-builds-it'}`,
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
      // Open tasks, plus anything a maintainer assigned to this worker (listed first).
      const ideas = await db.all<Idea>(
        "SELECT * FROM ideas WHERE guild_id = ? AND issue > 0 AND (status = 'approved' OR (status = 'building' AND claimed_by = ? AND pr IS NULL))",
        w.guild_id, w.user_id);
      return json(ideas.map((i) => ({ ...task(i), assigned: i.status === 'building' })).sort((x, y) => Number(y.assigned) - Number(x.assigned)));
    }
    const m = pathname.match(/^\/api\/tasks\/(\d+)\/(claim|submit|release)$/);
    if (!m || req.method !== 'POST') return json({ error: 'Not found' }, 404);
    const idea = await db.first<Idea>('SELECT * FROM ideas WHERE guild_id = ? AND issue = ?', w.guild_id, Number(m[1]));
    if (!idea) return json({ error: 'No such task.' }, 404);

    if (m[2] === 'claim') {
      if (g.builder !== 'workers') return json({ error: 'This server is not using Hive Workers right now.' }, 403);
      const member = await discord(env, 'GET', `/guilds/${g.guild_id}/members/${w.user_id}`);
      if (!member.roles.includes(g.worker_role_id)) return json({ error: 'You no longer have the Hive Worker role.' }, 403);
      if (idea.status === 'building' && idea.claimed_by === w.user_id && !idea.pr) {
        // Assigned to this worker by a maintainer: starting now restarts the expiry clock.
        await db.run('UPDATE ideas SET claimed_at = ? WHERE thread_id = ?', Date.now(), idea.thread_id);
        return json(task(idea));
      }
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

  if (new Date(now).getUTCMinutes() % 15 === 0) {
    for (const g of guilds.values()) await refreshStats(env, db, g).catch((e) => console.error(`hive stats ${g.guild_id}:`, e));
  }

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
