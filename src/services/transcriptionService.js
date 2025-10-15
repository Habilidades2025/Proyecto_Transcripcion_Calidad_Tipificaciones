// src/services/transcriptionService.js
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { Agent, setGlobalDispatcher } from 'undici';

/* ===================== Config de timeouts (fetch/undici) ===================== */
const FW_TIMEOUT_MS         = Number(process.env.FW_TIMEOUT_MS || 600000);         // abort total (10 min)
const FW_HEADERS_TIMEOUT_MS = Number(process.env.FW_HEADERS_TIMEOUT_MS || 600000); // headers (10 min)
const FW_BODY_TIMEOUT_MS    = Number(process.env.FW_BODY_TIMEOUT_MS || 3600000);   // body (60 min)

setGlobalDispatcher(new Agent({
  headersTimeout: FW_HEADERS_TIMEOUT_MS,
  bodyTimeout: FW_BODY_TIMEOUT_MS
}));

/* ============================ Defaults de entorno ============================ */
const ENV_PROVIDER = String(process.env.TRANSCRIBE_PROVIDER || 'openai')
  .toLowerCase()
  .trim();

/* ================================ Utilidades ================================= */

/** Convierte segundos a mm:ss */
function toClock(sec = 0) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Normaliza texto para scoring */
function norm(t = '') {
  return String(t || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Señales muy breves (acks) */
const SHORT_ACKS = [
  'sí', 'si', 'no', 'ok', 'okay', 'vale', 'bueno', 'ajá', 'aja', 'mmm', 'mm',
  'claro', 'listo', 'perfecto', 'entendido', 'de acuerdo', 'gracias'
].map(s => s.toLowerCase());

/** Acks/confirmaciones medianas frecuentes */
const ACKS_MEDIUM = [
  'perfecto', 'perfecto, entonces', 'entonces', 'claro', 'de acuerdo',
  'entiendo', 'vale', 'listo', 'está bien', 'bueno', 'correcto',
  'ah ok', 'ok, perfecto'
].map(s => s.toLowerCase());

/** Preguntas típicas del agente que esperan respuesta corta del cliente */
const QUESTION_PATTERNS = [
  /¿usted\s+actualmente\s+se\s+encuentra\s+laborando\??$/i,
  /¿(se\s+encuentra|est[aá])\s+laborando\??$/i,
  /¿c[oó]mo\s+est[aá]\??$/i,
  /¿le\s+parece\??$/i,
  /¿me\s+indica\??$/i,
  /¿puede\s+pagar\??$/i,
  /¿cu[aá]nto\s+(podr[ií]a|puede)\s+pagar\??$/i,
  /¿tiene\s+whatsapp\??$/i,
  /¿le\s+brindo\s+las\s+alternativas\??$/i,
  /¿le\s+parece\s+si\s+validamos\??$/i
];

/** Pistas “duras” de rol (brutal override) */
const AGENT_HINTS_RX = new RegExp([
  '\\b(le\\s+habla|habla\\s+con|mi\\s+nombre\\s+es)\\b',
  '(contacto\\s+solutions?|novarte[ck]|vartex|novartec)',
  '(área|area)\\s+(jur[ií]dica|de\\s+cobranza|juridica)',
  '(llamada|conversaci[oó]n).*(grabada|monitoreada)',
  'ley\\s*1581',
  '(alternativas?\\s+de\\s+pago|le\\s+ofrezco|le\\s+brindo|pago\\s+de\\s+contado|descuento|cuotas?)',
  '(confirm(a|amos)|qued(a|amos)\\s+(para|entonces)|se\\s+realiza|program(a|amos))'
].join('|'), 'i');

const CLIENT_HINTS_RX = new RegExp([
  '^(s[ií],?\\s*(señor|señora|perfecto|de\\s+acuerdo)|bien,?\\s+gracias)\\b',
  '\\b(no\\s+puedo|no\\s+me\\s+alcanza|no\\s+tengo|estoy\\s+desemplead|independiente|no\\s+me\\s+queda|yo\\s+(no|pago|puedo|tengo|quisiera))\\b',
  '(mi\\s+prima|mi\\s+familia|mi\\s+espos[oa])\\b'
].join('|'), 'i');

/** Scoring de pistas por rol en una línea. Devuelve { agent, client } */
function scoreRoleHints(text = '') {
  const t = norm(text);
  let agent = 0, client = 0;

  if (/(le\s+habla|habla\s+con|mi\s+nombre\s+es|somos|del\s+área|área\s+jur[ií]dica|departamento)/.test(t)) agent += 2;
  if (/(llamada\s+est[aá]\s+siendo\s+grabada|monitoread[ao]|calidad|ley\s+1581|protecci[oó]n\s+de\s+datos)/.test(t)) agent += 3;
  if (/(ofrezc|ofrecer|brindo|le\s+ofrezco|alternativas|descuento|cuotas|plan\s+de\s+pagos)/.test(t)) agent += 2;
  if (/(novarte[ck]|contacto\s+solutions|vartex|novartec)/.test(t)) agent += 2;
  if (/(link\s+de\s+pago|pse|portal\s+oficial|oficinas\s+autorizadas)/.test(t)) agent += 2;
  if (/^buen[oa]s\s+(tardes|d[ií]as|noches)[,;\s]/.test(t) && /(le\s+habla|de\\s+contacto|del\\s+área|somos)/.test(t)) agent += 2;

  if (/(no\s+tengo|no\s+puedo|no\s+estoy\s+trabajando|estoy\s+desemplead[oa]|independiente|no\s+me\s+queda|no\s+me\s+alcanza)/.test(t)) client += 2;
  if (/(mi\s+prima|mi\s+familia|yo\s+puedo|yo\s+pag[oé]|no\s+entiendo|c[oó]mo\s+hago)/.test(t)) client += 1;
  if (/^(sí|si|no|ok|bueno|claro|listo|perfecto)[,.\s]*$/.test(t)) client += 2;
  if (/gracias/.test(t)) client += 1;
  if (/^\$?\s*\d+([.,]\d+)?(\s*(mil|k|m|millones?))?$/.test(t)) client += 2;
  if (/^(emplead[oa]|independiente|pensionad[oa]|no\s+trabajo|buscando\s+empleo)\.?$/.test(t)) client += 2;

  return { agent, client };
}

/** Heurística MONO para etiquetar roles; devuelve ["mm:ss Rol: texto", ...] */
export function formatTranscriptLinesMono(segments = []) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const GAP_THR         = Number(process.env.MONO_GAP_THRESHOLD_SEC || 1.2);
  const MERGE_THR       = Number(process.env.MONO_MERGE_THRESHOLD_SEC || 0.6);
  const SWITCH_MARGIN   = Number(process.env.MONO_SWITCH_MARGIN || 2);
  const SHORT_ACK_MAX   = Number(process.env.MONO_SHORT_ACK_MAX_CHARS || 14);
  const STREAK_LOCK_SEC = Number(process.env.MONO_STREAK_LOCK_SEC || 25);

  const K = 8, S = 30;
  let agentScore = 0, clientScore = 0;
  for (let i = 0; i < segments.length && i < K; i++) {
    const seg = segments[i];
    if (Number(seg?.start) > S) break;
    const sc = scoreRoleHints(seg?.text || '');
    agentScore  += sc.agent;
    clientScore += sc.client;
  }
  let currentRole = (agentScore >= clientScore) ? 'Agente' : 'Cliente';
  let currentConfidence = Math.max(agentScore, clientScore);
  let lastEnd = 0;

  const raw = [];
  const recent = [];

  const isQuestion = (txt = '') =>
    /[?¿]\s*$/.test(txt) || QUESTION_PATTERNS.some(rx => rx.test(txt));

  const isAckShortish = (txt = '') => {
    const t = norm(txt);
    if (t.length <= SHORT_ACK_MAX && SHORT_ACKS.some(a => t === a || t.startsWith(a + ' '))) return true;
    if (ACKS_MEDIUM.some(a => t === a || t.startsWith(a + ' '))) return true;
    return false;
  };

  for (const seg of segments) {
    const start = Number(seg?.start ?? seg?.offset ?? lastEnd);
    const end   = Number(seg?.end   ?? (start + 2));
    const text  = String(seg?.text || '').trim();
    if (!text) { lastEnd = Math.max(lastEnd, end); continue; }

    while (recent.length && (start - recent[0].t) > STREAK_LOCK_SEC) recent.shift();

    const sc = scoreRoleHints(text);
    const prev = raw[raw.length - 1];
    const prevWasQuestion = !!(prev && isQuestion(prev.text));
    const prevRole = prev?.role || null;

    if (AGENT_HINTS_RX.test(text)) {
      currentRole = 'Agente';
      currentConfidence = Math.max(currentConfidence, sc.agent + 5);
    } else if (CLIENT_HINTS_RX.test(text)) {
      currentRole = 'Cliente';
      currentConfidence = Math.max(currentConfidence, sc.client + 3);
    } else {
      const gap = Math.max(0, start - lastEnd);

      if (prevRole === 'Agente' && prevWasQuestion) {
        const hasStrongAgent = (sc.agent - sc.client) >= (SWITCH_MARGIN + 1);
        const shortish       = text.trim().length <= 40;
        if (shortish && !hasStrongAgent && isAckShortish(text)) {
          currentRole = 'Cliente';
          currentConfidence = Math.max(currentConfidence, sc.client + 2);
        } else {
          if (shortish && sc.client >= sc.agent) {
            currentRole = 'Cliente';
            currentConfidence = Math.max(currentConfidence, sc.client + 1);
          } else {
            if (currentRole === 'Agente') sc.agent += 1; else sc.client += 1;
          }
        }
      } else {
        if (currentRole === 'Agente') sc.agent += 1; else sc.client += 1;

        let margin = SWITCH_MARGIN;
        if (gap >= GAP_THR || prevWasQuestion) margin = Math.max(0, SWITCH_MARGIN - 1);

        const agg = recent.reduce((acc, r) => { acc.agent += r.agent; acc.client += r.client; return acc; }, {agent:0, client:0});
        if (agg.agent - agg.client >= 3 && currentRole === 'Agente') sc.agent += 1;
        if (agg.client - agg.agent >= 3 && currentRole === 'Cliente') sc.client += 1;

        if (sc.agent - sc.client >= (SWITCH_MARGIN + 1)) {
          currentRole = 'Agente';
          currentConfidence = sc.agent;
        } else if (sc.client - sc.agent >= (SWITCH_MARGIN + 1)) {
          currentRole = 'Cliente';
          currentConfidence = sc.client;
        } else {
          const desired = (sc.agent >= sc.client) ? 'Agente' : 'Cliente';
          const desiredScore = Math.max(sc.agent, sc.client);
          if (desired !== currentRole && desiredScore >= currentConfidence + margin) {
            currentRole = desired;
            currentConfidence = desiredScore;
          } else {
            currentConfidence = Math.max(currentConfidence, (currentRole === 'Agente' ? sc.agent : sc.client));
          }
        }
      }
    }

    raw.push({ role: currentRole, start, end, text });
    recent.push({ t: start, agent: sc.agent, client: sc.client });
    lastEnd = Math.max(lastEnd, end);
  }

  // Merge cercano del mismo rol
  const merged = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === seg.role && seg.start - last.end <= MERGE_THR) {
      last.end = seg.end;
      last.text = `${last.text} ${seg.text}`.replace(/\s+/g, ' ').trim();
    } else {
      merged.push({ ...seg });
    }
  }

  // Asegura que frases de compliance/presentación queden como Agente
  for (let i = 0; i < merged.length; i++) {
    const t = merged[i].text || '';
    if (AGENT_HINTS_RX.test(t)) merged[i].role = 'Agente';
  }

  return merged.map(s => `${toClock(s.start)} ${s.role}: ${s.text}`);
}

