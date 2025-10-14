// src/services/analysisService.js
import OpenAI from 'openai';

/** ---------- Utils: parse JSON robusto ---------- */
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

/** Limpia honoríficos comunes (Señor, Sra., Don, etc.) */
function cleanName(x = '') {
  const s = String(x).trim();
  if (!s) return '';
  return s.replace(/^(señor(?:a)?|sr\.?|sra\.?|srta\.?|don|doña)\s+/i, '').trim();
}

/* ==================== FRAUDE: heurística liviana ==================== */
const OFFICIAL_PAY_CHANNELS = (process.env.OFFICIAL_PAY_CHANNELS || 'link de pago,PSE,portal oficial,oficinas autorizadas')
  .split(',').map(s => s.trim()).filter(Boolean);

function detectFraudHeuristics(transcriptText = '') {
  const txt = String(transcriptText || '');
  if (!txt) return [];
  const out = [];
  const push = (tipo, cita, riesgo = 'alto') => {
    if (!tipo || !cita) return;
    out.push({ tipo, cita: String(cita).trim().slice(0, 200), riesgo });
  };
  const around = (i) => txt.slice(Math.max(0, i - 60), Math.min(txt.length, i + 120)).replace(/\s+/g, ' ').trim();

  // A) Números alternos / WhatsApp personal
  const reAltNum = /\b(me\s+voy\s+a\s+comunicar|le\s+(?:escribo|llamo))\s+de\s+otro\s+n[úu]mero\b|\bn[úu]mero\s+personal\b|\bmi\s+(?:whatsapp|celular)\s+es\b/ig;
  let m;
  while ((m = reAltNum.exec(txt)) !== null) push('contacto_numero_no_oficial', around(m.index));

  // B) Cuentas / consignaciones directas a cuentas no oficiales
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

/* ==================== Reglas por TIPIFICACIÓN ==================== */
const TIPI_RULES = {
  // Algunas reglas de ejemplo (puedes extenderlas según tu operación)
  'promesa de pago': `
- Si el cliente muestra intención de pago, extrae (si aparece) MONTO, FECHA y CANAL de pago.
- Prioriza confirmar: fecha concreta, monto concreto, canal OFICIAL (ej.: ${OFFICIAL_PAY_CHANNELS.join(', ')}).
- Si no están los tres, sugiere en hallazgos precisar los faltantes (sin inventarlos).`.trim(),

  'recordatorio de pago': `
- Llamada de recordatorio simple: no marques falta de negociación u objeciones si el cliente solo confirma.
- Registra beneficios/consecuencias y canal oficial si aparecen.`.trim(),

  'acuerdo de pago': `
- Si hay acuerdo, extrae monto(s), fecha(s) y canal oficial. Si no se cierra, marca "negociacion_en_proceso".`.trim(),

  'novacion': '' // se rellena dinámicamente por campaña (ver bloque Novación)
};

/** Normaliza tipificación para indexar TIPI_RULES */
function keyTipi(t = '') {
  return String(t || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/* =============== NOVACIÓN (Carteras Propias): ítems críticos =============== */
const NOVACION_ITEMS = [
  '1. Informa beneficios y consecuencias de aceptar la novación',
  '2. Realiza proceso completo de confirmación de la novación (monto, cuotas, tasa y plazos)',
  '3. Indaga motivo por el cual el titular requiere la novación',
  '4. Solicita autorización para contacto por otros medios (Ley 1581)',
  '5. Despedida según guion establecido',
  '6. Explica correctamente condiciones del nuevo crédito (cuotas, tasas, beneficios)',
  '7. Gestiona objeciones sobre tasa o plazo con argumentos claros',
  '8. Informa grabación y monitoreo conforme Ley 1581',
  '9. Usa el guion completo establecido para novación',
  '10. Evita argumentos engañosos o coercitivos',
  '11. Utiliza vocabulario prudente y respetuoso'
];

function buildNovacionExtraPrompt() {
  return `
EVALUACIÓN ESPECÍFICA — NOVACIÓN (Carteras Propias)

Definición operativa: Novación = el titular acepta expresamente un **nuevo crédito** con Contacto Solutions para saldar la deuda anterior (nuevo contrato, nueva tasa, plazo entre 5 y 68 cuotas, nuevas condiciones).

DECISIÓN PREVIA (aplica/0 pts):
• Si **NO hay aceptación formal de novación**, devuelve:
  - "novacion.aceptada": false
  - "novacion.motivo_no_aplica": "No aplica — sin aceptación formal de novación."
  - En "consolidado.porAtributo": marca todos los ítems con "aplica": false
  - "consolidado.notaFinal": 0
  - En "fraude.alertas" añade: { "tipo": "novacion_invalida", "riesgo": "alto", "cita": "frase breve verificable" }
  - FIN (no intentes evaluar la matriz).

REGLA DE EVIDENCIA (muy estricta):
• Para marcar **cumplido=true** en un ítem, la "justificacion" DEBE incluir **una cita textual entre comillas** extraída de la transcripción (≥ 8 palabras) y, si existen, el tiempo aproximado (por ejemplo “00:38”).
• Si **no hay cita literal**, escribe "no_evidencia" y pon **cumplido=false**.
• Respuestas genéricas como “sí, correcto”, “perfecto”, “quedo pendiente por WhatsApp” **no valen** como evidencia.
• No infieras ni parafrasees sin cita: ante duda, **no_evidencia**.

ÍTEMS CRÍTICOS (peso 100% si aplica):
1) **Beneficios y consecuencias** de aceptar la novación  
   Cumple solo si el agente menciona **ambos** con cita (ej.: beneficios como “repone historial/retira reporte” **y** consecuencias/compromiso de pago).  
   No aplica: solo si no se avanza a oferta/aceptación.

2) **Confirmación completa** del nuevo crédito (**monto + nº de cuotas + tasa + plazo/fecha**)  
   Cumple solo si aparecen los **cuatro** elementos con cita. Si falta uno → **no cumple**.  
   No aplica: llamada se corta antes de confirmar.

3) **Indaga motivo** por el cual el titular requiere la novación  
   Cumple si se hace una **pregunta abierta** y queda el **motivo** registrado con cita. Si el agente asume → no cumple.

4) **Solicita autorización** para contacto por otros medios  
   Cumple si el agente **pide consentimiento explícito** (“¿autoriza… WhatsApp/SMS/correo?”) y registra aceptación/negativa con cita.  
   Palabras clave esperadas en la cita: autoriza/permite/consentimiento.

5) **Despedida** según guion (cierre cordial y próximos pasos)  
   Cumple si hay despedida + próximos pasos con cita.

6) **Explica condiciones** del nuevo crédito (coherentes con 2)  
   Cumple si se detallan condiciones (cuotas, tasa, beneficios) con cita literal; contradicciones con (2) → no cumple.

7) **Gestiona objeciones** sobre tasa o plazo con argumentos  
   Cumple si **hubo objeción** y el agente la atiende con argumentos reales (cita).  
   No aplica si no hubo objeciones.

8) **Informa grabación/monitoreo** (Ley 1581)  
   Cumple si el agente lo dice explícitamente (palabras esperadas: “grabada”, “monitoreo”, “calidad”, “Ley 1581”) con cita.

9) **Uso de guion completo de novación**  
   Cumple si se observan las etapas clave (presentación, verificación, explicación, confirmaciones, consentimiento, cierre) con **al menos una cita** que referencie 2 pasos distintos.

10) **Evita argumentos engañosos o coercitivos**  
   Cumple si NO hay frases engañosas/amenazantes; si las hay, marca “no cumple” y añade alerta de fraude con la cita.

11) **Vocabulario prudente y respetuoso**  
   Cumple si el trato es profesional; citas ofensivas → no cumple.

CÁLCULO DE NOTA (conservador):
• Considera solo los ítems con "aplica": true.  
• Si **cualquier** ítem aplicable tiene "cumplido": false → **notaFinal = 0**.  
• Si **todos** los ítems aplicables tienen "cumplido": true → **notaFinal = 100**.  
• Si ningún ítem aplica (caso raro con aceptación falsa), notaFinal = 0.

FRAUDE (además de “novacion_invalida”):
• Señala "cuenta_no_oficial" o "contacto_numero_no_oficial" si se piden consignaciones o se entrega un número personal/no oficial (incluye cita y riesgo).`.trim();
}


/* ==================== Helpers de consolidado (post-proceso) ==================== */
function normalizePorAtributo(list = []) {
  if (!Array.isArray(list)) return [];
  return list.map(x => ({
    atributo: String(x?.atributo || x?.categoria || '').trim() || '(ítem)',
    aplica: Boolean(x?.aplica),
    cumplido: Boolean(x?.cumplido),
    justificacion: String(x?.justificacion || '').trim(),
    mejora: String(x?.mejora || '').trim()
  }));
}

function deriveAffectedCriticos(porAtrib = []) {
  return porAtrib
    .filter(a => a?.aplica === true && a?.cumplido === false)
    .map(a => a.atributo)
    .filter(Boolean);
}

function computeNovacionScore(porAtrib = [], accepted = true) {
  if (!accepted) return 0;
  const aplicables = porAtrib.filter(a => a.aplica === true);
  if (aplicables.length === 0) return 100; // no aplica nada => no afecta
  const anyFail = aplicables.some(a => a.cumplido === false);
  return anyFail ? 0 : 100;
}

/** Ajusta/garantiza consolidado para Novación (nota y afectados) */
function ensureNovacionConsolidado(analisis = {}) {
  const accepted = analisis?.novacion?.aceptada !== false; // si falta el campo, asumimos true para no penalizar
  const rawPorAttr = Array.isArray(analisis?.consolidado?.porAtributo)
    ? analisis.consolidado.porAtributo
    : [];

  // Si el modelo no devolvió todos los ítems, no forzamos completar, pero sí normalizamos lo que vino.
  let porAtributo = normalizePorAtributo(rawPorAttr);

  // Calcular nota
  const nota = computeNovacionScore(porAtributo, accepted);

  // Afectados críticos
  const afectadosCriticos = deriveAffectedCriticos(porAtributo);

  analisis.consolidado = {
    ...(analisis.consolidado || {}),
    notaFinal: nota,
    porAtributo,
    afectadosCriticos
  };

  // Si explícitamente NO aceptada, garantizamos fraude novacion_invalida
  if (analisis?.novacion && analisis.novacion.aceptada === false) {
    const list = Array.isArray(analisis?.fraude?.alertas) ? analisis.fraude.alertas : [];
    const has = list.some(a => a?.tipo === 'novacion_invalida');
    if (!has) {
      (analisis.fraude = analisis.fraude || {}).alertas = list.concat([{
        tipo: 'novacion_invalida',
        riesgo: 'alto',
        cita: 'No hay aceptación expresa de novación, pero se intenta cerrar.'
      }]);
    }
  }

  return analisis;
}

/* ==================== Analizador principal ==================== */
export async function analyzeTranscriptSimple({
  transcript,
  campania = 'Carteras Propias',
  tipificacion = ''
}) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS) || 60000
  });

  const model      = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
  const MAX_TOKENS = Number(process.env.ANALYSIS_MAX_TOKENS) || 1100;

  const tipKey = keyTipi(tipificacion);
  const isNovacionCP =
    keyTipi(campania) === 'carteras propias' &&
    (tipKey === 'novacion' || tipKey === 'novación');

  // ---- System prompt (siempre con canales oficiales para marcar fraude) ----
  const system = `
Eres un analista de calidad experto en Contact Center. Evalúas transcripciones y devuelves JSON ESTRICTO en español, **sin texto adicional**.
No inventes datos. Si algo no aparece en la transcripción, indícalo como "no_evidencia".
Canales OFICIALES de pago: ${OFFICIAL_PAY_CHANNELS.join(', ')}.
Marca alertas de FRAUDE si el agente pide consignar/transferir a canal NO oficial o da un contacto NO oficial (otro número/WhatsApp personal). Incluye cita breve.
`.trim();

  // ---- Extra prompt específico por tipificación/campaña ----
  const extraTip = isNovacionCP ? buildNovacionExtraPrompt() : (TIPI_RULES[tipKey] || '');

  // ---- Instrucciones de salida (JSON) ----
  const commonJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \\"\\" )",
  "client_name": "string (si no hay evidencia, \\"\\" )",
  "resumen": "100-150 palabras, sin inventar nombres/fechas/montos",
  "hallazgos": ["3-6 bullets operativos y específicos sobre lo que sí aparece"],
  "sugerencias_generales": ["2-4 puntos accionables de mejora"],
  "flags": {
    "intencion_de_pago": true,
    "beneficios_y_consecuencias_mencionados": true,
    "ley_1581_mencionada": true,
    "negociacion_en_proceso": true,
    "hubo_objeciones": true,
    "despedida_adecuada": true
  },
  "fraude": {
    "alertas": [
      { "tipo": "cuenta_no_oficial|contacto_numero_no_oficial|otro", "cita": "frase breve", "riesgo": "alto|medio|bajo" }
    ],
    "observaciones": "string"
  }
}
`.trim();

  const novacionJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \\"\\" )",
  "client_name": "string (si no hay evidencia, \\"\\" )",
  "resumen": "100-150 palabras (claridad de oferta, consentimiento, normas 1581/1266 si aplica, objeciones, tono)",
  "hallazgos": ["3-6 bullets operativos y específicos sobre lo que sí aparece"],
  "sugerencias_generales": ["2-4 puntos accionables de mejora"],
  "flags": {
    "novacion_aceptada": true,
    "ley_1581_mencionada": true,
    "hubo_objeciones": true,
    "despedida_adecuada": true
  },
  "novacion": {
    "aceptada": true,
    "motivo_no_aplica": "string si aceptada=false; de lo contrario \\"\\""
  },
  "consolidado": {
    "notaFinal": 0,
    "porAtributo": [
      ${NOVACION_ITEMS.map(t =>
        `{"atributo":"${t.replace(/"/g, '\\"')}","aplica":true,"cumplido":true,"justificacion":"", "mejora":""}`
      ).join(',\n      ')}
    ]
  },
  "fraude": {
    "alertas": [
      { "tipo": "novacion_invalida|cuenta_no_oficial|contacto_numero_no_oficial|otro", "cita": "frase breve", "riesgo": "alto|medio|bajo" }
    ],
    "observaciones": "string"
  }
}
`.trim();

  const user = `
