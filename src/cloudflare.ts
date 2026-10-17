// Cloudflare Workers entry: Discord sends interactions over HTTP, a cron trigger runs tick().
import { registerCommands } from './commands.ts';
import { api, interaction, tick, type Db, type Env } from './hive.ts';

interface D1Database {
  prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<{ results: any[] }>; first(): Promise<any>; run(): Promise<{ meta: { changes: number } }> } };
}
interface Ctx { waitUntil(promise: Promise<unknown>): void }
type CfEnv = Env & { DB: D1Database; DISCORD_PUBLIC_KEY: string };

const d1 = (db: D1Database): Db => ({
  all: async (sql, ...p) => (await db.prepare(sql).bind(...p).all()).results,
  first: (sql, ...p) => db.prepare(sql).bind(...p).first(),
  run: async (sql, ...p) => (await db.prepare(sql).bind(...p).run()).meta.changes,
});

const text = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

// Discord signs every request; reject anything that isn't from them.
async function verify(req: Request, body: string, publicKey: string | undefined) {
  const sig = req.headers.get('x-signature-ed25519');
  const time = req.headers.get('x-signature-timestamp');
  if (!sig || !time) return false;
  if (!publicKey?.trim()) {
    console.error('DISCORD_PUBLIC_KEY is not set. Run: npx wrangler secret put DISCORD_PUBLIC_KEY');
    return false;
  }
  const key = await crypto.subtle.importKey('raw', bytes(publicKey.trim()), { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, bytes(sig), new TextEncoder().encode(time + body));
}

export default {
  async fetch(req: Request, env: CfEnv, ctx: Ctx): Promise<Response> {
    const db = d1(env.DB);
    const { pathname } = new URL(req.url);
    if (pathname.startsWith('/api/')) return api(req, env, db);
    if (pathname === '/register') {
      const r = await registerCommands(env.DISCORD_APP_ID, env.DISCORD_TOKEN);
      return text(r.message, r.ok ? 200 : 500);
    }
    if (req.method !== 'POST') return text('🧠 HiveCode is running');
    const body = await req.text();
    if (!(await verify(req, body, env.DISCORD_PUBLIC_KEY))) return new Response('Bad signature', { status: 401 });
    const ix = JSON.parse(body);
    if (ix.type === 1) {
      // Discord's endpoint check, sent when you save the Interactions Endpoint URL: a good moment to register commands.
      ctx.waitUntil(registerCommands(env.DISCORD_APP_ID, env.DISCORD_TOKEN).then((r) => console.log(r.message)));
      return Response.json({ type: 1 });
    }
    const reply = await interaction(ix, env, db);
    if (reply.after) ctx.waitUntil(reply.after().catch(console.error));
    return Response.json(reply.body);
  },

  async scheduled(_event: unknown, env: CfEnv, ctx: Ctx) {
    ctx.waitUntil(tick(env, d1(env.DB)));
  },
};
