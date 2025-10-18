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

    // 2) Analizar (lógica por campaña/tipificación en analysisService)
    const analisis = await analyzeTranscriptSimple({
      transcript,
      campania,
      tipificacion
    });

    // ---------------- Aliases de compatibilidad para MD/Excel ----------------
    // porAtributo: consolidado -> alias plano
    const porAtributo = Array.isArray(analisis?.consolidado?.porAtributo)
      ? analisis.consolidado.porAtributo
      : (Array.isArray(analisis?.porAtributo) ? analisis.porAtributo : []);

    // afectadosCriticos: consolidado -> alias plano -> derivación por fallback
    const afectadosCriticos = Array.isArray(analisis?.consolidado?.afectadosCriticos)
      ? analisis.consolidado.afectadosCriticos
      : (Array.isArray(analisis?.afectadosCriticos)
          ? analisis.afectadosCriticos
          : porAtributo
              .filter(a => a?.aplica === true && a?.cumplido === false)
              .map(a => a.atributo)
              .filter(Boolean));

    // errores_criticos: usar los del servicio o derivar desde porAtributo
    const errores_criticos = Array.isArray(analisis?.errores_criticos)
      ? analisis.errores_criticos
      : porAtributo
          .filter(a => a?.aplica === true && a?.cumplido === false)
          .map(a => ({
            atributo: a.atributo,
            severidad: 'critico',
            justificacion: a.justificacion || 'no_evidencia',
            mejora: a.mejora || ''
          }));

    // alertas_antifraude: alias a fraude.alertas si no existe
    const alertas_antifraude = Array.isArray(analisis?.alertas_antifraude)
      ? analisis.alertas_antifraude
      : (Array.isArray(analisis?.fraude?.alertas) ? analisis.fraude.alertas : []);

    // 3) Construir AUDIT (objeto que consumen MD/Excel legacy)
    const audit = {
      metadata: {
        fileName: req.file?.originalname || '',
        provider,
        campania,
        tipificacion,
        transcriptSource: `audio/${provider}`,
        transcriptLength: transcript.length,
        timestamp: Date.now()
      },
      // bloque moderno
      analisis,
      // --- ALIASES DE COMPATIBILIDAD (rutas legacy para MD/Excel) ---
      consolidado: analisis?.consolidado || {},
      porAtributo,
      afectadosCriticos,
      errores_criticos,
      alertas_antifraude,
      // útil para revisiones
      transcriptMarked: transcript
    };

    // 4) Respuesta estándar (un solo punto de verdad para MD/Excel)
    return res.json({ ok: true, audit });
  } catch (err) {
    console.error('[analyze] error:', err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
