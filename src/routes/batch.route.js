// src/routes/batch.route.js
import expressPkg from 'express';
const express = (expressPkg.default ?? expressPkg);

import multerPkg from 'multer';
const multer = (multerPkg.default ?? multerPkg);

import fs from 'fs';
import path from 'path';

import { transcribeAudio } from '../services/transcriptionService.js';
import { analyzeTranscriptSimple } from '../services/analysisService.js';
import { saveAudit } from '../services/persistService.js';

/* --------------------------- Helpers de log --------------------------- */
const log = (...a) => console.log('[batch]', ...a);

/* ------------------------------ Utils -------------------------------- */
const router = express.Router();
const AUDIO_RE = /\.(wav|mp3|m4a|ogg|flac|aac|webm)$/i;
const { promises: fsp } = fs;

function s(v, d = '') { return (v == null ? d : String(v)).trim(); }
function nowMs() { return Date.now(); }
function dur(t0) { return Math.max(0, nowMs() - t0); }
function jsonParseSafe(x, fallback = null) { try { return x ? JSON.parse(x) : fallback; } catch { return fallback; } }
function ensureDirPath(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

async function getFileBuffer(file) {
  if (file?.buffer) return file.buffer;
  if (file?.path) return await fsp.readFile(file.path);
  throw new Error('Archivo inválido (sin buffer ni path).');
}
async function cleanupUploaded(file) {
  if (file?.path) { try { await fsp.unlink(file.path); } catch {} }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0, active = 0;
  return new Promise((resolve) => {
    const runNext = () => {
      while (active < concurrency && idx < items.length) {
        const myIndex = idx++;
        active++;
        Promise
          .resolve(worker(items[myIndex], myIndex))
          .then(res => { results[myIndex] = res; })
          .catch(err => { results[myIndex] = { ok:false, error:String(err?.message||err) }; })
          .finally(() => {
            active--;
            if (idx >= items.length && active === 0) resolve(results);
            else runNext();
          });
      }
    };
    runNext();
  });
}

/* -------------------- Normalizador de consolidado --------------------- */
function computeAfectadosCriticos(consol = {}) {
  const lista = Array.isArray(consol?.porAtributo) ? consol.porAtributo : [];
  const afectados = lista
    .filter(a => a?.aplica === true && a?.cumplido === false)
    .map(a => String(a?.atributo || '').trim())
    .filter(Boolean);
  return { ...(consol || {}), afectadosCriticos: afectados };
}

/* ------------------------------ SSE ---------------------------------- */
function initSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}
function sseSend(res, event, payload) {
  const data = (typeof payload === 'string') ? payload : JSON.stringify(payload);
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${data}\n\n`);
}
function sseClose(res) {
  try { res.write('event: end\ndata: {}\n\n'); } catch {}
  try { res.end(); } catch {}
}

/* --------------------- Paths p/ meta de lotes y reportes --------------- */
const DATA_DIR            = path.resolve('data');
const BATCH_META_DIR      = path.join(DATA_DIR, 'batches');
const REPORTS_DIR         = path.resolve('reports');
const REPORTS_BATCH_DIR   = path.join(REPORTS_DIR, 'batches');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
ensureDir(DATA_DIR);
ensureDir(BATCH_META_DIR);
ensureDir(REPORTS_DIR);
ensureDir(REPORTS_BATCH_DIR);

/* --------------------------- Config Upload --------------------------- */
// Soporte memoria o disco (según .env):
// - UPLOAD_USE_DISK=1 → usa diskStorage en tmp/uploads (o UPLOAD_DISK_DIR)
// - UPLOAD_MAX_FILES (default 200)
// - UPLOAD_MAX_FILE_SIZE (default 100MB)
const USE_DISK = String(process.env.UPLOAD_USE_DISK ?? '0') !== '0';
const UPLOAD_DIR = process.env.UPLOAD_DISK_DIR || path.resolve('tmp', 'uploads');
if (USE_DISK) ensureDirPath(UPLOAD_DIR);

const storage = USE_DISK
  ? multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
      filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
    })
  : multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE || 100 * 1024 * 1024),
    files: Number(process.env.UPLOAD_MAX_FILES || 200) // ← sube el default a 200
  }
});

/* ---------------------------- Helpers batch --------------------------- */
function buildBatchMarkdown(job, results) {
  const ok = results.filter(r => r?.ok).length;
  const total = results.length;
  const failed = total - ok;

  const lines = [];
  lines.push(`# Reporte de Lote — ${job.id}\n`);
  lines.push(`**Creado:** ${new Date(job.started).toLocaleString()}`);
  lines.push(`\n**Totales:** ${ok}/${total} OK — fallidos: ${failed}\n`);
  lines.push(`**Campaña:** ${job.meta?.campania || ''}  `);
  lines.push(`**Proveedor STT:** ${job.meta?.provider || ''}  `);
  lines.push(`**Tipificación por defecto:** ${job.meta?.tipificacionDefault || ''}\n`);

  lines.push(`## Resultados\n`);
  results.forEach((r, i) => {
    const name = r?.fileName || job.items?.[i]?.name || `audio_${i+1}`;
    if (r?.ok) {
      const nota = r?.meta?.consolidado?.notaFinal ?? r?.meta?.nota ?? '-';
      const resumen = r?.meta?.analisis?.resumen ? String(r.meta.analisis.resumen).replace(/\s+/g, ' ').trim() : '';
      lines.push(`- ✅ **${name}** — Nota: **${nota}**${resumen ? ` — ${resumen.slice(0, 180)}${resumen.length > 180 ? '…' : ''}` : ''}`);
    } else {
      lines.push(`- ❌ **${name}** — Error: ${r?.error || 'Error'}`);
    }
  });

  return lines.join('\n');
}

