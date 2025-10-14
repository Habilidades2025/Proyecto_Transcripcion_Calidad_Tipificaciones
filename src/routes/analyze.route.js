// src/routes/analyze.route.js
import expressPkg from 'express';
const express = (expressPkg.default ?? expressPkg);

import multerPkg from 'multer';
const multer = (multerPkg.default ?? multerPkg);

import { transcribeAudio, formatTranscriptLinesMono } from '../services/transcriptionService.js';
import { analyzeTranscriptSimple } from '../services/analysisService.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE || 100 * 1024 * 1024) }
});

const router = express.Router();

function s(v, d = '') { return (v == null ? d : String(v)).trim(); }

router.post('/', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Adjunta un audio en el campo "audio".' });
    }

    const provider    = s(req.body.provider || process.env.STT_PROVIDER || 'openai');
    const campania    = s(req.body.campania || 'Carteras Propias');
    const tipificacion= s(req.body.tipificacion || '');

    // 1) Transcribir
    const tr = await transcribeAudio(req.file.buffer, { provider });
    const transcript = formatTranscriptLinesMono(tr?.segments || tr?.lines || tr?.text || '');

    // 2) Analizar (SIN matriz/guion)
    const analisis = await analyzeTranscriptSimple({
      transcript,
      campania,
      tipificacion
    });

    return res.json({
      ok: true,
      metadata: {
        fileName: req.file?.originalname || '',
        provider,
        campania,
        tipificacion
      },
      analisis,
      transcriptMarked: transcript // útil para revisar en UI
    });
  } catch (err) {
    console.error('[analyze] error:', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

export default router;
