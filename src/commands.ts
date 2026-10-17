// HiveCode's slash commands. The bot registers them itself: on Cloudflare when Discord verifies the
// endpoint (or when you open /register), on Node every time it starts.
import { CHOICES } from './hive.ts';

// Same labels as the setup guide's dropdowns.
const choices = (field: string) => CHOICES[field].map(([value, name]) => ({ name, value: String(value) }));

export const commands = [
  { name: 'idea', description: 'Suggest something for the hive to build', contexts: [0] },
  {
    name: 'hive', description: 'HiveCode', contexts: [0],
    options: [
      {
        type: 1, name: 'setup', description: 'Set up HiveCode step by step (run again any time; the options below are shortcuts)',
        options: [
          { type: 3, name: 'approval', description: 'How ideas get approved', choices: choices('approval') },
          { type: 4, name: 'min_votes', description: 'Votes needed to pass (0 = no minimum, decided when voting closes)', min_value: 0, max_value: 10000 },
          { type: 4, name: 'approve_pct', description: 'Percent of votes that must be yes (0 = simple majority)', min_value: 0, max_value: 100 },
          { type: 4, name: 'discuss_hours', description: 'Hours of discussion before voting (0 = vote right away)', min_value: 0, max_value: 720 },
          { type: 4, name: 'vote_hours', description: 'Hours voting stays open', min_value: 1, max_value: 720 },
          { type: 3, name: 'builder', description: 'Who builds approved ideas', choices: choices('builder') },
          { type: 3, name: 'merge', description: 'How finished PRs get merged', choices: choices('merge') },
          { type: 3, name: 'options_by', description: 'Who can turn replies into options', choices: choices('options_by') },
          { type: 8, name: 'voter_role', description: 'Only this role can vote (pick @everyone to let everyone vote)' },
          { type: 7, name: 'changelog', description: 'Channel that announces shipped ideas', channel_types: [0, 5] },
        ],
      },
      { type: 1, name: 'edit', description: 'Edit your idea while it is still being discussed' },
      { type: 1, name: 'worker', description: 'Get a token for the hive-worker CLI (needs the Hive Worker role)' },
    ],
  },
  { type: 3, name: 'Add as option', contexts: [0] },
];

// Discord replaces the whole command list on each PUT, so this is safe to run any time.
export async function registerCommands(appId: string | undefined, token: string | undefined): Promise<{ ok: boolean; message: string }> {
  if (!appId || !token) return { ok: false, message: '⚠️ DISCORD_APP_ID and DISCORD_TOKEN must both be set first.' };
  const res = await fetch(`https://discord.com/api/v10/applications/${appId.trim()}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${token.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (res.ok) return { ok: true, message: `🐝 Registered ${commands.length} commands. Type / in your server to see them.` };
  if (res.status === 401) return { ok: false, message: '⚠️ Discord rejected the bot token (401). It is wrong or was reset. Get a fresh one (Developer Portal → Bot → Reset Token) and update DISCORD_TOKEN.' };
  return { ok: false, message: `⚠️ Discord said ${res.status}: ${(await res.text()).slice(0, 300)}` };
}