function writeBatchArtifacts(job, results) {
  const mdPath = path.join(REPORTS_BATCH_DIR, `${job.id}.md`);
  const metaPath = path.join(BATCH_META_DIR, `${job.id}.json`);

  const md = buildBatchMarkdown(job, results);
  fs.writeFileSync(mdPath, md, 'utf-8');

  const ok = results.filter(r => r?.ok).length;
  const meta = {
    id: job.id,
    createdAt: job.started,
    totals: { total: results.length, ok, failed: results.length - ok },
    reportPath: mdPath,
    provider: job.meta?.provider || '',
    campania: job.meta?.campania || '',
    tipificacionDefault: job.meta?.tipificacionDefault || ''
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

/* ---------------------------- Diagnóstico ----------------------------- */
router.get('/ping', (_req, res) => res.json({ ok:true, at:'/batch/ping' }));

/* ===================================================================== */
/*                              MODO DIRECTO                              */
/* ===================================================================== */
async function handleDirect(req, res) {
  try {
    const files = (req.files || []).filter(f =>
      ['audios', 'audio', 'audio[]'].includes(f.fieldname) ||
      f.mimetype?.startsWith('audio/') ||
      AUDIO_RE.test(f.originalname || '')
    );
    const provider      = s(req.body.provider || process.env.STT_PROVIDER || 'openai');
    log('direct called url=%s files=%d provider=%s', req.originalUrl, files.length, provider);

    if (!files.length) return res.status(400).json({ error: 'Adjunta uno o más audios (campo "audios").' });

    const campania      = s(req.body.campania || req.body['campaña'] || 'Carteras Propias');
    const tipificacion  = s(req.body.tipificacion || '');
    const tipiMap       = jsonParseSafe(req.body.tipificacion_map, null);
    const tipiPromptUI  = s(req.body.tipi_prompt || '');

    // Concurrencia configurable: BATCH_MAX_PARALLEL (fallback BATCH_CONCURRENCY)
    const CONC = Math.max(1, Number(process.env.BATCH_MAX_PARALLEL ?? process.env.BATCH_CONCURRENCY ?? 8));
    const startedAll = nowMs();

    const worker = async (file, index) => {
      const t0 = nowMs();
      const name = file?.originalname || `audio_${index+1}`;
      try {
        // a) Transcribir (lee buffer desde memoria o disco)
        const audioBuf = await getFileBuffer(file);
        const tr = await transcribeAudio(audioBuf, { provider });

        // Preferimos líneas marcadas si existen; si no, caemos al texto plano
        let transcriptMarked = '';
        const marked = Array.isArray(tr?.linesRoleLabeled) ? tr.linesRoleLabeled : [];
        transcriptMarked = marked.length ? marked.join('\n') : (tr?.text || '').trim();

        // b) Tipificación efectiva
        const tipi = (tipiMap?.[name] ? s(tipiMap[name]) : tipificacion) || '';

        // c) Analizar
        const analisis = await analyzeTranscriptSimple({ transcript: transcriptMarked, campania, tipificacion: tipi, tipi_prompt: tipiPromptUI });

        // d) Consolidado (forzar afectadosCriticos)
        const consolidadoFromModel = (analisis && typeof analisis.consolidado === 'object') ? analisis.consolidado : null;
        let nota = (consolidadoFromModel && Number.isFinite(Number(consolidadoFromModel.notaFinal)))
          ? Math.round(Number(consolidadoFromModel.notaFinal))
          : null;
        if (nota === null) {
          nota =
            Number(analisis?.notaFinal) || Number(analisis?.nota) ||
            Number(analisis?.score)     || Number(analisis?.scoring) || null;
        }
        const consolidadoRaw = consolidadoFromModel ?? (Number.isFinite(nota) ? { notaFinal: Math.round(nota) } : undefined);
        const consolidado = computeAfectadosCriticos(consolidadoRaw);

        // Sincroniza el consolidado dentro del analisis
        if (analisis) analisis.consolidado = { ...(analisis.consolidado || {}), ...consolidado };

        // e) Persistencia individual
        const metadata = {
          timestamp: new Date().toISOString(),
          callId: name.replace(/\.[^.]+$/, ''), // ← ahora también en modo directo
          originalFile: name,
          agentName: analisis?.agent_name || '',
          customerName: analisis?.client_name || '',
          provider, campania, tipificacion: tipi
        };

        const savedPath = await saveAudit({
          metadata,
          analisis,
          consolidado,
          transcript: transcriptMarked,
          transcriptMarked
        });
        log('saved audit %s', savedPath);

        return {
          ok: true,
          index,
          fileName: name,
          durationMs: dur(t0),
          metadata,
          analisis,
          consolidado,
          nota: consolidado?.notaFinal,
          transcriptMarked
        };
      } catch (err) {
        return { ok:false, index, fileName:name, durationMs:dur(t0), error:String(err?.message||err) };
      } finally {
        await cleanupUploaded(file); // limpia archivo temporal si se usó diskStorage
      }
    };

    const results = await mapWithConcurrency(files, CONC, worker);
    const okCount = results.filter(r => r?.ok).length;

    // Artefacto de lote “ad-hoc”
    const fakeJob = {
      id: `direct_${Date.now()}`,
      started: startedAll,
      items: files.map((f, i) => ({ name: f?.originalname || `audio_${i+1}` })),
      meta: { provider, campania, tipificacionDefault: tipificacion || '' }
    };
    writeBatchArtifacts(fakeJob, results);

    res.json({
      ok: okCount === results.length,
      totals: { files: results.length, ok: okCount, failed: results.length - okCount, durationMs: dur(startedAll) },
      provider, campania, tipificacionDefault: tipificacion || '',
      results
    });
  } catch (err) {
    console.error('[batch][direct] error:', err);
    res.status(500).json({ error: String(err?.message || err) });
  }
}

// POST /batch (fallback)
router.post('/', upload.any(), handleDirect);

/* ===================================================================== */
/*                      MODO JOB (start/progress/result)                  */
/* ===================================================================== */
const jobs = new Map(); // id → { id, status, total, done, items[], listeners[], results[], group, meta, started }

function newJob(files, meta = {}) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    status: 'running',
    total: files.length,
    done: 0,
    items: files.map((f, i) => ({ name: (f?.originalname || `audio_${i+1}`), status: 'pending' })),
    listeners: [],
    results: new Array(files.length).fill(null),
    group: null,
    meta,
    started: nowMs()
  };
  jobs.set(id, job);
  log('job created id=%s files=%d meta=%j', id, files.length, meta);
  return job;
}
function notifyJob(job) {
  const payload = {
    status: job.status,
    total: job.total,
    done: job.done,
    items: job.items.map(x => ({ name: x.name, status: x.status }))
  };
  for (const res of job.listeners) { try { sseSend(res, 'progress', payload); } catch {} }
}

