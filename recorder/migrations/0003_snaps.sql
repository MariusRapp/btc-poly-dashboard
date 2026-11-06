-- Recorder v3 (apply once: npm run migrate:3): a snapshot of every running round each minute, the size at the best
-- bid and ask, and the market's id (Polymarket UP token / Kalshi ticker) kept so later minutes need no lookup.
CREATE TABLE IF NOT EXISTS snaps (
  series  TEXT    NOT NULL,   -- as in rounds: poly5, poly15, kalshi15, eth-poly5, …
  start   INTEGER NOT NULL,   -- round start, unix seconds
  t       INTEGER NOT NULL,   -- when the snapshot was taken (on the minute)
  bid     REAL,               -- best UP (YES) bid, 0..1
  ask     REAL,               -- best UP (YES) ask
  bid_sz  REAL,               -- shares / contracts at the best bid
  ask_sz  REAL,               -- … at the best ask
  price   REAL,               -- the coin's price (Kraken)
  sigma   REAL,               -- volatility of the last hour, $ per √s
  vol15   REAL,               -- volatilities as in rounds (log return per √s) and the last minute's speed ($/s)
  vol240  REAL,
  ewma    REAL,
  vel     REAL,
  model   REAL,               -- the Standard model's P(up)
  PRIMARY KEY (series, start, t)
);
ALTER TABLE rounds ADD COLUMN bid_sz REAL;
ALTER TABLE rounds ADD COLUMN ask_sz REAL;
ALTER TABLE rounds ADD COLUMN token  TEXT;