/* ==================== Selección de proveedor y firma tolerante ==================== */
/**
 * Soporta:
 * - (buffer, { provider, language, mimetype, model })
 * - (buffer, filename, language, opts)
 */
function normalizeArgs(buffer, a1, a2, a3) {
  let filename = 'audio.wav';
  let language = 'es-ES';
  let opts = {};

  if (a1 && typeof a1 === 'object' && !(a1 instanceof Buffer)) {
    opts = a1 || {};
    if (opts.filename) filename = String(opts.filename);
    if (opts.language) language = String(opts.language);
  } else {
    if (typeof a1 === 'string') filename = a1;
    if (a2 && typeof a2 === 'string') language = a2;
    if (a2 && typeof a2 === 'object') opts = a2;
    if (a3 && typeof a3 === 'object') opts = a3;
  }
  return { filename, language, opts };
}

function resolveProvider(input) {
  const fromReq = String(input || '').trim().toLowerCase();
  const allowed = new Set(['openai', 'faster', 'deepgram']);
  if (allowed.has(fromReq)) return fromReq;

  const fromEnv = String(ENV_PROVIDER).toLowerCase();
  if (allowed.has(fromEnv)) return fromEnv;

  return 'openai';
}

/* ============================ Transcripción (API) ============================ */
/**
 * Devuelve SIEMPRE:
 *  {
 *    text: string,
 *    segments: [{ start, end, text }],
 *    linesRoleLabeled: [ "mm:ss Rol: texto", ... ]
 *  }
 */
