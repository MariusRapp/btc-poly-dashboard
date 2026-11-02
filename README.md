# BTC · Polymarket Dashboard

Live-Dashboard für die 5-Minuten-Märkte „Bitcoin Up or Down“ auf Polymarket.
Läuft komplett im Browser – kein Backend, kein Build-Schritt, keine API-Keys.

**Live:** https://mariusrapp.github.io/btc-poly-dashboard/

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Haupt-Dashboard: BTC-Median aus sechs Börsen gegen den Strike, Countdown, implizite UP-Wahrscheinlichkeit, Polymarket-Orderbuch, Signale (Mispricing, Projected Close, Buy Pressure). Für Desktop, Tablet und Handy, mit Light- und Dark-Mode. |
| `btc-stream.html` | Schlanker BTC/USD-Tick-Stream (Binance aggTrade) mit Volumen und Buy Pressure. |
| `poly.ipynb` | Jupyter-Notebook: Polymarket-Orderbuch als ipywidgets-Dashboard und Strike-Suche über den Chainlink-Feed. |

## Datenquellen

- **BTC-Preis:** Trade-WebSockets von Coinbase, Kraken, Bitstamp, Gemini, Bitfinex und Binance; angezeigt wird der Median.
- **Polymarket:** Gamma API für die Marktsuche (`btc-updown-5m-<timestamp>`), CLOB-WebSocket für das Orderbuch.
- **Strike („Price to Beat“):** Chainlink BTC/USD-Feed auf Polygon (`0xc907E116054Ad103354f2D350FD2514433D57F6f`), gelesen über öffentliche RPCs.

## Benutzung

Die HTML-Dateien einfach im Browser öffnen.

Für das Notebook:

```bash
pip install requests websockets ipywidgets web3
```

## Hinweis

Mispricing, Confidence und Projected Close sind einfache Heuristiken, keine Handelsempfehlung.
