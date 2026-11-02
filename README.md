# BTC · Polymarket Dashboard

Live-Dashboard für die 5-Minuten-Märkte „Bitcoin Up or Down“ auf Polymarket.
Läuft komplett im Browser – kein Backend, kein Build-Schritt, keine API-Keys.

**Live:** https://mariusrapp.github.io/btc-poly-dashboard/

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Haupt-Dashboard: BTC-Median gegen den Strike, Countdown, implizite UP-Wahrscheinlichkeit, Polymarket-Orderbuch, Signale, letzte Runden mit offiziellen Ergebnissen und eigener Trefferquote. Für Desktop, Tablet und Handy, mit Light- und Dark-Mode. |
| `btc-stream.html` | Schlanker BTC/USD-Tick-Stream (Binance aggTrade) mit Volumen und Buy Pressure. |
| `poly.ipynb` | Jupyter-Notebook: Polymarket-Orderbuch als ipywidgets-Dashboard und Strike-Suche über den Chainlink-Feed. |

## Wie eine Runde entschieden wird

Laut Marktregeln entscheidet der **Chainlink BTC/USD TWAP-Stream (60 s)**: „Up“, wenn der
60-Sekunden-Durchschnitt am Rundenende ≥ dem 60-Sekunden-Durchschnitt am Rundenstart ist.
Das Dashboard rechnet deshalb so:

- **Strike** = 60-s-Durchschnitt des eigenen Börsen-Medians vor Rundenbeginn. Strike und Abrechnung
  kommen aus derselben Preisbasis, ein konstanter Versatz zu Chainlink hebt sich auf.
  Fallback (und Gegencheck): Chainlink-Feed auf Polygon (`0xc907E116054Ad103354f2D350FD2514433D57F6f`).
- **Abstand zum Strike** in der letzten Minute = bereits aufgezeichneter Teil des Abrechnungs-Durchschnitts
  plus aktueller Preis für den Rest.
- **Modell-Wahrscheinlichkeit** = Normalverteilung des Abrechnungs-Durchschnitts; Volatilität aus
  1-Minuten-Renditen der letzten Stunde (Coinbase).

## Datenquellen

- **BTC-Preis:** Trade-WebSockets von Coinbase, Kraken, Bitstamp, Gemini, Bitfinex und Binance; Median
  aus mindestens drei frischen Quellen. Binance (BTC/USDT) wird mit dem USDT/USD-Kurs von Coinbase umgerechnet.
  Beim Laden und nach der Rückkehr aus dem Hintergrund werden die letzten Minuten per REST nachgeladen
  (Coinbase, Kraken, Bitstamp, Binance).
- **Polymarket:** Gamma API für Marktsuche und offizielle Rundenergebnisse, CLOB-WebSocket für das Orderbuch.

## Benutzung

Die HTML-Dateien einfach im Browser öffnen. Die Glocke oben rechts schaltet Alarme ein
(Strike-Kreuzung in der letzten Minute, große Abweichung Markt vs. Modell). Die Trefferquote wird im
Browser gespeichert, solange das Dashboard offen ist.

Für das Notebook:

```bash
pip install requests websockets ipywidgets web3
```

## Hinweis

Modell, Mispricing, Projected Settlement und Buy Pressure sind Heuristiken, keine Handelsempfehlung.
Polymarket erhebt bei diesen Märkten Taker-Gebühren.
