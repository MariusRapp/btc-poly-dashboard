# Krypto Up/Down · Polymarket & Kalshi Dashboard

Live-Dashboard für die „Up or Down“-Märkte auf **Bitcoin, Ethereum, Solana, XRP und Dogecoin**: die 5- und
15-Minuten-Runden auf Polymarket und die 15-Minuten-Runden auf Kalshi („BTC price up in next 15 mins?“, Serien
`KXBTC15M`, `KXETH15M`, `KXSOL15M`, `KXXRP15M`, `KXDOGE15M`).
Polymarket läuft komplett im Browser – kein Backend, kein Build-Schritt, keine API-Keys. Für Kalshi braucht es
einen kleinen Proxy (siehe unten), weil Kalshi Browser-Anfragen von fremden Seiten blockiert.

**Live:** https://mariusrapp.github.io/btc-poly-dashboard/

Der Coin-Schalter ganz oben (BTC · ETH · SOL · XRP · DOGE) wechselt alles auf einmal: Börsen-Feeds, Chainlink-Feed,
Volatilität, Märkte, Trefferquote und die Runden des Recorders. Preise und Beträge haben die Nachkommastellen des Coins
(DOGE $0.07281), und Schwellen, die früher in Dollar für Bitcoin galten, sind jetzt Anteile am Preis.
`?asset=eth` in der Adresse wählt einen Coin direkt; die Wahl wird gemerkt.

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
| `recorder/` | Cloudflare Worker mit Cron Trigger und D1-Datenbank: zeichnet jede Minute alle laufenden Runden aller Coins auf, auch ohne offenen Tab (siehe „Recorder“). |
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
  Anteile zahlt 1 $, solange beide Börsen gleich abrechnen. Angezeigt wird zuerst, was ein Paar **nach dem Split-Risiko**
  im Mittel bringt, darunter die Kosten inklusive Taker-Gebühren (beide Börsen: 0,07 × p × (1 − p) pro Anteil,
  höchstens 1,75 ¢ bei 50 ¢), der Gewinn, falls beide gleich abrechnen, und wie viele Paare die Orderbücher hergeben.
- **Settle-apart risk:** Weil Chainlink und CF Benchmarks nicht identisch sind, können die Börsen eine Runde
  unterschiedlich abrechnen, wenn der Kurs am Ende fast genau am Strike liegt. Dann verlieren meist *beide* Anteile eines
  Paares: Der Preisunterschied zeigt gerade in die Richtung, in der die beiden Indizes auseinanderliegen. Wie oft das
  passiert, misst der Recorder: Bei Bitcoin liefen bis 6.11.2026 12 von 26 Runden auseinander, die innerhalb von
  0,25 Basispunkten (≈ 2 $) vom Strike endeten, 7 von 28 bei 0,25–0,5 bp, 5 von 56 bei 0,5–1 bp, keine von 100 bei 1–2 bp
  und 1 von 1.193 darüber. Diese Kurve (je Coin aus seinen eigenen Runden, solange es wenige sind zur Bitcoin-Kurve
  hingezogen) und die Modell-Verteilung der Abrechnung ergeben die Split-Wahrscheinlichkeit der laufenden Runde.
  Runden mit unterschiedlichem Ergebnis sind unter „Recent rounds“ mit ≠ markiert.
- **Recorded pairs:** spielt die aufgezeichneten Runden 60 s vor dem Ende nach: Wie oft gab es ein Paar unter 1 $, und
  was hätte je ein Paar mit den offiziellen Ergebnissen gebracht – alle Paare, und nur die, bei denen der Preisvorteil
  das Split-Risiko übersteigt. Stand 6.11.2026: 15 Paare in 87 Runden, −1,71 $ (beide Splits kosteten beide Anteile);
  mit der Regel 7 Paare, +0,16 $ (die Kurve stammt aus denselben Runden, das ist also eher zu optimistisch).

Die Glocke alarmiert in dieser Ansicht zusätzlich, wenn ein Paar nach Gebühren *und* Split-Risiko mindestens 0,5 ¢ bringt.

## Datenquellen

