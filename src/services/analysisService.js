// src/services/analysisService.js
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// CommonJS interop seguro en ESM:
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');

// opcional: atajos a promesas
const { promises: fsp } = fs;

/** Intenta parsear JSON incluso si el modelo añadió texto alrededor */
function forceJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = text.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch {}
  }
  try { return JSON.parse(text.replace(/\n/g, ' ').replace(/\r/g, ' ')); } catch {}
  return null;
}

/** Normaliza nombre para matching robusto (quita acentos, colapsa separadores) */
function keyName(x) {
  return String(x || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Limpia honoríficos comunes (Señor, Sra., Don, etc.) */
function cleanName(x = '') {
  const s = String(x).trim();
  if (!s) return '';
  return s.replace(/^(señor(?:a)?|sr\.?|sra\.?|srta\.?|don|doña)\s+/i, '').trim();
}

/* ==================== Criticidad flexible (compat) ==================== */
function isCriticalRow(row) {
  const thr = Number(process.env.CRITICAL_WEIGHT_VALUE || process.env.CRITICAL_WEIGHT_THRESHOLD || 100);
  const byWeightEnabled = String(process.env.CRITICAL_BY_WEIGHT ?? '1') !== '0';

  const nombre   = String(row?.atributo ?? row?.Atributo ?? '').toLowerCase();
  const cat      = String(row?.categoria ?? row?.Categoria ?? '').toLowerCase();
  const criterio = String(row?.criterio ?? '').toLowerCase();
  const peso     = Number(row?.peso ?? row?.Peso ?? 0);
  const flagCol  = (typeof row?.critico === 'boolean') ? row.critico : null;

  const noncriticalHints = (process.env.NONCRITICAL_HINT_WORDS || 'opcional,no obligatorio,preferible,ideal')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  const nameKeywords = (process.env.CRITICAL_NAME_KEYWORDS || 'tratamiento de datos,habeas data,autorización datos,consentimiento,legal,ley 1581')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  const catKeywords = (process.env.CRITICAL_CATEGORY_KEYWORDS || 'crítico,critico,legal,obligatorio,compliance')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  if (flagCol === true)  return true;
  if (flagCol === false) return false;

  if (noncriticalHints.some(w => criterio.includes(w))) return false;

  if (catKeywords.some(w => cat.includes(w)))     return true;
  if (nameKeywords.some(w => nombre.includes(w))) return true;

  if (byWeightEnabled && Number.isFinite(peso) && peso >= thr) return true;

  return false;
}
/* ============================================================= */

/* ==================== FRAUDE: configuración + heurística ==================== */
const OFFICIAL_PAY_CHANNELS = (process.env.OFFICIAL_PAY_CHANNELS || 'link de pago,PSE,portal oficial,oficinas autorizadas')
  .split(',').map(s => s.trim()).filter(Boolean);

/** Heurística local anti-fraude */
function detectFraudHeuristics(transcriptText = '') {
  const txt = String(transcriptText || '');
  if (!txt) return [];

  const out = [];
  const push = (tipo, cita, riesgo = 'alto') => {
    if (!tipo || !cita) return;
    out.push({ tipo, cita: String(cita).trim().slice(0, 200), riesgo });
  };
  const around = (i) => txt.slice(Math.max(0, i - 60), Math.min(txt.length, i + 120)).replace(/\s+/g, ' ').trim();

  // A) otros números / número personal / whatsapp
  const reAltNum = /\b(me\s+voy\s+a\s+comunicar|le\s+(?:escribo|llamo))\s+de\s+otro\s+n[úu]mero\b|\bn[úu]mero\s+personal\b|\bmi\s+(?:whatsapp|celular)\s+es\b/ig;
  let m;
  while ((m = reAltNum.exec(txt)) !== null) push('contacto_numero_no_oficial', around(m.index));

  // B) cuentas/consignaciones
  const reCuenta = /\b(cuenta(?:\s+de\s+(?:ahorros|corriente))?|consignar|consignación|transferir|dep[oó]sitar|nequi|daviplata|bancolombia|davivienda|bbva|colpatria|banco\s+de\s+bog[oó]t[aá]|efecty|baloto)\b[\s\S]{0,60}(\b\d[\d\s-]{6,}\b)/ig;
  while ((m = reCuenta.exec(txt)) !== null) push('cuenta_no_oficial', around(m.index));

  const seen = new Set();
  return out.filter(a => {
    const k = a.tipo + '|' + a.cita;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
/* ========================================================================== */

/** Hash simple para depurar prompts */
function hash32(s) {
  let h = 0; if (!s) return '0';
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return (h >>> 0).toString(16);
}

/* ==================== UTIL: extracción de guion (PDF/DOCX/TEXTO) ==================== */
/** Limpia HTML simple y comprime espacios */
function stripHtmlAndNormalize(s = '') {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Extrae texto de un Buffer PDF (robusto) */
async function extractTextFromPdfBuffer(buf) {
  try {
    const res = await pdfParse(buf);
    return stripHtmlAndNormalize(res.text || '');
  } catch (e) {
    console.warn('[analysisService] Error pdf-parse:', e?.message || e);
    return '';
  }
}

/** Extrae texto de un Buffer DOCX (robusto) */
async function extractTextFromDocxBuffer(buf) {
  try {
    const res = await mammoth.extractRawText({ buffer: buf });
    return stripHtmlAndNormalize(res.value || '');
  } catch (e) {
    console.warn('[analysisService] Error mammoth:', e?.message || e);
    return '';
  }
}

/**
 * Carga el guion desde:
 * - promptPath (ruta a .pdf o .docx),
 * - prompt en base64 (data:application/pdf;base64,... o JVBERi0...),
 * - o prompt ya como texto plano.
 */
async function loadCampaignText({ prompt = '', promptPath = '' } = {}) {
  const MAX = Number(process.env.CAMPAIGN_SCRIPT_MAX_CHARS || 5000);

  // 1) Ruta a archivo
  if (promptPath) {
    try {
      const ext = path.extname(promptPath).toLowerCase();
      const buf = await fsp.readFile(promptPath);
      let text = '';
      if (ext === '.pdf')       text = await extractTextFromPdfBuffer(buf);
      else if (ext === '.docx') text = await extractTextFromDocxBuffer(buf);
      else                      text = stripHtmlAndNormalize(buf.toString('utf8'));
      return text.slice(0, MAX);
    } catch (e) {
      console.warn('[analysisService] No se pudo leer promptPath:', e?.message || e);
      return '';
    }
  }

  // 2) Base64 data URL de PDF
  const trimmed = String(prompt || '').trim();
  const b64Match = trimmed.match(/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/);
  if (b64Match) {
    const buf = Buffer.from(b64Match[1], 'base64');
    const text = await extractTextFromPdfBuffer(buf);
    return text.slice(0, MAX);
  }
  // 2b) Base64 puro que comienza con JVBERi0 (=%PDF-1.)
  if (/^JVBERi0/.test(trimmed)) {
    try {
      const buf = Buffer.from(trimmed, 'base64');
      const text = await extractTextFromPdfBuffer(buf);
      return text.slice(0, MAX);
    } catch {
      return '';
    }
  }

  // 3) Si vino el BINARIO como string con %PDF-1.x -> ignorar para no contaminar prompt
  if (/%PDF-1\./.test(trimmed)) {
    return '';
  }

  // 4) Texto plano
  return stripHtmlAndNormalize(trimmed).slice(0, MAX);
}

/* ==================== NO-OPS para compatibilidad (sin debug en consola) ==================== */
const PREVIEW_CHARS = Number(process.env.DEBUG_PROMPT_PREVIEW_CHARS || 800);
function serializeMessages(messages = []) {
  return messages.map((m, i) => {
    const role = m?.role || `msg${i}`;
    const content = Array.isArray(m?.content)
      ? m.content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('\n')
      : (m?.content || '');
    return `--- ${role.toUpperCase()} ---\n${content}`;
  }).join('\n\n');
}
function extractByRole(messages = [], role = 'system') {
  const blocks = messages
    .filter(m => m.role === role)
    .map(m => Array.isArray(m.content)
      ? m.content.map(c => (typeof c === 'string' ? c : (c?.text || ''))).join('\n')
      : (m.content || '')
    );
  return blocks.join('\n\n');
}
function dumpPrompt() { /* no-op: sin logs */ }
/* ====================================================================== */

/* ==================== Reglas locales NA/forzados (solo transcripción) ==================== */
function naRulesFromTranscript(atributoNombre = '', transcript = '') {
  const name = (atributoNombre || '').toLowerCase();
  const t = (transcript || '').toLowerCase();

  const hasMonto = /\$\s?\d[\d\.\,]*|\b\d{3}\.?\d{3}\b/.test(t);
  const hasFecha = /(hoy|mañana|\b\d{1,2}\s*(de)?\s*(ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b|\d{4}-\d{2}-\d{2})/.test(t);

  // Canal de PAGO real (no contacto). Permitimos "link de pago por WhatsApp" explícito.
  const baseCanalPago = /(pse|link\s*de\s*pago|portal|oficina(s)?|corresponsal(es)?|sucursal|banco|dataf[oó]no|efecty|baloto)/.test(t);
  const canalPorWhatsApp = /(link\s*de\s*pago.*whatsapp|enviar(é|e)?\s+el\s+link.*whatsapp)/.test(t);
  const hasCanal = baseCanalPago || canalPorWhatsApp;

  const pospone = /(revis(ar|o)|le escribo|env[ií]o un mensaje|mañana|quedo pendiente)/.test(t);

  const intencionPago = /(pagar|pago|cuota|le escribo para coordinar|me confirma el link)/.test(t);
  const objecion = /(no puedo pagar|no reconozco|no estoy de acuerdo|no tengo dinero|no conf[ií]o)/.test(t);

  const guionGrabacion = /(grabada|grabaci[oó]n).+ley\s*1581/.test(t) || /ley\s*1581.+(grabada|grabaci[oó]n)/.test(t);
  const guionEmpresariales = /recaud.*cuentas.*empresariales|cuentas.*empresariales/.test(t);
  const guionDespedida = /(gracias|hasta luego|que est[eé] muy bien|feliz d[ií]a)/.test(t);
  const guionOK = guionGrabacion && guionEmpresariales && guionDespedida;

  const whatsappOK = /(este mismo n[uú]mero.*whatsapp|tiene whatsapp|le voy a enviar un mensaje|le escribo por whatsapp)/.test(t);

  // A) Confirmación de negociación → NA si no hay cierre (monto+fecha+canal) y hay posposición
  if (/confirmaci[oó]n.*negociaci[oó]n/.test(name)) {
    const cierre = hasMonto && hasFecha && hasCanal;
    if (!cierre && pospone) return { aplica: false, forceCumple: true, reason_code: 'NA_NO_CIERRE' };
  }

  // B) Debate de objeciones → NA si no hay objeción (sí hay intención de pago)
  if (/objeciones?/.test(name)) {
    if (intencionPago && !objecion) return { aplica: false, forceCumple: true, reason_code: 'NA_SIN_OBJECION' };
  }

  // C) Guion completo → Cumple si se detectan 3 piezas (fallback por transcripción)
  if (/guion.*completo/.test(name)) {
    if (guionOK) return { aplica: true, forceCumple: true, reason_code: 'OK_GUION_3P' };
  }

  // D) Autorización de contacto → Cumple si WhatsApp al mismo número (aceptación)
  if (/autorizaci[oó]n.*contactar/.test(name) || /contactarlo por diferentes medios/.test(name)) {
    if (whatsappOK) return { aplica: true, forceCumple: true, reason_code: 'OK_CONTACTO_WHATSAPP' };
  }

  return null;
}

/* ==================== Fallback de Hallazgos ==================== */
/** Extrae hechos rápidos de la transcripción para construir hallazgos si el LLM no los trae */
function extractQuickFacts(t = '') {
  const txt = String(t || '').toLowerCase();
  const amounts = Array.from(txt.matchAll(/\b\d{1,3}(?:\.\d{3})+(?:,\d+)?\b|\$\s?\d[\d\.\,]*/g)).map(m => m[0]).slice(0, 5);
  const dates   = Array.from(txt.matchAll(/\b(hoy|mañana|\d{1,2}\s*(de)?\s*(ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)|\d{4}-\d{2}-\d{2})\b/g)).map(m => m[0]).slice(0, 5);

  const hasGrabacionLey = /(grabada|grabaci[oó]n).+ley\s*1581|ley\s*1581.+(grabada|grabaci[oó]n)/.test(txt);
  const hasEmpresariales = /recaud.*cuentas.*empresariales|cuentas.*empresariales/.test(txt);
  const hasWhatsApp = /whatsapp/.test(txt);

  return { amounts, dates, hasGrabacionLey, hasEmpresariales, hasWhatsApp };
}

/** Construye hallazgos si el LLM no mandó ninguno */
function buildHallazgos(transcriptText = '', atributos = [], guionCheck = {}) {
  const h = [];
  const f = extractQuickFacts(transcriptText);
  if (guionCheck?.porcentaje_cobertura >= 1 || (f.hasGrabacionLey && f.hasEmpresariales)) {
    h.push('Se informó grabación y Ley 1581, y se aclaró recaudo a cuentas empresariales.');
  }
  const alt = atributos?.find(a => /alternativas|escalonado/i.test(a?.categoria || a?.atributo || '')) || atributos?.find(a => /alternativas/i.test(a?.atributo || ''));
  if (alt) {
    const montoEj = f.amounts[0] ? ` (p. ej., ${f.amounts[0]})` : '';
    h.push(`Se ofrecieron alternativas de pago${montoEj}${f.dates[0] ? ` con referencia temporal (${f.dates[0]})` : ''}.`);
  }
  const nego = atributos?.find(a => /confirmaci[oó]n.*negociaci[oó]n/i.test(a?.atributo || ''));
  if (nego && nego.aplica === false) {
    h.push('No hubo cierre de negociación en la llamada (NA por no existir monto+fecha+canal acordados).');
  }
  const aut = atributos?.find(a => /autorizaci[oó]n.*contact/i.test(a?.atributo || '') || /contactarlo por diferentes medios/i.test(a?.atributo || ''));
  if (aut && (aut.cumplido || f.hasWhatsApp)) {
    h.push('Se habilitó contacto posterior por WhatsApp en el mismo número.');
  }
  if (!h.length) {
    h.push('Se brindó información sobre la obligación y se exploraron opciones de pago.');
  }
  return h.slice(0, 4);
}

/* ==================== Export principal ==================== */
export async function analyzeTranscriptWithMatrix({
  transcript,
  matrix,
  prompt = '',
  promptPath = '',       // <<--- permite pasar ruta a PDF/DOCX
  context = {}
}) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS),
  });

  const model        = process.env.OPENAI_CHAT_MODEL;
  const MAX_CHARS    = Number(process.env.ANALYSIS_MAX_INPUT_CHARS);
  const MAX_TOKENS   = Number(process.env.ANALYSIS_MAX_TOKENS);
  const BATCH_SIZE   = Number(process.env.ANALYSIS_BATCH_SIZE);
  const BATCH_TOKENS = Number(process.env.ANALYSIS_BATCH_TOKENS);

  // '0' => false
  const ONLY_CRITICAL = String(process.env.ANALYZE_ONLY_CRITICAL || '0') !== '0';

  // ---------- Helpers ----------
  const toPlainTranscript = (t) => {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t === 'object') {
      if (typeof t.text === 'string') return t.text;
      if (Array.isArray(t.segments)) {
        try { return t.segments.map(s => (s?.text || '').trim()).filter(Boolean).join(' '); } catch {}
      }
    }
    try { return JSON.stringify(t); } catch { return String(t); }
  };
  const maybeTruncate = (s, max) => {
    const txt = String(s || '');
    if (!max || txt.length <= max) return txt;
    return txt.slice(0, max);
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // --- Cargar texto REAL del guion/reglas ---
  const campaignText = await loadCampaignText({ prompt, promptPath });

  // --- Info para guion (basado en texto, no binario) ---
  const hadScript = /guion/i.test(campaignText || '');
  let scriptPreview = (campaignText || '').slice(0, 300);
  let promptHash = hash32(campaignText || '');

  // --- Rubrica de OBJECIONES (operativa) ---
  const OBJECCIONES_RULES = `
Reglas para "Debate objeciones en función de la situación del cliente":
- CUMPLE si el agente (a) identifica la situación concreta del cliente y (b) propone al menos una alternativa coherente con esa situación.
- NO APLICA (tratar como CUMPLE) cuando el cliente acepta de inmediato la propuesta o muestra intención de pago sin cuestionar.
`.trim();

  // --- Policy block SOLO críticos/antifraude ---
  const CRITICAL_POLICY = ONLY_CRITICAL ? `
REGLAS DE SEVERIDAD Y ALCANCE (OBLIGATORIAS):
- Evalúa ÚNICAMENTE los atributos recibidos (lista cerrada). Si no hay evidencia clara => "cumplido": false.
- Reporta alertas de FRAUDE si hay canales/contacts no oficiales.
`.trim() : '';

  const makeReq = (userContent, maxTokens = MAX_TOKENS, extraSystem = []) => ({
    model,
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: [
        'Eres un analista de calidad experto en contact center.',
        'Evalúas transcripciones con base en una MATRIZ DE CALIDAD.',
        'Respondes ÚNICAMENTE en JSON válido y en español.',
        'Evalúa lista CERRADA y en el MISMO orden que los atributos solicitados.',
        'Cada "justificacion" debe citar o parafrasear una frase breve del audio cuando marques "cumplido": false.',
        'No inventes datos fuera de la transcripción.',
        `Canales oficiales de pago: ${OFFICIAL_PAY_CHANNELS.join(', ')}.`,
        'Marca FRAUDE si el agente deriva a un canal/contacto NO oficial.',
        'Si recibes "Guion de la campaña", devuelve "guion_check" con cobertura y faltantes.',
        OBJECCIONES_RULES,
        CRITICAL_POLICY,
        // Regla clave de NA:
        'Si el atributo NO APLICA por el propio criterio (p. ej., no hubo negociación que cerrar; no hubo objeción; aviso ya dado por IVR/contrato), marca "aplica": false y de todos modos "cumplido": true y "deduccion": 0, explicando la razón en "justificacion".'
      ].filter(Boolean).join(' ') },
      ...(context?.metodologia || context?.cartera || campaignText || (extraSystem && extraSystem.length) ? [{
        role: 'system',
        content: [
          context?.metodologia ? `Metodología: ${context.metodologia}.` : '',
          context?.cartera     ? `Cartera: ${context.cartera}.`         : '',
          campaignText ? `Reglas/Guion de campaña:\n${campaignText}` : '',
          ...(extraSystem || [])
        ].filter(Boolean).join('\n')
      }] : []),
      { role: 'user', content: userContent },
    ],
  });

  // ---------- Entradas preparadas ----------
  const transcriptText = maybeTruncate(toPlainTranscript(transcript), MAX_CHARS);
  const matrixAsText = (matrix || [])
    .map(m => `- ${m.atributo} | ${m.categoria} | ${m.peso} | ${m.criterio || ''}`)
    .join('\n');
  const expectedAttrNames = (matrix || [])
    .map(r => String(r.atributo ?? r.Atributo ?? '').trim())
    .filter(Boolean);
  const expectedCount = expectedAttrNames.length;

  // ---------- Prompt base ----------
  const baseUser = `
Vas a AUDITAR una transcripción contra una MATRIZ DE CALIDAD. El campo "criterio" de cada atributo es la fuente principal de verdad.

MATRIZ (atributo | categoría | peso | criterio ):
${matrixAsText}

ATRIBUTOS ESPERADOS (${expectedCount}):
- ${expectedAttrNames.join('\n- ')}

TRANSCRIPCIÓN (puede estar truncada si era muy larga):
${transcriptText}

Devuelve JSON ESTRICTAMENTE con el siguiente esquema (sin comentarios):
{
  "agent_name": "string",
  "client_name": "string",
  "resumen": "string",
  "hallazgos": ["string"],
  "atributos": [
    {
      "atributo": "string",
      "categoria": "string",
      "cumplido": true,
      "aplica": true,
      "deduccion": 0,
      "justificacion": "string",
      "mejora": "string",
      "reconocimiento": "string"
    }
  ],
  "sugerencias_generales": ["string"],
  "fraude": { "alertas": [{ "tipo": "cuenta_no_oficial|contacto_numero_no_oficial|otro", "cita": "string", "riesgo": "alto|medio|bajo" }], "observaciones": "string" },
  "guion_check": { "frases_detectadas": ["string"], "obligatorias_faltantes": ["string"], "porcentaje_cobertura": 0 }
}
`.trim();

  // ---------- 1) Intentos normales (hasta 3) ----------
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const req = makeReq(baseUser);

      const completion = await client.chat.completions.create(req);
      const raw  = completion.choices?.[0]?.message?.content || '';
      const json = forceJson(raw);
      if (!json || !Array.isArray(json.atributos)) {
        throw new Error('El modelo no devolvió JSON válido con "atributos".');
      }
      const ret = finalizeFromLLM(json, matrix, transcriptText, { onlyCritical: ONLY_CRITICAL, campaignText });
      ret._debug_prompt = {
        had_script: hadScript,
        prompt_hash: hash32(serializeMessages(req.messages)),
        prompt_preview: serializeMessages(req.messages).slice(0, PREVIEW_CHARS)
      };
      return ret;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '').toLowerCase();
      const isTimeoutish =
        msg.includes('timeout') ||
        err?.name?.toLowerCase?.().includes('timeout') ||
        err?.code === 'ETIMEDOUT' ||
        err?.status === 408 || err?.status === 504 || err?.status === 524;

      if (isTimeoutish && attempt < 3) {
        const backoff = 800 * attempt ** 2;
        await sleep(backoff);
        continue;
      }
      break; // pasamos a intento truncado
    }
  }

  // ---------- 2) Intento final con truncado agresivo ----------
  try {
    const hardMax = Math.floor((Number(process.env.ANALYSIS_MAX_INPUT_CHARS) || 20000) / 2);
    const smallTranscript = maybeTruncate(toPlainTranscript(transcript), hardMax);

    const userTruncated = `
MATRIZ (atributo | categoría | peso | criterio ):
${matrixAsText}

ATRIBUTOS ESPERADOS (${expectedCount}):
- ${expectedAttrNames.join('\n- ')}

TRANSCRIPCIÓN (recortada por tamaño):
${smallTranscript}

Devuelve el MISMO JSON solicitado antes (con TODOS los atributos y en el mismo orden).
`.trim();

    const req2 = makeReq(userTruncated, Math.min(Number(process.env.ANALYSIS_MAX_TOKENS) || 1000, 800));
    const completion = await client.chat.completions.create(req2);
    const raw  = completion.choices?.[0]?.message?.content || '';
    const json = forceJson(raw);
    if (json && Array.isArray(json.atributos)) {
      const ret = finalizeFromLLM(json, matrix, smallTranscript, { onlyCritical: ONLY_CRITICAL, campaignText });
      ret._debug_prompt = {
        had_script: hadScript,
        prompt_hash: hash32(serializeMessages(req2.messages)),
        prompt_preview: serializeMessages(req2.messages).slice(0, PREVIEW_CHARS)
      };
      return ret;
    }
    throw new Error('El modelo no devolvió JSON válido con "atributos" (modo truncado).');
  } catch (err2) {
    lastErr = lastErr || err2;
  }

  // ---------- 3) PLAN B por lotes ----------
  const result = await analyzeByBatches({
    transcriptText, matrix,
    client, model,
    BATCH_SIZE, BATCH_TOKENS
  });
  result._debug_prompt = {
    had_script: hadScript,
    prompt_hash: hash32('plan_b_batches_' + (matrix?.length || 0)),
    prompt_preview: 'Plan B por lotes.'
  };
  return result;
}

