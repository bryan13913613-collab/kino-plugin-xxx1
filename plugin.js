/// <reference path="./kino.d.ts" />
// Xxx1 -- plugin de Kino con videos +18 de es.pornhub.com: búsqueda, filas de Inicio, "Ver más",
// reproducción y descarga. Todo lo que devuelve va marcado `adult: true`: Kino lo muestra solo con el
// código +18 de la persona desbloqueado, y este plugin nunca intenta saltarse ese candado, el aviso de
// edad del sitio ni ninguna verificación o captcha: si el sitio pide una, la llamada termina con un error.
//
// Qué está probado y qué no (versión 0.1.2):
//   - search / browse: la lista de resultados se leyó de una página real guardada de la búsqueda.
//   - home y categorías: usan /video?o=cm, /video?o=mv y /video?c=N con el mismo formato (sin probar con una página real).
//   - resolve: busca "mediaDefinitions" y, si no está, el mp4 directo de og:video (probado con una página real guardada).

const X1_SITE = "https://es.pornhub.com";
const X1_HLS = "application/vnd.apple.mpegurl";
const x1Enc = encodeURIComponent;

// Filas de Inicio. Cada `ref` ("o:<orden>") es lo que browse() recorre página por página.
const X1_ROWS = [
  { id: "novedades", ref: "o:cm", es: "Recién agregados", en: "Recently added" },
  { id: "mas-vistos", ref: "o:mv", es: "Más vistos", en: "Most viewed" },
];
const x1En = () => kino.lang === "en-US";

// Categorías del sitio ([número, nombre]). Se pueden abrir buscando su nombre exacto (por ejemplo "Lesbianas")
// y algunas salen como filas en Inicio.
const X1_CATS = [
  [28, "Maduras"], [29, "MILF"], [17, "Negras"], [35, "Anal"],
  [27, "Lesbianas"], [65, "Tríos"], [111, "Japonésas"], [36, "Hentai"],
  [105, "60FPS"], [3, "Aficionado"], [592, "Al Dedo"], [95, "Alemanas"],
  [98, "Árabe"], [1, "Asiáticas"], [90, "Audiciones"], [5, "Babe"],
  [76, "Bisexual Masculino"], [10, "Bondage"], [102, "Brasileras"], [96, "Británicas"],
  [14, "Bukkake"], [61, "Cámara Web"], [86, "Caricaturas"], [12, "Celebridades"],
  [100, "Checas"], [103, "Coreanas"], [242, "Cornudos"], [241, "Cosplay"],
  [15, "Creampie"], [4, "Culos Grandes"], [141, "Detrás De Cámaras"], [32, "Divertidos"],
  [72, "Doble penetración"], [30, "Estrellas Porno"], [33, "Estriptís"], [55, "Europeos"],
  [115, "Exclusivo"], [16, "Eyaculaciones"], [18, "Fetiches"], [53, "Fiestas"],
  [19, "Fisting"], [94, "Francesas"], [91, "Fumadores"], [1311, "Garganta profunda"],
  [6, "Gordas"], [101, "Indias"], [108, "Interactivo"], [25, "Interracial"],
  [97, "Italianas"], [881, "Juego"], [81, "Juegos de Rol"], [23, "Juguetes"],
  [131, "Lamidas de Coño"], [26, "Latinas"], [13, "Mamadas"], [78, "Masajes"],
  [22, "Masturbación"], [11, "Morenas"], [562, "Mujeres Tatuadas"], [512, "Musculosos"],
  [121, "Música"], [502, "Orgasmo Femenino"], [80, "Orgía"], [2, "Orgías"],
  [211, "Orinadas"], [20, "Pajas"], [201, "Parodia"], [42, "Pelirojas"],
  [93, "Pies"], [891, "Podcast xxx"], [73, "Popular entre mujeres"], [38, "Porno HD"],
  [41, "POV"], [24, "Público"], [921, "Reaccion"], [31, "Real"],
  [104, "Realidad Virtual"], [57, "Recopilación"], [522, "Romance"], [9, "Rubias"],
  [99, "Rusas"], [21, "Sexo Duro"], [221, "SFW"], [492, "Solitaria"],
  [92, "Solitario"], [69, "Squirt"], [542, "Strap On"], [732, "Subtítulos"],
  [8, "Tetas Grandes"], [59, "Tetas pequeñas"], [83, "Transgénero"], [482, "Verdaderas Parejas"],
  [138, "Verdaderos Aficionados"], [139, "Verdaderos Modelos"], [7, "Vergas grandes"], [231, "Video Narrado"],
  [43, "Vintage"],
];
const X1_HOME_CATS = [28, 29, 27, 35, 26, 1];
const x1Fold = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// ---------- Leer el HTML (solo regex: no hay DOM en QuickJS) ----------

function x1Decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function x1First(re, text) {
  const m = re.exec(text);
  return m ? x1Decode(m[1]).trim() : "";
}