/* ---------------- Resumen grupal (promedio, críticos, plan) ----------- */
function buildGroupSummary(results) {
  const oks = results.filter(r => r?.ok && r.meta?.analisis);

  const hallCount = new Map();
  oks.forEach(r => (r.meta.analisis.hallazgos || [])
    .forEach(h => hallCount.set(h, (hallCount.get(h) || 0) + 1)));
  const hallTop = Array.from(hallCount.entries())
    .sort((a,b)=>b[1]-a[1])
    .slice(0,5)
    .map(([h,c])=>`${h} (${c})`);

  const notas = oks
    .map(r => Number(r.meta?.consolidado?.notaFinal))
    .filter(n => Number.isFinite(n));
  const promedio = notas.length ? Math.round(notas.reduce((a,b)=>a+b,0) / notas.length) : 0;

  const criticos = new Set();
  const mejoras = [];
  oks.forEach(r => {
    const porAtrib = Array.isArray(r.meta?.consolidado?.porAtributo)
      ? r.meta.consolidado.porAtributo : [];
    porAtrib.forEach(a => {
      if (a && a.aplica === true && a.cumplido === false) {
        const nombre = String(a.atributo || a.nombre || 'Atributo').trim();
        if (nombre) criticos.add(nombre);
        if (a.mejora) mejoras.push(`• ${String(a.mejora).trim()}`);
      }
    });
  });

  return {
    total: results.length,
    promedio,
    resumen: '',
    topHallazgos: hallTop,
    atributosCriticos: Array.from(criticos),
    planMejora: mejoras.join('  ')
  };
}

