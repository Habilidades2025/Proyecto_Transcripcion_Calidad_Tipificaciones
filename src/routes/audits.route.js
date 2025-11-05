// src/routes/audits.route.js
import expressPkg from 'express';
const express = (expressPkg.default ?? expressPkg);

import fs from 'fs';
import path from 'path';

import xlsxPkg from 'xlsx'; // XLSX para generar Excel
const XLSX = (xlsxPkg?.default ?? xlsxPkg);

import {
  listAudits,
  summaryAudits,
  listAuditsPage,
  listBatches,
  resolveReportFile,
  getBatchReportPath,
} from '../services/persistService.js';

const router = express.Router();

// === Paths base (por si luego quieres materializar MDs)
const REPORTS_DIR       = path.resolve('reports');
const REPORTS_CALL_DIR  = path.join(REPORTS_DIR, 'calls');
const REPORTS_BATCH_DIR = path.join(REPORTS_DIR, 'batches');

// === Helpers ===
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function toInt(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function basenameNoExt(s='') { return String(s).replace(/\.[a-z0-9]{1,4}$/i,''); }

function ddmmyyyyFromISO(dateStr='') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}
const BLANK_RE = /^[\s\u00A0\u200B\u200C\u200D\uFEFF]*$/;
function sanitizeMaybeBlank(v) {
  if (v == null) return undefined;
  if (typeof v === 'string') {
    const t = v.replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, ' ').trim();
    return t.length ? t : undefined;
  }
  return v;
}

// === TZ consistente con persistService
const FILES_TZ = process.env.FILES_TZ || process.env.TZ || 'America/Bogota';
function toTzDate(dateLike) {
  const base = dateLike ? new Date(dateLike) : new Date();
  return new Date(base.toLocaleString('en-US', { timeZone: FILES_TZ }));
}
function getYMD(ts) {
  const d = toTzDate(ts);
  return { yyyy: d.getFullYear(), mm: `${d.getMonth()+1}`.padStart(2,'0'), dd: `${d.getDate()}`.padStart(2,'0') };
}
function matchesYMD(ts, y, m, d) {
  if (!y && !m && !d) return true;
  const { yyyy, mm, dd } = getYMD(ts);
  if (y && String(yyyy) !== String(y)) return false;
  if (m && String(mm).padStart(2,'0') !== String(m).padStart(2,'0')) return false;
  if (d && String(dd).padStart(2,'0') !== String(d).padStart(2,'0')) return false;
  return true;
}

// consolidado seguro: raíz -> analisis.consolidado -> {}
function getConsolidado(audit) {
  const an = audit?.analisis || {};
  return audit?.consolidado || an?.consolidado || {};
}

function isCritical(attr) {
  if (!attr || typeof attr !== 'object') return false;
  if (typeof attr.critico === 'boolean') return attr.critico;
  const cat = String(attr.categoria || attr.category || '').toLowerCase();
  if (cat.includes('crítico') || cat.includes('critico')) return true;
  const thr = Number(process.env.CRITICAL_WEIGHT_THRESHOLD ?? 10);
  const peso = Number(attr.peso);
  return Number.isFinite(peso) && peso >= thr;
}

function splitAffected(consolidado) {
  const arr = Array.isArray(consolidado?.porAtributo) ? consolidado.porAtributo : [];
  const incumplidos = arr.filter(a => a && a.aplica === true && a.cumplido === false);
  const criticos = [], noCriticos = [];
  for (const a of incumplidos) {
    const nombre = a?.atributo || a?.nombre || '(sin nombre)';
    (isCritical(a) ? criticos : noCriticos).push(nombre);
  }
  return { criticos, noCriticos };
}

/* ===== Parseo de nombre de archivo =====
   Esperado: DOC_ASESOR_YYYY-MM-DD_HH_MM_SS_NUMCLIENTE_TMO
   Ej: "52848062_2025-10-01_10_16_33_3045254978_455" */
function parseCallNameFields(name='') {
  const base = basenameNoExt(name);
  const parts = base.split('_').filter(Boolean);
  const dateIdx = parts.findIndex(p => /^\d{4}-\d{2}-\d{2}$/.test(p));

  if (dateIdx === -1) return { doc:'', date:'', time:'', client:'', tmo:'' };

  const doc    = parts[0] || '';
  const date   = parts[dateIdx] || '';
  const time   = (parts[dateIdx+1] && parts[dateIdx+2] && parts[dateIdx+3])
    ? `${parts[dateIdx+1]}:${parts[dateIdx+2]}:${parts[dateIdx+3]}`
    : '';
  const client = (parts[dateIdx+4] && /^\d+$/.test(parts[dateIdx+4])) ? parts[dateIdx+4] : '';
  let tmo      = (parts[dateIdx+5] && /^\d+$/.test(parts[dateIdx+5])) ? parts[dateIdx+5] : '';

  if (!tmo) {
    const m = base.match(/_(\d{1,6})$/);
    if (m) tmo = m[1];
  }
  return { doc, date, time, client, tmo };
}

