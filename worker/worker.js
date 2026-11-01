/*
 * Stahl & Verstand – Zwischenstation (Cloudflare Worker)
 * Hält den KI-Schlüssel geheim, beantwortet den Chat und schickt die fertige Projektmappe per E-Mail.
 *
 * Benötigte Einstellungen in Cloudflare (Settings → Variables and Secrets):
 *   ANTHROPIC_KEY   (Secret)  dein Anthropic-API-Schlüssel, sk-ant-…
 *   RESEND_KEY      (Secret)  dein Resend-API-Schlüssel, re_…
 *   TO_EMAIL        (Text)    deine E-Mail-Adresse, an die die Projektmappen gehen
 *   FROM_EMAIL      (Text, optional) Absender, Standard: "Stahl & Verstand <onboarding@resend.dev>"
 *   BASE_ADDRESS    (Text)    deine Firmenadresse für km und Fahrtzeit, z. B. "Musterstraße 1, 96450 Coburg"
 *   LOGO_URL        (Text, optional) Logo für die E-Mail, Standard: tzuas.github.io/Stahl-und-Verstand/logo.png
 *   ALLOWED_ORIGINS (Text, optional) erlaubte Seiten, Standard: tzuas.github.io und stahlundverstand.de
 */
const MODEL = "claude-sonnet-5-5";
const DEFAULT_ORIGINS = "https://tzuas.github.io,https://www.stahlundverstand.de,https://stahlundverstand.de";

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map(s => s.trim());
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Vary": "Origin",
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return json({ ok: true, info: "Stahl & Verstand Zwischenstation läuft." });
    if (req.method !== "POST") return json({ error: "Nicht erlaubt" }, 405);
    if (!allowed.includes(origin)) return json({ error: "Diese Seite ist nicht freigegeben." }, 403);
    if (!env.ANTHROPIC_KEY) return json({ error: "ANTHROPIC_KEY fehlt in den Cloudflare-Einstellungen." }, 500);

    const len = +(req.headers.get("content-length") || 0);
    if (len > 12_000_000) return json({ error: "Zu große Datenmenge. Bitte weniger Fotos senden." }, 413);
    let body;
    try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage" }, 400); }

    try {
      if (url.pathname === "/chat") return json(await chat(body, env));
      if (url.pathname === "/submit") return json(await submit(body, env));
      return json({ error: "Unbekannte Adresse" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};

async function claude(env, system, messages, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: env.MODEL || MODEL, max_tokens: maxTokens, system, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(r.status === 429 ? "Der Assistent ist gerade ausgelastet. Bitte gleich nochmal versuchen." : "KI-Fehler " + r.status);
  return (j.content || []).map(c => c.text || "").join("");
}

async function chat(body, env) {
  const system = String(body.system || "").slice(0, 24000);
  if (!system.includes("Stahl & Verstand")) throw new Error("Ungültige Anfrage");
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-30);
  if (!messages.length) throw new Error("Keine Nachricht");
  // Bilder begrenzen: höchstens 3 pro Nachricht, nur JPEG/PNG
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      let n = 0;
      m.content = m.content.filter(c => c.type === "text" || (c.type === "image" && ++n <= 3 && /image\/(jpeg|png)/.test(c.source?.media_type || "")));
    }
  }
  const text = await claude(env, system, messages, 700);
  return { text };
}

