// src/services/transcriptionService.js
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { Agent, setGlobalDispatcher } from 'undici';

// === Config de timeouts ===
const FW_TIMEOUT_MS         = Number(process.env.FW_TIMEOUT_MS || 600000);         // abort total (10 min)
const FW_HEADERS_TIMEOUT_MS = Number(process.env.FW_HEADERS_TIMEOUT_MS || 600000); // headers (10 min)
const FW_BODY_TIMEOUT_MS    = Number(process.env.FW_BODY_TIMEOUT_MS || 3600000);   // body (60 min)

// Dispatcher global para elevar límites de undici/fetch
setGlobalDispatcher(new Agent({
  headersTimeout: FW_HEADERS_TIMEOUT_MS,
  bodyTimeout: FW_BODY_TIMEOUT_MS
}));

// Valor por defecto del .env
const ENV_PROVIDER = (process.env.TRANSCRIBE_PROVIDER || 'faster').toLowerCase().trim();

/* ================= Utilidades ================= */

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
  // Presentación / empresa / área
  '\\b(le\\s+habla|habla\\s+con|mi\\s+nombre\\s+es)\\b',
  '(contacto\\s+solutions?|novarte[ck]|vartex|novartec)',
  '(área|area)\\s+(jur[ií]dica|de\\s+cobranza|juridica)',
  // Cumplimiento / compliance
  '(llamada|conversaci[oó]n).*(grabada|monitoreada)',
  'ley\\s*1581',
  // Gestión / alternativas
  '(alternativas?\\s+de\\s+pago|le\\s+ofrezco|le\\s+brindo|pago\\s+de\\s+contado|descuento|cuotas?)',
  // Cierre/confirmación
  '(confirm(a|amos)|qued(a|amos)\\s+(para|entonces)|se\\s+realiza|program(a|amos))'
].join('|'), 'i');

const CLIENT_HINTS_RX = new RegExp([
  // Respuestas cortas / muletillas
  '^(s[ií],?\\s*(señor|señora|perfecto|de\\s+acuerdo)|bien,?\\s+gracias)\\b',
  // Dificultades / primera persona
  '\\b(no\\s+puedo|no\\s+me\\s+alcanza|no\\s+tengo|estoy\\s+desemplead|independiente|no\\s+me\\s+queda|yo\\s+(no|pago|puedo|tengo|quisiera))\\b',
  // Terceros ayudan
  '(mi\\s+prima|mi\\s+familia|mi\\s+espos[oa])\\b'
].join('|'), 'i');

/**
 * Scoring de pistas por rol en una línea.
 * Devuelve { agent, client } con pesos heurísticos.
 */
function scoreRoleHints(text = '') {
  const t = norm(text);
  let agent = 0, client = 0;

  // Presentación / cumplimiento / script típico de agente
  if (/(le\s+habla|habla\s+con|mi\s+nombre\s+es|somos|del\s+área|área\s+jur[ií]dica|departamento)/.test(t)) agent += 2;
  if (/(llamada\s+est[aá]\s+siendo\s+grabada|monitoread[ao]|calidad|ley\s+1581|protecci[oó]n\s+de\s+datos)/.test(t)) agent += 3;
  if (/(ofrezc|ofrecer|brindo|le\s+ofrezco|alternativas|descuento|cuotas|plan\s+de\s+pagos)/.test(t)) agent += 2;
  if (/(novarte[ck]|contacto\s+solutions|vartex|novartec)/.test(t)) agent += 2;
  if (/(link\s+de\s+pago|pse|portal\s+oficial|oficinas\s+autorizadas)/.test(t)) agent += 2;
  if (/^buen[oa]s\s+(tardes|d[ií]as|noches)[,;\s]/.test(t) && /(le\s+habla|de\s+contacto|del\s+área|somos)/.test(t)) agent += 2;

  // Señales típicas de cliente (situación personal, respuesta corta, agradecimientos)
  if (/(no\s+tengo|no\s+puedo|no\s+estoy\s+trabajando|estoy\s+desemplead[oa]|independiente|no\s+me\s+queda|no\s+me\s+alcanza)/.test(t)) client += 2;
  if (/(mi\s+prima|mi\s+familia|yo\s+puedo|yo\s+pag[oé]|no\s+entiendo|c[oó]mo\s+hago)/.test(t)) client += 1;
  if (/^(sí|si|no|ok|bueno|claro|listo|perfecto)[,.\s]*$/.test(t)) client += 2;
  if (/gracias/.test(t)) client += 1;

  // Respuesta de monto/ocupación breve
  if (/^\$?\s*\d+([.,]\d+)?(\s*(mil|k|m|millones?))?$/.test(t)) client += 2;
  if (/^(emplead[oa]|independiente|pensionad[oa]|no\s+trabajo|buscando\s+empleo)\.?$/.test(t)) client += 2;

  return { agent, client };
}

