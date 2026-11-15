/// <reference path="./kino.d.ts" />
// Xxx1 -- plugin de Kino con videos +18 de es.pornhub.com: búsqueda, filas de Inicio, "Ver más",
// reproducción y descarga. Todo lo que devuelve va marcado `adult: true`: Kino lo muestra solo con el
// código +18 de la persona desbloqueado, y este plugin nunca intenta saltarse ese candado, el aviso de
// edad del sitio ni ninguna verificación o captcha: si el sitio pide una, la llamada termina con un error.
//
// Qué está probado y qué no (versión 0.1.0):
//   - search / browse: la lista de resultados se leyó de una página real guardada de la búsqueda.
//   - home: usa las listas /video?o=cm y /video?o=mv con el mismo formato (sin probar con una página real).
//   - resolve: busca "mediaDefinitions" en la página del video (sin probar con una página real).

const X1_SITE = "https://es.pornhub.com";
const X1_HLS = "application/vnd.apple.mpegurl";
const x1Enc = encodeURIComponent;

// Filas de Inicio. Cada `ref` ("o:<orden>") es lo que browse() recorre página por página.
const X1_ROWS = [
  { id: "novedades", ref: "o:cm", es: "Recién agregados", en: "Recently added" },
  { id: "mas-vistos", ref: "o:mv", es: "Más vistos", en: "Most viewed" },
];
const x1En = () => kino.lang === "en-US";

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
  const html = await x1Html(X1_SITE + "/video/search?search=" + x1Enc(q).replace(/%20/g, "+") + (page > 1 ? "&page=" + page : ""));
  const { items, next } = x1ParseList(html, page);
  return { items: items.map(x1Item), next: next ? String(next) : undefined };
}

function x1ListUrl(ref, page) {
  const m = /^o:([a-z]{2})$/.exec(String(ref));
  if (!m) return null;
  return X1_SITE + "/video?o=" + m[1] + (page > 1 ? "&page=" + page : "");
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
  const rows = [];
  let lastError = null;
  for (const row of X1_ROWS) {
    try {
      const { items } = x1ParseList(await x1Html(x1ListUrl(row.ref, 1)), 1);
      if (items.length) rows.push({ id: row.id, title: x1En() ? row.en : row.es, ref: row.ref, genre: "peliculas", items: items.slice(0, 20).map(x1Item) });
    } catch (e) {
      lastError = e;
    }
  }
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
} "Recently added" },
  { id: "mas-vistos", ref: "o:mv", es: "Más vistos", en: "Most viewed" },
];
const en = () => kino.lang === "en-US";

// ---------- Leer el HTML (solo regex: no hay DOM en QuickJS) ----------

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function first(re, text) {
  const m = re.exec(text);
  return m ? decodeEntities(m[1]).trim() : "";
}