export async function transcribeAudio(buffer, a1, a2, a3) {
  if (process.env.SKIP_TRANSCRIPTION === '1') {
    return {
      text: '(SKIP_TRANSCRIPTION=1) Transcripción omitida (usa el campo transcript del body si está).',
      segments: [],
      linesRoleLabeled: []
    };
  }

  const { filename, language, opts } = normalizeArgs(buffer, a1, a2, a3);
  const provider = resolveProvider(opts?.provider);

  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY no configurada; no puedo usar OpenAI.');
    }
    return transcribeAudioOpenAI(buffer, filename, language);
  }

  if (provider === 'deepgram') {
    if (!process.env.DEEPGRAM_API_KEY) {
      throw new Error('DEEPGRAM_API_KEY no configurada; no puedo usar Deepgram.');
    }
    return transcribeAudioDeepgram(
      buffer,
      filename,
      language,
      opts?.mimetype || guessMimeFromName(filename),
      opts?.model || process.env.DEEPGRAM_MODEL
    );
  }

  // provider === 'faster' (Faster-Whisper local)
  return transcribeAudioLocal(buffer, filename, language);
}

/* ============================== OpenAI Whisper ============================== */
async function transcribeAudioOpenAI(buffer, filename, language) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 120000)
  });

  const file = await toFile(Buffer.from(buffer), filename || 'audio.wav', {
    type: 'application/octet-stream'
  });

  const model = process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
  const lang  = (language || 'es-ES').split('-')[0];

  const resp = await client.audio.transcriptions.create({
    file,
    model,
    language: lang,
    response_format: 'verbose_json'
  });

  const text = String(resp?.text || '').trim();
  const segments = Array.isArray(resp?.segments)
    ? resp.segments.map(s => ({
        start: s?.start ?? s?.offset ?? 0,
        end:   s?.end   ?? (s?.start ?? 0) + 2,
        text:  s?.text ?? ''
      }))
    : [];

  const linesRoleLabeled = formatTranscriptLinesMono(segments);
  return { text, segments, linesRoleLabeled };
}

