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
2. **The community discusses it** in the replies. Ideas can have competing options: the author can add up to two alternatives right in the `/idea` form, and a good reply can become one too (right-click it → **Apps → Add as option**, up to 4 options).
3. **The card freezes and the hive votes.** Buttons for each option, plus Reject. You choose the bar: a minimum number of votes, a yes percentage, or both.
4. **Approved ideas become GitHub issues** containing exactly the text people voted on. The discussion itself never goes to the AI.
5. **Something builds it**, whichever you pick: you, an AI agent in a GitHub Action, or **Hive Workers** (community members running their own AI on their own machines).
6. **The PR gets merged** by you, by a community ship vote, or automatically (risky, opt-in). The post's tag tracks every step: Discussing → Voting → Approved → Building → Review → Shipped.

## Install

About 20 minutes. Every step starts with a tag saying **where** it happens:

| Tag | Where |
|---|---|
| 🌐 **Browser** | A website, in your web browser |
| 💬 **Discord** | The Discord app (desktop, browser or phone), inside your server |
| 💻 **Terminal** | Windows: Start menu → type **PowerShell** → open it. Mac: Cmd+Space → type **Terminal** → open it |
| 📝 **Editor** | Any text editor: Notepad (Windows), TextEdit (Mac) or VS Code |

### Before you start

You need:

- **A Discord server where you have "Manage Server".** If you created the server, you do.
- **A GitHub account and the repo for the project the hive will build.** That's *your app's* repo, not HiveCode. Example: `https://github.com/you/my-app`.
- **Node.js 24 or newer.** 🌐 Download the LTS installer from https://nodejs.org and run it.
- **Git.** 🌐 Windows: https://git-scm.com/downloads. Mac: 💻 run `git --version` and accept the prompt to install it.
- **Option A only: a free Cloudflare account.** 🌐 https://dash.cloudflare.com/sign-up

💻 To check Node and Git: `node --version` should print `v24` or higher, and `git --version` should print a version number.

### Where things live

| What | Default location |
|---|---|
| HiveCode folder (created in step 3) | Windows `C:\Users\<you>\Documents\hivecode` · Mac `/Users/<you>/Documents/hivecode` |
| Cloudflare config file | `wrangler.toml` inside the HiveCode folder |
| Node config file | `.env` inside the HiveCode folder |
| Node database | `hive.db` inside the HiveCode folder |
| Your bot's settings | 🌐 https://discord.com/developers/applications → your app |
| Your Cloudflare bot | 🌐 https://dash.cloudflare.com → **Workers & Pages** → **hivecode** |
| Hive Worker login and repos | Windows `C:\Users\<you>\.hive\` · Mac `/Users/<you>/.hive/` |

### 1. Create the Discord bot

1. 🌐 Go to https://discord.com/developers/applications and log in with your Discord account.
2. 🌐 Click **New Application** (top right), name it `HiveCode`, accept the terms and click **Create**. You land on your app's **General Information** page.
3. 🌐 Optional: under **App Icon**, upload the [HiveCode logo](assets/logo.png) (open it, then right-click → **Save image as**).
4. 🌐 On **General Information**, find **Application ID** and **Public Key**. Each has a **Copy** button. You'll paste them in step 4; this page is always here to come back to.
5. 🌐 In the left sidebar, click **Bot** → **Reset Token** → confirm → **Copy**. This is your **bot token**. Discord shows it only once, so keep it handy until step 4. If you lose it, click **Reset Token** again for a new one. Never share it or post it anywhere.
6. 🌐 Invite the bot to your server. Copy this link, replace `YOUR_APP_ID` with your Application ID, and open it in your browser:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=292326296592
   ```
   Choose your server under **Add to server** → **Continue** → **Authorize**. HiveCode now appears in your server's member list.

   It asks for: View Channels, Send Messages, Embed Links, Read Message History, Manage Channels (to create the ideas forum), Manage Roles (to create the Hive Worker role), Manage Threads and Send Messages in Threads.

