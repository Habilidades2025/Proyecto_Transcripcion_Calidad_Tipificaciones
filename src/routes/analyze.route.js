// src/routes/analyze.route.js
import expressPkg from 'express';
const express = (expressPkg.default ?? expressPkg);

import multerPkg from 'multer';
const multer = (multerPkg.default ?? multerPkg);

import { transcribeAudio, formatTranscriptLinesMono } from '../services/transcriptionService.js';
import { analyzeTranscriptSimple } from '../services/analysisService.js';

/* --------------------------- Upload config --------------------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE || 100 * 1024 * 1024) }
});

const router = express.Router();

/* ------------------------------ Utils -------------------------------- */
function s(v, d = '') { return (v == null ? d : String(v)).trim(); }

/* ================================ POST / =============================== */
/**
 * Form-data esperado (SIEMPRE con audio):
 * - audio (file)            -> requerido
 * - provider (openai|...)   -> opcional (por defecto STT_PROVIDER o 'openai')
 * - campania                -> opcional (por defecto 'Carteras Propias')
 * - tipificacion            -> opcional (propuesta de pago | abono | novacion)
 */
router.post('/', upload.single('audio'), async (req, res) => {
  try {
    // 0) Validación estricta: siempre debe venir audio
    if (!req.file?.buffer) {
      return res.status(400).json({
        ok: false,
        error: 'Adjunta un audio en el campo "audio" (multipart/form-data).'
      });
    }

    const provider     = s(req.body.provider || process.env.STT_PROVIDER || 'openai');
    const campania     = s(req.body.campania || 'Carteras Propias');
    const tipificacion = s(req.body.tipificacion || '');

    // 1) Transcribir SIEMPRE (no se aceptan transcripts manuales)
    const tr = await transcribeAudio(req.file.buffer, { provider });
    const transcript = formatTranscriptLinesMono(tr?.segments || tr?.lines || tr?.text || '');

    // 2) Analizar (SIN matriz/guion; lógica por campaña/tipificación en analysisService)
    const analisis = await analyzeTranscriptSimple({
      transcript,
      campania,
      tipificacion
    });

    // 3) Respuesta estándar
    return res.json({
      ok: true,
      metadata: {
        fileName: req.file?.originalname || '',
        provider,
        campania,
        tipificacion,
        transcriptSource: `audio/${provider}`,
        transcriptLength: transcript.length
      },
      analisis,
      transcriptMarked: transcript // útil para UI/QA
    });
  } catch (err) {
    console.error('[analyze] error:', err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