- **Coin-Preis:** Trade-WebSockets von Coinbase, Kraken, Bitstamp, Gemini, Bitfinex und Binance; Median
  aus mindestens drei frischen Quellen. Binance und Bitfinex laufen über <Coin>/USDT und werden mit dem USDT/USD-Kurs
  von Coinbase umgerechnet. Bitfinex' eigenes BTC/USD-Paar liegt dauerhaft 100 $+ über dem Rest, weil Dollar auf
  Bitfinex schwer abzuheben sind und dort rund 0,15 % weniger wert sind als Bankdollar. Die Symbole aller fünf Coins
  (auch die Chainlink-Feeds auf Polygon) stehen in `js/assets.js` und sind gegen die Live-APIs geprüft.
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

## Recorder

Der Browser sammelt nur, solange ein Tab offen ist. Der Worker in `recorder/` läuft deshalb jede Minute auf Cloudflare
(Cron Trigger) und speichert für alle fünf Coins und jeden ihrer drei Märkte (Bitcoin: `poly5`, `poly15`, `kalshi15`;
die anderen mit Präfix: `eth-poly5`, `doge-kalshi15`, …) in der D1-Datenbank `btc-rounds`:

- **jede Minute** einen Snapshot jeder laufenden Runde (Tabelle `snaps`): besten Bid und Ask **und die Menge dort**,
  Preis, Volatilitäten, Tempo der letzten Minute und die Wahrscheinlichkeit des Standard-Modells (dasselbe wie im
  Dashboard, `js/math.js`) – eine 5-Minuten-Runde bekommt fünf Snapshots, eine 15-Minuten-Runde fünfzehn,
- pro Runde (Tabelle `rounds`) den Snapshot 60 s vor dem Ende, die 60-s-Durchschnitte vor dem Start und vor dem Ende,
  das offizielle Ergebnis, bei Kalshi zusätzlich die veröffentlichten Indexwerte (Start und Abrechnung).

Preise: Bitcoin aus Kraken-BTC/USD-Trades (Binance blockt Anfragen aus dem Cloudflare-Netz). Die anderen Coins handeln
auf Kraken allein zu selten (Dogecoin: alle 30 s ein Trade, Lücken bis zwei Minuten), deshalb werden ihre Trades von
Kraken und Coinbase zusammengeführt. Volatilität aus Coinbase-1-Minuten-Kerzen.

Die offiziellen Ergebnisse der 15-Minuten-Runden beider Börsen holt er für jeden Coin zwei Wochen rückwirkend nach.
Das Dashboard liest die Runden über `GET /rounds` (Trefferquote, Log Loss und Brier-Score von Markt und Modell, Backtest,
Kalibrierung, Split-Kurve) und die Minuten-Snapshots über `GET /snaps` (Karte „Recorded rounds“, „By minute“).
Ist der Recorder nicht erreichbar, bleibt es bei der Trefferquote im Browser.

Damit er im Free-Plan bleibt (10 ms CPU, 50 Unteranfragen, etwa 50 D1-Abfragen pro Lauf): alle Polymarket-Orderbücher
in einer Anfrage, die Markt-IDs (Polymarket-Token, Kalshi-Ticker) in D1 gemerkt statt jede Minute nachgeschlagen,
Kalshi-Bücher nur mit der besten Stufe, kleine Trade-Seiten und alle Schreibzugriffe eines Laufs in drei
mehrzeiligen Statements. Gemessen auf abgespielten Antworten: etwa 5 ms Arbeit pro Lauf, 20–35 Unteranfragen.
Rund 22.000 Zeilen am Tag (Limit: 100.000).

Einrichten (einmalig; die Datenbank `btc-rounds` ist angelegt und in `recorder/wrangler.jsonc` eingetragen):

```bash
cd recorder
npm install
npm run schema      # Tabellen in D1 anlegen (eine neue Datenbank bekommt alles auf einmal)
npm run deploy      # Worker und Cron Trigger
```

Eine bestehende Datenbank bringen die Migrationen auf Stand: `npm run migrate` (Version 2: Modell-Eingaben) und
`npm run migrate:3` (Version 3: Tabelle `snaps`, Mengen am besten Preis, Markt-IDs). Ohne Migration 3 schreibt der
Worker weiter in die alten Spalten und meldet im Log, was fehlt.