/* ===== Formateo de fraude ===== */
function buildFraudString(analisis) {
  if (!analisis || !Array.isArray(analisis?.fraude?.alertas)) return '';
  return analisis.fraude.alertas
    .map(a => {
      const tipo   = String(a?.tipo   || '').replace(/_/g, ' ');
      const riesgo = String(a?.riesgo || 'alto');
      const cita   = String(a?.cita   || '').trim();
      return `[${riesgo}] ${tipo}${cita ? ` — "${cita}"` : ''}`;
    })
    .join(' | ');
}
function _normAlertKeyByType(a) {
  const t = String(a?.tipo || '').toLowerCase().trim();
  return t;
}
function listFraudPlainTypes(analisis) {
  const src = Array.isArray(analisis?.fraude?.alertas) ? analisis.fraude.alertas : [];
  const seen = new Set();
  const out = [];
  for (const a of src) {
    const k = _normAlertKeyByType(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(String(a?.tipo || '').replace(/_/g, ' ').trim());
  }
  return out;
}

/* ===== “Llamada mal tipificada” (razón o vacío) ===== */
function getMalTipificadaText(analisis) {
  if (!analisis) return undefined;
  const isBad = (analisis?.llamada_mal_tipificada === true) || (analisis?.tipificacion_valida === false);
  if (!isBad) return undefined;
  const reason = String(analisis?.motivo_mal_tipificada || analisis?.motivo_no_aplica || '').trim();
  return reason || 'Sí';
}

/** Genera un MD de una auditoría individual (sin guardar a disco) */
function buildCallMarkdown(audit) {
  const lines = [];
  const meta = audit?.metadata || {};
  const an   = audit?.analisis  || {};
  const cons = getConsolidado(audit);
  const transcriptMarked = String(audit?.transcriptMarked || '').trim();

  const fecha        = meta.timestamp ? toTzDate(meta.timestamp).toLocaleString() : '';
  const agente       = meta.agentName    || an.agent_name  || '-';
  const cliente      = meta.customerName || an.client_name || '-';
  const campania     = meta.campania     || '';
  const tipificacion = meta.tipificacion || '';
  const nota         = cons?.notaFinal ?? 0;

  // Críticos con fallback (prioriza consolidado.afectadosCriticos)
  const criticos = Array.isArray(cons?.afectadosCriticos)
    ? cons.afectadosCriticos
    : splitAffected(cons).criticos;

  const fraudes = Array.isArray(an?.fraude?.alertas) ? an.fraude.alertas : [];

  lines.push(`# Reporte de Llamada — ${meta.callId || '(sin id)'}\n`);
  lines.push(`**Fecha:** ${fecha}  `);
  lines.push(`**Agente:** ${agente}  `);
  lines.push(`**Cliente:** ${cliente}  `);
  if (campania)     lines.push(`**Campaña:** ${campania}  `);
  if (tipificacion) lines.push(`**Tipificación:** ${tipificacion}  `);
  lines.push(`**Nota:** ${nota}/100`);

  lines.push('\n## Resumen\n');
  lines.push(an?.resumen || '—');

  // Transcripción con tiempos/rol
  lines.push('\n## Transcripción (tiempos y rol)\n');
  lines.push(transcriptMarked || '(no disponible con este proveedor)');

  lines.push('\n\n## Hallazgos');
  if (Array.isArray(an?.hallazgos) && an.hallazgos.length) {
    for (const h of an.hallazgos) lines.push(`- ${h}`);
  } else {
    lines.push('- —');
  }

  lines.push('\n## Afectados (críticos)');
  lines.push(criticos.length ? `- ${criticos.join('\n- ')}` : '- —');

  lines.push('\n## Sugerencias');
  if (Array.isArray(an?.sugerencias_generales) && an.sugerencias_generales.length) {
    for (const s of an.sugerencias_generales) lines.push(`- ${s}`);
  } else {
    lines.push('- —');
  }

  lines.push('\n## Alertas de fraude');
  if (fraudes.length) {
    for (const f of fraudes) {
      const tipo = String(f?.tipo || '').replace(/_/g, ' ');
      const riesgo = String(f?.riesgo || 'alto');
      const cita = String(f?.cita || '').trim();
      lines.push(`- **${tipo}** [${riesgo}]${cita ? ` — "${cita}"` : ''}`);
    }
  } else {
    lines.push('- —');
  }

  return lines.join('\n');
}

/* ========================== Filtros por Año/Mes/Día ==========================
   Soportados en:
   - GET /audits
   - GET /audits/export.json
   - GET /audits/export.xlsx

   Query params:
   - year=2025
   - month=10
   - day=03
   (Opcional) tz=America/Bogota -> si quieres sobreescribir temporalmente FILES_TZ
-------------------------------------------------------------------------------*/

function readWithFilters(req) {
  const y = req.query.year ? String(req.query.year).trim() : '';
  const m = req.query.month ? String(req.query.month).padStart(2,'0') : '';
  const d = req.query.day ? String(req.query.day).padStart(2,'0') : '';
  const hasYMD = Boolean(y || m || d);

  // Si hay filtros de fecha, leemos TODO y luego filtramos (para exactitud)
  // Si NO hay filtros, respetamos paginación (eficiente).
  if (hasYMD) {
    const all = listAudits();
    return all.filter(it => matchesYMD(it?.metadata?.timestamp, y, m, d));
  }

  const hasPaging = (req.query.offset !== undefined) || (req.query.limit !== undefined);
  if (hasPaging && typeof listAuditsPage === 'function') {
    const offset = toInt(req.query.offset, 0);
    const limit  = toInt(req.query.limit,  200);
    const order  = (req.query.order === 'asc') ? 'asc' : 'desc';
    const { items } = listAuditsPage({ offset, limit, order });
    return items;
  }
  return listAudits();
}

// === Audits (con paginación opcional y/o filtros Y/M/D) ===
router.get('/audits', (req, res) => {
  const items = readWithFilters(req);
  res.json({ total: items.length, items });
});

router.get('/audits/summary', (_req, res) => {
  const s = summaryAudits();
  res.json(s);
});

// === Export JSON (con paginación opcional y/o filtros Y/M/D) ===
router.get('/audits/export.json', (req, res) => {
  const items = readWithFilters(req);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="audits.json"');
  res.send(JSON.stringify(items, null, 2));
});

// === Export a Excel (con paginación opcional y/o filtros Y/M/D) ===
// Requisitos extra:
// - Parsear "Nombre de la llamada" para llenar Documento (misma columna), Número cliente, TMO y Fecha (DD/MM/AAAA).
// - Una fila por cada crítico/alerta (pareo por índice).
// - Escribir celdas REALMENTE vacías (undefined) para no romper fórmulas/filtros.
// - NUEVO: columnas Año / Mes / Día según FILES_TZ, alineadas con almacenamiento.
router.get('/audits/export.xlsx', (req, res) => {
  const items = readWithFilters(req);

  const rows = [];
  items.forEach((it, idx) => {
    const idSecuencial = idx + 1; // inicia en 1
    const cons        = getConsolidado(it);

    const afectados   = Array.isArray(cons?.afectadosCriticos)
      ? cons.afectadosCriticos
      : splitAffected(cons).criticos;

    const fraudeList  = listFraudPlainTypes(it?.analisis);

    const callName    = it?.metadata?.callId ?? '';
    const parsed      = parseCallNameFields(callName);
    const nombreDoc   = parsed.doc || callName; // si no parsea, dejamos el callId completo

    // Fecha preferida: del nombre. Fallback al timestamp con TZ.
    let fechaFmt = ddmmyyyyFromISO(parsed.date);
    if (!fechaFmt && it?.metadata?.timestamp) {
      try {
        const d = toTzDate(it.metadata.timestamp);
        const dd = `${d.getDate()}`.padStart(2,'0');
        const mm = `${d.getMonth()+1}`.padStart(2,'0');
        const yy = d.getFullYear();
        fechaFmt = `${dd}/${mm}/${yy}`;
      } catch {}
    }

    const agente      = it?.metadata?.agentName    || it?.analisis?.agent_name  || undefined;
    const clienteNom  = it?.metadata?.customerName || it?.analisis?.client_name || undefined;
    const campania    = it?.metadata?.campania     || undefined;
    const tipificacion= it?.metadata?.tipificacion || undefined;
    const resumen     = it?.analisis?.resumen ? String(it.analisis.resumen).replace(/\s+/g, ' ').trim() : undefined;
    const nota        = (cons?.notaFinal ?? undefined);
    const malTipTxt   = getMalTipificadaText(it?.analisis); // razón o vacío

    const nCrit  = afectados.length;
    const nFraud = fraudeList.length;
    const nRows  = Math.max(nCrit, nFraud, 1);

    for (let i = 0; i < nRows; i++) {
      rows.push({
        'ID de la llamada': idSecuencial,
        'Nombre de la llamada': sanitizeMaybeBlank(nombreDoc) ?? undefined, // DOC asesor
        'Número cliente': sanitizeMaybeBlank(parsed.client) ?? undefined,    // desde el nombre
        'TMO': parsed.tmo === '' ? undefined : Number(parsed.tmo) || parsed.tmo,
        'Fecha': sanitizeMaybeBlank(fechaFmt) ?? undefined,                  // DD/MM/AAAA
        'Agente': sanitizeMaybeBlank(agente),
        'Cliente': sanitizeMaybeBlank(clienteNom),
        'Campaña': sanitizeMaybeBlank(campania),
        'Tipificación': sanitizeMaybeBlank(tipificacion),
        'Nota': (nota === '' ? undefined : nota),
        'Atributo crítico afectado': (i < nCrit ? sanitizeMaybeBlank(afectados[i]) : undefined),
        'Alerta de fraude': (i < nFraud ? sanitizeMaybeBlank(fraudeList[i]) : undefined),
        'Resumen': (i === 0 ? sanitizeMaybeBlank(resumen) : undefined),
        'Llamada mal tipificada': (i === 0 ? sanitizeMaybeBlank(malTipTxt) : undefined)
      });
    }
  });

  // Limpieza adicional de invisibles
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      const v = r[k];
      if (v == null) { delete r[k]; continue; }
      if (typeof v === 'string' && BLANK_RE.test(v)) delete r[k];
    }
  }

  const headers = [
    'ID de la llamada',
    'Nombre de la llamada', // documento asesor
    'Número cliente',
    'TMO',
    'Fecha',                // DD/MM/AAAA (del nombre o timestamp)
    'Agente',
    'Cliente',
    'Campaña',
    'Tipificación',
    'Nota',
    'Atributo crítico afectado',
    'Alerta de fraude',
    'Resumen',
    'Llamada mal tipificada',
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  XLSX.utils.book_append_sheet(wb, ws, 'Consolidado');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="consolidado.xlsx"');
  res.send(buf);
});

