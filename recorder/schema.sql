-- D1 schema of the recorder (apply: npx wrangler d1 execute btc-rounds --remote --file schema.sql).
-- A fresh database gets everything at once; an older one is brought up to date by migrations/0002 and 0003.
-- One row per market and round. Prices of the market are 0..1; coin prices come from Kraken (and Coinbase for
-- the coins other than Bitcoin).
CREATE TABLE IF NOT EXISTS rounds (
  series   TEXT    NOT NULL,   -- poly5 | poly15 | kalshi15 (Bitcoin), eth-poly5 | … for the other coins
  start    INTEGER NOT NULL,   -- round start, unix seconds
  snap_t   INTEGER,            -- when bid / ask / model were taken (about 60s before the end)
  bid      REAL,               -- best UP (YES) bid at the snapshot
  ask      REAL,               -- best UP (YES) ask at the snapshot
  model    REAL,               -- model P(up) at the snapshot
  price    REAL,               -- the coin's price at the snapshot
  sigma    REAL,               -- volatility the model used, $ per √s
  strike   REAL,               -- 60s average before the start
  settle   REAL,               -- 60s average before the end
  result   TEXT,               -- official result: up | down
  k_strike REAL,               -- Kalshi's published index start average (kalshi15)
  k_settle REAL,               -- Kalshi's published index settlement average (kalshi15)
  vol15    REAL,               -- model inputs at the snapshot (migrations/0002): volatility of the last 15 min,
  vol240   REAL,               --   of the last 4 h, recent minutes weighted (half-life 10 min) — log return per √s —
  ewma     REAL,
  vel      REAL,               --   and the price's speed over the last 60s, $/s
  bid_sz   REAL,               -- size at the best bid and ask at the snapshot (migrations/0003)
  ask_sz   REAL,
  token    TEXT,               -- Polymarket UP token / Kalshi ticker of the round's market (migrations/0003)
  updated  INTEGER NOT NULL,
  PRIMARY KEY (series, start)
);

-- every running round, once a minute (migrations/0003)
CREATE TABLE IF NOT EXISTS snaps (
  series  TEXT    NOT NULL,
  start   INTEGER NOT NULL,
  t       INTEGER NOT NULL,   -- when the snapshot was taken (on the minute)
  bid     REAL, ask REAL, bid_sz REAL, ask_sz REAL,
  price   REAL, sigma REAL, vol15 REAL, vol240 REAL, ewma REAL, vel REAL,
  model   REAL,
  PRIMARY KEY (series, start, t)
);

-- backfill progress (cursors)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