### 2. Create a GitHub token

This lets HiveCode create issues and merge pull requests in your project repo.

1. 🌐 Go to https://github.com/settings/personal-access-tokens/new. (The long way: GitHub → your profile picture, top right → **Settings** → **Developer settings**, at the bottom of the left sidebar → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.)
2. 🌐 **Token name:** `HiveCode`. **Expiration:** your choice. When it expires, make a new one and swap it in (see [Changing settings later](#changing-settings-later)).
3. 🌐 **Repository access:** choose **Only select repositories** and pick your project repo.
4. 🌐 **Permissions:** give **Contents**, **Issues** and **Pull requests** **Read and write** access. (Metadata: Read-only gets added automatically.)
5. 🌐 Click **Generate token** and copy it. It starts with `github_pat_`, and GitHub shows it only once.

### 3. Download HiveCode

💻 Open a terminal and run these lines one at a time:

```bash
cd ~/Documents
git clone https://github.com/Jerdann/hivecode
cd hivecode
npm install
```

That creates the HiveCode folder in your Documents:

- **Windows:** `C:\Users\<you>\Documents\hivecode`
- **Mac:** `/Users/<you>/Documents/hivecode`

**Keep this terminal open.** Every 💻 step from here runs in it, inside the `hivecode` folder. If you open a new terminal later, run `cd ~/Documents/hivecode` first.

> **Can't find the folder?** `git clone` creates it inside whatever folder your terminal was in, so if you skipped `cd ~/Documents` it's probably `C:\Users\<you>\hivecode`. 💻 `pwd` prints where the terminal is, and `explorer .` (Windows) or `open .` (Mac) opens that folder.
>
> If npm warns that esbuild/workerd install scripts were skipped, run `npm install-scripts approve esbuild workerd`, then `npm install` again.

### 4. Run the bot (pick one)

- **Option A: Cloudflare Workers.** Free, always on, and your computer can be off. Recommended.
- **Option B: Node.** Runs on your own computer or a server. The bot is offline whenever that machine is off.

#### Your settings and where to find them

Both options ask for these values:

| Setting | Paste this | Where to find it |
|---|---|---|
| `DISCORD_APP_ID` | Application ID | 🌐 [Developer Portal](https://discord.com/developers/applications) → your app → **General Information** → Application ID → **Copy** |
| `DISCORD_PUBLIC_KEY` | Public Key | 🌐 Same page → Public Key → **Copy** |
| `DISCORD_TOKEN` | Bot token | From step 1, or 🌐 your app → **Bot** → **Reset Token** for a fresh one |
| `GITHUB_TOKEN` | GitHub token | From step 2 (starts with `github_pat_`) |
| `GITHUB_REPO` | Your project repo as `owner/name` | The part after `github.com/` in your project's address: `https://github.com/you/my-app` → `you/my-app` |
| `PUBLIC_URL` | Your bot's web address | Cloudflare: the `workers.dev` address from step A4. Node: your server's public address. Only needed for Hive Workers |

#### Option A: Cloudflare Workers

**A1. Log in to Cloudflare.** 💻

```bash
npx wrangler login
```

A browser tab opens. 🌐 Log in to Cloudflare, click **Allow**, then come back to the terminal.

**A2. Create the database.** 💻

```bash
npx wrangler d1 create hivecode
```

The terminal prints a block with a line like `"database_id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"`. Highlight the ID inside the quotes with your mouse and copy it. If wrangler asks whether to add the database to your config file for you, answer **No**; the file already has a spot for it.

**A3. Paste the ID into `wrangler.toml`.** 📝

💻 Open the file with `notepad wrangler.toml` (Mac: `open -e wrangler.toml`), or find it in File Explorer / Finder at `Documents\hivecode\wrangler.toml`. Find this line:

```toml
database_id = "PASTE-YOUR-DATABASE-ID-HERE"
```

Replace the placeholder with your ID, keeping the quotes. Save (Ctrl+S, or Cmd+S on Mac) and close the editor. This is the only file you edit.

**A4. Create the tables and deploy.** 💻

```bash
npx wrangler d1 execute hivecode --remote --file=schema.sql
npx wrangler deploy
```

If this is your first Cloudflare Worker, `deploy` asks you to pick a `workers.dev` subdomain; any name works. The last lines it prints include your bot's address, like `https://hivecode.<your-subdomain>.workers.dev`. Copy it. (Lost it? 🌐 https://dash.cloudflare.com → **Workers & Pages** → **hivecode** shows it.)

**A5. Give the bot its settings.** 💻 Run these one at a time. Use the [settings table](#your-settings-and-where-to-find-them) to find each value.

```bash
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_REPO
npx wrangler secret put PUBLIC_URL
```

> ⚠️ **Type each command exactly as shown, with the capitalized name, and press Enter.** Wait until it asks `Enter a secret value:`, *then* paste the value (right-click in PowerShell, Cmd+V on Mac) and press Enter. The value might not show while you paste; that's normal.
>
> **Never put the value on the command line itself.** It gets saved as the setting's *name*: visible in plain text in your Cloudflare dashboard, and useless to the bot. If that happens, delete the entry at 🌐 https://dash.cloudflare.com → **Workers & Pages** → **hivecode** → **Settings** → **Variables and Secrets**. If it was a token, reset it (bot token: Developer Portal → **Bot** → **Reset Token**; GitHub token: delete it at https://github.com/settings/personal-access-tokens and make a new one).

**A6. Connect Discord to your bot.** 🌐 Back in your browser, go to the Discord Developer Portal: https://discord.com/developers/applications → your **HiveCode** app → **General Information**. Scroll down to **Interactions Endpoint URL**, paste your `workers.dev` address from A4, then click **Save Changes** at the bottom of the page.

Discord sends your bot a test request. If it saves without an error, you're connected. If you see *"interactions endpoint url could not be verified"*, `DISCORD_PUBLIC_KEY` is missing or wrong: redo that line from A5, then save again.

> On Cloudflare, HiveCode always looks **offline** in your member list. That's normal: it wakes up whenever someone uses it.

#### Option B: Node

1. 💻 Create your settings file and open it:
   ```bash
   cp .env.example .env
   notepad .env
   ```
   On Mac, use `open -e .env` instead of `notepad .env`. The file lives at `Documents\hivecode\.env`. File names starting with a dot are hidden in File Explorer and Finder, so open it from the terminal like this.
2. 📝 Fill in the value after each `=` (no quotes) using the [settings table](#your-settings-and-where-to-find-them). Leave `PORT` and `DB_PATH` as they are. Save and close.
3. 💻 Start the bot:
   ```bash
   npm start
   ```
   You should see `🧠 HiveCode online as HiveCode#1234` and `🧠 Registered 3 commands.` **Leave this terminal open**; closing it stops the bot. If you need a terminal for anything else, open a second one and run `cd ~/Documents/hivecode` first.

**Hive Workers on Node:** workers on other computers connect to the bot's Hive Worker API on port `8787`. If you'll use the `workers` builder, run the bot on a server with a public address, or expose the port with a tunnel (for example `cloudflared tunnel --url http://localhost:8787`). Put that public address in `PUBLIC_URL`.

### 5. Check the slash commands

HiveCode registers its commands (`/idea`, `/hive` and the **Add as option** right-click action) by itself, so usually there's nothing to do:

- **Cloudflare:** it happened when Discord verified your endpoint in A6.
- **Node:** it happens every time `npm start` runs; its terminal prints `🧠 Registered 3 commands.`

💬 In your server, type `/`. You should see `/idea` and `/hive`. If you don't, restart Discord (Ctrl+R on desktop) and look again.

Still missing? 🌐 Open your bot's address with `/register` added to the end, e.g. `https://hivecode.<your-subdomain>.workers.dev/register` (Node: `http://localhost:8787/register`). The page says `Registered 3 commands`, or tells you what's wrong (usually a bot token that was reset: update `DISCORD_TOKEN` as in [Changing settings later](#changing-settings-later)).

### 6. Turn it on in your server

1. 💬 Open your server, click into any text channel, type `/hive setup` and press Enter. (Ignore the options that pop up as you type; they're shortcuts for later.)
2. 💬 **Already have a forum** (say, for suggestions)? The first time, HiveCode asks where ideas should go: pick your forum, or click **➕ Create #hive-ideas**. You can switch later in the guide's first step, **Where do ideas go?** An existing forum keeps its tags, permissions and posts; HiveCode adds its status tags and only tracks posts made with `/idea`.
3. 💬 A **setup guide** appears that only you can see. Each step explains one choice and has dropdowns with sensible defaults already picked. Change anything you like (it saves instantly), click **Next ▶** to move on and **✅ Finish** at the end. Steps that don't apply are skipped; for example, there are no voting steps if maintainers decide everything.
4. 💬 HiveCode also creates a **🧠 HiveCode** category in your channel list, and **five roles**, explained in [Roles](#roles) below. You get **Hive Mind** automatically.

| Channel | Who sees it | What it's for |
|---|---|---|
| **#hive-guide** | Everyone (read-only) | How ideas work in your server, every command and every role. The bot keeps it in sync with your settings. Only maintainers can post here |
| **#hive-ideas** | Everyone | The ideas forum (unless you picked your own). Ideas start with `/idea`; everyone can reply |
| **#hive-stats** | Everyone (read-only) | One card per stat, refreshed every 15 minutes: ideas by stage, approval rate, votes cast, most ideas, top catalysts, most votes cast, hardest workers, the hottest idea and the idea waiting longest |
| **#hive-workers** | Hive Workers and maintainers only | A step-by-step guide to setting up `hive-worker`, the two ways to get work, the risks, and how to revoke access. Workers can chat and coordinate here |
| **#hive-changelog** | Everyone (read-only) | Optional. A post for every shipped idea. Create it with the **➕ Create #hive-changelog** button in the last step of the setup guide, or pick any channel |

5. 💬 Try it: type `/idea` in any channel, fill in the form, and your idea appears as a post in the ideas forum.

To change anything later, run `/hive setup` again: the guide opens with your current choices selected, and **#hive-guide** updates as you go. Deleted one of HiveCode's channels by accident? Run `/hive setup` and it gets recreated.

#### Roles

| Role | Who it's for | What they can do |
|---|---|---|
| **Hive Mind** (gold) | You and other owners | Everything: run `/hive setup`, Approve, Veto, Open voting now, Assign |
| **Hive Manager** (orange) | Trusted moderators | Approve, Veto, Open voting now and Assign, plus moderate the ideas forum (lock, close, pin and delete posts). They can't change setup |
| **Hive Worker** (blue) | Members who code for the project with their own AI | Claim approved ideas and build them with `hive-worker` (see [Builders](#builders)). They need a GitHub account, but no access to your repo |
| **Catalyst** (pink) | Anyone whose idea shipped | Given automatically the first time one of their ideas ships |
| **Synapse** (cyan) | Anyone who voted | Given automatically on their first vote |

Hive Mind and Hive Manager are the **maintainers**. Anyone with **Manage Server** also counts as Hive Mind.

💬 To give someone a role: Server Settings → **Members** → find the person → click **+** next to their roles → pick the role. (Or right-click their name → **Roles**.)

The member list on the right shows each role as its own group: Hive Mind, Hive Manager, Hive Worker, Catalyst, then Synapse. If your server already has other grouped roles above them, drag the Hive roles higher in Server Settings → **Roles**. They must stay below the **HiveCode** role, or the bot can't manage them.

When an idea needs a maintainer's OK, HiveCode pings **@Hive Mind** and **@Hive Manager** in its post. **✅ Approve** and **⛔ Veto** work at any point before an idea is decided, and each asks for an optional reason that gets posted in the thread.

#### Setup shortcuts

Everything in the guide can also be set directly as a `/hive setup` option, e.g. `/hive setup approval:Maintainers decide`:

| Option | What it does | Default |
|---|---|---|
| `approval` | `vote` community decides · `vote+owner` community, then a maintainer confirms · `owner` maintainer picks · `auto` everything is approved instantly (risky) | `vote` |
| `min_votes` | Votes needed. When set, an idea passes **the moment** it has enough votes at the required %. `0` = no minimum, decided when voting closes | `5` |
| `approve_pct` | % of votes that must be yes. `0` = simple majority | `60` |
| `discuss_hours` | Discussion time before voting opens. `0` = vote right away | `24` |
| `vote_hours` | How long voting (and ship votes) stay open | `48` |
| `builder` | `manual` you build it · `action` AI agent via GitHub Action · `workers` Hive Workers claim it (see [Builders](#builders)) | `manual` |
| `merge` | `owner` you merge · `vote` community ship vote · `auto` merge as soon as checks pass (risky) | `owner` |
| `options_by` | Who can turn replies into options: `author` (idea author + maintainers) or `anyone` | `author` |
| `voter_role` | Only this role can vote. Pick `@everyone` to open it back up | everyone |
| `changelog` | Channel that announces shipped ideas | none |

### Changing settings later

- **Discord rules** (votes, builder, merge…): 💬 run `/hive setup` again.
- **Tokens and keys on Cloudflare:** 💻 in the `hivecode` folder, run the matching `npx wrangler secret put NAME` line from A5 again. It takes effect right away.
- **Tokens and keys on Node:** 📝 edit `.env`, then restart the bot: press Ctrl+C in its terminal and run `npm start` again.

### Updating HiveCode

💻 In the `hivecode` folder, run `git pull`. Then run `npx wrangler deploy` (Cloudflare), or restart the bot with Ctrl+C and `npm start` (Node).

## Builders

Choose one in the setup guide (the "Who builds approved ideas" step), or with 💬 `/hive setup builder:`.

### `manual`: you build it

HiveCode creates an issue in your project repo (🌐 your repo → **Issues** tab, labeled `hive:approved`). Build it however you like. When you close the issue as completed, or merge a PR whose description says `Closes #<issue number>`, the Discord post flips to Shipped.

### `action`: your AI agent in GitHub Actions

All of this happens 🌐 on GitHub, in your **project repo** (your app's repo, not HiveCode):

1. **Add the workflow file.** On your repo's main page, click **Add file → Create new file**. In the name box, type `.github/workflows/hive-build.yml` (typing `/` creates the folders). In another tab, open [`templates/hive-build.yml`](https://github.com/Jerdann/hivecode/blob/main/templates/hive-build.yml) and click **Copy raw file** (the copy icon, top right of the code). Paste it into the editor and click **Commit changes**.
2. **Add your AI key as a secret.** Repo **Settings** tab → left sidebar **Secrets and variables → Actions** → **New repository secret**. Add one of these:
   - `ANTHROPIC_API_KEY`: an API key from 🌐 https://console.anthropic.com → **API Keys** (pay per use).
   - `CLAUDE_CODE_OAUTH_TOKEN`: uses your Claude Pro/Max subscription. 💻 With [Claude Code](https://claude.com/claude-code) installed, run `claude setup-token` and copy the token it prints.
   - `OPENAI_API_KEY`: for Codex, from 🌐 https://platform.openai.com/api-keys.
3. **Using Codex?** On the same page, open the **Variables** tab → **New repository variable**, name `HIVE_AGENT`, value `codex`. Claude is the default, so skip this for Claude.
4. **Let Actions open pull requests.** Repo **Settings** → left sidebar **Actions → General** → scroll down to **Workflow permissions** → tick **Allow GitHub Actions to create and approve pull requests** → **Save**.
5. 💬 In the setup guide, pick **AI agent (GitHub Action)** as the builder (or run `/hive setup builder:AI agent (GitHub Action)`).

When an idea is approved, HiveCode labels its issue `hive:build`. That starts the workflow (🌐 watch it in your repo's **Actions** tab): your agent edits files with file-editing tools only, any change under `.github/` is thrown away, and a PR that closes the issue gets opened.

> Using `merge: auto` with required checks? PRs opened by the workflow's default token don't trigger other workflows, so your checks never run. Add a secret `HIVE_PR_TOKEN`: a fine-grained token made like step 2, with **Contents** and **Pull requests** set to Read and write.

### `workers`: Hive Workers (the hive builds it)

**Server owner:**

1. Make sure workers can reach your bot. On Cloudflare that works out of the box once `PUBLIC_URL` is set (step A5). On Node, see [Hive Workers on Node](#option-b-node).
2. 💬 Give trusted members the **Hive Worker** role: Server Settings → **Members** → find the person → click **+** next to their roles → **Hive Worker**. You can also right-click their name → **Roles** → **Hive Worker**.
3. 💬 In the setup guide, pick **Hive Workers** as the builder (or run `/hive setup builder:Hive Workers`). Each newly approved idea pings **@Hive Worker** in its post.
4. 💬 Want a specific person on it? Click **👷 Assign to a worker** on the approved idea and pick them. They get pinged, and `hive-worker work` picks up their assignment first. Assignments go back to the queue after 6 hours if nobody starts.

**Each Hive Worker, on their own computer:**

1. Install the tools: Node.js 24+ (🌐 https://nodejs.org), Git (🌐 https://git-scm.com/downloads), the GitHub CLI (🌐 https://cli.github.com) and an AI coding CLI such as [Claude Code](https://claude.com/claude-code) or Codex. Then 💻 run `gh auth login` once and follow the prompts.
2. 🌐 Download the worker script: open [`worker/hive-worker.mts`](https://github.com/Jerdann/hivecode/blob/main/worker/hive-worker.mts) and click **Download raw file** (the download icon, top right of the code). It saves to your **Downloads** folder.
3. 💬 In the server, type `/hive worker` in any channel. Only you see the reply: a login command containing your personal token.
4. 💻 Go to the script and log in by pasting that command:
   ```bash
   cd ~/Downloads
   node hive-worker.mts login https://your-bot-address hive_xxxxxxxx
   ```
   Your login is saved to `C:\Users\<you>\.hive\config.json` (Mac: `~/.hive/config.json`).
5. 💻 Build something, from the same folder:
   ```bash
   node hive-worker.mts list          # see open tasks
   node hive-worker.mts work          # claim the next one, build it, open the PR
   node hive-worker.mts work 42       # or claim issue #42
   ```

`hive-worker` shows you the spec and asks before claiming. It forks the project into your GitHub account (no access to the original repo needed) and clones it to `~/.hive/repos/`. Then it runs **your** agent on **your** subscription, pushes a branch and opens the PR. Claims expire after 6 hours.

The default agent is `claude -p --allowedTools Read,Edit,Write,Glob,Grep` (file edits only). To use another, add it in quotes at the end of the login command; the task is passed to it on stdin:

```bash
node hive-worker.mts login https://your-bot-address hive_xxx "codex exec --sandbox workspace-write -"
```

## Safety

Community-written text ends up in an AI agent's prompt, so HiveCode limits what a malicious idea could do, rather than trying to detect one:

- **People vote on frozen text.** Discussion never reaches the agent, and ideas can't be edited once voting opens.
- **Agents only edit files** by default: no shell, no web access. In Actions, the agent step can't read secrets, and any change under `.github/` is discarded.
- **Workflow changes always need a human.** HiveCode never auto-merges a PR that touches `.github/`.
- **Hive Workers' machines run community prompts.** Keep the default file-only agent command, or run the worker in a container if you loosen it.
- **Tokens stay with their owners.** Your GitHub token lives in your deployment, AI keys live in your repo secrets or on each worker's machine, and worker tokens are stored hashed.
- **Risky modes are opt-in.** **Approve everything** and **Auto-merge** are meant for projects that can afford to get weird. Use a repo with no secrets and keep tests required.

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