// De una página de resultados o de una lista de videos saca { items, next }.
function x1ParseList(html, currentPage) {
  const items = [];
  const seen = {};
  const chunks = String(html).split(/(?=<li[^>]*\sdata-video-vkey=")/);
  for (const chunk of chunks) {
    const key = /^<li[^>]*\sdata-video-vkey="([A-Za-z0-9]+)"/.exec(chunk);
    if (!key) continue;
    const id = key[1];
    if (seen[id]) continue;
    const block = chunk.split("</li>")[0];

    let title = x1First(/class="thumbnailTitle"[^>]*>\s*([^<]+?)\s*</, block);
    if (!title) title = x1First(/<img[^>]*\salt="([^"]+)"/, block);
    if (!title) continue;

    let poster = x1First(/<img[^>]*class="[^"]*videoThumb[^"]*"[^>]*\ssrc="([^"]+)"/, block);
    if (!poster) poster = x1First(/\sdata-poster="([^"]+)"/, block);
    if (poster && !/^https:\/\//.test(poster)) poster = "";

    seen[id] = true;
    items.push({
      id,
      title,
      poster,
      duration: x1First(/class="[^"]*\btime\b[^"]*"[^>]*>\s*([^<]+?)\s*</, block),
      uploader: x1First(/class="uploaderLink[^"]*"[^>]*>\s*([^<]+?)\s*</, block),
      views: x1First(/class="videoViews"[^>]*>\s*<i[^>]*><\/i>\s*([^<]+?)\s*</, block),
    });
  }
  // La página siguiente es el menor "page=N" que sea mayor que la actual.
  let next = null;
  const re = /(?:[?&]|&amp;)page=(\d+)/g;
  let m;
  while ((m = re.exec(html))) {
    const n = parseInt(m[1], 10);
    if (n > currentPage && (next === null || n < next)) next = n;
  }
  return { items, next };
}

function x1Minutes(duration) {
  const p = String(duration).split(":").map(Number);
  if (!p.length || p.some((n) => isNaN(n))) return undefined;
  const seconds = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] || 0);
  return Math.max(1, Math.round(seconds / 60));
}

const x1Item = (x) => ({
  id: x.id,
  ref: x.id,
  title: x.title.slice(0, 200),
  kind: "movie",
  poster: x.poster || undefined,
  overview: [x.uploader && (x1En() ? "By " : "De ") + x.uploader, x.views && x.views + (x1En() ? " views" : " vistas")].filter(Boolean).join(" · ") || undefined,
  runtimeMinutes: x1Minutes(x.duration),
  adult: true,
});

// ---------- Red ----------

async function x1Html(url) {
  const r = await kino.fetch(url, { headers: { "Accept-Language": kino.lang }, timeoutMs: 12000 });
  if (r.status === 404) throw kino.error("not_found", "el sitio respondió 404");
  if (r.status === 429) throw kino.error("rate_limited");
  if (r.status === 451) throw kino.error("geo_blocked", "el sitio respondió 451");
  if (r.status === 403 || r.status === 503) {
    // Nunca se intenta resolver una verificación: se termina la llamada.
    throw kino.error("unavailable", "el sitio pidió una verificación (" + r.status + ")", {
      userMessage: x1En() ? "The site asked for a check and this can't continue from here." : "El sitio pidió una verificación y no se puede continuar desde aquí.",
    });
  }
  if (!r.ok) throw kino.error("unavailable", "el sitio respondió " + r.status);
  return r.text();
}

// ---------- Búsqueda, Inicio y "Ver más" ----------

export async function search(query) {
  const q = String(query.q || "").trim();
  if (!q) return [];
  const page = Math.max(1, parseInt(query.cursor, 10) || 1);
  const cat = X1_CATS.find((c) => x1Fold(c[1]) === x1Fold(q));
  if (cat) return browse("c:" + cat[0], query.cursor);
  const html = await x1Html(X1_SITE + "/video/search?search=" + x1Enc(q).replace(/%20/g, "+") + (page > 1 ? "&page=" + page : ""));
  const { items, next } = x1ParseList(html, page);
  return { items: items.map(x1Item), next: next ? String(next) : undefined };
}

function x1ListUrl(ref, page) {
  const o = /^o:([a-z]{2})$/.exec(String(ref));
  if (o) return X1_SITE + "/video?o=" + o[1] + (page > 1 ? "&page=" + page : "");
  const c = /^c:(\d{1,5})$/.exec(String(ref));
  if (c) return X1_SITE + "/video?c=" + c[1] + (page > 1 ? "&page=" + page : "");
  return null;
}

export async function browse(ref, cursor) {
  await null;
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  const url = x1ListUrl(ref, page);
  if (!url) throw kino.error("not_found", "fila desconocida");
  const { items, next } = x1ParseList(await x1Html(url), page);
  return { items: items.map(x1Item), next: next ? String(next) : undefined };
}