async function handleStart(req, res) {
  try {
    const files = (req.files || []).filter(f =>
      ['audios', 'audio', 'audio[]'].includes(f.fieldname) ||
      f.mimetype?.startsWith('audio/') ||
      AUDIO_RE.test(f.originalname || '')
    );

    const provider      = s(req.body.provider || process.env.STT_PROVIDER || 'openai');
    const campania      = s(req.body.campania || req.body['campaña'] || 'Carteras Propias');
    const tipificacion  = s(req.body.tipificacion || '');
    const tipiMap       = jsonParseSafe(req.body.tipificacion_map, null);
    const tipiPromptUI  = s(req.body.tipi_prompt || '');

    log('start called url=%s files=%d provider=%s', req.originalUrl, files.length, provider);

    if (!files.length) {
      return res.status(400).json({ error: 'Adjunta uno o más audios (campo "audios").' });
    }

    const job = newJob(files, { provider, campania, tipificacionDefault: tipificacion });
    res.json({ jobId: job.id }); // UI espera respuesta inmediata

    // Concurrencia configurable: BATCH_MAX_PARALLEL (fallback BATCH_CONCURRENCY)
    const CONC = Math.max(1, Number(process.env.BATCH_MAX_PARALLEL ?? process.env.BATCH_CONCURRENCY ?? 8));

    let cursor = 0;
    async function runOne() {
      const i = cursor++;
      const file = files[i];
      if (!file) return;

      const name = file?.originalname || `audio_${i+1}`;
      const t0 = nowMs();

      let ok = false, meta = null, errMsg = '';
      try {
        const audioBuf = await getFileBuffer(file);
        const tr = await transcribeAudio(audioBuf, { provider });

        let transcriptMarked = '';
        const marked = Array.isArray(tr?.linesRoleLabeled) ? tr.linesRoleLabeled : [];
        transcriptMarked = marked.length ? marked.join('\n') : (tr?.text || '').trim();

        const tipi = (tipiMap?.[name] ? s(tipiMap[name]) : tipificacion) || '';
        const analisis = await analyzeTranscriptSimple({ transcript: transcriptMarked, campania, tipificacion: tipi, tipi_prompt: tipiPromptUI });

        const consolidadoFromModel = (analisis && typeof analisis.consolidado === 'object') ? analisis.consolidado : null;
        let nota = (consolidadoFromModel && Number.isFinite(Number(consolidadoFromModel.notaFinal)))
          ? Math.round(Number(consolidadoFromModel.notaFinal))
          : null;
        if (nota === null) {
          nota =
            Number(analisis?.notaFinal) || Number(analisis?.nota) ||
            Number(analisis?.score)     || Number(analisis?.scoring) || null;
        }
        const consolidadoRaw = consolidadoFromModel ?? (Number.isFinite(nota) ? { notaFinal: Math.round(nota) } : undefined);
        const consolidado = computeAfectadosCriticos(consolidadoRaw);

        // sincroniza en analisis
        if (analisis) analisis.consolidado = { ...(analisis.consolidado || {}), ...consolidado };

        const metadata = {
          timestamp: new Date().toISOString(),
          callId: name.replace(/\.[^.]+$/, ''),
          agentName: analisis?.agent_name || '',
          customerName: analisis?.client_name || '',
          provider, campania, tipificacion: tipi
        };

        const savedPath = await saveAudit({
          metadata,
          analisis,
          consolidado,
          transcript: transcriptMarked,
          transcriptMarked
        });
        log('saved audit %s', savedPath);

        ok = true;
        meta = {
          analisis,
          consolidado,
          nota: consolidado?.notaFinal,
          transcriptMarked,
          durationMs: dur(t0)
        };
      } catch (e) {
        ok = false;
        errMsg = String(e?.message || e);
      } finally {
        await cleanupUploaded(file); // limpia archivo temporal si aplica
      }

      const item = job.items[i];
      if (item) item.status = ok ? 'done' : 'error';
      job.results[i] = ok ? { ok:true, fileName:name, meta } : { ok:false, fileName:name, error:errMsg };
      job.done += 1;
      notifyJob(job);

      await runOne();
    }

    await Promise.all(Array.from({ length: CONC }).map(() => runOne()));

    job.group = buildGroupSummary(job.results);
    job.status = 'done';
    writeBatchArtifacts(job, job.results);
    notifyJob(job);
    log('job finished id=%s done=%d/%d', job.id, job.done, job.total);
  } catch (err) {
    console.error('[batch/start] error:', err);
    try { res.status(500).json({ error: String(err?.message || err) }); } catch {}
  }
}

