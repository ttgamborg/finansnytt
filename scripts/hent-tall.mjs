// Henter ferske verdier for de nordiske aksjeindeksene og skriver dem til data.json
// i repo-roten. Kjøres av GitHub Actions-workflowen .github/workflows/oppdater-tall.yml,
// men kan også kjøres lokalt med: node scripts/hent-tall.mjs
//
// Prinsipp: vi leser den synlige teksten på siden (ikke CSS-klassenavn, som gjerne
// endrer seg hver gang et nettsted bygges på nytt) og finner tallene ut fra de faste
// etikettene ("Senast", "Utveckling idag" osv.). Det gjør skriptet mer robust mot
// mindre designendringer på kildesidene, men ikke ugjennomtrengelig — dukker en kilde
// opp med "Fant ikke ..."-feil i loggen, må etiketten/selectoren under oppdateres.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data.json");

// Finn linjen rett etter en gitt etikett i sidens synlige tekst, og tolk den som
// "verdi" + "endring i prosent". Brukes for Nordnet-sidene, som alle har samme
// oppbygning (bare på ulike språk).
async function hentFraEtikett(page, prisEtikett, endringEtikett) {
  const tekst = await page.locator("body").innerText();
  const linjer = tekst
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const prisIdx = linjer.findIndex((l) => l === prisEtikett);
  const endringIdx = linjer.findIndex((l) => l === endringEtikett);
  if (prisIdx === -1 || endringIdx === -1) {
    throw new Error(
      `Fant ikke etiketten "${prisEtikett}" og/eller "${endringEtikett}" i sideteksten`
    );
  }

  const verdi = linjer[prisIdx + 1];
  const endringLinje = linjer[endringIdx + 1]; // f.eks. "+0,40%+13,24"
  const m = endringLinje.match(/^([+\-][\d.,]+)%/);
  if (!m) {
    throw new Error(`Klarte ikke å tolke endringstallet: "${endringLinje}"`);
  }
  const endring = parseFloat(m[1].replace(",", "."));
  if (Number.isNaN(endring)) {
    throw new Error(`Endringstallet ga ikke et gyldig tall: "${m[1]}"`);
  }
  return { verdi, endring };
}

const kilder = [
  {
    key: "osebx",
    navn: "OSEBX",
    land: "Norge, Oslo Børs",
    url: "https://e24.no/bors/instrument/OSEBX.OSE",
    async hent(page) {
      const prisSel = "#detailed-indicator .millistream-indicator-detailed-lastprice";
      const diffSel = "#detailed-indicator .millistream-indicator-detailed-diffprc";
      await page.waitForSelector(prisSel, { timeout: 20000 });
      const verdi = (await page.locator(prisSel).first().innerText()).trim();
      const diffTxt = (await page.locator(diffSel).first().innerText()).trim();
      const negativ = await page
        .locator(diffSel)
        .first()
        .evaluate((el) => el.className.includes("status-negative"));
      const tall = parseFloat(diffTxt.replace(",", "."));
      if (Number.isNaN(tall)) throw new Error(`Klarte ikke å tolke OSEBX-endring: "${diffTxt}"`);
      return { verdi, endring: negativ ? -tall : tall };
    },
  },
  {
    key: "omxs30",
    navn: "OMXS30",
    land: "Sverige, Stockholmsbörsen",
    url: "https://www.nordnet.se/marknaden/indikator/omxs30",
    hent: (page) => hentFraEtikett(page, "Senast", "Utveckling idag"),
  },
  {
    key: "omxc25",
    navn: "OMXC25",
    land: "Danmark, København",
    url: "https://www.nordnet.dk/markedet/indikator/omxc25",
    hent: (page) => hentFraEtikett(page, "Seneste", "Udvikling i dag"),
  },
  {
    key: "omxh25",
    navn: "OMXH25",
    land: "Finland, Helsingfors",
    url: "https://www.nordnet.fi/markkinakatsaus/indikaattori/omxh25",
    hent: (page) => hentFraEtikett(page, "Viimeisin", "Kehitys tänään"),
  },
  {
    key: "omxn40",
    navn: "OMX Nordic 40",
    land: "Samlet nordisk indeks, 40 største selskaper",
    url: "https://www.marketscreener.com/quote/index/OMX-NORDIC-40-30080007/",
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
        // Gi siden litt tid til å hente og rendre live-tallene (mange av kildene
        // henter kursdata asynkront etter at selve HTML-en er lastet).
        await page.waitForTimeout(3000);
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