export async function home() {
  const cached = kino.storage.get("home");
  if (cached) return JSON.parse(cached);
  const defs = X1_ROWS.map((r) => ({ id: r.id, title: x1En() ? r.en : r.es, ref: r.ref }));
  for (const id of X1_HOME_CATS) {
    const c = X1_CATS.find((x) => x[0] === id);
    if (c) defs.push({ id: "cat-" + id, title: c[1], ref: "c:" + id });
  }
  let lastError = null;
  const got = await Promise.all(
    defs.map(async (d) => {
      try {
        const { items } = x1ParseList(await x1Html(x1ListUrl(d.ref, 1)), 1);
        return items.length ? { id: d.id, title: d.title, ref: d.ref, genre: "peliculas", items: items.slice(0, 20).map(x1Item) } : null;
      } catch (e) {
        lastError = e;
        return null;
      }
    })
  );
  const rows = got.filter(Boolean);
  if (!rows.length && lastError) throw lastError;
  if (rows.length) kino.storage.set("home", JSON.stringify(rows), { ttlMs: 15 * 60 * 1000 });
  return rows;
}

// ---------- Reproducir ----------

// Saca el arreglo "mediaDefinitions" de la página del video (cuenta corchetes, ignora los de los textos).
function x1Defs(html) {
  const k = html.indexOf('"mediaDefinitions"');
  if (k < 0) return [];
  const b = html.indexOf("[", k);
  if (b < 0 || b - k > 40) return [];
  let depth = 0, inStr = false, esc = false;
  for (let i = b; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      try { return JSON.parse(html.slice(b, i + 1)); } catch (e) { return []; }
    }
  }
  return [];
}

function x1Quality(def) {
  const q = Array.isArray(def.quality) ? Math.max(...def.quality.map(Number)) : Number(def.quality);
  return q > 0 ? q : 0;
}

const x1Abs = (u) => (/^https?:\/\//.test(u) ? u : X1_SITE + (u[0] === "/" ? "" : "/") + u);

export async function resolve(ref) {
  await null;
  if (!/^[A-Za-z0-9]{1,32}$/.test(String(ref))) throw kino.error("not_found", "referencia no válida");
  const html = await x1Html(X1_SITE + "/view_video.php?viewkey=" + ref);
  const defs = x1Defs(html).filter((d) => d && d.videoUrl);
  const found = [];

  // Los "mp4" traen un enlace a una lista con una dirección por calidad (se pueden descargar).
  const mp4 = defs.find((d) => d.format === "mp4");
  if (mp4) {
    try {
      const r = await kino.fetch(x1Abs(mp4.videoUrl), { headers: { "Accept-Language": kino.lang, Referer: X1_SITE + "/" }, timeoutMs: 8000 });
      const list = r.ok ? r.json() : null;
      if (Array.isArray(list)) {
        for (const m of list) if (m && m.videoUrl && /mp4/i.test(m.format || "mp4")) found.push({ q: x1Quality(m), url: m.videoUrl, mime: "video/mp4" });
      }
    } catch (e) {
      kino.log("resolve: lista mp4", e.code || "error");
    }
  }
  // Los "hls" traen la dirección directa de la lista de reproducción.
  for (const d of defs) if (d.format === "hls") found.push({ q: x1Quality(d), url: x1Abs(d.videoUrl), mime: X1_HLS });

  // Respaldo: la página trae un mp4 directo en la etiqueta og:video (suele ser de baja calidad).
  const og = x1First(/<meta[^>]*property="og:video:secure_url"[^>]*content="([^"]+)"/, html) || x1First(/<meta[^>]*property="og:video"[^>]*content="([^"]+)"/, html);
  if (/^https:\/\//.test(og) && !found.some((f) => f.url === og)) {
    const mq = /\/(\d{3,4})P_/.exec(og);
    found.push({ q: mq ? Number(mq[1]) : 0, url: og, mime: "video/mp4" });
  }
  kino.log("resolve: defs", defs.length, "enlaces", found.length);

  if (!found.length) {
    throw kino.error("not_found", "sin enlaces de video", {
      userMessage: x1En() ? "Couldn't find the video. It may have been removed or need a check." : "No se encontró el video. Puede haber sido retirado o pedir una verificación.",
    });
  }
  // Primero los mp4 (sirven para descargar), de mayor a menor calidad; luego los hls.
  found.sort((a, b) => (a.mime === b.mime ? b.q - a.q : a.mime === "video/mp4" ? -1 : 1));
  const headers = { Referer: X1_SITE + "/" };
  const label = (f) => ((f.q ? f.q + "p" : "Auto") + (f.mime === X1_HLS ? " · HLS" : "")).slice(0, 48);
  const [main, ...rest] = found;
  return {
    url: main.url,
    mime: main.mime,
    headers,
    label: label(main),
    expiresInSeconds: 900,
    alternatives: rest.slice(0, 8).map((f) => ({ label: label(f), url: f.url, mime: f.mime, headers })),
  };
                            }