/* ------------------------------- Rutas JOB ------------------------------- */
// Importante: si montas este router con app.use('/batch', router),
// la ruta efectiva es /batch/start , /batch/progress/:id , /batch/result/:id
router.post('/start', upload.any(), handleStart);
// (Evita duplicar prefijo con alias /batch/batch/*)
// router.post('/batch/start', upload.any(), handleStart);

/* ------------------------------ Progreso (SSE) --------------------------- */
function progressHandler(req, res) {
  const id = s(req.params.id || '');
  if (!id) return res.status(400).json({ error: 'Falta jobId' });

  const job = jobs.get(id);
  log('progress open id=%s found=%s', id, !!job);

  if (!job) return res.status(404).json({ error: 'Job no encontrado' });

  initSSE(res);
  job.listeners.push(res);
  notifyJob(job);

  // keepalive para proxies intermedios
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, Number(process.env.SSE_KEEPALIVE_MS || 15000));

  req.on('close', () => {
    clearInterval(keepalive);
    job.listeners = job.listeners.filter(r => r !== res);
    log('progress closed id=%s', id);
  });
}
router.get('/progress/:id', progressHandler);
// router.get('/batch/progress/:id', progressHandler); // alias opcional

/* -------------------------------- Resultado ------------------------------ */
function resultHandler(req, res) {
  const id = s(req.params.id || '');
  const job = jobs.get(id);
  log('result requested id=%s found=%s', id, !!job);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });

  const items = job.results.map((r, i) => {
    const safeName = job.items?.[i]?.name || r?.fileName || `audio_${i + 1}`;
    if (r?.ok) {
      return {
        status: 'done',
        name: safeName,
        meta: {
          analisis: r.meta?.analisis || {},
          nota: r.meta?.nota,
          consolidado: r.meta?.consolidado,
          transcriptMarked: r.meta?.transcriptMarked || '',
          durationMs: r.meta?.durationMs ?? 0
        }
      };
    }
    return { status: 'error', name: safeName, error: r?.error || 'Error' };
  });

  res.json({ items, group: job.group || { total: items.length } });
}
router.get('/result/:id', resultHandler);
// router.get('/batch/result/:id', resultHandler); // alias opcional

export default router;
