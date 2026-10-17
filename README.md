<p align="center"><img src="assets/logo.png" width="120" alt="HiveCode logo"></p>

<h1 align="center">HiveCode</h1>
<p align="center"><b>Hive coding: your Discord community suggests features, votes on them, and AI agents build them.</b><br>
Self-hosted, free, works with Claude Code, Codex, or whatever agent you use.</p>

---

## How it works

```
/idea ──▶ forum post with a spec card ──▶ discuss ──▶ vote ──▶ GitHub issue ──▶ agent builds a PR ──▶ merge ──▶ 🚀 shipped
```

1. **Someone runs `/idea`.** HiveCode opens a post in your `#hive-ideas` forum. Its first message is the **spec card**: the official version of the idea.
2. **The community discusses it** in the replies. A good suggestion can become a competing option: right-click the reply → **Apps → Add as option** (up to 4 options).
3. **The card freezes and the hive votes.** Buttons for each option, plus Reject. You choose the bar: a minimum number of votes, a yes percentage, or both.
4. **Approved ideas become GitHub issues** containing exactly the text people voted on. The discussion itself never goes to the AI.
5. **Something builds it**, whichever you pick: you, an AI agent in a GitHub Action, or **Hive Workers** (community members running their own AI on their own machines).
6. **The PR gets merged** by you, by a community ship vote, or automatically (chaos mode). The post's tag tracks every step: Discussing → Voting → Approved → Building → Review → Shipped.

## Install

You need about 15 minutes, a GitHub repo for the project the hive will build, and a Discord server you manage.

### 1. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it "HiveCode". The `assets/logo.png` image works as its avatar.
2. **General Information:** copy the **Application ID** and **Public Key**.
3. **Bot:** click **Reset Token** and copy the **bot token**. Keep it secret.
4. Invite it to your server with this URL (replace `YOUR_APP_ID`):
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=292326296592
   ```
   That grants View Channels, Send Messages, Embed Links, Read Message History, Manage Channels (to create the forum), Manage Roles (to create the Hive Worker role), Manage Threads and Send Messages in Threads.

### 2. Create a GitHub token

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token.

- **Repository access:** only the project repo.
- **Permissions:** Issues, Pull requests and Contents, all set to **Read and write**.

### 3. Download HiveCode

Open a terminal (Windows: **PowerShell** or **Terminal**; Mac: **Terminal**) and run:

```bash
cd ~/Documents
git clone https://github.com/Jerdann/hivecode
cd hivecode
npm install
```

That puts HiveCode in your Documents folder:

- **Windows:** `C:\Users\<your name>\Documents\hivecode`
- **Mac:** `/Users/<your name>/Documents/hivecode`

**Every command from here on runs inside this `hivecode` folder**, and that's where the config files (`wrangler.toml`, `.env`) live.

> **Can't find the folder?** `git clone` creates it inside whatever folder your terminal was in, so if you skipped `cd ~/Documents` it's probably `C:\Users\<your name>\hivecode`. In the terminal, `pwd` prints where you are, and `explorer .` (Windows) or `open .` (Mac) opens that folder.
>
> If npm warns that esbuild/workerd install scripts were skipped, run `npm install-scripts approve esbuild workerd`, then `npm install` again.

### 4. Run the bot (pick one)

#### Option A: Cloudflare Workers (free, always on, nothing to babysit)

**A1. Log in and create the database**

```bash
npx wrangler login
npx wrangler d1 create hivecode
```

The output includes a line like `"database_id": "1a2b3c4d-5e6f-..."`. Copy the ID inside the quotes. If wrangler offers to add the database to your config file for you, choose **No**; the file already has a spot for it.

**A2. Paste the ID into `wrangler.toml`**

`wrangler.toml` is in your `hivecode` folder (for example `C:\Users\<your name>\Documents\hivecode\wrangler.toml`). Open it in any text editor (`notepad wrangler.toml` on Windows, `open -e wrangler.toml` on Mac), find this line:

```toml
database_id = "PASTE-YOUR-DATABASE-ID-HERE"
```

Replace the placeholder with your ID, keep the quotes, and save. That's the only file you edit.

**A3. Create the tables and deploy**

```bash
npx wrangler d1 execute hivecode --remote --file=schema.sql
npx wrangler deploy
```

`deploy` prints your bot's address, like `https://hivecode.<you>.workers.dev`. Copy it.

**A4. Add your settings.** Run each line. Each one asks you to paste one value:

```bash
npx wrangler secret put DISCORD_APP_ID       # Application ID (step 1)
npx wrangler secret put DISCORD_PUBLIC_KEY   # Public Key (step 1)
npx wrangler secret put DISCORD_TOKEN        # Bot token (step 1)
npx wrangler secret put GITHUB_TOKEN         # GitHub token (step 2)
npx wrangler secret put GITHUB_REPO          # Your project repo as owner/name, e.g. Jerdann/my-app
npx wrangler secret put PUBLIC_URL           # The workers.dev address from A3
```

**A5. Connect Discord.** Developer Portal → **General Information → Interactions Endpoint URL** → paste the workers.dev address → **Save Changes**. Discord sends a test request; if it saves, the bot is live.

#### Option B: Node (your PC, a VPS, Railway…)

Needs Node 24+. In your `hivecode` folder:

```bash
cp .env.example .env
notepad .env
npm start
```

Fill in each line of `.env` before `npm start` (on Mac, use `open -e .env` instead of `notepad`). The comments in the file say where each value comes from.

