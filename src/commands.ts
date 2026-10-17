// Registers HiveCode's slash commands with Discord. Run once after setup: npm run register
const choices = (pairs: Record<string, string>) => Object.entries(pairs).map(([value, name]) => ({ name, value }));

const commands = [
  { name: 'idea', description: 'Suggest something for the hive to build', contexts: [0] },
  {
    name: 'hive', description: 'HiveCode', contexts: [0],
    options: [
      {
        type: 1, name: 'setup', description: 'Create the ideas forum and set the rules (run again to change them)',
        options: [
          { type: 3, name: 'approval', description: 'How ideas get approved', choices: choices({
            vote: 'Community vote', 'vote+owner': 'Community vote, then a maintainer confirms',
            owner: 'Maintainer picks', auto: 'Auto-approve everything (chaos)' }) },
          { type: 4, name: 'min_votes', description: 'Votes needed to pass (0 = no minimum, decided when voting closes)', min_value: 0, max_value: 10000 },
          { type: 4, name: 'approve_pct', description: 'Percent of votes that must be yes (0 = simple majority)', min_value: 0, max_value: 100 },
          { type: 4, name: 'discuss_hours', description: 'Hours of discussion before voting (0 = vote right away)', min_value: 0, max_value: 720 },
          { type: 4, name: 'vote_hours', description: 'Hours voting stays open', min_value: 1, max_value: 720 },
          { type: 3, name: 'builder', description: 'Who builds approved ideas', choices: choices({
            manual: 'Maintainer builds it (just create the issue)', action: 'AI agent via GitHub Action', workers: 'Hive Workers claim it' }) },
          { type: 3, name: 'merge', description: 'How finished PRs get merged', choices: choices({
            owner: 'Maintainer merges', vote: 'Community ship vote', auto: 'Auto-merge when checks pass (chaos)' }) },
          { type: 3, name: 'options_by', description: 'Who can turn replies into options', choices: choices({
            author: 'Idea author + server managers', anyone: 'Anyone' }) },
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

const { DISCORD_APP_ID, DISCORD_TOKEN } = process.env;
if (!DISCORD_APP_ID || !DISCORD_TOKEN) throw new Error('Set DISCORD_APP_ID and DISCORD_TOKEN (in .env) first.');
const res = await fetch(`https://discord.com/api/v10/applications/${DISCORD_APP_ID}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});
console.log(res.ok ? `🐝 Registered ${commands.length} commands.` : `Failed: ${res.status} ${await res.text()}`);
