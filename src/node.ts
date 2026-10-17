// Node entry: discord.js gateway for interactions (no public URL needed), SQLite on disk,
// a 60s timer for tick(), and a small HTTP server for the Hive Worker API.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Client, GatewayDispatchEvents, GatewayIntentBits } from 'discord.js';
import { registerCommands } from './commands.ts';
import { api, interaction, tick, type Db, type Env } from './hive.ts';

const env = process.env as unknown as Env;
for (const key of ['DISCORD_APP_ID', 'DISCORD_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPO'] as const) {
  if (!env[key]) throw new Error(`Missing ${key}. Copy .env.example to .env and fill it in.`);
}

const sqlite = new DatabaseSync(process.env.DB_PATH ?? 'hive.db');
sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const db: Db = {
  all: async (sql, ...p) => sqlite.prepare(sql).all(...(p as SQLInputValue[])) as any[],
  first: async (sql, ...p) => (sqlite.prepare(sql).get(...(p as SQLInputValue[])) ?? null) as any,
  run: async (sql, ...p) => Number(sqlite.prepare(sql).run(...(p as SQLInputValue[])).changes),
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
// Raw payloads, so the exact same handler serves Cloudflare and Node.
client.ws.on(GatewayDispatchEvents.InteractionCreate, async (ix) => {
  try {
    const reply = await interaction(ix, env, db);
    await fetch(`https://discord.com/api/v10/interactions/${ix.id}/${ix.token}/callback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reply.body),
    });
    await reply.after?.();
  } catch (e) {
    console.error(e);
  }
});
client.once('clientReady', async () => {
  console.log(`🐝 HiveCode online as ${client.user?.tag}`);
  console.log((await registerCommands(env.DISCORD_APP_ID, env.DISCORD_TOKEN)).message);
});
await client.login(env.DISCORD_TOKEN);

setInterval(() => tick(env, db).catch(console.error), 60_000);

const port = Number(process.env.PORT ?? 8787);
createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    let response: Response;
    if (req.url?.startsWith('/api/')) response = await api(request, env, db);
    else if (req.url === '/register') {
      const r = await registerCommands(env.DISCORD_APP_ID, env.DISCORD_TOKEN);
      response = new Response(r.message, { status: r.ok ? 200 : 500 });
    } else response = new Response('🐝 HiveCode is running');
    res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'text/plain; charset=utf-8' });
    res.end(await response.text());
  } catch (e) {
    console.error(e);
    res.writeHead(500).end();
  }
}).listen(port, () => console.log(`🐝 Hive Worker API on http://localhost:${port}`));