/** Une lo que devuelve el LLM con la matriz, garantizando TODOS los atributos en orden + reglas NA locales */
function finalizeFromLLM(json, matrix, transcriptText = '', { onlyCritical = false, campaignText = '' } = {}) {
  const byName = new Map();
  for (const a of (json.atributos || [])) {
    const k = keyName(a?.atributo);
    if (!k) continue;
    byName.set(k, a);
  }

  const guionCheck = {
    frases_detectadas: Array.isArray(json?.guion_check?.frases_detectadas) ? json.guion_check.frases_detectadas : [],
    obligatorias_faltantes: Array.isArray(json?.guion_check?.obligatorias_faltantes) ? json.guion_check.obligatorias_faltantes : [],
    porcentaje_cobertura: Number(json?.guion_check?.porcentaje_cobertura) || 0
  };

  const full = [];
  for (const row of (matrix || [])) {
    const nombre = String(row?.atributo ?? row?.Atributo ?? '').trim();
    if (!nombre) continue;

    const found = byName.get(keyName(nombre)) || {};
    const categoria = String(found?.categoria ?? (row?.categoria ?? row?.Categoria ?? '')).trim();
    const peso = Number(row?.peso ?? row?.Peso ?? 0);
    const critico = true;

    // valores base del LLM
    let cumplido = (typeof found?.cumplido === 'boolean') ? found.cumplido : false;
    let aplica = (typeof found?.aplica === 'boolean') ? found.aplica : true;
    let justif = (found?.justificacion || '').trim();
    let mejora = (found?.mejora ?? (cumplido ? null : 'Definir acciones concretas para cumplir el criterio.'));
    let reconocimiento = found?.reconocimiento ?? null;

    // Regla extra para "guion completo" basada en guion_check
    if (/usa\s+guion\s+establecido/i.test(nombre)) {
      if (guionCheck.obligatorias_faltantes.length > 0) {
        cumplido = false;
        if (!justif) {
          justif = `Faltan frases obligatorias de guion: ${guionCheck.obligatorias_faltantes.slice(0,3).join('; ')}.`;
        }
      } else if (guionCheck.porcentaje_cobertura > 0 || guionCheck.frases_detectadas.length > 0) {
        cumplido = true;
        aplica = true;
        if (!justif) justif = 'Se cubren las frases obligatorias del guion.';
      }
    }

    // === Reglas locales NA/forzados (sin CRM) ===
    const override = naRulesFromTranscript(nombre, transcriptText);
    if (override) {
      if (override.aplica === false) {
        aplica = false;
        cumplido = true;                  // NA → cuenta como Cumple
        mejora = null;
        if (!justif) {
          justif = (override.reason_code === 'NA_NO_CIERRE')
            ? 'No aplica: no hubo cierre de negociación; la persona pospone y no hay monto+fecha+canal acordados.'
            : (override.reason_code === 'NA_SIN_OBJECION')
              ? 'No aplica: no se presentaron objeciones; el cliente expresa intención de pago/ coordinación.'
              : 'No aplica según el criterio (NA).';
        }
      }
      if (override.forceCumple) {
        cumplido = true;
        aplica = (override.aplica === false) ? false : true;
        mejora = null;
        if (!justif) justif = 'Cumplimiento detectado por pauta del criterio.';
      }
    }

    // deducción: si NA o Cumple → 0; si No cumple → peso
    const deduccion = (!aplica || cumplido) ? 0 : (Number.isFinite(peso) ? peso : 0);

    full.push({
      atributo: nombre,
      categoria,
      peso,
      critico,
      aplica,
      cumplido,
      deduccion,
      reason_code: override?.reason_code || null,
      justificacion: justif || (cumplido ? 'Se evidencia cumplimiento del criterio.' : 'No se encontró evidencia explícita de cumplimiento (fail-closed por criticidad).'),
      mejora,
      reconocimiento
    });
  }

  const llmAlerts = Array.isArray(json?.fraude?.alertas) ? json.fraude.alertas : [];
  const heurAlerts = detectFraudHeuristics(transcriptText);
  const merge = [];
  const seen = new Set();
  for (const a of [...llmAlerts, ...heurAlerts]) {
    const clean = {
      tipo: String(a?.tipo || 'otro'),
      cita: String(a?.cita || '').slice(0, 200),
      riesgo: String(a?.riesgo || 'alto')
    };
    const k = clean.tipo + '|' + clean.cita;
    if (clean.cita && !seen.has(k)) { seen.add(k); merge.push(clean); }
  }

  // HALLAZGOS con fallback local si el modelo no envía ninguno
  const hall = (Array.isArray(json.hallazgos) && json.hallazgos.length)
    ? json.hallazgos
    : buildHallazgos(transcriptText, full, guionCheck);

  return {
    agent_name: typeof json.agent_name === 'string' ? cleanName(json.agent_name) : '',
    client_name: typeof json.client_name === 'string' ? cleanName(json.client_name) : '',
    resumen: json.resumen,
    hallazgos: hall,
    atributos: full,
    sugerencias_generales: Array.isArray(json.sugerencias_generales) ? json.sugerencias_generales : [],
    fraude: {
      alertas: merge,
      observaciones: typeof json?.fraude?.observaciones === 'string' ? json.fraude.observaciones : ''
    },
    guion_check: guionCheck,
    _policy_only_critical: onlyCritical ? 1 : 0
  };
}

