// src/services/transcriptionService.js
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

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
  if (/(link\s+de\s+pago|pse|portal\\s+oficial|oficinas\\s+autorizadas)/.test(t)) agent += 2;
  if (/^buen[oa]s\s+(tardes|d[ií]as|noches)[,;\s]/.test(t) && /(le\\s+habla|de\\s+contacto|del\\s+área|somos)/.test(t)) agent += 2;

  if (/(no\\s+tengo|no\\s+puedo|no\\s+estoy\\s+trabajando|estoy\\s+desemplead[oa]|independiente|no\\s+me\\s+queda|no\\s+me\\s+alcanza)/.test(t)) client += 2;
  if (/(mi\\s+prima|mi\\s+familia|yo\\s+puedo|yo\\s+pag[oé]|no\\s+entiendo|c[oó]mo\\s+hago)/.test(t)) client += 1;
  if (/^(sí|si|no|ok|bueno|claro|listo|perfecto)[,.\s]*$/.test(t)) client += 2;
  if (/gracias/.test(t)) client += 1;
  if (/^\$?\s*\d+([.,]\d+)?(\s*(mil|k|m|millones?))?$/.test(t)) client += 2;
  if (/^(emplead[oa]|independiente|pensionad[oa]|no\\s+trabajo|buscando\\s+empleo)\\.?$/.test(t)) client += 2;

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
  const allowed = new Set(['openai', 'deepgram']);
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

  console.log('[STT] provider=%s language=%s', provider, language);

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
    const out = await transcribeAudioDeepgram(buffer, filename, language);
    // Salvavidas: si Deepgram no devuelve nada y tienes activado fallback:
    if (!out.text && (!Array.isArray(out.segments) || out.segments.length === 0)) {
      if (String(process.env.DEEPGRAM_FALLBACK_OPENAI || '0') === '1') {
        console.warn('[STT][Deepgram] vacío → fallback a OpenAI (whisper)');
        try { return await transcribeAudioOpenAI(buffer, filename, language); } catch {}
      }
    }
    return out;
  }

  throw new Error('Proveedor de transcripción no soportado.');
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

  console.log('[STT][OpenAI] model=%s lang=%s bytes=%d', model, lang, buffer?.length || 0);

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

/* ========================== Deepgram (SDK + HTTP fallback) ========================== */
function guessMimeFromName(name = '') {
  const ext = String(name || '').toLowerCase().split('.').pop();
  switch (ext) {
    case 'mp3':  return 'audio/mpeg';
    case 'wav':  return 'audio/wav';
    case 'm4a':  return 'audio/mp4';
    case 'aac':  return 'audio/aac';
    case 'ogg':  return 'audio/ogg';
    case 'oga':  return 'audio/ogg';
    case 'opus': return 'audio/opus';
    case 'webm': return 'audio/webm';
    case 'flac': return 'audio/flac';
    default:     return 'application/octet-stream';
  }
}

