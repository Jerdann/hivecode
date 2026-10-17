CREATE TABLE IF NOT EXISTS guilds (
  guild_id       TEXT PRIMARY KEY,
  forum_id       TEXT NOT NULL,
  worker_role_id TEXT NOT NULL,
  manager_role_id TEXT,                           -- Hive Manager: approve, veto, moderate the forum
  mind_role_id   TEXT,                            -- Hive Mind: owners (setup + decisions)
  pollinator_role_id TEXT,                        -- given to authors whose idea shipped
  category_id    TEXT,                            -- the 🐝 HiveCode category
  guide_channel_id TEXT, guide_message_id TEXT,   -- #hive-guide and its live post
  stats_channel_id TEXT, stats_message_id TEXT,   -- #hive-stats and its live post
  workers_channel_id TEXT,                        -- #hive-workers (private)
  tags           TEXT NOT NULL,                   -- JSON: status -> forum tag id
  voter_role_id  TEXT,                            -- NULL = everyone can vote
  changelog_id   TEXT,
  min_votes      INTEGER NOT NULL DEFAULT 5,
  approve_pct    INTEGER NOT NULL DEFAULT 60,
  discuss_hours  INTEGER NOT NULL DEFAULT 24,
  vote_hours     INTEGER NOT NULL DEFAULT 48,
  approval       TEXT NOT NULL DEFAULT 'vote',    -- vote | vote+owner | owner | auto
  builder        TEXT NOT NULL DEFAULT 'manual',  -- manual | action | workers
  merge          TEXT NOT NULL DEFAULT 'owner',   -- owner | vote | auto
  options_by     TEXT NOT NULL DEFAULT 'author'   -- author | anyone
);

CREATE TABLE IF NOT EXISTS ideas (
  thread_id   TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  author_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  options     TEXT NOT NULL,                      -- JSON: [{ text, by }]
  status      TEXT NOT NULL,
  phase_ends  INTEGER,                            -- unix ms when discussion / voting closes
  winner      INTEGER,
  issue       INTEGER,                            -- 0 while the issue is being created
  pr          INTEGER,
  claimed_by  TEXT,
  claimed_at  INTEGER,
  merge_state TEXT                                -- auto | manual
);

CREATE TABLE IF NOT EXISTS votes (
  thread_id TEXT NOT NULL,
  round     TEXT NOT NULL,                        -- idea | ship
  user_id   TEXT NOT NULL,
  choice    INTEGER NOT NULL,                     -- option index, -1 = reject
  PRIMARY KEY (thread_id, round, user_id)
);

CREATE TABLE IF NOT EXISTS workers (
  token_hash TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL
);