// === Servir reportes MD (individuales o de lote) ===
router.get('/audits/files/calls/:callId.md', (req, res) => {
  const callId = req.params.callId.replace(/\.md$/, '');
  const abs = path.join(REPORTS_CALL_DIR, `${callId}.md`);
  if (!fs.existsSync(abs)) return res.status(404).send('Reporte no encontrado');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(fs.readFileSync(abs, 'utf-8'));
});
router.get('/audits/files/batches/:jobId.md', (req, res) => {
  const jobId = req.params.jobId.replace(/\.md$/, '');
  const abs = path.join(REPORTS_BATCH_DIR, `${jobId}.md`);
  if (!fs.existsSync(abs)) return res.status(404).send('Reporte no encontrado');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(fs.readFileSync(abs, 'utf-8'));
});

// 2) resolvedor genérico y fallback dinámico si no existe el archivo .md
router.get('/audits/files/:name', (req, res) => {
  const base = path.basename(req.params.name);
  const callId = base.replace(/\.md$/,'');
  const withExt = base.endsWith('.md') ? base : `${base}.md`;

  const candidates = [
    resolveReportFile(base),
    resolveReportFile(req.params.name),
    path.join(REPORTS_CALL_DIR, withExt),
    path.join(REPORTS_DIR, withExt),
  ].filter(Boolean);

  const existing = candidates.find(p => fs.existsSync(p));
  if (existing) {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.send(fs.readFileSync(existing, 'utf-8'));
  }

  // Fallback: construir MD al vuelo desde los JSON guardados
  try {
    const items = listAudits();
    const audit = items.find(a => String(a?.metadata?.callId || '') === callId);
    if (!audit) return res.status(404).send('Reporte no encontrado');

    const md = buildCallMarkdown(audit);

    try {
      ensureDir(REPORTS_CALL_DIR);
      fs.writeFileSync(path.join(REPORTS_CALL_DIR, `${callId}.md`), md, 'utf-8');
    } catch { /* ignore */ }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.send(md);
  } catch (e) {
    return res.status(404).send('Reporte no encontrado');
  }
});

// === Lotes (bloques) ===
router.get('/audits/batches', (_req, res) => {
  const items = listBatches();
  res.json({ total: items.length, items });
});
router.get('/audits/batches/:id/report.md', (req, res) => {
  const abs = getBatchReportPath(req.params.id);
  if (!abs || !fs.existsSync(abs)) return res.status(404).send('Reporte de lote no encontrado');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(fs.readFileSync(abs, 'utf-8'));
});

// === (Opcional) Servir transcripciones externas si STORE_TRANSCRIPT_INLINE=0 ===
router.use(
  '/audits/transcripts',
  express.static(path.resolve('data', 'transcripts'), { fallthrough: true })
);

export default router;
