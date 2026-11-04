# BTC · Polymarket Dashboard

Live-Dashboard für die 5-Minuten-Märkte „Bitcoin Up or Down“ auf Polymarket.
Läuft komplett im Browser – kein Backend, kein Build-Schritt, keine API-Keys.

**Live:** https://mariusrapp.github.io/btc-poly-dashboard/

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Haupt-Dashboard: BTC-Median gegen den Strike, Countdown, implizite UP-Wahrscheinlichkeit, Polymarket-Orderbuch (feste Preisleiter, das Mid wandert; umschaltbar auf die nächste Runde), Signale, die letzten 2 Stunden mit offiziellen Ergebnissen – jede Runde im Chart abrufbar – und eigene Trefferquote. Für Desktop, Tablet und Handy, mit Light- und Dark-Mode. |
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
  aus mindestens drei frischen Quellen. Binance und Bitfinex laufen über BTC/USDT und werden mit dem USDT/USD-Kurs
  von Coinbase umgerechnet. Bitfinex' eigenes BTC/USD-Paar liegt dauerhaft 100 $+ über dem Rest, weil Dollar auf
  Bitfinex schwer abzuheben sind und dort rund 0,15 % weniger wert sind als Bankdollar.
  Beim Laden und nach der Rückkehr aus dem Hintergrund werden die letzten Minuten per REST nachgeladen
  (Coinbase, Kraken, Binance – die anderen Börsen erlauben keine Browser-Anfragen).
- **Polymarket:** Gamma API für Marktsuche und offizielle Rundenergebnisse, CLOB-WebSocket für das Orderbuch.
  Der Markt der nächsten Runde wird schon während der laufenden Runde verbunden, der Wechsel an der
  Rundengrenze passiert ohne Nachladen.
- **Vergangene Runden:** BTC aus dem eigenen Median, solange er noch im Speicher ist, sonst Binance-1s-Kerzen
  (USDT→USD); Wahrscheinlichkeit aus den live mitgeschriebenen Mids, sonst aus allen Trades der Runde
  (Polymarket Data API v2, ein Punkt pro Sekunde).

## Benutzung

Die HTML-Dateien einfach im Browser öffnen. Die Glocke oben rechts schaltet Alarme ein
(Strike-Kreuzung in der letzten Minute, große Abweichung Markt vs. Modell). Die Trefferquote wird im
Browser gespeichert, solange das Dashboard offen ist.

Über das Menü links in der Chart-Leiste (oder einen Tipp auf eine Runde unter „Recent rounds“) lässt
sich jede der letzten 24 Runden im Chart ansehen. „Exchange lines“ und „Averaging windows“ (die beiden
60-s-Fenster, aus denen Strike und Abrechnung berechnet werden) sind Schalter und werden im Browser gemerkt.

Für das Notebook:

```bash
pip install requests websockets ipywidgets web3
```

## Hinweis

Modell, Mispricing, Projected Settlement und Buy Pressure sind Heuristiken, keine Handelsempfehlung.
Polymarket erhebt bei diesen Märkten Taker-Gebühren.
