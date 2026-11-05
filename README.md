# BTC · Polymarket & Kalshi Dashboard

Live-Dashboard für die „Bitcoin Up or Down“-Märkte: die 5- und 15-Minuten-Runden auf Polymarket und die
15-Minuten-Runden auf Kalshi („BTC price up in next 15 mins?“, Serie `KXBTC15M`).
Polymarket läuft komplett im Browser – kein Backend, kein Build-Schritt, keine API-Keys. Für Kalshi braucht es
einen kleinen Proxy (siehe unten), weil Kalshi Browser-Anfragen von fremden Seiten blockiert.

**Live:** https://mariusrapp.github.io/btc-poly-dashboard/

## Drei Ansichten

Der Schalter oben wählt den Markt, die Wahl wird im Browser gemerkt:

| Ansicht | Runden | Inhalt |
|---|---|---|
| **Polymarket** | 5 oder 15 min | wie bisher: Kurs gegen Strike, UP-Wahrscheinlichkeit, Orderbuch (Now/Next), Signale, Runden, Trefferquote |
| **Kalshi** | 15 min | dasselbe für Kalshi; der Strike-Tooltip zeigt zusätzlich Kalshis offiziellen Zielpreis |
| **Both** | 15 min | beide Wahrscheinlichkeiten übereinander (Lücke dazwischen schaltbar), Orderbuch umschaltbar, Karte „Poly vs Kalshi“ |

Kalshi hat keine 5-Minuten-Runden; „Kalshi“ und „Both“ laufen deshalb immer auf 15 Minuten. Polymarkets
15-Minuten-Runden decken genau dieselben Zeitfenster ab (z. B. 16:00–16:15 ET auf beiden Seiten).

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | Das Dashboard: BTC-Median gegen den Strike, Countdown, implizite UP-Wahrscheinlichkeit, Orderbuch (feste Preisleiter, das Mid wandert), Signale, Polymarket-vs-Kalshi-Vergleich mit Arbitrage-Rechnung, die letzten 24 Runden mit offiziellen Ergebnissen – jede Runde im Chart abrufbar – und eigene Trefferquote. Für Desktop, Tablet und Handy, mit Light- und Dark-Mode. Nur Markup; Stil in `css/app.css`, Code in `js/`. |
| `js/` | Der Code als ES-Module, ohne Build-Schritt (siehe „Code-Aufbau“). |
| `test/` | Tests für die Rechenkerne (`math.js`, Chainlink-Dekodierung) und den Modul-Aufbau: `npm test`. |
| `serve.mjs` | Kleiner lokaler Server: `npm start` → http://localhost:8000/ |
| `manifest.webmanifest`, `icons/` | App-Manifest und Icons: Das Dashboard lässt sich auf dem Handy zum Home-Bildschirm hinzufügen und öffnet dann im Vollbild. |
| `kalshi-proxy/` | Cloudflare Worker, der Kalshis öffentliche Marktdaten mit CORS-Headern an das Dashboard weiterreicht (`worker.js`), plus `dev.mjs` zum lokalen Testen mit Node. |
| `btc-stream.html` | Schlanker BTC/USD-Tick-Stream (Binance aggTrade) mit Volumen und Buy Pressure. |
| `poly.ipynb` | Jupyter-Notebook: Polymarket-Orderbuch als ipywidgets-Dashboard und Strike-Suche über den Chainlink-Feed. |

## Wie eine Runde entschieden wird

Beide Börsen nutzen dieselbe Regel, aber verschiedene Indizes:

- **Polymarket:** Chainlink BTC/USD TWAP-Stream (60 s). „Up“, wenn der 60-Sekunden-Durchschnitt am Rundenende ≥ dem
  60-Sekunden-Durchschnitt am Rundenstart ist.
- **Kalshi:** CF Benchmarks BRTI. „Yes“, wenn der Durchschnitt der 60 BRTI-Werte in der letzten Minute vor dem Ende ≥ dem
  Durchschnitt der 60 Werte vor dem Start ist. Kalshi veröffentlicht den Startwert als Zielpreis (`floor_strike`)
  und den Endwert nach der Abrechnung (`expiration_value`).

Das Dashboard rechnet deshalb so:

- **Strike** = 60-s-Durchschnitt des eigenen Börsen-Medians vor Rundenbeginn. Strike und Abrechnung
  kommen aus derselben Preisbasis, ein konstanter Versatz zu Chainlink bzw. BRTI hebt sich auf.
  Fallback: Kalshis Zielpreis, sonst der Chainlink-Feed auf Polygon (`0xc907E116054Ad103354f2D350FD2514433D57F6f`).
- **Abstand zum Strike** in der letzten Minute = bereits aufgezeichneter Teil des Abrechnungs-Durchschnitts
  plus aktueller Preis für den Rest.
- **Modell-Wahrscheinlichkeit** = Normalverteilung des Abrechnungs-Durchschnitts; Volatilität aus
  1-Minuten-Renditen der letzten Stunde (Coinbase).
- **Model edge** (Karte „Signals“) = erwarteter Gewinn pro 1-$-Anteil, wenn man eine Seite zum besten Ask kauft
  und das Modell recht hat: Modell-Wahrscheinlichkeit − Ask − Taker-Gebühr (0,07 × p × (1 − p)). UP kostet den
  UP-Ask, DOWN 1 − den besten UP-Bid. Angezeigt wird die bessere Seite (in „Both“ über beide Börsen), darunter alle Seiten.

## Poly vs Kalshi

In der Ansicht „Both“ vergleicht eine eigene Karte beide Märkte derselben Runde:

- **Price gap:** UP-Mid auf Polymarket minus YES-Mid auf Kalshi.
- **Poly UP + Kalshi NO** und **Poly DOWN + Kalshi YES:** Kauf beider Seiten zu den besten Ask-Preisen. Einer der beiden
  Anteile zahlt 1 $, solange beide Börsen gleich abrechnen. Angezeigt werden Kosten inklusive Taker-Gebühren
  (beide Börsen: 0,07 × p × (1 − p) pro Anteil, höchstens 1,75 ¢ bei 50 ¢) und – falls ein Paar unter 1 $ kostet –
  wie viele Paare die Orderbücher hergeben und was das brutto bringt.
- **Settle-apart risk:** Weil Chainlink und CF Benchmarks nicht identisch sind, können die Börsen eine Runde
  unterschiedlich abrechnen, wenn der Kurs am Ende genau am Strike liegt. Dann verlieren *beide* Anteile eines Paares.
  Die Karte zeigt die Modell-Wahrscheinlichkeit, dass die Abrechnung innerhalb von ±5 $ um den Strike landet
  (eine Schätzung), und wie oft beide Börsen in den letzten Runden gleich abgerechnet haben. Runden mit
  unterschiedlichem Ergebnis sind unter „Recent rounds“ mit ≠ markiert.

Die Glocke alarmiert in dieser Ansicht zusätzlich, wenn ein Paar nach Gebühren mindestens 0,5 ¢ unter 1 $ kostet.

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
- **Kalshi:** REST-API über den Proxy. Das Orderbuch wird jede Sekunde abgefragt (Kalshis WebSocket braucht einen
  API-Key), Zielpreis und letzter Trade alle fünf Sekunden, die offiziellen Ergebnisse der letzten Runden mit einer
  Anfrage. Kalshis nächster Markt handelt erst ab Rundenstart; „Next“ im Orderbuch bleibt dort leer.
- **Vergangene Runden:** BTC aus dem eigenen Median, solange er noch im Speicher ist, sonst Binance-1s-Kerzen
  (USDT→USD). Wahrscheinlichkeit aus den live mitgeschriebenen Mids, sonst Polymarket: alle Trades der Runde
  (Data API v2, ein Punkt pro Sekunde); Kalshi: 1-Minuten-Kerzen (eine Runde hat zehntausende Trades, und Kalshi
  erlaubt nur etwa 5–10 Anfragen pro Sekunde).

## Kalshi-Proxy einrichten

Kalshis API schickt CORS-Header nur für kalshi.com und antwortet anderen Webseiten mit 403. Der Worker in
`kalshi-proxy/` leitet ausschließlich die öffentlichen, lesenden Marktdaten-Anfragen des Dashboards weiter
(kein Kalshi-Konto, kein API-Key) und lässt nur `https://mariusrapp.github.io`, `localhost` und lokal geöffnete
Dateien zu. Das Orderbuch wird am Cloudflare-Edge eine Sekunde gecacht.

Auf Cloudflare (kostenloser Plan reicht: 100.000 Anfragen/Tag ≈ 20 Stunden Dashboard am Stück):