Danach zeigt https://btc-recorder.mariusrapp-kit.workers.dev/status, was schon gespeichert ist. Lokal: `npm run schema:local`,
`npm run dev -- --port 8790` (`/__scheduled` löst einen Lauf aus), Dashboard mit `?recorder=http://localhost:8790`.

## Modelle

Ganz unten erklärt die Karte **Model**, wie die UP-Wahrscheinlichkeit zustande kommt – live für die laufende Runde:

- **Wo der 60-s-Schnitt am Ende landet:** die Verteilung, grün rechts vom Strike (UP gewinnt), rot links. Mit dem Zeiger
  zeigt sie für jeden Preis, wie wahrscheinlich die Abrechnung darüber liegt.
- **Die Rechnung in vier Schritten:** Abstand zum Strike → typische Bewegung bis zum Ende → wie viele typische Bewegungen
  der Abstand ist → Wahrscheinlichkeit.
- **Markt vs. Modell:** beide auf einer Skala, dazu die Volatilität, die der Marktpreis einpreist („der Markt rechnet
  mit 1,4× so viel Bewegung wie das Modell“) – die häufigste Erklärung für eine Abweichung.
- **Edge Schritt für Schritt:** Modell-Chance − Ask − Gebühr, für UP und DOWN.

Rechts die Sammlung der Modelle. Das gewählte steuert Modell-%, Edge, Prognose-Kegel und Alarme; seine Einstellungen
liegen darunter (Schieberegler, „Reset“), alles wird im Browser gemerkt.

| Modell | Annahme |
|---|---|
| Standard | Kein Trend, Glockenkurve, Volatilität der letzten 15 min / 1 h / 4 h |
| Fast volatility | Wie Standard, die letzten Minuten zählen am meisten (Halbwertszeit 10 min) |
| Momentum | Ein Teil des Tempos der letzten Minute läuft weiter und klingt in etwa einer Minute ab |
| Fat tails | Gleiche typische Bewegung, aber große Sprünge häufiger (Student-t) |
| Learned | Logistische Regression auf den Recorder-Runden des Markts: wie viel Abstand zum Strike, Trend der letzten Minute und ruhiger/hektischer Markt tatsächlich ausmachten. Trainiert ab 100 Runden, bewertet außerhalb der Stichprobe |

Jede Karte zeigt, wie das Modell mit seinen aktuellen Einstellungen auf den Recorder-Runden abgeschnitten hätte: Log Loss
und Brier-Score gegen den Markt (alle Runden und die noch offenen, Markt 10–90 % 60 s vor dem Ende), Backtest „Edge ≥ 3 ¢
zum Ask“. Runden, in denen eine Buchseite leer ist (schon entschieden), zählen mit: die fehlende Seite gilt als 0 ¢ bzw.
100 ¢. Aussagekräftig wird das erst nach einigen hundert Runden.

**Learned** zeigt in den Einstellungen statt Schiebereglern, was es gelernt hat: das Gewicht jeder Eingabe mit seiner
Unsicherheit. Die Bewertung läuft in fünf zeitlich geordneten Teilen: Jedes Fünftel der Runden wird von einem Fit auf den
anderen vier vorhergesagt, nie von einem, der die Runde schon kannte. Für den Prognose-Kegel nimmt es die Streuung des
Standard-Modells und legt die Mitte so, dass die Wahrscheinlichkeit stimmt.

**Fit to recorded rounds** (bei Modellen mit „Volatility ×“) probiert ×0,50 bis ×2,00 auf den aufgezeichneten Runden
und übernimmt den Faktor mit dem kleinsten Log Loss – angepasst auf denselben Runden, an denen er gemessen wird.

**Eigenes Modell ergänzen:** in `js/models.js` einen Eintrag zu `MODELS` hinzufügen – die kommentierte Vorlage steht
direkt darüber. Ein Modell bekommt die Live-Eingaben (Preis, Strike, Restzeit, Volatilitäten, Tempo) und liefert
Schwankung, Trend und optional dicke Ränder; Karte, Einstellungen und Bewertung entstehen daraus von selbst. Auch ein
später trainiertes Modell (z. B. Machine Learning auf den Recorder-Runden) passt in diese Form.

Damit alle Modelle bewertet werden können, speichert der Recorder seit seiner zweiten Version ihre Eingaben mit. Einmalig:

```bash
cd recorder
npm run migrate     # vier neue Spalten in D1
npm run deploy
```

## Recorded rounds

Die Karte ganz unten wertet die Recorder-Daten des Markts in der Ansicht mit dem gewählten Modell aus:

- **Model vs market:** Weiß das Modell etwas, das der Marktpreis nicht schon sagt? Eine logistische Regression erklärt das
  Ergebnis erst mit den Log-Odds des Markts allein, dann mit Markt und Modell zusammen. Wiederholt das Modell nur den Markt,
  bekommt es das Gewicht 0 (± etwa zweimal seine Unsicherheit). Dazu: wie wahrscheinlich so ein Gewicht durch Zufall ist,
  und der Log Loss beider Fits außerhalb der Stichprobe. Ein Markt-Gewicht über 1 heißt: seine Favoriten gewannen öfter,
  als sein Preis sagte.
- **By minute:** aus den Minuten-Snapshots (Recorder v3) für jede Minute der Runde: Log Loss von Markt und Modell,
  Anteil noch offener Runden, der Backtest „Edge ≥ 3 ¢“ zu dieser Minute und die mittlere Menge, die zum Ask im Buch lag.
  Damit lässt sich sehen, wann in einer Runde ein Vorsprung entsteht – und ob er sich überhaupt handeln ließe.
- **By hour:** UP-Anteil, typische Bewegung (Median-Abstand der Abrechnung vom Strike) und Spread 60 s vor dem Ende je
  Stunde des Tages (Ortszeit), für alle Tage, Mo–Fr oder Sa–So. Stunden mit weniger als 10 Runden sind blasser.

## Paper trades und Book vs price

**Paper trades** (rechte Spalte) kauft UP oder DOWN der laufenden Runde ohne Geld: zum besten Ask, bei größeren Mengen
durch die tieferen Stufen, mit Taker-Gebühr, an der Börse in der Ansicht (in „Both“ die im Orderbuch gewählte). Jeder Trade
merkt sich, was Markt (Mid) und Modell in diesem Moment sagten, und wird mit dem offiziellen Ergebnis abgerechnet, auch für
Coins und Märkte, die gerade nicht angezeigt werden. Die Karte zeigt das eigene Ergebnis neben dem, was Markt und Modell
erwartet hatten. Gespeichert im Browser, Export als CSV.

**Book vs price** (Karte „Signals“): Springt der Preis, sagt das gewählte Modell, wie weit sich die UP-Wahrscheinlichkeit
bewegen müsste. Ist die Mitte des Orderbuchs nicht mitgekommen, sind seine Kurse für einen Moment veraltet – an diesen kurzen
Märkten die klassische Kante, um die allerdings Bots konkurrieren. Die Zeile vergleicht die letzten 2 s je Börse und
misst bei jedem Sprung von 5+ Punkten, wie lange das Buch brauchte, um die Hälfte nachzuholen (negativ: das Buch war
schneller als unser Median). Kalshis Buch wird nur einmal pro Sekunde abgefragt. Die Glocke meldet ein Buch, das einem
Sprung um 5+ Punkte hinterherhinkt.

## Code-Aufbau

Das Dashboard ist eine statische Seite: GitHub Pages liefert `index.html`, `css/app.css` und die Module in `js/` so aus,
wie sie im Repository liegen – kein Build, keine Abhängigkeiten. `index.html` lädt alle Module per `modulepreload`
parallel vor (ein Test prüft, dass die Liste vollständig ist).

