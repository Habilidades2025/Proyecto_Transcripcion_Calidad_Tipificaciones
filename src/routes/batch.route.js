// src/routes/batch.route.js
import expressPkg from 'express';
const express = expressPkg.default ?? expressPkg;

import multerPkg from 'multer';
const multer = multerPkg.default ?? multerPkg;

import { EventEmitter } from 'events';

import fs from 'fs';
import path from 'path';

import { parseMatrixFromXlsx } from '../services/matrixService.js';
import { transcribeAudio, formatTranscriptLinesMono } from '../services/transcriptionService.js';
import { analyzeTranscriptWithMatrix } from '../services/analysisService.js';
import { scoreFromMatrix } from '../services/scoringService.js';
import { saveAudit } from '../services/persistService.js';

// ---- Multer (memoria)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.BATCH_MAX_FILE_SIZE || 100 * 1024 * 1024) } // 100MB c/u
});

// ---- Router
const router = express.Router();

// ---- Store de jobs en memoria
// job: { id, status: 'queued'|'running'|'done'|'error', total, done, items:[{name,status,callId,meta?}], em:EE, group?:{} }
const jobs = new Map();

// ---- Paths para reportes de lotes
const REPORTS_BATCH_DIR = path.resolve('reports', 'batches');

// ---- Helpers
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function makeJobId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function payload(job) { return { status: job.status, total: job.total, done: job.done, items: job.items, group: job.group ?? null }; }
function notify(job) { job.em?.emit('progress', payload(job)); }
function toNum(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }
function cleanName(x = '') { return String(x).trim().replace(/^(señor(?:a)?|sr\.?|sra\.?|srta\.?|don|doña)\s+/i, '').trim(); }

// === Config filtro SOLO críticos/antifraude (consistente con /analyze)
const ONLY_CRITICAL = String(process.env.ANALYZE_ONLY_CRITICAL || '0') !== '0';
const envCsv = (name, fb='') => String(process.env[name] ?? fb).split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
function isCriticalOrAntifraud(row) {
  const s = (v)=>String(v??'').trim().toLowerCase();
  const criterio  = s(row?.criterio);
  const categoria = s(row?.categoria ?? row?.Categoría);
  const tipo      = s(row?.tipo ?? row?.Tipo);
  const peso      = Number(row?.peso ?? row?.Peso ?? row?.PESO ?? 0);
  const byWeight  = String(process.env.CRITICAL_BY_WEIGHT ?? '1') !== '0';
  const thr       = Number(process.env.CRITICAL_WEIGHT_VALUE ?? process.env.CRITICAL_WEIGHT_THRESHOLD ?? 100);
  const nameKw    = envCsv('CRITICAL_NAME_KEYWORDS','tratamiento de datos,habeas data,autorización datos,consentimiento,legal,ley 1581');
  const catKw     = envCsv('CRITICAL_CATEGORY_KEYWORDS','crítico,critico,legal,obligatorio,compliance');
  const nonKw     = envCsv('NONCRITICAL_HINT_WORDS','opcional,no obligatorio,preferible,ideal');

  if (row?.critico === true)  return true;
  if (row?.critico === false) return false;
  if (nonKw.some(w => criterio.includes(w))) return false;
  if (catKw.some(w => categoria.includes(w))) return true;
  if (nameKw.some(w => s(row?.atributo ?? row?.Atributo).includes(w))) return true;
  if (byWeight && Number.isFinite(peso) && peso >= thr) return true;

  const esAF = ['antifraude','anti-fraude','alerta antifraude','alertas antifraude']
    .some(k => tipo.includes(k) || categoria.includes(k));
  return esAF;
}

// Criticidad de atributos (para compactación)
function isCritical(attr) {
  if (!attr || typeof attr !== 'object') return false;
  if (typeof attr.critico === 'boolean') return attr.critico;
  const cat = String(attr.categoria || attr.category || '').toLowerCase();
  if (cat.includes('crítico') || cat.includes('critico')) return true;
  const thr = Number(process.env.CRITICAL_WEIGHT_THRESHOLD ?? 10);
  const peso = Number(attr.peso);
  return Number.isFinite(peso) && peso >= thr;
}