/* ========================== Deepgram (HTTP /listen) ========================== */
function guessMimeFromName(name = '') {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.wav'))  return 'audio/wav';
  if (n.endsWith('.mp3'))  return 'audio/mpeg';
  if (n.endsWith('.m4a'))  return 'audio/m4a';
  if (n.endsWith('.aac'))  return 'audio/aac';
  if (n.endsWith('.ogg'))  return 'audio/ogg';
  if (n.endsWith('.webm')) return 'audio/webm';
  if (n.endsWith('.flac')) return 'audio/flac';
  return 'application/octet-stream';
}

async function transcribeAudioDeepgram(buffer, filename, language, mimetype, model) {
  const key = process.env.DEEPGRAM_API_KEY;
  const base = 'https://api.deepgram.com/v1/listen';
  const lang = (language || 'es-ES').split('-')[0] || 'es';

  const url = new URL(base);
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('utterances', 'true');     // para segmentos con tiempos
  url.searchParams.set('model', model || 'nova-2');
  url.searchParams.set('language', lang);

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Authorization': `Token ${key}`,
      'Content-Type': mimetype || 'audio/mpeg',
      'Accept': 'application/json'
    },
    body: Buffer.from(buffer)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Deepgram error ${resp.status}: ${t.slice(0, 300)}`);
  }

  const j = await resp.json().catch(() => ({}));

  const text = String(
    j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
  ).trim();

  let segments = [];
  // 1) Mejor opción: utterances (con start/end)
  if (Array.isArray(j?.results?.utterances) && j.results.utterances.length) {
    segments = j.results.utterances.map(u => ({
      start: Number(u?.start ?? 0),
      end:   Number(u?.end ?? ((u?.start ?? 0) + 2)),
      text:  String(u?.transcript || '')
    }));
  } else {
    // 2) Fallback: agrupar por palabras con gap
    const words = j?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
    const GAP = 0.8;     // segundos
    const MAX_DUR = 8;   // segundos
    let cur = null;
    for (const w of words) {
      const wstart = Number(w?.start ?? w?.start_time ?? 0);
      const wend   = Number(w?.end   ?? w?.end_time   ?? (wstart + 0.2));
      const wtext  = String(w?.punctuated_word || w?.word || '').trim();
      if (!wtext) continue;

      if (!cur) { cur = { start: wstart, end: wend, text: wtext }; continue; }
      const gap = Math.max(0, wstart - cur.end);
      const dur = Math.max(0, cur.end - cur.start);

      if (gap > GAP || dur > MAX_DUR) {
        segments.push(cur);
        cur = { start: wstart, end: wend, text: wtext };
      } else {
        cur.text = `${cur.text} ${wtext}`.replace(/\s+/g, ' ').trim();
        cur.end = wend;
      }
    }
    if (cur) segments.push(cur);
  }

  const linesRoleLabeled = formatTranscriptLinesMono(segments);
  return { text, segments, linesRoleLabeled };
}

/* ===================== Faster-Whisper local (fw-server) ===================== */
async function transcribeAudioLocal(buffer, filename, language) {
  let url = (process.env.FW_SERVER_URL || 'http://127.0.0.1:8000/transcribe')
              .trim()
              .replace('localhost', '127.0.0.1');

  console.log('[FW][POST]', url, 'len=', buffer?.byteLength || buffer?.length, 'lang=', language, 'timeoutMs=', FW_TIMEOUT_MS);

  const fd = new FormData();
  const blob = new Blob([buffer]);
  fd.append('file', blob, filename || 'audio.wav');
  fd.append('language', (language || 'es-ES').split('-')[0]);

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FW_TIMEOUT_MS);

    const resp = await fetch(url, {
      method: 'POST',
      body: fd,
      signal: ctrl.signal
    });
    clearTimeout(t);

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`FW server error ${resp.status}: ${txt}`);
    }

    const json = await resp.json().catch(() => ({}));

    const ok = (json.ok === undefined) ? true : !!json.ok;
    if (!ok) throw new Error(json.error || 'Faster-Whisper error');

    const text = String(json?.text || '').trim();

    const segments = Array.isArray(json?.segments)
      ? json.segments.map(s => ({
          start: s?.start ?? s?.offset ?? 0,
          end:   s?.end   ?? (s?.start ?? 0) + 2,
          text:  s?.text ?? ''
        }))
      : [];

    const linesRoleLabeled = formatTranscriptLinesMono(segments);
    return { text, segments, linesRoleLabeled };
  } catch (e) {
    console.error('[FW][ERROR]', e?.name, e?.message, e?.cause?.code || '');
    throw e;
  }
}