// De una página de resultados o de una lista de videos saca { items, next }.
function parseList(html, currentPage) {
  const items = [];
  const seen = {};
  const chunks = String(html).split(/(?=<li[^>]*\sdata-video-vkey=")/);
  for (const chunk of chunks) {
    const key = /^<li[^>]*\sdata-video-vkey="([A-Za-z0-9]+)"/.exec(chunk);
    if (!key) continue;
    const id = key[1];
    if (seen[id]) continue;
    const block = chunk.split("</li>")[0];

    let title = first(/class="thumbnailTitle"[^>]*>\s*([^<]+?)\s*</, block);
    if (!title) title = first(/<img[^>]*\salt="([^"]+)"/, block);
    if (!title) continue;

    let poster = first(/<img[^>]*class="[^"]*videoThumb[^"]*"[^>]*\ssrc="([^"]+)"/, block);
    if (!poster) poster = first(/\sdata-poster="([^"]+)"/, block);
    if (poster && !/^https:\/\//.test(poster)) poster = "";

    seen[id] = true;
    items.push({
      id,
      title,
      poster,
      duration: first(/class="[^"]*\btime\b[^"]*"[^>]*>\s*([^<]+?)\s*</, block),
      uploader: first(/class="uploaderLink[^"]*"[^>]*>\s*([^<]+?)\s*</, block),
      views: first(/class="videoViews"[^>]*>\s*<i[^>]*><\/i>\s*([^<]+?)\s*</, block),
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

function minutes(duration) {
  const p = String(duration).split(":").map(Number);
  if (!p.length || p.some((n) => isNaN(n))) return undefined;
  const seconds = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] || 0);
  return Math.max(1, Math.round(seconds / 60));
}

const toItem = (x) => ({
  id: x.id,
  ref: x.id,
  title: x.title.slice(0, 200),
  kind: "movie",
  poster: x.poster || undefined,
  overview: [x.uploader && (en() ? "By " : "De ") + x.uploader, x.views && x.views + (en() ? " views" : " vistas")].filter(Boolean).join(" · ") || undefined,
  runtimeMinutes: minutes(x.duration),
  adult: true,
});

// ---------- Red ----------

async function getHtml(url) {
  const r = await kino.fetch(url, { headers: { "Accept-Language": kino.lang }, timeoutMs: 12000 });
  if (r.status === 404) throw kino.error("not_found", "el sitio respondió 404");
  if (r.status === 429) throw kino.error("rate_limited");
  if (r.status === 451) throw kino.error("geo_blocked", "el sitio respondió 451");
  if (r.status === 403 || r.status === 503) {
    // Nunca se intenta resolver una verificación: se termina la llamada.
    throw kino.error("unavailable", "el sitio pidió una verificación (" + r.status + ")", {
      userMessage: en() ? "The site asked for a check and this can't continue from here." : "El sitio pidió una verificación y no se puede continuar desde aquí.",
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
  const html = await getHtml(SITE + "/video/search?search=" + enc(q).replace(/%20/g, "+") + (page > 1 ? "&page=" + page : ""));
  const { items, next } = parseList(html, page);
  return { items: items.map(toItem), next: next ? String(next) : undefined };
}

function listUrl(ref, page) {
  const m = /^o:([a-z]{2})$/.exec(String(ref));
  if (!m) return null;
  return SITE + "/video?o=" + m[1] + (page > 1 ? "&page=" + page : "");
}

export async function browse(ref, cursor) {
  await null;
  const page = Math.max(1, parseInt(cursor, 10) || 1);
  const url = listUrl(ref, page);
  if (!url) throw kino.error("not_found", "fila desconocida");
  const { items, next } = parseList(await getHtml(url), page);
  return { items: items.map(toItem), next: next ? String(next) : undefined };
}

export async function home() {
  const cached = kino.storage.get("home");
  if (cached) return JSON.parse(cached);
  const rows = [];
  let lastError = null;
  for (const row of ROWS) {
    try {
      const { items } = parseList(await getHtml(listUrl(row.ref, 1)), 1);
      if (items.length) rows.push({ id: row.id, title: en() ? row.en : row.es, ref: row.ref, genre: "peliculas", items: items.slice(0, 20).map(toItem) });
    } catch (e) {
      lastError = e;
    }
  }
  if (!rows.length && lastError) throw lastError;
  if (rows.length) kino.storage.set("home", JSON.stringify(rows), { ttlMs: 15 * 60 * 1000 });
  return rows;
}

// ---------- Reproducir ----------

// Saca el arreglo "mediaDefinitions" de la página del video (cuenta corchetes, ignora los de los textos).
function mediaDefinitions(html) {
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

function qualityOf(def) {
  const q = Array.isArray(def.quality) ? Math.max(...def.quality.map(Number)) : Number(def.quality);
  return q > 0 ? q : 0;
}

const absolute = (u) => (/^https?:\/\//.test(u) ? u : SITE + (u[0] === "/" ? "" : "/") + u);

export async function resolve(ref) {
  await null;
  if (!/^[A-Za-z0-9]{1,32}$/.test(String(ref))) throw kino.error("not_found", "referencia no válida");
  const html = await getHtml(SITE + "/view_video.php?viewkey=" + ref);
  const defs = mediaDefinitions(html).filter((d) => d && d.videoUrl);
  const found = [];

  // Los "mp4" traen un enlace a una lista con una dirección por calidad (se pueden descargar).
  const mp4 = defs.find((d) => d.format === "mp4");
  if (mp4) {
    try {
      const r = await kino.fetch(absolute(mp4.videoUrl), { headers: { "Accept-Language": kino.lang, Referer: SITE + "/" }, timeoutMs: 8000 });
      const list = r.ok ? r.json() : null;
      if (Array.isArray(list)) {
        for (const m of list) if (m && m.videoUrl && /mp4/i.test(m.format || "mp4")) found.push({ q: qualityOf(m), url: m.videoUrl, mime: "video/mp4" });
      }
    } catch (e) {
      kino.log("resolve: lista mp4", e.code || "error");
    }
  }
  // Los "hls" traen la dirección directa de la lista de reproducción.
  for (const d of defs) if (d.format === "hls") found.push({ q: qualityOf(d), url: absolute(d.videoUrl), mime: HLS });

  if (!found.length) {
    throw kino.error("not_found", "sin enlaces de video", {
      userMessage: en() ? "Couldn't find the video. It may have been removed or need a check." : "No se encontró el video. Puede haber sido retirado o pedir una verificación.",
    });
  }
  // Primero los mp4 (sirven para descargar), de mayor a menor calidad; luego los hls.
  found.sort((a, b) => (a.mime === b.mime ? b.q - a.q : a.mime === "video/mp4" ? -1 : 1));
  const headers = { Referer: SITE + "/" };
  const label = (f) => ((f.q ? f.q + "p" : "Auto") + (f.mime === HLS ? " · HLS" : "")).slice(0, 48);
  const [main, ...rest] = found;
  return {
    url: main.url,
    mime: main.mime,
    headers,
    label: label(main),
    expiresInSeconds: 900,
    alternatives: rest.slice(0, 8).map((f) => ({ label: label(f), url: f.url, mime: f.mime, headers })),
  };
}s token there too.
        headers: { "X-Token": t },
        // Sent by the PLAYER with every channel of this list (apart from `headers` above: the token goes only to
        // this server's list, never to the hosts the channels are on). An entry that names its own agent wins.
        streamHeaders: agentHeaders(),
        genre: "entretenimiento",
        epg: { url: base() + "/guia.xml.gz", format: "xmltv" },
        refreshHours: 1,
        // Group titles never to show (the "Adultos" group is hidden by Kino whatever you say).
        hideGroups: ["Compras"],
      },
    },
    {
      playlist: {
        url: base() + "/lista-token.m3u",
        format: "m3u",
        headers: { "X-Token": t },
        genre: "entretenimiento",
        refreshHours: 24,
        resolve: true,
      },
    },
  ];
}

// A `resolve: true` list entry: the link is this server's /channels/<id>/play, which answers the stream only
// with the token. Whatever address the list named, it is asked through the typed server.
async function resolveListEntry(ref) {
  const c = await api(new URL(ref).pathname);
  return { url: base() + c.stream, mime: HLS, headers: agentHeaders() };
}

// One channel as Kino takes it: Deportes with an inline stream (and its ref as the fallback), the rest
// with a ref. `categoryId` also marks a liveSearch hit's category.
function channel(c) {
  const out = { id: c.id, title: c.title, number: c.number, categoryId: c.categoryId, logo: poster(c.id), ref: c.id };
  if (c.categoryId === "deportes") out.stream = { url: base() + "/live/" + c.id + ".m3u8", mime: HLS, headers: agentHeaders() };
  return out;
}

// Paged two at a time, the way a big catalog would be: Kino follows `next` (10 pages at first, 5 more as
// the person scrolls).
export async function liveChannels({ categoryId, cursor }) {
  const page = await api("/channels?limit=2&category=" + enc(categoryId) + (cursor ? "&cursor=" + enc(cursor) : ""));
  return { items: page.items.map(channel), next: page.next || null };
}

// En vivo's search, while some channels were never listed (a category not opened yet, a page left).
export async function liveSearch({ query }) {
  const page = await api("/channels/search?q=" + enc(query));
  return { items: page.items.map(channel) };
}

// Optional: a guide for the channels above (the playlist's comes from its XMLTV file). Kino asks for
// at most 50 ids and a window of at most 24 hours, and keeps what falls inside it.
export async function guide({ channelIds, from, to }) {
  return api("/channels/guide?ids=" + enc(channelIds.join(",")) + "&from=" + from + "&to=" + to);
}

// ---------- apiVersion 6: a section of its own, Categorías tiles, moving saved titles, describing titles ----------

// The manifest's `"section": { "label": "Tu servidor" }`: a chip atop Inicio on the phone, an entry in the TV
// sidebar, painted with the manifest's `theme`. One answer per tab; rows are Home rows (same checks).
const TABS = [{ id: "peliculas", label: "Películas" }, { id: "series", label: "Series" }, { id: "en-vivo", label: "En vivo" }];

export async function section({ tab }) {
  const chosen = TABS.some((t) => t.id === tab) ? tab : TABS[0].id;
  const rows = [];
  let hero;
  if (chosen === "peliculas") {
    const movies = (await api("/items?limit=20&kind=movie")).items;
    const featured = movies.find((x) => x.overview && !x.adult);
    if (featured) hero = { title: featured.title, image: backdrop(featured.id), text: featured.overview.slice(0, 300) };
    rows.push({ id: "peliculas-todas", title: "Todas las películas", ref: "movie", genre: "peliculas", items: movies.map(item) });
    for (const g of await api("/genres")) {
      if (g.adult) continue;
      const p = await api("/items?limit=10&kind=movie&genre=" + enc(g.id));
      if (p.items.length) rows.push({ id: "genero-" + g.id, title: g.title, ref: "genre:" + g.id, items: p.items.map(item) });
    }
  } else {
    const kind = chosen === "series" ? "series" : "live";
    const p = await api("/items?limit=20&kind=" + kind);
    rows.push({ id: chosen + "-todo", title: chosen === "series" ? "Todas las series" : "Canales", ref: kind, genre: chosen === "series" ? "series" : undefined, items: p.items.map(item) });
  }
  return { tabs: TABS, tab: chosen, hero, rows };
}

// Tiles of Kino's Categorías (needs `browse`): one per genre of the server, each opening browse("genre:<id>").
// An 18+ genre is marked `adult` and shows only while the person's 18+ code is unlocked.
export async function categories() {
  const genres = await api("/genres");
  return genres.map((g) => ({ id: "genero-" + g.id, title: g.title, ref: "genre:" + g.id, art: backdrop(g.art), adult: g.adult || undefined }));
}

// `migrate`: Kino offers, in the background, every saved value no source can open any more (a library title,
// its chapters, a live favorite or recent). The server keeps the ids it gave its titles before (a library
// rebuilt on a real server changes them): read once and kept an hour, so the many calls cost one request.
// null = not ours, remembered by Kino until this plugin's next version.
async function movedTable() {
  const key = "moved:" + scope();
  const cached = kino.storage.get(key);
  if (cached) return JSON.parse(cached);
  const moved = await api("/moved");
  kino.storage.set(key, JSON.stringify(moved), { ttlMs: 60 * 60 * 1000 });
  return moved;
}

export async function migrate(input) {
  const moved = await movedTable();
  if (input.kind === "title") {
    const t = moved.titles[input.ref];
    return t ? { kind: t.kind, id: t.id, ref: t.id } : null;
  }
  if (input.kind === "chapter") {
    const e = moved.episodes[input.ref];
    return e ? { kind: "episode", ref: e.id, season: e.season, number: e.number } : null;
  }
  if (input.kind === "live") {
    const code = moved.channels[input.code];
    return code ? { kind: "live", code } : null;
  }
  return null;
}

// `meta`: Kino asks it to fill what TMDB left empty on the info page of a title ANY source listed, when the
// server has that title (by its ids). From Kino 0.9.51 also a clear-logo shown instead of the name, other
// sites' ratings next to the page's score, and a cast when TMDB has none. null = not in this library.
export async function meta({ type, ids }) {
  if (!ids.imdb && !ids.tmdb) return null;
  let m;
  try {
    m = await api("/meta?type=" + enc(type) + (ids.imdb ? "&imdb=" + enc(ids.imdb) : "") + (ids.tmdb ? "&tmdb=" + ids.tmdb : ""));
  } catch (e) {
    if (e.code === "not_found") return null;
    throw e;
  }
  return {
    title: m.title,
    overview: m.overview,
    poster: poster(m.id),
    backdrop: backdrop(m.id),
    year: String(m.year),
    genres: m.genres,
    runtimeMinutes: m.runtime,
    logo: art("logo", m.id),
    ratings: m.ratings,
    cast: m.cast.map((c) => ({ name: c.name, character: c.character, photo: poster(c.id) })),
  };
}

// ---------- apiVersion 7 (Kino 0.9.51), and the subtitles any plugin may export ----------

// `subtitles` (declared, so the consent sheet says so): the player's "Buscar subtítulos en línea" for any
// movie or episode Kino knows by id, from any source. Kino 0.9.51 also says which FILE is playing (`file`:
// its OpenSubtitles hash, size and name): the subtitle timed for that exact file goes first, labelled so.
// Then the person's languages in their order; a machine translation is marked `translated`.
export async function subtitles({ imdbId, tmdbId, kind, season, episode, languages, file }) {
  const q = new URLSearchParams();
  if (imdbId) q.set("imdb", imdbId);
  if (tmdbId) q.set("tmdb", String(tmdbId));
  if (kind === "series") { q.set("season", String(season)); q.set("episode", String(episode)); }
  const found = await api("/subtitles?" + q);
  const stem = (name) => String(name || "").toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "");
  const forThisFile = (s) => Boolean(file && ((file.hash && s.hash === file.hash) || (file.name && s.release && stem(s.release) === stem(file.name))));
  const langRank = (s) => { const i = languages.indexOf(s.lang); return i < 0 ? languages.length : i; };
  const rank = (s) => (forThisFile(s) ? 0 : 1000) + langRank(s) * 10 + (s.translated ? 1 : 0);
  return found
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((s) => ({
      lang: s.lang,
      url: base() + s.file,
      format: s.format,
      label: forThisFile(s) ? (s.label + " · para este archivo").slice(0, 60) : s.label,
      translated: s.translated || undefined,
    }));
}

// `tracking` (apiVersion 7, approved in red: "Le contará al servidor que escribas en su configuración qué
// ves y cuándo lo terminas"): Kino calls track() for every movie or episode played on this device, from any
// source, and keeps the event in its own queue until it is delivered (offline, app closed...). The server
// marks what is in its library as watched, like its own app. The event id is the idempotency key. What the
// error codes mean to Kino: `unavailable`/`rate_limited` (and network trouble) retry later, in order;
// `auth_required`/`not_found` drop the event. Log the outcome, never the title.
export async function track(event) {
  const answer = await api("/playing", { method: "POST", body: { json: event }, headers: { "Idempotency-Key": event.id } });
  kino.log("track:", event.type, answer && answer.ignored ? "skipped" : "delivered");
  // A title the server does not have (it played from another source) is of no use to it: dropped, but not
  // counted as a delivery (only a real one clears the red "No pudo avisar…" line in Ajustes).
  return answer && answer.ignored ? { skipped: true } : { ok: true };
}

// `segments` (apiVersion 7): where a title's intro and credits are, for "Saltar intro" / "Saltar outro" on ANY
// movie or episode Kino knows by id, the way an intro-skipper plugin of a media server knows them. Asked in the
// background once the file plays; `durationMs` is that file's length, so the server answers for that cut.
// For an episode `ids` are the episode's own and may be empty: the show's ids + season + episode then.
// (This plugin's own files carry `skip` in their Stream instead, which wins over any segments answer.)
export async function segments({ kind, ids, show, season, episode, durationMs }) {
  const q = new URLSearchParams();
  let known = false;
  if (ids.imdb) { q.set("imdb", ids.imdb); known = true; }
  if (ids.tmdb) { q.set("tmdb", String(ids.tmdb)); known = true; }
  if (kind === "episode" && show) {
    if (show.ids.imdb) { q.set("showImdb", show.ids.imdb); known = true; }
    if (show.ids.tmdb) { q.set("showTmdb", String(show.ids.tmdb)); known = true; }
    q.set("season", String(season));
    q.set("episode", String(episode));
  }
  if (!known) return null;
  if (durationMs) q.set("duration", String(durationMs));
  const found = await api("/segments?" + q);
  return found.map((s) => ({ type: s.type, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs) }));
}

// ---------- the settings form (apiVersion 6): status lines, buttons, and a check before saving ----------

const EVENT_WORDS = { start: "empezaste a verlo", progress: "lo estás viendo", stop: "lo dejaste", watched: "visto" };

// Why a call failed, in words for a status line (the form shows it as is).
function failure(e) {
  if (e.code === "auth_required") return "Tu servidor no acepta ese usuario y contraseña";
  if (e.code === "timeout" || e.code === "network") return "Tu servidor no responde en esa dirección";
  if (e.code === "host_not_allowed") return "Guarda la dirección para poder probarla";
  return "Tu servidor respondió con un error";
}

// One text per `status` setting, asked when the form opens and after every button. It runs even while a
// required setting is still empty, so it says what is missing.
export async function settingsStatus() {
  if (!kino.config.get("server")) return { estado: "Escribe la dirección de tu servidor", ultimoAviso: "Sin información" };
  if (!kino.config.get("user") || !kino.config.get("password")) return { estado: "Escribe tu usuario y contraseña", ultimoAviso: "Sin información" };
  try {
    const s = await api("/status", { timeoutMs: 8000 });
    const p = await api("/playing", { timeoutMs: 8000 });
    return {
      estado: `Conectado a ${s.name} ${s.version} como ${s.user}: ${s.titles} títulos`,
      ultimoAviso: p.last ? `${p.last.title}: ${EVENT_WORDS[p.last.type] || p.last.type} (${p.count === 1 ? "1 aviso" : p.count + " avisos"} en total)` : "Tu servidor aún no ha recibido avisos",
    };
  } catch (e) {
    return { estado: failure(e), ultimoAviso: "Sin información" };
  }
}

// The form's buttons. "Cerrar sesión" also forgets this account's cached answers and the cookie jar;
// "Usar el User-Agent de Kino" empties an optional setting through `clearSettings`, as if the person had
// emptied the field and saved.
export async function action(key) {
  if (key === "probar") {
    const started = Date.now();
    const s = await api("/status", { timeoutMs: 8000 });
    return { message: `${s.name} respondió en ${Date.now() - started} ms (versión ${s.version}).` };
  }
  if (key === "salir") {
    try {
      await api("/session", { method: "DELETE" });
    } catch (e) {
      if (e.code !== "auth_required") throw e;
    }
    const mine = ":" + scope();
    for (const k of kino.storage.keys()) if (k.endsWith(mine)) kino.storage.remove(k);
    kino.cookies.clear();
    return { message: "Sesión cerrada. La próxima vez Kino vuelve a entrar con tu usuario y contraseña." };
  }
  if (key === "quitarAgente") return { message: "Listo: los canales usan otra vez el User-Agent de Kino.", clearSettings: ["userAgent"] };
  return null;
}

// Checked BEFORE Kino saves. Formats first, offline; then, when the server is the one already saved (a new
// address becomes reachable only once saved), the account against it: a wrong password never gets saved.
// `values` has only the valued settings, trimmed; kino.config.all() is what is saved now.
export async function validateSettings(values) {
  const errors = {};
  const server = trimSlash(values.server || "");
  try {
    const u = new URL(server);
    if ((u.pathname !== "/" && u.pathname !== "") || u.search) errors.server = "Escribe solo la dirección, sin rutas: por ejemplo http://192.168.1.10:8096";
  } catch {
    errors.server = "Esa no es una dirección completa: empieza por http:// o https://";
  }
  if (/\s/.test(String(values.user || ""))) errors.user = "El usuario no lleva espacios";
  if (/[\r\n]/.test(String(values.userAgent || ""))) errors.userAgent = "El User-Agent va en una sola línea";
  const others = Array.isArray(values.addresses) ? values.addresses : [];
  if (others.some((a) => trimSlash(a.url) === server)) errors.addresses = "Esa dirección ya es la del servidor de arriba";
  if (Object.keys(errors).length) return errors;

  const saved = kino.config.all();
  if (saved.server && trimSlash(saved.server) === server && values.user && values.password) {
    try {
      const r = await kino.fetch(server + "/auth", { method: "POST", body: { json: { user: values.user, password: values.password } }, timeoutMs: 8000 });
      if (r.status === 401) return { password: "Tu servidor no reconoce ese usuario con esa contraseña" };
    } catch (e) {
      kino.log("validateSettings: account not checked:", e.code);
    }
  }
  return null;
}