```bash
cd kalshi-proxy
npx wrangler login
npx wrangler deploy        # gibt die URL aus, z. B. https://kalshi-proxy.<name>.workers.dev
```

Dann die URL in `index.html` bei `KALSHI_PROXY_DEFAULT` eintragen – oder das Dashboard einmal mit
`?kalshi=https://kalshi-proxy.<name>.workers.dev` öffnen (wird im Browser gemerkt, `?kalshi=` löscht es wieder).
Eingetragen ist `https://kalshi-proxy.mariusrapp-kit.workers.dev`.

Lokal ohne Cloudflare:

```bash
node kalshi-proxy/dev.mjs            # http://localhost:8787
node serve.mjs                       # Dashboard unter http://localhost:8000/?kalshi=http://localhost:8787
```

## Code-Aufbau

Das Dashboard ist eine statische Seite: GitHub Pages liefert `index.html`, `css/app.css` und die Module in `js/` so aus,
wie sie im Repository liegen – kein Build, keine Abhängigkeiten. `index.html` lädt alle Module per `modulepreload`
parallel vor (ein Test prüft, dass die Liste vollständig ist).

| Modul | Inhalt |
|---|---|
| `main.js` | Einstieg: Bedienelemente, Start der Feeds und Timer |
| `state.js` | Gemeinsamer Zustand `S` (Werte, die mehrere Module setzen), Konstanten, gespeicherte Optionen, Börsenliste |
| `math.js` | Reine Funktionen ohne DOM und Zustand: TWAP, Median, Modell-Verteilung, Gebühren, Edge, Arbitrage-Walk. Getestet |
| `prices.js` | Trade-Feeds der sechs Börsen, Median, REST-Nachladen |
| `model.js` | Strike, erwartete Abrechnung, Modell-Wahrscheinlichkeit |
| `chainlink.js` | Chainlink-Feed auf Polygon per JSON-RPC |
| `venues.js`, `polymarket.js`, `kalshi.js`, `mode.js` | Die beiden Börsen, ihre Orderbücher und Rundenwechsel; Markt-Umschalter |
| `charts.js`, `theme.js` | Die beiden Canvas-Charts, Tooltips, Render-Schleife; Farben |
| `panels.js`, `ladder.js`, `arb.js`, `rounds.js`, `review.js`, `alerts.js` | Die Karten: Kennzahlen und Signale, Orderbuch, Poly vs Kalshi, Runden und Trefferquote, vergangene Runden, Alarme |
| `util.js` | DOM-Zugriff, Formatierung, Rundenzeiten |

ES-Module laden nicht von `file://`; lokal deshalb `npm start` (oder `node serve.mjs`) und http://localhost:8000/ öffnen.

## Benutzung

Online: https://mariusrapp.github.io/btc-poly-dashboard/ – lokal siehe oben. Die Glocke oben rechts schaltet Alarme ein
(Strike-Kreuzung in der letzten Minute, Model edge ab 5 ¢ pro Anteil nach Gebühren, in „Both“ Arbitrage). Auf dem
Desktop laufen Alarme und Trefferquote auch in einem Hintergrund-Tab weiter; ein gesperrtes Handy pausiert die Seite.
Der Bildschirm-Knopf daneben hält deshalb den Bildschirm an, solange das Dashboard offen ist (nur in Browsern mit
Screen Wake Lock, sonst ausgeblendet). Die Trefferquote wird je Börse und Rundenlänge im Browser gespeichert,
solange das Dashboard offen ist.

Auf dem Handy: im Browser-Menü „Zum Home-Bildschirm“ – dann startet das Dashboard wie eine App im Vollbild.

Über das Menü links in der Chart-Leiste (oder einen Tipp auf eine Runde unter „Recent rounds“) lässt
sich jede der letzten 24 Runden im Chart ansehen. „Exchange lines“, „Averaging windows“ (die beiden
60-s-Fenster, aus denen Strike und Abrechnung berechnet werden) und „Price gap“ sind Schalter und werden im Browser gemerkt.

Für das Notebook:

```bash
pip install requests websockets ipywidgets web3
```

## Hinweis

Modell, Model edge, Arbitrage, Projected Settlement und Buy Pressure sind Heuristiken, keine Handelsempfehlung.
Beide Börsen erheben bei diesen Märkten Taker-Gebühren. Kalshi steht nicht in jedem Land für den Handel offen.
