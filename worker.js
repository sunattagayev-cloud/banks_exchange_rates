// uzrates.uz -> brauzer uchun JSON (Cloudflare Worker)
// Bitta so'rov = bitta valyuta + bitta oy + barcha banklar (kunlik o'rtacha bilan)
const ALLOWED_ORIGIN = "https://sunattagayev-cloud.github.io";   // index.html joylashgan sayt manbasi
const SOURCE = "exchange";                                        // "Obmen punkti"
const CURRENCIES = ["USD", "EUR", "RUB", "GBP", "JPY", "CHF", "KZT", "CHY", "TRY"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const BANKS = [
  ["Agrobank", "agrobank"], ["Aloqabank", "aloqabank"], ["Anorbank", "anorbank"], ["Apexbank", "apexbank"],
  ["Asakabank", "asakabank"], ["Asia Alliance", "asia-alliance"], ["BRB", "brb"], ["Davrbank", "davrbank"],
  ["Garantbank", "garantbank"], ["Hamkorbank", "hamkorbank"], ["Hayot Bank", "hayot-bank"], ["Infinbank", "infinbank"],
  ["Ipak Yuli Bank", "ipak-yuli-bank"], ["Ipoteka bank", "ipoteka-bank"], ["Kapitalbank", "kapitalbank"], ["KDB bank", "kdb-bank"],
  ["Madadinvest", "madadinvest"], ["MKbank", "mkbank"], ["NBU", "nbu"], ["Octobank", "octobank"], ["OFB", "ofb"],
  ["Poytaxt Bank", "poytaxt-bank"], ["Saderatbank", "saderatbank"], ["SQB", "sqb"], ["TBC", "tbc"], ["Tengebank", "tengebank"],
  ["Trastbank", "trastbank"], ["Turonbank", "turonbank"], ["Universalbank", "universalbank"], ["Uzum Bank", "uzum-bank"],
  ["Xalq banki", "xalq-banki"], ["Ziraat bank", "ziraat-bank"],
];

// Jadval qatorlari: [Valyuta, Sotib olish, Sotish, Sana] -> [{day, buy, sell}]
export function parseRows(html, cur) {
  const out = [];
  for (const [, row] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(([, c]) => c.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
    if (cells.length !== 4 || cells[0] !== cur) continue;
    const buy = Number(cells[1].replace(/[\s,]/g, ""));
    const sell = Number(cells[2].replace(/[\s,]/g, ""));
    const d = cells[3].match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!d || !(buy > 0) || !(sell > 0)) continue;
    out.push({ day: `${d[3]}-${d[2]}-${d[1]}`, buy, sell });
  }
  return out;
}

// Kunlik o'rtacha (bir kunda bir necha yozuv bo'lsa)
export function average(bank, cur, rows) {
  const acc = new Map();
  for (const r of rows) {
    const a = acc.get(r.day) || { b: 0, s: 0, n: 0 };
    a.b += r.buy; a.s += r.sell; a.n++;
    acc.set(r.day, a);
  }
  return [...acc].map(([day, a]) => ({
    Sana: day, Bank: bank, Valyuta: cur,
    "Sotib olish": Math.floor(a.b / a.n + 0.5), Sotish: Math.floor(a.s / a.n + 0.5),
  }));
}

async function fetchBank(slug, cur, year, month) {
  const body = new URLSearchParams({
    selected_year: String(year),
    selected_month: String(month).padStart(2, "0"),
    selected_currency: cur,
    selected_source: SOURCE,
  });
  const r = await fetch(`https://uzrates.uz/arkhiv-kursov-valyut/${slug}/`, {
    method: "POST", body, headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseRows(await r.text(), cur);
}

function reply(body, headers, maxAge, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` },
  });
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      Vary: "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });

    const url = new URL(req.url);
    if (url.pathname === "/banks") return reply(BANKS.map(b => b[0]), cors, 86400);
    if (url.pathname !== "/rates") return new Response("Not found", { status: 404, headers: cors });

    const cur = url.searchParams.get("cur");
    const year = Number(url.searchParams.get("year"));
    const month = Number(url.searchParams.get("month"));
    if (!CURRENCIES.includes(cur) || !Number.isInteger(year) || year < 2000 || !Number.isInteger(month) || month < 1 || month > 12) {
      return reply({ error: "bad params" }, cors, 0, 400);
    }

    const cache = caches.default;
    const cached = await cache.match(req);
    if (cached) return cached;

    const now = new Date();
    const age = (now.getUTCFullYear() * 12 + now.getUTCMonth() + 1) - (year * 12 + month); // 0 = joriy oy
    const results = await Promise.allSettled(BANKS.map(([, slug]) => fetchBank(slug, cur, year, month)));
    const records = [], failed = [];
    results.forEach((r, i) => {
      const [name] = BANKS[i];
      if (r.status === "fulfilled") records.push(...average(name, cur, r.value));
      else failed.push(name);
    });

    // Joriy/o'tgan oy: 10 daqiqa (yangi kurslar tez ko'rinsin). Eski oylar: 7 kun. Xatolik bo'lsa: 1 daqiqa.
    const ttl = failed.length ? 60 : age <= 1 ? 600 : 604800;
    const res = reply({ records, failed }, cors, ttl);
    ctx.waitUntil(cache.put(req, res.clone()));
    return res;
  },
};