// Compacta lo que enviaremos al front (añadimos transcriptMarked y nota robusta)
function compactAuditForFront(audit) {
  const afectNoCrit = [];
  const afectCrit   = [];
  const porAtrib = Array.isArray(audit?.consolidado?.porAtributo) ? audit.consolidado.porAtributo : [];
  for (const a of porAtrib) {
    if (a?.cumplido === false) {
      (isCritical(a) ? afectCrit : afectNoCrit).push(a.atributo || a.nombre || '(sin nombre)');
    }
  }

  // Alertas fraude -> texto breve para UI
  const alertasFraude = Array.isArray(audit?.analisis?.fraude?.alertas)
    ? audit.analisis.fraude.alertas.map(x => {
        const tipo = String(x?.tipo || '').replace(/_/g, ' ');
        const riesgo = String(x?.riesgo || 'alto');
        const cita = String(x?.cita || '').trim();
        return `[${riesgo}] ${tipo}${cita ? ` — "${cita}"` : ''}`;
      })
    : [];

  const notaFinal = Number(audit?.consolidado?.notaFinal);
  const notaSafe = Number.isFinite(notaFinal) ? Math.round(notaFinal) : null;

  return {
    callId: audit?.metadata?.callId || '',
    timestamp: audit?.metadata?.timestamp || Date.now(),
    agente: audit?.metadata?.agentName || audit?.analisis?.agent_name || '-',
    cliente: audit?.metadata?.customerName || audit?.analisis?.client_name || '-',
    nota: notaSafe,
    resumen: audit?.analisis?.resumen || '',
    hallazgos: Array.isArray(audit?.analisis?.hallazgos) ? audit.analisis.hallazgos : [],
    sugerencias: Array.isArray(audit?.analisis?.sugerencias_generales) ? audit.analisis.sugerencias_generales : [],
    afectadosNoCriticos: afectNoCrit,
    afectadosCriticos: afectCrit,
    alertasFraude,
    transcriptMarked: audit?.transcriptMarked || ''
  };
}

