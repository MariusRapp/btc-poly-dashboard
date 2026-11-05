-- D1 schema of the recorder (apply: npx wrangler d1 execute btc-rounds --remote --file schema.sql)
-- One row per market and round. Prices of the market are 0..1; BTC values come from Kraken BTC/USD trades.
CREATE TABLE IF NOT EXISTS rounds (
  series   TEXT    NOT NULL,   -- poly5 | poly15 | kalshi15
  start    INTEGER NOT NULL,   -- round start, unix seconds
  snap_t   INTEGER,            -- when bid / ask / model were taken (about 60s before the end)
  bid      REAL,               -- best UP (YES) bid at the snapshot
  ask      REAL,               -- best UP (YES) ask at the snapshot
  model    REAL,               -- model P(up) at the snapshot
  price    REAL,               -- BTC at the snapshot
  sigma    REAL,               -- volatility the model used, $ per √s
  strike   REAL,               -- BTC 60s average before the start
  settle   REAL,               -- BTC 60s average before the end
  result   TEXT,               -- official result: up | down
  k_strike REAL,               -- Kalshi's published BRTI start average (kalshi15)
  k_settle REAL,               -- Kalshi's published BRTI settlement average (kalshi15)
  updated  INTEGER NOT NULL,
  PRIMARY KEY (series, start)
);

-- backfill progress (cursors)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
