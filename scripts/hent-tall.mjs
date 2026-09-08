// Henter ferske verdier for de nordiske aksjeindeksene og skriver dem til data.json
// i repo-roten. Kjøres av GitHub Actions-workflowen .github/workflows/oppdater-tall.yml,
// men kan også kjøres lokalt med: node scripts/hent-tall.mjs
//
// De fire landsindeksene hentes fra Nordnets samlede markedsoversikt
// (nordnet.no/market/<land>), som har identisk sideoppbygning for alle fire land —
// bare med ulikt hvilken indeks som står øverst. Vi leser den synlige teksten på
// siden (ikke CSS-klassenavn, som gjerne endrer seg hver gang nettstedet bygges på
// nytt) og finner raden til riktig indeksnavn. Det gjør skriptet robust mot mindre
// designendringer, men ikke ugjennomtrengelig — dukker en kilde opp med
// "Fant ikke ..."-feil i loggen, må indeksnavnet/selectoren under oppdateres.
//
// Før vi leser av tallene venter vi til siden faktisk har rendret dem (i stedet for
// en fast pause), siden GitHub sine kjøremaskiner kan være tregere og mer variable
// enn en vanlig nettleser — en fast pause på f.eks. 3 sekunder er noen ganger for
// kort, og da fanger vi opp en tom/ikke-ferdig-lastet side i stedet for tallene.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data.json");
const VENT_TIMEOUT_MS = 15000;

// Venter til raden for en gitt indeks faktisk viser et prosenttall på Nordnets
// markedsoversikt (ikke bare kolonneoverskriften "i dag %", som står der før
// tallene er lastet).
async function ventPaNordnetRad(page, indeksNavn) {
  try {
    await page.waitForFunction(
      (navn) => {
        const t = document.body.innerText;
        const i = t.indexOf(navn);
        if (i === -1) return false;
        const utsnitt = t.slice(i, i + 200);
        return /[+\-−][\d.,]+%/.test(utsnitt);
      },
      indeksNavn,
      { timeout: VENT_TIMEOUT_MS, polling: 300 }
    );
  } catch {
    throw new Error(`Tallene for "${indeksNavn}" rakk ikke å laste innen ${VENT_TIMEOUT_MS / 1000} sekunder`);
  }
}

// Finn raden for en gitt indeks i Nordnets markedsoversikt. Radene ser slik ut i
// sidens synlige tekst (fire linjer per indeks): navn, klokkeslett, endring i
// prosent, siste kurs. Endringstallet bruker det typografiske minustegnet "−"
// (U+2212), ikke vanlig bindestrek, derfor egen håndtering av fortegn.
async function hentFraNordnetOversikt(page, indeksNavn) {
  const tekst = await page.locator("body").innerText();
  const linjer = tekst
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const idx = linjer.findIndex((l) => l === indeksNavn);
  if (idx === -1 || idx + 3 >= linjer.length) {
    throw new Error(`Fant ikke raden for "${indeksNavn}" i sideteksten`);
  }

  const endringRaw = linjer[idx + 2]; // f.eks. "+0,49%" eller "−0,43%"
  const verdi = linjer[idx + 3]; // f.eks. "2 108,45"

  const m = endringRaw.match(/^([+\-−])([\d.,]+)%$/);
  if (!m) {
    throw new Error(`Klarte ikke å tolke endringstallet for "${indeksNavn}": "${endringRaw}"`);
  }
  const fortegn = m[1] === "+" ? 1 : -1;
  const endring = fortegn * parseFloat(m[2].replace(",", "."));
  if (Number.isNaN(endring)) {
    throw new Error(`Endringstallet ga ikke et gyldig tall for "${indeksNavn}": "${endringRaw}"`);
  }
  return { verdi, endring };
}