// Calcula resumen grupal del bloque + plan de mejora + TOP fraude
function buildGroupSummary(itemsCompact) {
  const total = itemsCompact.length || 0;
  const promedio = total ? Math.round(itemsCompact.reduce((acc, it) => acc + toNum(it.nota), 0) / total) : 0;

  const hallFreq = new Map();
  const sugFreq  = new Map();
  const critMap  = new Map();
  const fraudeMap = new Map();

  for (const it of itemsCompact) {
    (it.hallazgos || []).forEach(h => hallFreq.set(h, (hallFreq.get(h) || 0) + 1));
    (it.sugerencias || []).forEach(s => sugFreq.set(s, (sugFreq.get(s) || 0) + 1));
    (it.afectadosCriticos || []).forEach(a => critMap.set(a, (critMap.get(a) || 0) + 1));
    (it.alertasFraude || []).forEach(f => {
      const k = String(f).trim();
      if (!k) return;
      fraudeMap.set(k, (fraudeMap.get(k) || 0) + 1);
    });
  }

  const top = (m, n = 10) => Array.from(m.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`);

  const topHallazgos   = top(hallFreq, 10);
  const topSugerencias = top(sugFreq, 10);
  const topCriticos    = top(critMap, 10);
  const fraudeAlertasTop = top(fraudeMap, 10);

  const resumenGrupo = [
    `Se auditaron ${total} llamadas.`,
    `La nota promedio del bloque fue ${promedio}/100.`,
    topCriticos.length
      ? `Atributos críticos más afectados: ${topCriticos.slice(0, 5).join(', ')}.`
      : `Sin atributos críticos recurrentes.`,
    fraudeAlertasTop.length ? `Se detectaron alertas de posible fraude en varias llamadas (ver Top).` : ''
  ].filter(Boolean).join(' ');

  const planMejora = [
    (topSugerencias.length ? `Refuerzo general sugerido: ${topSugerencias.slice(0,5).join(' · ')}.` : ''),
    (topCriticos.length ? `Enfoque inmediato en atributos críticos: ${topCriticos.slice(0,5).join(', ')}.` : '')
  ].filter(Boolean).join('\n');

  return {
    total,
    promedio,
    resumen: resumenGrupo,
    topHallazgos,
    atributosCriticos: topCriticos.map(s => s.replace(/\s+\(\d+\)$/, '')),
    planMejora,
    fraudeAlertasTop
  };
}

// Construye el Markdown del bloque (para /reports/batches/<jobId>.md)
function buildBatchMarkdown(jobId, group, itemsCompact) {
  const lines = [];
  lines.push(`# Informe de Bloque — ${jobId}`);
  lines.push('');
  lines.push(`**Total llamadas:** ${group.total}  `);
  lines.push(`**Promedio:** ${group.promedio}/100  `);
  lines.push('');
  lines.push(`## Resumen del Bloque`);
  lines.push(group.resumen || '—');
  lines.push('');
  if (group.planMejora) {
    lines.push('## Plan de Mejora Propuesto');
    lines.push(group.planMejora);
    lines.push('');
  }
  if ((group.topHallazgos || []).length) {
    lines.push('## Hallazgos Recurrentes (Top)');
    for (const h of group.topHallazgos) lines.push(`- ${h}`);
    lines.push('');
  }
  if ((group.atributosCriticos || []).length) {
    lines.push('## Atributos Críticos más afectados');
    for (const a of group.atributosCriticos) lines.push(`- ${a}`);
    lines.push('');
  }
  if ((group.fraudeAlertasTop || []).length) {
    lines.push('## Alertas de fraude (grupo)');
    for (const f of group.fraudeAlertasTop) lines.push(`- ${f}`);
    lines.push('');
  }
  lines.push('## Detalle por Llamada (resumen breve)');
  for (const it of itemsCompact) {
    const fecha = it.timestamp ? new Date(it.timestamp).toLocaleString() : '';
    lines.push(`### ${it.callId || '(sin id)'} — Nota ${toNum(it.nota)}/100`);
    lines.push(`**Fecha:** ${fecha}  `);
    lines.push(`**Agente:** ${it.agente || '-'}  `);
    lines.push(`**Cliente:** ${it.cliente || '-'}  `);
    if (it.resumen) { lines.push(''); lines.push(it.resumen); lines.push(''); }
    if ((it.hallazgos || []).length) {
      lines.push('**Hallazgos:**');
      for (const h of it.hallazgos) lines.push(`- ${h}`);
      lines.push('');
    }
    const c  = (it.afectadosCriticos || []).join(', ');
    lines.push(`**Afectados críticos:** ${c || '—'}`);
    const af = (it.alertasFraude || []).join(' • ');
    lines.push(`**Alertas de fraude:** ${af || '—'}`);
    lines.push('');
  }
  return lines.join('\n');
}

const MAX_SCRIPT_CHARS = Number(process.env.MAX_SCRIPT_CHARS || 8000);

// ---- POST /batch/start
router.post(
  '/batch/start',
  upload.fields([
    { name: 'matrix',  maxCount: 1 },
    { name: 'audios',  maxCount: Number(process.env.BATCH_MAX_FILES || 2000) },
    { name: 'script',  maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      if (!req.files?.matrix?.[0] || !req.files?.audios?.length) {
        return res.status(400).json({ error: 'Adjunta "matrix" (.xlsx) y al menos un archivo en "audios"' });
      }

      // 1) Parse matriz (+ filtro solo críticos/AF si aplica)
      const matrixBuf = req.files.matrix[0].buffer;
      const rawMatrix = parseMatrixFromXlsx(matrixBuf);
      if (!Array.isArray(rawMatrix) || rawMatrix.length === 0) {
        return res.status(422).json({ error: 'Matriz inválida o vacía' });
      }
      const matrix = ONLY_CRITICAL ? rawMatrix.filter(isCriticalOrAntifraud) : rawMatrix;
      if (ONLY_CRITICAL && matrix.length === 0) {
        return res.status(400).json({ error: 'La matriz quedó vacía tras filtrar a críticos/antifraude' });
      }

      // 1.b) Leer GUION (opcional)
      let scriptText = '';
      try {
        const buf = req.files?.script?.[0]?.buffer;
        if (buf && buf.length) {
          scriptText = buf.toString('utf-8').replace(/\s+/g, ' ').trim();
          if (scriptText.length > MAX_SCRIPT_CHARS) {
            scriptText = scriptText.slice(0, MAX_SCRIPT_CHARS) + ' ...';
          }
        }
      } catch {}

      // 2) Crear job
      const jobId = makeJobId();
      const job = {
        id: jobId,
        status: 'queued',
        total: req.files.audios.length,
        done: 0,
        items: req.files.audios.map(f => ({ name: f.originalname, status: 'pending' })),
        em: new EventEmitter(),
        group: null
      };
      jobs.set(jobId, job);

      // 3) Responder con el jobId
      res.json({ jobId });

      // 4) Procesamiento en background
      setImmediate(async () => {
        job.status = 'running';
        notify(job);

        const language     = String(req.body.language || 'es-ES');
        const channel      = String(req.body.channel  || 'voz');
        const provider     = String(req.body.provider || '').trim().toLowerCase();
        const mode         = String(req.body.mode || '').trim().toLowerCase();
        const agentChannel = Number.isFinite(Number(req.body.agentChannel)) ? Number(req.body.agentChannel) : undefined;
        const metodologia  = String(req.body.metodologia || '');
        const cartera      = String(req.body.cartera || '');

        // Prompt base por campaña + refuerzo only-critical
        const baseCampaignPrompt =
          (metodologia === 'cobranza' && cartera === 'carteras_bogota')
            ? [
                'Analiza la auditoría para Carteras Propias Bogotá siguiendo lineamientos de negociación, objeciones y formalidad.',
                'Reglas específicas:',
                '- Informa al cliente beneficios y consecuencias de no pago Objetivo del criterio: Verificar que el agente eduque al titular explicando, en la misma llamada, al menos 1 beneficio de pagar a tiempo y al menos 1 consecuencia de no pagar. El foco es educación financiera, no solo “venta” de la alternativa. Regla de decisión CUMPLE (APLICA=TRUE) si se detecta evidencia textual de ambos: Beneficio(s) de pagar a tiempo / mantenerse al día (≥1) Consecuencia(s) de no pagar / incurrir en mora (≥1) NO CUMPLE (APLICA=TRUE) si: Menciona solo beneficios o solo consecuencias (falta una de las dos partes). Se limita a pedir pago/confirmar pago sin educación financiera (no hay beneficios/consecuencias). Presenta “beneficios del descuento u oferta” (ej.: “pagaría menos”, “le queda en X”) sin explicar beneficios de la conducta de pago (historial, paz y salvo, etc.). NO APLICA (APLICA=FALSE) si: La llamada es solo recordatorio de un compromiso previo (no se abrió espacio para educación). El cliente cuelga / corta o no permite continuidad impidiendo dar la explicación. La gestión es exclusivamente técnica (p. ej., verificación de datos / envío de soporte) sin ventana para educación.',
                '- Cobro escalonado (CUMPLE) solo si se evidencia esta secuencia en la conversación: Primera oferta de un monto base equivalente al total u obligación sin descuento (el agente puede expresarlo como “valor total”, “saldo completo”, “valor original”, “monto sin descuento”, “lo que aparece en sistema”, “lo que figura en cartera”, “el valor completo de la deuda”, etc.; no es obligatorio que diga “capital”). Al menos una alternativa posterior con descuento explícito (el agente puede decir “descuento”, “rebaja”, “condonación parcial”, “pagar menos que el total”, “quedaría en…”, “se lo dejo en…”, “podría cancelarlo por…”), dejando claro que el segundo monto es inferior al monto base. Marca NO APLICA si: Solo se ofrece un plan en cuotas (mismo total prorrateado) sin reducción del total. Se menciona un monto “más bajo” sin relacionarlo con el total u obligación inicial. Hay descuento pero no se presentó antes un monto base sin descuento. Para CUMPLE, exige evidencia textual de ambos elementos: (a) primera oferta base (sin descuento) y (b) oferta posterior con descuento, en ese orden.',
                '- Debate objeciones: CUMPLE si el agente identifica la situación y propone alternativa alineada.'
              ].join('\n')
            : (metodologia === 'cobranza' && cartera === 'carteras_medellin')
              ? 'Analiza la auditoría de la cartera Medellín siguiendo lineamientos de negociación, objeciones y formalidad.'
              : '';

        const promptParts = [baseCampaignPrompt];
        if (ONLY_CRITICAL) {
          promptParts.push('REGLA: Ignora totalmente afectaciones NO críticas. Reporta únicamente ERRORES CRÍTICOS y ALERTAS ANTIFRAUDE.');
        }
        if (scriptText) {
          promptParts.push('Guion de la campaña (extracto, usar para validar "uso de guion" y consistencia):\n' + scriptText);
        }
        const finalPrompt = promptParts.filter(Boolean).join('\n\n');

        const compactList = [];

        for (let i = 0; i < req.files.audios.length; i++) {
          const f = req.files.audios[i];
          try {
            // a) Transcribir
            const transcript = await transcribeAudio(
              f.buffer,
              f.originalname,
              language,
              { provider, mode, agentChannel }
            );

            // a.1) Transcripción marcada (mm:ss Rol: …) para MONO
            let transcriptMarked = '';
            if (transcript && typeof transcript === 'object') {
              if (Array.isArray(transcript.linesRoleLabeled) && transcript.linesRoleLabeled.length) {
                transcriptMarked = transcript.linesRoleLabeled.join('\n');
              } else if (Array.isArray(transcript.segments) && transcript.segments.length) {
                transcriptMarked = formatTranscriptLinesMono(transcript.segments).join('\n');
              }
            }

            // b) Analizar
            const analysis = await analyzeTranscriptWithMatrix({
              transcript,
              matrix,
              prompt: finalPrompt,
              context: { metodologia, cartera, onlyCritical: ONLY_CRITICAL }
            });
            // c) Scoring
            const scoring = scoreFromMatrix(analysis, matrix);

            // d) Persistir
            const callId = `${Date.now()}_${i + 1}`;
            const agentName    = cleanName(analysis?.agent_name || '');
            const customerName = cleanName(analysis?.client_name || '');
            const audit = {
              metadata: {
                callId,
                agentName:    agentName || '-',
                customerName: customerName || '-',
                language,
                channel,
                provider: provider || '(default .env)',
                metodologia,
                cartera,
                timestamp: Date.now(),
                onlyCritical: ONLY_CRITICAL ? 1 : 0
              },
              transcript,
              transcriptMarked, // se guarda en la auditoría
              analisis: {
                ...analysis,
                agent_name:  agentName || '',
                client_name: customerName || ''
              },
              consolidado: scoring
            };
            saveAudit(audit);

            // e) Compact para front (incluyendo transcriptMarked)
            const compact = compactAuditForFront(audit);
            job.items[i] = { name: f.originalname, status: 'done', callId, meta: compact };
            compactList.push(compact);

            job.done += 1;
            notify(job);
          } catch (err) {
            job.items[i] = { name: f.originalname, status: 'error', error: err?.message || String(err) };
            job.done += 1;
            notify(job);
          }
        }

        // Resumen grupal + Reporte de bloque
        job.group = buildGroupSummary(compactList);
        try {
          ensureDir(REPORTS_BATCH_DIR);
          const md = buildBatchMarkdown(job.id, job.group, compactList);
          fs.writeFileSync(path.join(REPORTS_BATCH_DIR, `${job.id}.md`), md, 'utf-8');
        } catch (e) {
          console.warn('[BATCH][report][WARN]', e?.message || e);
        }

        job.status = 'done';
        notify(job);
      });
    } catch (e) {
      console.error('[BATCH][start][ERROR]', e);
      return res.status(500).json({ error: e?.message || String(e) });
    }
  }
);

// ---- SSE /batch/progress/:jobId
router.get('/batch/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders?.();

  const send = (data) => {
    res.write(`event: progress\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!job) {
    send({ status: 'error', total: 0, done: 0, items: [], error: 'job not found' });
    return res.end();
  }

  send(payload(job));

  const onProgress = (data) => send(data);
  job.em.on('progress', onProgress);

  req.on('close', () => {
    job.em.off('progress', onProgress);
    res.end();
  });
});

// ---- Resultado compacto del lote (para pintar UI final)
router.get('/batch/result/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const items = (job.items || []).map(it => ({
    name: it.name,
    status: it.status,
    callId: it.callId || null,
    meta: it.meta || null
  }));

  res.json({
    jobId: job.id,
    status: job.status,
    total: job.total,
    done: job.done,
    items,
    group: job.group || null
  });
});

export default router;