async function transcribeAudioDeepgram(buffer, filename, language) {
  const { createClient } = await import('@deepgram/sdk'); // import dinámico
  const dg = createClient(process.env.DEEPGRAM_API_KEY);

  const model = process.env.DEEPGRAM_STT_MODEL || 'nova-3';
  const lang  = (language || 'es-ES').split('-')[0];

  let source = {
    buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    mimetype: guessMimeFromName(filename)
  };

  const opts = {
    model,
    language: lang,
    smart_format: true,
    punctuate: true,
    utterances: true,
    paragraphs: true
  };

  const doSDK = async () => {
    console.log('[STT][Deepgram] bytes=%d mime=%s model=%s lang=%s',
      source.buffer?.length || 0, source.mimetype, opts.model, opts.language);

    const resp   = await dg.listen.prerecorded.transcribeFile(source, opts);
    const result = resp?.result || {};
    const ch0    = result?.results?.channels?.[0] || {};
    const alt0   = ch0?.alternatives?.[0] || {};

    // ----------- TEXT robusto -----------
    let text = '';

    // 1) transcript completo si viene
    if (!text && typeof alt0?.transcript === 'string') {
      text = alt0.transcript.trim();
      if (text && text !== '(no speech)') console.log('[STT][Deepgram] texto desde alt0.transcript');
    }

    // 2) paragraphs.transcript (si lo trae)
    if (!text && alt0?.paragraphs?.transcript) {
      text = String(alt0.paragraphs.transcript).trim();
      if (text) console.log('[STT][Deepgram] texto desde paragraphs.transcript');
    }

    // 3) paragraphs.paragraphs[*].text/sentences
    if (!text && Array.isArray(alt0?.paragraphs?.paragraphs)) {
      text = alt0.paragraphs.paragraphs
        .map(p => (Array.isArray(p?.sentences)
          ? p.sentences.map(s => s.text || '').join(' ')
          : (p?.text || '')))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) console.log('[STT][Deepgram] texto desde paragraphs.paragraphs[*]');
    }

    // 4) utterances
    const utterances = Array.isArray(result?.results?.utterances) ? result.results.utterances : [];
    if (!text && utterances.length) {
      text = utterances.map(u => String(u?.transcript || ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) console.log('[STT][Deepgram] texto desde utterances');
    }

    // 5) words
    if (!text && Array.isArray(alt0?.words) && alt0.words.length) {
      text = alt0.words
        .map(w => w?.punctuated_word || w?.word || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) console.log('[STT][Deepgram] texto desde words');
    }

    // ----------- SEGMENTOS -----------
    let segments = [];
    if (utterances.length) {
      segments = utterances.map(u => ({
        start: Number(u?.start ?? 0),
        end:   Number(u?.end ?? ((u?.start ?? 0) + 2)),
        text:  String(u?.transcript || '').trim()
      })).filter(s => s.text);
    } else if (Array.isArray(alt0?.words) && alt0.words.length) {
      const words = alt0.words;
      const GAP = 0.8;   // segundos
      const MAX = 8;     // segundos
      let cur = null;
      for (const w of words) {
        const wstart = Number(w?.start ?? w?.start_time ?? 0);
        const wend   = Number(w?.end   ?? w?.end_time   ?? (wstart + 0.2));
        const wtext  = String(w?.punctuated_word || w?.word || '').trim();
        if (!wtext) continue;

        if (!cur) { cur = { start: wstart, end: wend, text: wtext }; continue; }
        const gap = Math.max(0, wstart - cur.end);
        const dur = Math.max(0, cur.end - cur.start);

        if (gap > GAP || dur > MAX) {
          segments.push(cur);
          cur = { start: wstart, end: wend, text: wtext };
        } else {
          cur.text = `${cur.text} ${wtext}`.replace(/\s+/g, ' ').trim();
          cur.end = wend;
        }
      }
      if (cur) segments.push(cur);
    }

    // Derivar texto desde segmentos si aún está vacío
    if (!text && segments.length) {
      text = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text) console.log('[STT][Deepgram] texto derivado de segmentos');
    }

    console.log('[STT][Deepgram] text.len=%d segments=%d', text.length, segments.length);
    const linesRoleLabeled = formatTranscriptLinesMono(segments);
    return { text, segments, linesRoleLabeled };
  };

  const doHTTPFallback = async () => {
    const base = 'https://api.deepgram.com/v1/listen';
    const url = new URL(base);
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('punctuate', 'true');
    url.searchParams.set('utterances', 'true');
    url.searchParams.set('paragraphs', 'true');
    url.searchParams.set('model', model);
    url.searchParams.set('language', lang);

    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': source.mimetype || 'application/octet-stream',
        'Accept': 'application/json'
      },
      body: Buffer.from(source.buffer)
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Deepgram HTTP error ${resp.status}: ${t.slice(0, 300)}`);
    }

    const j = await resp.json().catch(() => ({}));

    let text = '';
    const ch0  = j?.results?.channels?.[0] || {};
    const alt0 = ch0?.alternatives?.[0] || {};
    if (typeof alt0?.transcript === 'string') text = alt0.transcript.trim();
    if (!text && alt0?.paragraphs?.transcript) text = String(alt0.paragraphs.transcript).trim();
    if (!text && Array.isArray(j?.results?.utterances)) {
      text = j.results.utterances.map(u => u?.transcript || '').join(' ').replace(/\s+/g, ' ').trim();
    }
    if (!text && Array.isArray(alt0?.words)) {
      text = alt0.words.map(w => w?.punctuated_word || w?.word || '').join(' ').replace(/\s+/g, ' ').trim();
    }

    let segments = [];
    if (Array.isArray(j?.results?.utterances) && j.results.utterances.length) {
      segments = j.results.utterances.map(u => ({
        start: Number(u?.start ?? 0),
        end:   Number(u?.end ?? (u?.start ?? 0) + 2),
        text:  String(u?.transcript || '').trim()
      })).filter(s => s.text);
    }

    if (!text && segments.length) {
      text = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
    }

    console.log('[STT][Deepgram][HTTP] text.len=%d segments=%d', text.length, segments.length);
    const linesRoleLabeled = formatTranscriptLinesMono(segments);
    return { text, segments, linesRoleLabeled };
  };

  try {
    const out = await doSDK();
    if (out.text || (out.segments && out.segments.length)) return out;

    console.warn('[STT][Deepgram] SDK vacío → intento HTTP fallback /v1/listen');
    // Reintento: a veces 422 por mime; probamos octet-stream también
    if (source.mimetype !== 'application/octet-stream') {
      source = { buffer: Buffer.from(source.buffer), mimetype: 'application/octet-stream' };
    }
    return await doHTTPFallback();
  } catch (err) {
    const code = err?.status || err?.response?.status;
    const msg  = err?.message || String(err);
    console.error('[STT][Deepgram][ERROR] code=%s msg=%s', code, msg);

    // 422: “Unable to read the entire client request.” → fallback HTTP
    if (code === 422) {
      try {
        console.warn('[STT][Deepgram] 422 → intento HTTP fallback /v1/listen con octet-stream');
        return await doHTTPFallback();
      } catch (e2) {
        console.error('[STT][Deepgram][HTTP Fallback][ERROR]', e2?.message || e2);
      }
    }

    throw err;
  }
}