The bot connects to Discord over the gateway, so it needs no public URL. Data lives in `hive.db`.

The **Hive Worker API** listens on `PORT` (default 8787). Workers on other machines need to reach it, so if you use the `workers` builder, either run on a server with a public address or expose the port with a tunnel (for example `cloudflared tunnel --url http://localhost:8787`). Put that address in `PUBLIC_URL`.

### 5. Register the slash commands

In your `hivecode` folder:

```bash
npm run register
```

It asks for your Application ID and bot token (Node users who filled in `.env` skip the questions).

### 6. Set it up in Discord

Run `/hive setup` in your server. It creates the `#hive-ideas` forum (only `/idea` can start posts; everyone can reply), the **Hive Worker** role, and applies default rules. Run it again with any option to change a setting:

| Option | What it does | Default |
|---|---|---|
| `approval` | `vote` community decides · `vote+owner` community, then a maintainer confirms · `owner` maintainer picks · `auto` everything is approved instantly (chaos) | `vote` |
| `min_votes` | Votes needed. When set, an idea passes **the moment** it has enough votes at the required %. `0` = no minimum, decided when voting closes | `5` |
| `approve_pct` | % of votes that must be yes. `0` = simple majority | `60` |
| `discuss_hours` | Discussion time before voting opens. `0` = vote right away | `24` |
| `vote_hours` | How long voting (and ship votes) stay open | `48` |
| `builder` | `manual` you build it · `action` AI agent via GitHub Action · `workers` Hive Workers claim it | `manual` |
| `merge` | `owner` you merge · `vote` community ship vote · `auto` merge as soon as checks pass (chaos) | `owner` |
| `options_by` | Who can turn replies into options: `author` (idea author + managers) or `anyone` | `author` |
| `voter_role` | Only this role can vote. Pick `@everyone` to open it back up | everyone |
| `changelog` | Channel that announces shipped ideas | none |

Anyone with **Manage Server** counts as a maintainer: they get the Approve, Veto and "Open voting now" buttons.

## Builders

### `manual`
HiveCode creates the issue and you build it however you like. When the issue closes as completed, the post flips to Shipped.

### `action`: your AI agent in GitHub Actions
1. Copy [`templates/hive-build.yml`](templates/hive-build.yml) into your project at `.github/workflows/hive-build.yml`.
2. Add one secret: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token` to use your Claude subscription), or `OPENAI_API_KEY`.
3. For Codex, add a repo **variable** `HIVE_AGENT` = `codex`.
4. Settings → Actions → General → enable **Allow GitHub Actions to create and approve pull requests**.

When an idea is approved, HiveCode labels the issue `hive:build`. The workflow runs your agent with file-editing tools only, throws away any changes it made under `.github/`, and opens a PR that closes the issue.

### `workers`: Hive Workers (the hive builds it)
Give trusted members the **Hive Worker** role. When an idea is approved, they're pinged in the post.

```bash
# 1. In Discord: /hive worker  → gives you a personal token and login command
# 2. Grab worker/hive-worker.mts from this repo, then:
node hive-worker.mts login https://your-bot-url hive_xxxxxxxx
node hive-worker.mts list          # open tasks
node hive-worker.mts work          # claim the next one, build it, open the PR
node hive-worker.mts work 42       # or a specific issue
```

`hive-worker` shows you the spec, asks before claiming, forks the repo (no repo access needed), runs **your** agent on **your** subscription, pushes a branch and opens the PR. Claims expire after 6 hours. Requirements: Node 24+, git, the [GitHub CLI](https://cli.github.com) (`gh auth login`) and an AI coding CLI.

The default agent is `claude -p --allowedTools Read,Edit,Write,Glob,Grep`. Use a different one at login:

```bash
node hive-worker.mts login https://your-bot-url hive_xxx "codex exec --sandbox workspace-write -"
```

The task is passed to the agent on stdin.

## Safety

Community-written text ends up in an AI agent's prompt, so HiveCode limits what a malicious idea could do, rather than trying to detect one:

- **People vote on frozen text.** Discussion never reaches the agent, and ideas can't be edited once voting opens.
- **Agents only edit files** by default: no shell, no web access. In Actions, the agent step can't read secrets, and any change under `.github/` is discarded.
- **Workflow changes always need a human.** HiveCode never auto-merges a PR that touches `.github/`.
- **Hive Workers' machines run community prompts.** Keep the default file-only agent command, or run the worker in a container if you loosen it.
- **Tokens stay with their owners.** Your GitHub token lives in your deployment, AI keys live in your repo secrets or on each worker's machine, and worker tokens are stored hashed.
- **Chaos mode is opt-in.** `approval: auto` and `merge: auto` are meant for projects that can afford to get weird. Use a repo with no secrets and keep tests required.

## Development

```bash
npm test         # vote math + a full idea → vote → issue → claim → PR → ship run against fake Discord/GitHub
npm run check    # typecheck
```

`src/hive.ts` holds all the logic. `src/cloudflare.ts` and `src/node.ts` are thin entry points around it.

## Contributing

Built something better? **Open a pull request here** instead of keeping a separate fork, so every hive gets the improvement. Bug reports and ideas are welcome in Issues.

## License

[Apache 2.0](LICENSE). Use it, modify it and run it anywhere, including commercially. If you redistribute HiveCode or a modified version, keep the [NOTICE](NOTICE) file so the credit travels with it.
