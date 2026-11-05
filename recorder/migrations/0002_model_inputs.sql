-- Inputs of every model in the dashboard's collection, stored with each snapshot so any of them can be scored
-- (apply once: npm run migrate). Volatilities are log returns per √s; vel in $/s.
ALTER TABLE rounds ADD COLUMN vol15  REAL;   -- volatility of the last 15 minutes of 1-minute closes
ALTER TABLE rounds ADD COLUMN vol240 REAL;   -- … of the last 4 hours
ALTER TABLE rounds ADD COLUMN ewma   REAL;   -- recent minutes weighted, half-life 10 minutes
ALTER TABLE rounds ADD COLUMN vel    REAL;   -- BTC's speed over the last 60s, $/s
