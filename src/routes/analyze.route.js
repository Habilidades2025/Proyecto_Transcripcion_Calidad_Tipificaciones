// src/routes/analyze.route.js
import expressPkg from 'express';
const express = expressPkg.default ?? expressPkg;

import multerPkg from 'multer';
const multer = multerPkg.default ?? multerPkg;

import fs from 'fs';
import path from 'path';

import { parseMatrixFromXlsx } from '../services/matrixService.js';
import { transcribeAudio, formatTranscriptLinesMono } from '../services/transcriptionService.js';
import { analyzeTranscriptWithMatrix } from '../services/analysisService.js';
import { scoreFromMatrix } from '../services/scoringService.js';
import { saveAudit } from '../services/persistService.js';
import { extractNames } from '../services/nameExtractor.js';

// --- Multer en memoria (100MB por archivo; ajustable por env)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE || 100 * 1024 * 1024) }
});

const router = express.Router();

/** Helper seguro para strings */
function s(v, def = '') { return (v == null ? def : String(v)).trim(); }

/** --- Modos desde .env --- */
const ONLY_CRITICAL  = String(process.env.ANALYZE_ONLY_CRITICAL || '0') !== '0';
const STRICT_APPLICA = String(process.env.STRICT_APPLICA || '0') !== '0'; // si 1: por defecto aplica=false salvo evidencia

/** Normaliza lista separada por comas desde .env */
function envCsv(name, fallback = '') {
  return String(process.env[name] ?? fallback)
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
}

/** Filtro: mantiene SOLO Errores Críticos y Alertas Antifraude */
function isCriticalOrAntifraud(row) {
  const criticidad = s(row?.criticidad ?? row?.Criticidad).toLowerCase();
  const tipo       = s(row?.tipo ?? row?.Tipo).toLowerCase();
  const categoria  = s(row?.categoria ?? row?.Categoría ?? row?.Categoria).toLowerCase();
  const peso       = Number(row?.peso ?? row?.PESO ?? 0);

  const byWeight   = String(process.env.CRITICAL_BY_WEIGHT ?? '1') !== '0';
  const thr        = Number(process.env.CRITICAL_WEIGHT_VALUE ?? process.env.CRITICAL_WEIGHT_THRESHOLD ?? 100);

  const nameKw     = envCsv('CRITICAL_NAME_KEYWORDS', 'tratamiento de datos,habeas data,autorización datos,consentimiento,legal,ley 1581');
  const catKw      = envCsv('CRITICAL_CATEGORY_KEYWORDS', 'crítico,critico,legal,obligatorio,compliance');
  const nonCritKw  = envCsv('NONCRITICAL_HINT_WORDS', 'opcional,no obligatorio,preferible,ideal');

  if (row?.critico === true)  return true;
  if (row?.critico === false) return false;

  if (nonCritKw.some(w => s(row?.criterio).toLowerCase().includes(w))) return false;

  if (catKw.some(w => categoria.includes(w))) return true;
  if (nameKw.some(w => s(row?.atributo).toLowerCase().includes(w))) return true;

  if (byWeight && Number.isFinite(peso) && peso >= thr) return true;

  const esAntifraude = ['antifraude','anti-fraude','alerta antifraude','alertas antifraude']
    .some(k => tipo.includes(k) || categoria.includes(k));
  if (esAntifraude) return true;

  return false;
}

/* ========= Heurísticas de aplicabilidad (guard-rails) ========= */

const meses = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';
const RE_MONTO   = /\b(\d{1,3}(?:\.\d{3}){1,3}|\d{4,})\b/; // 350.000 / 2.584.000 / 350
const RE_FECHA   = new RegExp(`\\b(hoy|mañana|pasado mañana|s[áa]bado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|\\d{1,2}\\s*(de\\s*)?(?:${meses})|\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?)\\b`, 'i');
const RE_MEDIO   = /\b(pse|bancolombia|davivienda|bbva|nequi|daviplata|efecty|baloto|corresponsal|transferencia|consignaci[oó]n|pago en l[ií]nea|oficina|caja)\b/i;
const RE_RECAP   = /\b(acordamos|qued[aó]\s+(entonces|para)|confirm(a|amos)|program(a|amos)|se realiza|se efect[uú]a|el pago es|queda(n)?\s+(para|as[ií]))\b/i;
const RE_WHATS   = /whats\s*app|whatsapp/i;