/**
 * Heurística para etiquetar roles en MONO con mejoras + overrides “duros”:
 * - Alterna turno cuando hay pausas >= GAP_THR.
 * - Handoff pregunta→respuesta: si la línea anterior (Agente) fue pregunta y la actual es corta/ack, forzamos Cliente.
 * - Histeresis por racha reciente y márgenes configurables.
 * - Overrides: si el texto coincide con AGENT_HINTS_RX -> Agente; si coincide con CLIENT_HINTS_RX -> Cliente.
 * - Merge de segmentos contiguos del MISMO rol.
 * - Post-pass: reetiqueta como Agente las líneas con “ley 1581 / llamada grabada / etc.” por seguridad.
 */
export function formatTranscriptLinesMono(segments = []) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const GAP_THR           = Number(process.env.MONO_GAP_THRESHOLD_SEC || 1.2);
  const MERGE_THR         = Number(process.env.MONO_MERGE_THRESHOLD_SEC || 0.6);
  const SWITCH_MARGIN     = Number(process.env.MONO_SWITCH_MARGIN || 2);
  const SHORT_ACK_MAX     = Number(process.env.MONO_SHORT_ACK_MAX_CHARS || 14);
  const STREAK_LOCK_SEC   = Number(process.env.MONO_STREAK_LOCK_SEC || 25);

  // Rol inicial por pistas en primeros S segundos / K segmentos
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
  const recent = []; // ventana para "racha" (últimos N segundos de evidencia)

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

    // limpiar ventana reciente (racha)
    while (recent.length && (start - recent[0].t) > STREAK_LOCK_SEC) recent.shift();

    const sc = scoreRoleHints(text);
    const prev = raw[raw.length - 1];
    const prevWasQuestion = !!(prev && isQuestion(prev.text));
    const prevRole = prev?.role || null;

    // Overrides “duros”: si hay pista clara de agente/cliente, imponemos
    if (AGENT_HINTS_RX.test(text)) {
      currentRole = 'Agente';
      currentConfidence = Math.max(currentConfidence, sc.agent + 5);
    } else if (CLIENT_HINTS_RX.test(text)) {
      currentRole = 'Cliente';
      currentConfidence = Math.max(currentConfidence, sc.client + 3);
    } else {
      // Cambio por gran silencio también sugiere cambio de turno
      const gap = Math.max(0, start - lastEnd);

      // ------------- Regla fuerte: Q→A -------------
      if (prevRole === 'Agente' && prevWasQuestion) {
        const hasStrongAgent = (sc.agent - sc.client) >= (SWITCH_MARGIN + 1);
        const shortish       = text.trim().length <= 40;
        if (shortish && !hasStrongAgent && isAckShortish(text)) {
          currentRole = 'Cliente';
          currentConfidence = Math.max(currentConfidence, sc.client + 2);
        } else {
          // si es respuesta concreta corta (monto/ocupación), favorece cliente
          if (shortish && sc.client >= sc.agent) {
            currentRole = 'Cliente';
            currentConfidence = Math.max(currentConfidence, sc.client + 1);
          } else {
            // mantener rol con histeresis
            if (currentRole === 'Agente') sc.agent += 1; else sc.client += 1;
          }
        }
      } else {
        // ------------- Reglas generales / histeresis -------------
        if (currentRole === 'Agente') sc.agent += 1; else sc.client += 1;

        // Pausa o pregunta reduce el margen de cambio
        let margin = SWITCH_MARGIN;
        if (gap >= GAP_THR || prevWasQuestion) margin = Math.max(0, SWITCH_MARGIN - 1);

        // Racha: si hay mucha evidencia reciente a favor del rol actual, subimos umbral para cambiar
        const agg = recent.reduce((acc, r) => { acc.agent += r.agent; acc.client += r.client; return acc; }, {agent:0, client:0});
        if (agg.agent - agg.client >= 3 && currentRole === 'Agente') sc.agent += 1;
        if (agg.client - agg.agent >= 3 && currentRole === 'Cliente') sc.client += 1;

        // Pistas muy fuertes corrigen rol sin margen
        if (sc.agent - sc.client >= (SWITCH_MARGIN + 1)) {
          currentRole = 'Agente';
          currentConfidence = sc.agent;
        } else if (sc.client - sc.agent >= (SWITCH_MARGIN + 1)) {
          currentRole = 'Cliente';
          currentConfidence = sc.client;
        } else {
          // Cambio solo si el deseado supera la confianza actual + margen
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

    // Guardar y acumular racha
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

  // Post-pass: asegura que frases de compliance/presentación queden como Agente
  for (let i = 0; i < merged.length; i++) {
    const t = merged[i].text || '';
    if (AGENT_HINTS_RX.test(t)) merged[i].role = 'Agente';
  }

  // Formato final "mm:ss Rol: texto"
  return merged.map(s => `${toClock(s.start)} ${s.role}: ${s.text}`);
}

/* =============== Transcripción (API) =============== */
/**
 * Transcribe audio con Faster-Whisper (local) u OpenAI Whisper.
 * Devuelve SIEMPRE un objeto:
 *  {
 *    text: string,
 *    segments: [{ start, end, text }],
 *    linesRoleLabeled: [ "mm:ss Rol: texto", ... ]  // MONO (heurística)
 *  }
 */
export async function transcribeAudio(buffer, filename, language = 'es-ES', opts = {}) {
  if (process.env.SKIP_TRANSCRIPTION === '1') {
    return {
      text: '(SKIP_TRANSCRIPTION=1) Transcripción omitida (usa el campo transcript del body si está).',
      segments: [],
      linesRoleLabeled: []
    };
  }

  const provider = (opts.provider || ENV_PROVIDER).toLowerCase().trim();

  if (provider === 'openai') {
    return transcribeAudioOpenAI(buffer, filename, language);
  }

  // provider === 'faster' (local)
  return transcribeAudioLocal(buffer, filename, language);
}

/* =============== OpenAI Whisper (cloud) =============== */
async function transcribeAudioOpenAI(buffer, filename, language) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 120000)
  });

  // Más seguro en Node que usar new File(...)
  const file = await toFile(Buffer.from(buffer), filename, {
    type: 'application/octet-stream'
  });

  const model = process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
  const lang  = (language || 'es-ES').split('-')[0];

  // Pedimos "verbose_json" para obtener segmentos con timestamps
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

/* =============== Faster-Whisper local (fw-server) =============== */
async function transcribeAudioLocal(buffer, filename, language) {
  let url = (process.env.FW_SERVER_URL || 'http://127.0.0.1:8000/transcribe')
              .trim()
              .replace('localhost', '127.0.0.1');

  console.log('[FW][POST]', url, 'len=', buffer?.byteLength || buffer?.length, 'lang=', language, 'timeoutMs=', FW_TIMEOUT_MS);

  const fd = new FormData();
  const blob = new Blob([buffer]);
  fd.append('file', blob, filename);
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

    // Compatibilidad: algunos servidores devuelven { ok, text, segments? } y otros solo { text, segments? }
    const ok = (json.ok === undefined) ? true : !!json.ok;
    if (!ok) throw new Error(json.error || 'Faster-Whisper error');

    const text = String(json?.text || '').trim();

    // Si el servidor devuelve segments, los usamos; si no, dejamos []
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