/* Entfernung und Fahrtzeit: OpenStreetMap (Nominatim) + OSRM, kostenlos, ohne Schlüssel */
async function geocode(q, env) {
  const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=de,at,ch&q=" + encodeURIComponent(q),
    { headers: { "User-Agent": "StahlUndVerstand-Projektassistent/1.0 (" + (env.TO_EMAIL || "kontakt") + ")", "Accept-Language": "de" } });
  const j = await r.json();
  if (!j[0]) throw new Error("Adresse nicht gefunden");
  return { lat: +j[0].lat, lon: +j[0].lon };
}
async function route(env, kundeAdresse) {
  if (!env.BASE_ADDRESS) return null;
  const a = await geocode(env.BASE_ADDRESS, env);
  await new Promise(r => setTimeout(r, 1100)); // Nominatim: max. 1 Anfrage pro Sekunde
  const b = await geocode(kundeAdresse, env);
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`);
  const j = await r.json();
  const rt = j.routes && j.routes[0];
  if (!rt) throw new Error("Keine Route gefunden");
  const km = Math.round(rt.distance / 100) / 10, min = Math.round(rt.duration / 60);
  return { km, min, text: `${km.toLocaleString("de-DE")} km · ca. ${min >= 60 ? Math.floor(min / 60) + " Std. " + (min % 60) + " Min." : min + " Min."} (ohne Verkehr)`,
    maps: "https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=" + encodeURIComponent(env.BASE_ADDRESS) + "&destination=" + encodeURIComponent(kundeAdresse) };
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function submit(b, env) {
  if (!env.RESEND_KEY || !env.TO_EMAIL) throw new Error("E-Mail-Versand ist noch nicht eingerichtet.");
  const k = b.kunde || {};
  if (!k.nachname || !(k.telefon || k.email)) throw new Error("Kontaktdaten fehlen.");
  const verlauf = (b.verlauf || []).slice(-80).map(m => `${m.rolle}: ${m.text}`).join("\n").slice(0, 30000);
  const spec = (b.spec || []).map(([a, v]) => `${a}: ${v}`).join("\n");

  // 1) Vertrauliche Einschätzung
  let ein = { kaufabsicht: "unklar", punkte: 50, zeitrahmen: "", eigentuemer: "", budget: "", vergleicht: "unklar", montage: "", quelle: "", zusammenfassung: "", empfehlung: "", absage: false };
  try {
    const raw = await claude(env,
      `Du bist ein erfahrener Vertriebsleiter eines Metallbau-Fachbetriebs. Bewerte nüchtern und fair, wie ernsthaft ein Interessent ist, anhand eines Gesprächs mit dem Online-Assistenten. Antworte ausschließlich mit JSON:
{"kaufabsicht":"hoch|mittel|niedrig","punkte":0-100,"zeitrahmen":"…","eigentuemer":"ja|nein|unklar","budget":"…","vergleicht":"ja|nein|unklar","montage":"selbst|durch uns|unklar","quelle":"…","zusammenfassung":"2-3 Sätze zum Projekt","empfehlung":"1 Satz, was der Inhaber als Nächstes tun sollte","absage":true|false}
"absage" nur dann true, wenn eindeutig erkennbar ist, dass es fast ausschließlich um einen Preisvergleich geht UND kein konkreter Bedarf oder Zeitrahmen besteht (punkte unter 25). Im Zweifel false.`,
      [{ role: "user", content: `KONFIGURATION:\n${spec}\nHinweise: ${b.hinweise || "-"}\nKontaktweg: ${k.kontaktweg || "-"}, Wunschtermin: ${k.wunschtermin || "-"}\n\nGESPRÄCH:\n${verlauf}` }], 600);
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) ein = Object.assign(ein, JSON.parse(m[0]));
  } catch (e) { ein.zusammenfassung = "Einschätzung nicht verfügbar (" + e.message + ")."; }
  const absage = ein.absage === true && +ein.punkte < 25;

  // Anfahrt
  const kAdr = [k.strasse, [k.plz, k.ort].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  let fahrt = null, fahrtFehler = "";
  try { fahrt = await route(env, kAdr); } catch (e) { fahrtFehler = e.message; }
  const vo = b.vorort || {};

  // 2) E-Mail
  const farbe = ein.kaufabsicht === "hoch" ? "#2e7d4f" : ein.kaufabsicht === "mittel" ? "#b06d00" : "#9a2b2b";
  const name = [k.vorname, k.nachname].filter(Boolean).join(" ");
  const row = (a, v) => v ? `<tr><td style="padding:4px 12px 4px 0;color:#5d6972;font-size:13px;vertical-align:top">${esc(a)}</td><td style="padding:4px 0;font-size:14px">${esc(v)}</td></tr>` : "";
  const logo = env.LOGO_URL || "https://tzuas.github.io/Stahl-und-Verstand/logo.png";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;color:#1d2328">
  <div style="border-bottom:3px solid #2c3a44;padding-bottom:10px;margin-bottom:16px">${env.LOGO_URL ? `<img src="${esc(logo)}" alt="Stahl &amp; Verstand" height="48" style="height:48px;width:auto;display:block">` : `<div style="font-weight:800;font-size:20px;letter-spacing:.02em">STAHL <span style="color:#c4561f">&amp;</span> VERSTAND</div>`}</div>
  <h2 style="margin:0 0 4px">Neue Projektanfrage: ${esc(name)}</h2>
  <p style="margin:0 0 16px;color:#5d6972">${esc((b.spec || []).slice(0, 2).map(x => x[1]).join(" "))} · ${esc(k.plz)} ${esc(k.ort)}</p>
  <div style="border-left:5px solid ${farbe};background:#f6f8f9;padding:12px 16px;margin-bottom:18px">
   <b style="color:${farbe}">Kaufabsicht: ${esc(ein.kaufabsicht)} (${esc(ein.punkte)}/100)</b>${absage ? ' · <b style="color:#9a2b2b">Dem Kunden wurde „ausgebucht“ angezeigt</b>' : ""}<br>
   <span style="font-size:14px">${esc(ein.zusammenfassung)}</span><br><span style="font-size:14px"><b>Empfehlung:</b> ${esc(ein.empfehlung)}</span>
   <table style="margin-top:8px">${row("Zeitrahmen", ein.zeitrahmen)}${row("Eigentümer", ein.eigentuemer)}${row("Budget", ein.budget)}${row("Vergleicht Angebote", ein.vergleicht)}${row("Montage", ein.montage)}${row("Gefunden über", ein.quelle)}</table>
   <p style="font-size:11px;color:#5d6972;margin:6px 0 0">Nur für dich. Diese Einschätzung sieht der Kunde nicht.</p>
  </div>
  <h3 style="margin:0 0 6px">Kunde</h3><table>${row("Name", name)}${row("Adresse", [k.strasse, [k.plz, k.ort].filter(Boolean).join(" ")].filter(Boolean).join(", "))}${row("Telefon", k.telefon)}${row("E-Mail", k.email)}${row("Kontakt per", k.kontaktweg)}${row("Wunschtermin", k.wunschtermin)}</table>
  <h3 style="margin:16px 0 6px">Anfahrt &amp; vor Ort</h3><table>${row("Entfernung", fahrt ? fahrt.text : (env.BASE_ADDRESS ? "nicht berechenbar (" + fahrtFehler + ")" : "BASE_ADDRESS in Cloudflare eintragen"))}${row("Parken", vo.parken)}${row("Strom 230 V", vo.strom)}</table>${fahrt ? `<p style="margin:6px 0 0"><a href="${esc(fahrt.maps)}">Route in Google Maps öffnen</a></p>` : ""}
  <h3 style="margin:16px 0 6px">Projekt</h3><table>${(b.spec || []).map(([a, v]) => row(a, v)).join("")}${row("Hinweise", b.hinweise)}</table>
  ${b.link ? `<p style="margin:18px 0"><a href="${esc(b.link)}" style="background:#c4561f;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Im Berater-Tool öffnen</a></p>` : ""}
  <p style="font-size:13px;color:#5d6972">Im Anhang: Ansicht, Skizze und ${(b.fotos || []).length} Foto(s) des Kunden.</p>
  <details><summary style="font-size:13px">Gesprächsverlauf</summary><pre style="white-space:pre-wrap;font-size:12px;color:#3a444b">${esc(verlauf)}</pre></details></div>`;

  const att = [];
  const add = (dataUrl, filename) => { if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) att.push({ filename, content: dataUrl.split(",")[1] }); };
  add(b.bilder?.ansicht, "ansicht.png"); add(b.bilder?.skizze, "skizze.png");
  (b.fotos || []).slice(0, 8).forEach((f, i) => add(f, `foto-${i + 1}.jpg`));

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + env.RESEND_KEY },
    body: JSON.stringify({
      from: env.FROM_EMAIL || "Stahl & Verstand <onboarding@resend.dev>",
      to: [env.TO_EMAIL],
      reply_to: k.email || undefined,
      subject: `${fahrt ? "[" + fahrt.km.toLocaleString("de-DE") + " km] " : ""}${absage ? "[Absage angezeigt] " : ein.kaufabsicht === "hoch" ? "🔥 " : ""}Projektanfrage ${name} · ${(b.spec || [])[0]?.[1] || ""} · ${k.plz || ""}`,
      html, attachments: att,
    }),
  });
  if (!r.ok) throw new Error("E-Mail konnte nicht gesendet werden (" + r.status + ").");
  return { ok: true, absage }; // Entfernung bleibt intern, der Kunde sieht sie nicht
}