const OBJECTION_WORDS = [
  'no puedo','no me alcanza','no tengo','desemplead','trabajo informal','enfermo','muy caro',
  'mas adelante','más adelante','no estoy de acuerdo','ya pague','ya pagué','no voy a pagar','no confio','no confío',
  'no recibi','no recibí','no me lleg','no cuento con','desocupad','sin empleo','reduccion de ingresos','reducción de ingresos',
  'menos sueldo','no puedo trabajar','no consegui' 
];

function norm(t='') {
  return String(t || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function hasNegotiationEvidence(t) {
  const n = norm(t);
  const monto = RE_MONTO.test(n);
  const fecha = RE_FECHA.test(n);
  const medio = RE_MEDIO.test(n);
  const recap = RE_RECAP.test(n);
  return (monto && fecha && medio && recap);
}
function hasObjectionEvidence(t) {
  const n = norm(t);
  return OBJECTION_WORDS.some(w => n.includes(norm(w)));
}
function hasProbeEvidence(t) {
  const n = norm(t);
  return /\b(que paso|qué paso|que inconveniente|qué inconveniente|motivo|razon|razón|por que|por qué|situacion actual|situación actual|estado actual|labora|trabaja|ingresos)\b/.test(n);
}
function hasRecordingDisclosure(t) {
  const n = norm(t);
  return /\b(llamada|conversacion|conversación).*(grabada|monitoreada)\b/.test(n) || /\bley\s*1581\b/.test(n);
}
function hasAlternativesEvidence(t){
  const n = norm(t);
  return /\b(alternativa|opcion|opción|pago de contado|cuotas?|plan de pago|descuento|dos partes|dos pagos)\b/.test(n);
}
function hasBenefitsConsequences(t){
  const n = norm(t);
  return /\b(beneficio|consecuencia|centrales|paz y salvo|historial|juridico|jurídico|interes|intereses|mora|reporte)\b/.test(n);
}
// consentimiento explícito para otros medios (WhatsApp/correo/SMS/llamadas)
function hasConsentEvidence(t) {
  const n = norm(t);
  return /\b(autoriza|permite|me\s+autoriza|me\s+permite).*(whats\s*app|whatsapp|correo|email|sms|mensajes|llamadas?)\b/.test(n);
}
// guion completo (flujo fuerte)
function hasFullScriptFlow(t) {
  const n = norm(t);
  const saludo   = /\b(buen[oa]s\s+(dias|días|tardes|noches))\b/.test(n) && /\b(le\s+habla|mi\s+nombre\s+es|de\s+contacto\s+solutions|novarte[ck])\b/.test(n);
  const aviso    = hasRecordingDisclosure(n);
  const ofertas  = hasAlternativesEvidence(n);
  const negoUObj = hasNegotiationEvidence(n) || hasObjectionEvidence(n);
  return (saludo && aviso && ofertas && negoUObj);
}
// *** NUEVO: evidencia de llamada tipo recordatorio ***
function hasReminderEvidence(t) {
  const n = norm(t);
  return /\b(recordatorio|recordarle|le\s+recuerdo\s+que|recuerde\s+que|llamo\s+para\s+recordar|solamente\s+para\s+recordarle)\b/.test(n);
}

function isAttr(row, needle) {
  const a = norm(row?.atributo || row?.Atributo || '');
  return a.includes(norm(needle));
}

router.post(
  '/analyze',
  upload.fields([
    { name: 'matrix', maxCount: 1 },
    { name: 'audio',  maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      // --- Validación mínima
      if (!req.files?.matrix?.[0] || !req.files?.audio?.[0]) {
        return res.status(400).json({
          error: 'Datos incompletos',
          detail: 'Adjunta "matrix" (.xlsx) y "audio" (.mp3/.wav/.m4a)'
        });
      }

      // --- Metadatos del formulario
      const callId       = s(req.body.callId) || String(Date.now());
      const formAgent    = s(req.body.agentName);
      const formClient   = s(req.body.customerName);
      const language     = s(req.body.language || 'es-ES');
      const channel      = s(req.body.channel || 'voz');
      const metodologia  = s(req.body.metodologia);
      const cartera      = s(req.body.cartera);

      // --- Opciones ASR
      const provider     = (s(req.body?.provider) || s(process.env.TRANSCRIBE_PROVIDER || 'faster')).toLowerCase();
      const mode         = s(req.body?.mode).toLowerCase(); // 'mono' | 'stereo'
      const agentChannel = Number.isFinite(Number(req.body?.agentChannel))
        ? Number(req.body.agentChannel)
        : undefined;

      // --- 1) Matriz
      const matrixBuf = req.files.matrix[0].buffer;
      const rawMatrix = parseMatrixFromXlsx(matrixBuf);
      if (!Array.isArray(rawMatrix) || rawMatrix.length === 0) {
        return res.status(422).json({
          error: 'Matriz inválida',
          detail: 'No se extrajeron filas válidas (Atributo, Categoria, Peso)'
        });
      }

      // Filtro crítico/antifraude
      const matrix = ONLY_CRITICAL ? rawMatrix.filter(isCriticalOrAntifraud) : rawMatrix;

      if (ONLY_CRITICAL && matrix.length === 0) {
        return res.status(400).json({
          error: 'Matriz sin criterios críticos/antifraude',
          detail: 'La matriz quedó vacía tras filtrar; revisa Criticidad/Tipo/Categoría/Peso y tus keywords del .env'
        });
      }

      // --- 2) Transcripción
      const audioFile = req.files.audio[0];
      let transcript = s(req.body.transcript);
      if (!transcript) {
        transcript = await transcribeAudio(
          audioFile.buffer,
          audioFile.originalname,
          language,
          { provider, mode, agentChannel }
        );
      }

      // --- 2.1 Transcripción con tiempos/roles (MONO, heurística)
      let transcriptMarked = '';
      if (transcript && typeof transcript === 'object') {
        if (Array.isArray(transcript.linesRoleLabeled) && transcript.linesRoleLabeled.length > 0) {
          transcriptMarked = transcript.linesRoleLabeled.join('\n');
        } else if (Array.isArray(transcript.segments) && transcript.segments.length > 0) {
          const lines = formatTranscriptLinesMono(transcript.segments);
          transcriptMarked = lines.join('\n');
        }
      }

      // Texto crudo para heurísticas
      const transcriptText = typeof transcript === 'object'
        ? [transcript.text || '', transcriptMarked || ''].join('\n')
        : String(transcript || '');

      // --- 3) Prompt por campaña + reglas de aplicabilidad (para el LLM)
      let analysisPrompt = '';

      const reglasAplicabilidad = `
REGLAS DE APLICABILIDAD:
- "Realiza el proceso completo de confirmación de la negociación":
  APLICA=TRUE solo si existe ACUERDO explícito con (monto + fecha/plazo + medio de pago + recapitulación verbal).
  Si falta cualquiera => APLICA=FALSE (No Aplica) y NO se penaliza.

- "Debate objeciones en función de la situación del cliente":
  APLICA=TRUE solo si hay OBJECIÓN/RESISTENCIA real (no puedo, desempleado, muy caro, más adelante, ya pagué, no confío...).
  Si no hay objeción => APLICA=FALSE (No Aplica).

- "Solicita autorización para contactarlo por diferentes medios":
  APLICA=TRUE solo si se evidencia una solicitud de consentimiento explícita (p. ej. “¿me autoriza a contactarle por WhatsApp/correo/SMS?”).
  Si no hay esa solicitud clara => APLICA=FALSE (No Aplica).

- "Usa guion establecido por la campaña (completo)":
  APLICA=TRUE cuando el flujo está completo (saludo/presentación + aviso de grabación + alternativas + negociación u objeciones).
  Si la gestión queda exploratoria y/o se deriva a WhatsApp sin negociación/objeciones => APLICA=FALSE.

- "Llamadas de recordatorio":
  Si la llamada es un RECORDATORIO y NO hay negociación cerrada ni consentimiento explícito, entonces:
    • "Confirmación de la negociación" => APLICA=FALSE.
    • "Autorización para contactarlo por diferentes medios" => APLICA=FALSE.
Devuelve por atributo: { atributo, aplica: true|false, status: "OK"|"NA", cumplido: true|false|null, justificacion, mejora }.
${STRICT_APPLICA ? 'POLÍTICA ESTRICTA: Asume aplica=false salvo evidencia textual explícita.' : ''}
`.trim();

      if (metodologia === 'cobranza') {
        if (cartera === 'carteras_bogota') {
          analysisPrompt =
            'Analiza la auditoría de la cartera Bogotá con criterios de gestión jurídica/extrajudicial, negociación clara, objeciones frecuentes y cierre formal.';
        } else if (cartera === 'carteras_medellin') {
          analysisPrompt =
            'Analiza la auditoría de la cartera Medellín considerando formalidad, perfilamiento, alternativas de pago y manejo de objeciones.';
        }
      }
      analysisPrompt = [analysisPrompt, reglasAplicabilidad].filter(Boolean).join('\n\n');
      if (ONLY_CRITICAL) {
        analysisPrompt += '\nREGLA: Reporta solo ERRORES CRÍTICOS y ALERTAS ANTIFRAUDE.';
      }

      // --- 4) Análisis LLM
      const analysis = await analyzeTranscriptWithMatrix({
        transcript,
        matrix,
        prompt: analysisPrompt,
        context: { metodologia, cartera, onlyCritical: ONLY_CRITICAL, strictAplica: STRICT_APPLICA }
      });

      // --- 4.b Guard-rails deterministas (independientes del LLM)
      const evidence = {
        negotiation: hasNegotiationEvidence(transcriptText),
        objections:  hasObjectionEvidence(transcriptText),
        whatsapp:    RE_WHATS.test(transcriptText),
        probe:       hasProbeEvidence(transcriptText),
        recording:   hasRecordingDisclosure(transcriptText),
        alternatives:hasAlternativesEvidence(transcriptText),
        beneCons:    hasBenefitsConsequences(transcriptText),
        consent:     hasConsentEvidence(transcriptText),
        fullScript:  hasFullScriptFlow(transcriptText),
        reminder:    hasReminderEvidence(transcriptText) // NUEVO
      };

      // Construimos lista de atributos NO APLICAN por reglas duras
      const forceNA = new Set();
      matrix.forEach(row => {
        const attr = s(row.atributo || row.Atributo);
        if (!attr) return;

        const aNeg  = isAttr(row, 'confirmacion de la negociacion') || isAttr(row,'confirmación de la negociación');
        const aObj  = isAttr(row, 'objeciones');
        const aGui  = isAttr(row, 'guion establecido') || isAttr(row,'guión establecido');
        const aCons = isAttr(row, 'autorización para contactarlo') || isAttr(row, 'autorizacion para contactarlo') ||
                      isAttr(row, 'autorización para contactarse') || isAttr(row, 'autorizacion para contactarse');

        if (aNeg && !evidence.negotiation) forceNA.add(attr);
        if (aObj && !evidence.objections)  forceNA.add(attr);
        if (aCons && !evidence.consent)    forceNA.add(attr);
        if (aGui && !evidence.fullScript)  forceNA.add(attr);
      });

      // Regla auxiliar A: si NO hay negociación y SÍ hay continuidad por WhatsApp → NA en negociación/objeciones/consentimiento
      if (!evidence.negotiation && evidence.whatsapp) {
        matrix.forEach(row => {
          const name = String(row.atributo || row.Atributo || '').trim();
          const n = name.toLowerCase();
          if (/confirmaci[oó]n de la negociaci[oó]n/.test(n) || /objeciones/.test(n) || /autorizaci[oó]n .*contact(ar|arse)/.test(n)) {
            forceNA.add(name);
          }
        });
      }

      // *** Regla auxiliar B (NUEVA): llamada de RECORDATORIO ***
      // Si es recordatorio y no hay negociación cerrada ni consentimiento explícito,
      // los ítems (2) Confirmación negociación y (4) Autorización otros medios => NA
      if (evidence.reminder) {
        matrix.forEach(row => {
          const name = String(row.atributo || row.Atributo || '').trim();
          const n = name.toLowerCase();
          const isConfirm = /confirmaci[oó]n de la negociaci[oó]n/.test(n);
          const isConsent = /autorizaci[oó]n .*contact(ar|arse)/.test(n);
          if (isConfirm && !evidence.negotiation) forceNA.add(name);
          if (isConsent && !evidence.consent)     forceNA.add(name);
        });
      }

      // === Propagar NA también a analysis.atributos y porAtributo ===
      const forceNaNames = new Set(Array.from(forceNA.values()).map(n => n.toLowerCase()));
      const toNaObj = (it, msg) => ({
        ...it,
        aplica: false,
        status: 'NA',
        ...(typeof it?.cumplido === 'boolean' ? {} : { cumplido: null }),
        justificacion: it?.justificacion || (msg || 'No Aplica por evidencia determinista (no se cumplen condiciones de activación).')
      });

      // 4.b.1) sobre analysis.atributos
      if (Array.isArray(analysis?.atributos)) {
        analysis.atributos = analysis.atributos.map(it => {
          const name = String(it?.atributo || '').toLowerCase();
          if (forceNaNames.has(name)) return toNaObj(it);
          return it;
        });
      }

      // 4.b.2) STRICT_APPLICA: cualquier atributo SIN aplica=true explícito pasa a NA
      if (STRICT_APPLICA && Array.isArray(analysis?.atributos)) {
        analysis.atributos = analysis.atributos.map(it => {
          if (it?.aplica === true) return it;
          return toNaObj(it, 'No Aplica (política estricta: sin evidencia textual clara).');
        });
      }

      // 4.b.3) mantener también la versión porAtributo
      if (Array.isArray(analysis?.porAtributo)) {
        analysis.porAtributo = analysis.porAtributo.map(it => {
          const name = String(it?.atributo || '').toLowerCase();
          if (forceNaNames.has(name)) return toNaObj(it);
          if (STRICT_APPLICA && it?.aplica !== true) return toNaObj(it, 'No Aplica (política estricta: sin evidencia textual clara).');
          return it;
        });
      }

      // === 4.c Matriz/atributos a considerar en el scoring ===
      const naFromLLM = new Set(
        (analysis?.porAtributo || [])
          .filter(x => x && (x.aplica === false || String(x.status || '').toUpperCase() === 'NA'))
          .map(x => s(x.atributo))
      );
      const matrixForScore = matrix.filter(row => {
        const name = s(row.atributo || row.Atributo);
        return !forceNA.has(name) && !naFromLLM.has(name);
      });

      // === 4.d Hallazgos: conservar los del LLM y añadir fallback si está vacío ===
      const llmHall = Array.isArray(analysis?.hallazgos) ? analysis.hallazgos.slice() : [];
      const autoHall = [];
      if (evidence.recording)      autoHall.push('Se informó la grabación y monitoreo (Ley 1581).');
      if (evidence.alternatives)   autoHall.push('Se ofrecieron alternativas de pago (contado / cuotas / descuento).');
      if (evidence.probe)          autoHall.push('Se indagó por motivo/estado actual del titular.');
      if (evidence.beneCons)       autoHall.push('Se comunicaron beneficios y/o consecuencias del (no) pago.');
      if (evidence.objections)     autoHall.push('Se presentaron objeciones del titular.');
      if (evidence.negotiation)    autoHall.push('Se concretó un acuerdo con monto/fecha/medio y recapitulación.');
      if (evidence.whatsapp && !evidence.negotiation) autoHall.push('Se dejó continuidad por WhatsApp sin concretar negociación.');
      if (evidence.consent)        autoHall.push('Se solicitó autorización para futuros contactos por otros medios.');
      if (evidence.fullScript)     autoHall.push('Se siguió el guion completo de la campaña.');
      if (evidence.reminder)       autoHall.push('Llamada de recordatorio (no orientada a negociar en el mismo contacto).');

      const hallSet = new Set(llmHall.map(s));
      autoHall.forEach(h => { if (!hallSet.has(s(h))) hallSet.add(h); });
      analysis.hallazgos = Array.from(hallSet);

      // (Opcional) nombres detectados por LLM, luego corregimos si vienen en el form
      const llmAgent  = typeof analysis?.agent_name  === 'string' ? analysis.agent_name.trim()  : '';
      const llmClient = typeof analysis?.client_name === 'string' ? analysis.client_name.trim() : '';

      // --- 5) Resolución de nombres
      let finalAgentName    = formAgent  || llmAgent;
      let finalCustomerName = formClient || llmClient;

      if (!finalAgentName || !finalCustomerName) {
        try {
          const guessed = await extractNames({ summary: analysis?.resumen || '', transcript });
          if (!finalAgentName && guessed.agent)     finalAgentName    = guessed.agent;
          if (!finalCustomerName && guessed.client) finalCustomerName = guessed.client;
        } catch (e) {
          if (process.env.DEBUG_NAME === '1') {
            console.warn('[analyze.route][names][WARN]', e?.message || e);
          }
        }
      }
      if (!finalAgentName)    finalAgentName    = '-';
      if (!finalCustomerName) finalCustomerName = '-';

      // --- 6) Scoring (con matriz filtrada)
      const scoring = scoreFromMatrix(analysis, matrixForScore);

      // === 6.b Afectados críticos y NA desde el SCORING (para el front)
      const afectadosCriticos = (scoring?.porAtributo || [])
        .filter(a => a && a.aplica !== false && a.critico && a.cumplido === false)
        .map(a => a.atributo);

      const noAplican = (scoring?.porAtributo || [])
        .filter(a => a && (a.aplica === false || String(a.status||'').toUpperCase()==='NA'))
        .map(a => a.atributo);

      if (!analysis) analysis = {};
      analysis.afectadosCriticos = afectadosCriticos;
      analysis.noAplican = noAplican;

      scoring.afectadosCriticos = afectadosCriticos;
      scoring.noAplican = noAplican;

      // --- 7) Reporte .md
      const reportDir = path.resolve('reports');
      if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

      const reportPath = path.join(reportDir, `${callId}.md`);
      const autoNA = Array.from(forceNA.values());
      const md = [
        `# Informe de Calidad — ${callId}`,
        '',
        `**Agente:** ${finalAgentName}`,
        `**Cliente:** ${finalCustomerName}`,
        `**Idioma:** ${language}`,
        `**Canal:** ${channel}`,
        `**Proveedor ASR:** ${provider || '(default .env)'}`,
        `**Nota Final:** ${scoring.notaFinal}/100`,
        '',
        '## Resumen',
        analysis?.resumen || '(sin resumen)',
        '',
        '## Transcripción (tiempos y rol)',
        transcriptMarked || '(no disponible con este proveedor)',
        '',
        '## Atributos NO APLICAN (auto)',
        (autoNA.length ? autoNA.map(a => `- ${a}`).join('\n') : '—'),
        '',
        '## Afectados (críticos, desde scoring)',
        (afectadosCriticos.length ? afectadosCriticos.map(a => `- ${a}`).join('\n') : '—'),
        '',
        '## Hallazgos',
        (analysis?.hallazgos || []).map(h => `- ${h}`).join('\n') || '- (sin hallazgos)',
        '',
        '## Atributos evaluados',
        (scoring?.porAtributo || [])
          .map(a => {
            const isNA = String(a?.status || '').toUpperCase() === 'NA' || a?.aplica === false;
            const badge = isNA ? 'NA' : (a.cumplido ? '✅' : '❌');
            return `- ${a.atributo} [${badge}] peso ${a.peso}${a?.mejora ? ' | Mejora: ' + a.mejora : ''}${a?.justificacion ? ' — ' + a.justificacion : ''}`;
          })
          .join('\n') || '- (sin atributos procesados)'
      ].join('\n');
      fs.writeFileSync(reportPath, md, 'utf-8');

      // --- 8) Persistencia
      const audit = {
        metadata: {
          callId,
          agentName:    finalAgentName,
          customerName: finalCustomerName,
          language,
          channel,
          provider: provider || '(default .env)',
          metodologia,
          cartera,
          timestamp: Date.now(),
          onlyCritical: ONLY_CRITICAL ? 1 : 0
        },
        transcript,
        transcriptMarked,
        analisis: analysis,
        consolidado: scoring,
        reportPath
      };

      const savedPath = saveAudit(audit);

      // --- 9) Respuesta
      return res.json({ ...audit, savedPath });
    } catch (err) {
      console.error('[ANALYZE][ERROR]', err);
      return res.status(500).json({
        error: 'Error interno',
        detail: err?.message || String(err),
        hint: 'Revisa .env (API key / FW_SERVER_URL), formatos de archivos y conectividad'
      });
    }
  }
);

export default router;