CONTEXTO:
- Campaña: ${campania}
- Tipificación: ${tipificacion || '(no especificada)'}
- Reglas por tipificación/campaña:
${extraTip || '(Sin reglas adicionales para esta tipificación.)'}

TRANSCRIPCIÓN:
${String(transcript || '').slice(0, Number(process.env.ANALYSIS_MAX_INPUT_CHARS) || 20000)}

Devuelve SOLO este JSON:
${isNovacionCP ? novacionJsonShape : commonJsonShape}
`.trim();

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: MAX_TOKENS,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  });

  const raw  = completion.choices?.[0]?.message?.content || '';
  const json = forceJson(raw) || {};

  let analisis = {
    agent_name: cleanName(json?.agent_name || ''),
    client_name: cleanName(json?.client_name || ''),
    resumen: json?.resumen || '',
    hallazgos: Array.isArray(json?.hallazgos) ? json.hallazgos : [],
    sugerencias_generales: Array.isArray(json?.sugerencias_generales) ? json.sugerencias_generales : [],
    flags: json?.flags || {},
    fraude: {
      alertas: Array.isArray(json?.fraude?.alertas) ? json.fraude.alertas : [],
      observaciones: json?.fraude?.observaciones || ''
    },
    // campos opcionales (cuando el prompt los incluye)
    novacion: json?.novacion,
    consolidado: json?.consolidado
  };

  // ---- Post-proceso Novación: nota 100/0 y afectados críticos
  if (isNovacionCP) {
    analisis = ensureNovacionConsolidado(analisis);
  }

  // Merge con heurística local anti-fraude (sin duplicar)
  const heur = detectFraudHeuristics(String(transcript || ''));
  if (heur.length) {
    analisis.fraude.alertas = analisis.fraude.alertas || [];
    const seen = new Set(analisis.fraude.alertas.map(a => (a.tipo + '|' + a.cita)));
    for (const a of heur) {
      const k = a.tipo + '|' + a.cita;
      if (!seen.has(k)) { analisis.fraude.alertas.push(a); seen.add(k); }
    }
  }

  return analisis;
}
