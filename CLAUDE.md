# Arbeitsrichtlinie für Claude in diesem Repo

Dieses Projekt ist die Website von Stahl & Verstand, inkl. `kunde.html`
(Kunden-Assistent „Professor Funke") und dem Cloudflare-Worker unter
`worker/worker.js`. Hier wurden bereits mehrfach Bugs live beim Kunden
entdeckt, die vor dem Deploy hätten auffallen müssen. Deshalb gilt ab jetzt
verbindlich:

## Vor jedem Deploy (kunde.html, config.js, worker.js)

1. **Bauen & Syntax prüfen**: `bash kbuild.sh` im Quellverzeichnis laufen
   lassen (nutzt intern `node --check`). Fehler sofort beheben, nicht nur
   notdürftig umgehen.
2. **Live im Browser testen, nicht nur "sollte gehen"**: Über den
   verbundenen Browser (remote-devices Claude Browser) die neue Version
   öffnen und tatsächlich durchklicken:
   - Konsole prüfen (`read_console_messages`, pattern `.`) – **null
     Fehler** ist die Messlatte, nicht "nur Warnungen".
   - Kompletten Standard-Flow durchspielen: Start → Produkt wählen →
     Nachricht abschicken während noch etwas lädt (Race-Condition-Test!) →
     Zurück-Button → Kamera-Button → Foto-Studio öffnen.
   - **Immer auch den Zustand VOR Produktwahl testen** (`S.product=""`,
     `K.mode!=="katalog"`, frischer Start über "Los geht's"). Genau dieser
     Zustand hat schon zweimal Abstürze verursacht (`fixState()`,
     `layout()` griffen auf `undefined` zu).
   - Reparatur-Pfad ("Reparatur"-Kachel) mindestens einmal mit anstoßen,
     da dort die Antworten länger werden (Checkliste, Zusammenfassung).
3. **Cache-Bypass beim Verifizieren**: Nach `git push` dauert das
   GitHub-Pages-Rollout ~30–60 Sekunden. Vor dem "live"-Test mit
   `fetch(url, {cache:'no-store'})` oder einem Query-Parameter
   (`?v=timestamp`) sicherstellen, dass wirklich die neue Version geladen
   wird – alte Konsolenfehler aus einem vorherigen Tab-Zustand nicht mit
   frischen verwechseln.
4. Erst wenn Build **und** Live-Test fehlerfrei sind: committen und
   pushen.
5. **Nie behaupten, ein Fix sei live, ohne es verifiziert zu haben.**
   Lieber einmal mehr live testen als eine Vermutung als Tatsache
   verkaufen.

## Worker-Deploys (worker/worker.js)

Der Worker läuft separat auf Cloudflare und wird **nicht** automatisch
deployt, wenn der Code hier im Repo geändert wird. Nach jeder Änderung an
`worker/worker.js` im Chat klar sagen, dass der Code manuell in Cloudflare
(Dashboard oder `wrangler deploy`) neu ausgerollt werden muss, sonst läuft
dort weiter die alte Version.

## Bekannte Fehlerquellen in diesem Projekt

- **Smart/Curly Quotes** (", ", „) landen gelegentlich durch das Edit-Tool
  in JS-String-Literalen und brechen sie. Nach jeder Textänderung in den
  `.js`-Quelldateien `node --check` laufen lassen (passiert automatisch in
  `kbuild.sh`).
- **Leerer Produkt-/Modell-Zustand** (`S.product=""`, `S.model=""`): Viele
  Funktionen (`fixState()`, `layout()`, `prod()`, `model()`,
  `modelsFor()`) gingen ursprünglich davon aus, dass immer ein gültiges
  Produkt gesetzt ist. Bei Änderungen an Reset-/Default-Logik immer auch
  den Zustand "noch kein Produkt gewählt" testen.
- Der Chat-Parser erwartet valides JSON vom Worker (`{"sagen":...}`).
  Abgeschnittene Antworten (zu niedriges `max_tokens` im Worker) führen zu
  rohem JSON im Chat statt lesbarem Text – es gibt inzwischen einen
  Regex-Fallback in `ask()`, aber die eigentliche Ursache (Token-Limit) im
  Zweifel zuerst prüfen.