/** Plan B: evalúa SOLO "atributos" por lotes y los une en el orden de la matriz */
async function analyzeByBatches({ client, model, transcriptText, matrix, BATCH_SIZE, BATCH_TOKENS }) {
  const batches = [];
  for (let i = 0; i < matrix.length; i += BATCH_SIZE) {
    batches.push(matrix.slice(i, i + BATCH_SIZE));
  }

  const atributosAll = [];
  for (const batch of batches) {
    const batchNames = batch
      .map(r => String(r.atributo ?? r.Atributo ?? '').trim())
      .filter(Boolean);

    const batchUser = `
Evalúa SOLO los siguientes atributos (en el MISMO orden) y devuelve ÚNICAMENTE este JSON:
{
  "atributos": [
    {
      "atributo": "string (copiar exactamente de la lista)",
      "categoria": "string",
      "cumplido": true,
      "aplica": true,
      "deduccion": 0,
      "justificacion": "string",
      "mejora": "string",
      "reconocimiento": "string"
    }
  ]
}

LISTA DE ATRIBUTOS (${batchNames.length}):
- ${batchNames.join('\n- ')}

TRANSCRIPCIÓN (puede estar truncada):
${transcriptText}
`.trim();

    const reqB = {
      model,
      temperature: 0.2,
      max_tokens: BATCH_TOKENS,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Responde SOLO el objeto JSON con "atributos". Si marcas false, cita evidencia concreta. Lista cerrada.' },
        { role: 'user', content: batchUser }
      ],
    };

    const completion = await client.chat.completions.create(reqB);
    const raw  = completion.choices?.[0]?.message?.content || '';
    const json = forceJson(raw);
    if (!json || !Array.isArray(json.atributos)) {
      throw new Error('El modelo no devolvió "atributos" en un batch.');
    }
    atributosAll.push(...json.atributos);
  }

  // Unión por nombre y orden de la matriz
  const byName = new Map();
  for (const a of atributosAll) {
    const k = keyName(a?.atributo);
    if (!k) continue;
    byName.set(k, a);
  }

  const full = (matrix || []).map(row => {
    const nombre = String(row?.atributo ?? row?.Atributo ?? '').trim();
    const found  = byName.get(keyName(nombre)) || {};

    const categoria = String(found?.categoria ?? (row?.categoria ?? row?.Categoria ?? '')).trim();
    const peso = Number(row?.peso ?? row?.Peso ?? 0);
    const critico = true;

    let cumplido = (typeof found?.cumplido === 'boolean') ? found.cumplido : false;
    let aplica = (typeof found?.aplica === 'boolean') ? found.aplica : true;

    const justif = (found?.justificacion || '').trim();
    const defaultJustif = cumplido
      ? 'Se evidencia cumplimiento del criterio.'
      : 'No se encontró evidencia explícita de cumplimiento (fail-closed por criticidad).';
    const mejora = (found?.mejora ?? (cumplido ? null : 'Definir acciones concretas para cumplir el criterio.'));
    const deduccion = (!aplica || cumplido) ? 0 : (Number.isFinite(peso) ? peso : 0);

    return {
      atributo: nombre,
      categoria,
      peso,
      critico,
      aplica,
      cumplido,
      deduccion,
      reason_code: null,
      justificacion: justif || defaultJustif,
      mejora,
      reconocimiento: found?.reconocimiento ?? null
    };
  });

  // Mini llamada para resumen/hallazgos + NOMBRES (ligera)
  const miniUser = `
A partir de la transcripción, devuelve ÚNICAMENTE este JSON:
{
  "agent_name": "string",
  "client_name": "string",
  "resumen": "100-200 palabras",
  "hallazgos": ["string","string","string"],
  "sugerencias_generales": ["string","string","string"]
}

REGLAS:
- No inventes nombres; si no hay evidencia explícita, deja el campo vacío "".
- Quita honoríficos (Señor/Sra./Sr./Sra./Don/Doña) si aparecen.

TRANSCRIPCIÓN (puede estar truncada):
${transcriptText}
`.trim();

  try {
    const reqMini = {
      model,
      temperature: 0.2,
      max_tokens: 450,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'No incluyas nombres inventados. Responde SOLO el objeto JSON solicitado.' },
        { role: 'user', content: miniUser },
      ],
    };

    const mini = await client.chat.completions.create(reqMini);
    const rawMini  = mini.choices?.[0]?.message?.content || '';
    const jsonMini = forceJson(rawMini);
    return {
      agent_name: typeof jsonMini?.agent_name === 'string' ? cleanName(jsonMini.agent_name) : '',
      client_name: typeof jsonMini?.client_name === 'string' ? cleanName(jsonMini.client_name) : '',
      resumen: jsonMini?.resumen || '',
      hallazgos: Array.isArray(jsonMini?.hallazgos) && jsonMini.hallazgos.length ? jsonMini.hallazgos : buildHallazgos(transcriptText, full, {}),
      sugerencias_generales: Array.isArray(jsonMini?.sugerencias_generales) ? jsonMini.sugerencias_generales : [],
      atributos: full,
      fraude: { alertas: detectFraudHeuristics(String(transcriptText || '')), observaciones: '' }
    };
  } catch {
    return {
      agent_name: '',
      client_name: '',
      resumen: '',
      hallazgos: buildHallazgos(transcriptText, full, {}),
      sugerencias_generales: [],
      atributos: full,
      fraude: { alertas: detectFraudHeuristics(String(transcriptText || '')), observaciones: '' }
    };
  }
}