| Modul | Inhalt |
|---|---|
| `main.js` | Einstieg: Bedienelemente, Start der Feeds und Timer |
| `state.js` | Gemeinsamer Zustand `S` (Werte, die mehrere Module setzen), Konstanten, gespeicherte Optionen, Börsenliste |
| `assets.js` | Die fünf Coins mit allen Symbolen und Nachkommastellen, Serien-IDs (rein, mit dem Recorder geteilt, getestet) |
| `math.js` | Reine Funktionen ohne DOM und Zustand: TWAP, Median, Modell-Verteilung, Gebühren, Edge, Arbitrage-Walk. Getestet |
| `prices.js` | Trade-Feeds der sechs Börsen, Median, REST-Nachladen |
| `model.js` | Strike, erwartete Abrechnung, Eingaben und Wahrscheinlichkeit des gewählten Modells |
| `models.js`, `modelcard.js` | Die Modell-Sammlung (rein, getestet); die Karte „Model“ mit Erklärung, Auswahl und Einstellungen |
| `chainlink.js` | Chainlink-Feed auf Polygon per JSON-RPC |
| `venues.js`, `polymarket.js`, `kalshi.js`, `mode.js` | Die beiden Börsen, ihre Orderbücher und Rundenwechsel; Markt-Umschalter |
| `charts.js`, `theme.js` | Die beiden Canvas-Charts, Tooltips, Render-Schleife; Farben |
| `panels.js`, `ladder.js`, `arb.js`, `rounds.js`, `review.js`, `alerts.js` | Die Karten: Kennzahlen und Signale, Orderbuch, Poly vs Kalshi, Runden und Trefferquote, vergangene Runden, Alarme |
| `stats.js`, `recorder.js` | Auswertung der Recorder-Runden (Log Loss, Brier, Kalibrierung, Backtest, Split-Kurve, Paar-Backtest); Abruf vom Recorder (Runden und Minuten-Snapshots) |
| `learn.js`, `analysis.js` | Logistische Regression, Kreuzvalidierung, Stacking-Test (rein, getestet); die Karte „Recorded rounds“ |
| `paper.js`, `lag.js` | Paper trades; Book vs price |
| `util.js` | DOM-Zugriff, Formatierung, Rundenzeiten |

ES-Module laden nicht von `file://`; lokal deshalb `npm start` (oder `node serve.mjs`) und http://localhost:8000/ öffnen.

## Benutzung

Online: https://mariusrapp.github.io/btc-poly-dashboard/ – lokal siehe oben. Die Glocke oben rechts schaltet Alarme ein
(Strike-Kreuzung in der letzten Minute, Model edge ab 5 ¢ pro Anteil nach Gebühren, ein Orderbuch, das einem
Preissprung hinterherhinkt, in „Both“ Arbitrage nach Split-Risiko). Auf dem
Desktop laufen Alarme und Trefferquote auch in einem Hintergrund-Tab weiter; ein gesperrtes Handy pausiert die Seite.
Der Bildschirm-Knopf daneben hält deshalb den Bildschirm an, solange das Dashboard offen ist (nur in Browsern mit
Screen Wake Lock, sonst ausgeblendet). Die Trefferquote wird je Börse und Rundenlänge im Browser gespeichert,
solange das Dashboard offen ist.

Auf dem Handy: im Browser-Menü „Zum Home-Bildschirm“ – dann startet das Dashboard wie eine App im Vollbild.

Über das Menü links in der Chart-Leiste (oder einen Tipp auf eine Runde unter „Recent rounds“) lässt
sich jede der letzten 24 Runden im Chart ansehen. „Exchange lines“, „Averaging windows“ (die beiden
60-s-Fenster, aus denen Strike und Abrechnung berechnet werden) und „Price gap“ sind Schalter und werden im Browser gemerkt.

„Model forecast“ zeigt im Rundenmodus, was das Modell bis zum Rundenende erwartet: ein Band für 68 % und 95 % der
Ausgänge – bis das Abrechnungsfenster öffnet für den Preis, danach für den laufenden 60-s-Durchschnitt, der am Ende
die Abrechnung ist. Am rechten Rand liegt die Verteilung dieses Durchschnitts, oberhalb des Strikes grün, unterhalb rot;
ihr grüner Anteil ist die Modell-Wahrscheinlichkeit. Mit dem Zeiger in der Zukunft zeigt der Tooltip den erwarteten
Wert und den 68-%-Bereich für diesen Zeitpunkt. Standardmäßig aus, die Wahl wird gemerkt.

Für das Notebook:

```bash
pip install requests websockets ipywidgets web3
```

## Hinweis

Modelle (auch Learned), Model edge, Arbitrage, Book vs price, Projected Settlement und Buy Pressure sind Heuristiken,
keine Handelsempfehlung; Paper trades handeln nicht wirklich.
Beide Börsen erheben bei diesen Märkten Taker-Gebühren. Kalshi steht nicht in jedem Land für den Handel offen.
