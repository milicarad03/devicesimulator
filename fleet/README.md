# Flota od 100 uredjaja

`devices-100.json` je zajednicki izvor serijskih brojeva za grupni unos u
backend bazu i generisanje simulator sertifikata. Sadrzi 34 `modelA`, 33
`modelB` i 33 `modelC` uredjaja, sve na verziji `10.0.0`.

Pre upotrebe proveriti `targetUserEmail` u manifestu. Korisnik i sve tri
verzije modela moraju vec postojati u backend bazi.

Prvo se moze proveriti manifest bez pravljenja sertifikata:

```bash
cd ~/projekat/devicesimulator
npm run fleet:certificates -- --dry-run
```

Zatim se za svih 100 serijskih brojeva poziva postojeci generator jednog
uredjaja, redom, kako procesi za OpenSSL ne bi delili CA serial fajl u isto
vreme:

```bash
cd ~/projekat/devicesimulator
npm run fleet:certificates
```

Drugi manifest se moze proslediti opcijom `--file`:

```bash
npm run fleet:certificates -- --file fleet/druga-flota.json
```

Test validacije manifesta ne pokrece OpenSSL i ne pravi sertifikate:

```bash
npx jest --runInBand --runTestsByPath \
  tests/generate-fleet-certificates.test.js
```

Ova faza ne pokrece simulatore. Pokretanje i kontrolisano gasenje cele flote
sprovodi fleet launcher.

## Pokretanje simulatora

Pre pokretanja treba da rade Mosquitto i backend. Uredjaji iz manifesta treba
da postoje u bazi, a sertifikati treba da budu prethodno generisani.

U prvom terminalu pokrenuti svih 100 procesa:

```bash
cd ~/projekat/devicesimulator
npm run demo:fleet -- --dry-run
npm run demo:fleet
```

Launcher koristi model i verziju iz svakog reda manifesta, pa pokrece 34
`modelA`, 33 `modelB` i 33 `modelC` simulatora. Podrazumevani razmak izmedju
pokretanja procesa je 100 ms.

U drugom terminalu:

```bash
cd ~/projekat/devicesimulator
npm run demo:fleet:status
```

Za aktiviranje telemetrije kroz backend komande potrebno je pokrenuti novu
flotu sa administratorskim JWT tokenom:

```bash
FLEET_ADMIN_TOKEN="$TOKEN" \
npm run demo:fleet -- --activate
```

Backend zahtevi se salju sa ogranicenom konkurentnoscu, tako da svih 100
komandi ne stize istovremeno. Svaka komanda prolazi kroz standardnu
autorizaciju, audit i redundantnost.

Gasiti supervisor preko zasebne komande ili sa `Ctrl+C` u njegovom terminalu:

```bash
npm run demo:fleet:stop
```

Log jednog uredjaja nalazi se u:

```text
.fleet-runs/<run-id>/logs/<device-id>.log
```

Unit test launchera koristi lazne child procese i ne pokrece simulatore:

```bash
npx jest --runInBand --runTestsByPath tests/fleet-manager.test.js
```

## Automatizovani fleet E2E test

Poseban opt-in test koristi pravi Mosquitto, pravi `FleetManager` i zaseban
`sim.js` proces za svaki uredjaj. Podrazumevano pokrece pet privremenih
uredjaja, ceka njihove `online` statuse, salje `SET_STATE/ACTIVE`, proverava
odgovor i telemetriju svakog uredjaja, a zatim proverava `offline`, uredno
gasenje i da nijedan PID nije ostao aktivan:

```bash
cd ~/projekat/devicesimulator
npm run test:e2e:fleet
```

Isti test moze da se pokrene sa 20 ili svih 100 procesa:

```bash
FLEET_E2E_COUNT=20 npm run test:e2e:fleet
FLEET_E2E_COUNT=100 npm run test:e2e:fleet
```

Test koristi `SKIP_CERT=true` jer proverava launcher i MQTT zivotni ciklus, a
PKI generisanje se proverava zasebnim testom. Privremeni serijski brojevi su
jedinstveni, pa uredjaji ne moraju biti prethodno upisani u backend bazu.
Test nije deo obicnog `npm test`; aktivira ga samo `test:e2e:fleet` skripta.
Na kraju ispisuje broj online uredjaja, odgovora i telemetrijskih poruka, kao i
ukupno vreme pokretanja, prosecno/p95/maksimalno vreme po uredjaju i statistiku
urednog gasenja.