async function ventPaMarketscreener(page) {
  try {
    await page.waitForFunction(
      () => /([\d.,]+)\s*PTS[\s\t]+([+\-][\d.,]+)%/i.test(document.body.innerText),
      null,
      { timeout: VENT_TIMEOUT_MS, polling: 300 }
    );
  } catch {
    throw new Error(`OMX Nordic 40-tallet rakk ikke å laste innen ${VENT_TIMEOUT_MS / 1000} sekunder`);
  }
}

const kilder = [
  {
    key: "osebx",
    navn: "OSEBX",
    land: "Norge, Oslo Børs",
    url: "https://www.nordnet.no/market/no?no",
    vent: (page) => ventPaNordnetRad(page, "OSEBX"),
    hent: (page) => hentFraNordnetOversikt(page, "OSEBX"),
  },
  {
    key: "omxs30",
    navn: "OMXS30",
    land: "Sverige, Stockholmsbörsen",
    url: "https://www.nordnet.no/market/se?se",
    vent: (page) => ventPaNordnetRad(page, "OMX Stockholm 30"),
    hent: (page) => hentFraNordnetOversikt(page, "OMX Stockholm 30"),
  },
  {
    key: "omxc25",
    navn: "OMXC25",
    land: "Danmark, København",
    url: "https://www.nordnet.no/market/dk?dk",
    vent: (page) => ventPaNordnetRad(page, "OMX Copenhagen 25"),
    hent: (page) => hentFraNordnetOversikt(page, "OMX Copenhagen 25"),
  },
  {
    key: "omxh25",
    navn: "OMXH25",
    land: "Finland, Helsingfors",
    url: "https://www.nordnet.no/market/fi?fi",
    vent: (page) => ventPaNordnetRad(page, "OMX Helsinki 25"),
    hent: (page) => hentFraNordnetOversikt(page, "OMX Helsinki 25"),
  },
  {
    key: "omxn40",
    navn: "OMX Nordic 40",
    land: "Samlet nordisk indeks, 40 største selskaper",
    url: "https://www.marketscreener.com/quote/index/OMX-NORDIC-40-30080007/",
    vent: (page) => ventPaMarketscreener(page),
    async hent(page) {
      const tekst = await page.locator("body").innerText();
      const m = tekst.match(/([\d.,]+)\s*PTS[\s\t]+([+\-][\d.,]+)%/i);
      if (!m) throw new Error("Fant ikke OMX Nordic 40-verdien i sideteksten");
      const endring = parseFloat(m[2].replace(",", "."));
      if (Number.isNaN(endring)) throw new Error(`Ugyldig endringstall: "${m[2]}"`);
      return { verdi: `${m[1]} pts`, endring };
    },
  },
];

function lesEksisterende() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    return { indekser: {} };
  }
}

async function main() {
  const eksisterende = lesEksisterende();
  const indekser = { ...eksisterende.indekser };
  const feil = [];

  const browser = await chromium.launch();
  try {
    for (const kilde of kilder) {
      const page = await browser.newPage({ locale: "nb-NO" });
      try {
        await page.goto(kilde.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await kilde.vent(page);
        const { verdi, endring } = await kilde.hent(page);
        indekser[kilde.key] = {
          navn: kilde.navn,
          land: kilde.land,
          verdi,
          endring,
        };
        console.log(`OK   ${kilde.key}: ${verdi} (${endring > 0 ? "+" : ""}${endring}%)`);
      } catch (err) {
        feil.push(`${kilde.key}: ${err.message}`);
        console.error(`FEIL ${kilde.key}: ${err.message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  if (feil.length === kilder.length) {
    console.error("Alle kilder feilet i denne kjøringen — avbryter uten å skrive data.json.");
    process.exit(1);
  }

  const data = {
    oppdatert: new Date().toISOString(),
    indekser,
    sisteFeil: feil,
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`Skrev ${DATA_PATH}${feil.length ? ` (${feil.length} kilde(r) feilet)` : ""}`);
}

main().catch((err) => {
  console.error("Uventet feil:", err);
  process.exit(1);
});
