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

/* ==================== Reglas por TIPIFICACIÓN (genéricas) ==================== */
const TIPI_RULES = {
  'promesa de pago': `
- Si el cliente muestra intención de pago, extrae (si aparece) MONTO, FECHA y CANAL de pago.
- Prioriza confirmar: fecha concreta, monto concreto, canal OFICIAL (ej.: ${OFFICIAL_PAY_CHANNELS.join(', ')}).
- Si no están los tres, sugiere en hallazgos precisar los faltantes (sin inventarlos).`.trim(),

  'recordatorio de pago': `
- Llamada de recordatorio simple: no marques falta de negociación u objeciones si el cliente solo confirma.
- Registra beneficios/consecuencias y canal oficial si aparecen.`.trim(),

  'acuerdo de pago': `
- Si hay acuerdo, extrae monto(s), fecha(s) y canal oficial. Si no se cierra, marca "negociacion_en_proceso".`.trim(),

  // estos se inyectan dinámicamente por campaña:
  'novacion': '',
  'propuesta de pago': '',
  'abono': ''
};

/** Normaliza tipificación para indexar TIPI_RULES */
function keyTipi(t = '') {
  return String(t || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/* =============== Ítems críticos por caso =============== */
/** Propuesta de pago — mantiene los 11 ítems originales */
const PP_ITEMS = [
  '1. Informa beneficios y consecuencias de no pago',
  '2. Realiza proceso completo de confirmación de la negociación',
  '3. Indaga motivo del no pago',
  '4. Solicita autorización para contacto por otros medios',
  '5. Despedida según guion establecido',
  '6. Ofrece alternativas acordes a la realidad del cliente y políticas vigentes',
  '7. Debate objeciones según situación del cliente',
  '8. Informa que la llamada es grabada y monitoreada (Ley 1581)',
  '9. Usa guion completo establecido por la campaña',
  '10. Evita argumentos engañosos con el cliente',
  '11. Utiliza vocabulario prudente y respetuoso'
];

/** Abono — solo los 8 ítems validados */
const ABONO_ITEMS = [
  '1. Informa beneficios y consecuencias de no pago',
  '2. Indaga motivo del no pago',
  '3. Despedida según guion establecido',
  '4. Debate objeciones según situación del cliente',
  '5. Informa que la llamada es grabada y monitoreada (Ley 1581)',
  '6. Usa guion completo establecido por la campaña',
  '7. Evita argumentos engañosos con el cliente',
  '8. Utiliza vocabulario prudente y respetuoso'
];

const NOVACION_ITEMS = [
  '1. Informa beneficios y consecuencias de aceptar la novación',
  '2. Realiza proceso completo de confirmación de la novación (monto, cuotas, tasa y plazos)',
  '3. Indaga motivo por el cual el titular requiere la novación',
  '4. Solicita autorización para contacto por otros medios',
  '5. Despedida según guion establecido',
  '6. Explica correctamente condiciones del nuevo crédito (cuotas, tasas, beneficios)',
  '7. Gestiona objeciones sobre tasa o plazo con argumentos claros',
  '8. Informa grabación y monitoreo conforme Ley 1581',
  '9. Usa el guion completo establecido para novación',
  '10. Evita argumentos engañosos o coercitivos',
  '11. Utiliza vocabulario prudente y respetuoso'
];

/* =============== Prompts específicos por caso =============== */
function strictEvidenceBlock() {
  return `
REGLA DE EVIDENCIA (muy estricta):
• Para marcar **cumplido=true** en un ítem, la "justificacion" DEBE incluir **una cita textual entre comillas** extraída de la transcripción (≈8+ palabras) y, si existe, el tiempo aproximado (“00:38”).
• Si **no hay cita literal**, escribe "no_evidencia" y pon **cumplido=false**.
• Frases genéricas (“sí, correcto”, “perfecto”, “quedo pendiente por WhatsApp”) **no valen** como evidencia.
• No infieras ni parafrasees sin cita: ante duda, **no_evidencia**.
`.trim();
}

/* --- Novación (Carteras Propias) --- */
function buildNovacionExtraPrompt() {
  return `
EVALUACIÓN ESPECÍFICA — NOVACIÓN (Carteras Propias)
Definición: el titular acepta un **nuevo crédito** con Contacto Solutions para saldar la deuda anterior (nuevo contrato; 5–68 cuotas; nueva tasa/plazo).

DECISIÓN PREVIA:
• Si **NO** hay aceptación formal de novación:
  - "novacion.aceptada": false
  - "novacion.motivo_no_aplica": "No aplica — sin aceptación formal de novación."
  - En "consolidado.porAtributo": marca todos "aplica": false
  - "consolidado.notaFinal": 0
  - En "fraude.alertas": { "tipo":"novacion_invalida", "riesgo":"alto", "cita":"frase breve verificable" }
  - FIN.

${strictEvidenceBlock()}

ÍTEMS CRÍTICOS (peso 100% si aplica):
${NOVACION_ITEMS.map(s => `- ${s}`).join('\n')}

CÁLCULO DE NOTA (binaria):
• Considera solo ítems con "aplica": true.
• Si **alguno** aplicable tiene "cumplido": false → **notaFinal = 0**.
• Si **todos** los aplicables tienen "cumplido": true → **notaFinal = 100**.
• Si ningún ítem aplica (caso raro), notaFinal = 100 (no penaliza).

FRAUDE:
• Además de “novacion_invalida”, marca:
  - "cuenta_no_oficial" cuando pidan consignar/transferir a canal NO oficial.
  - "contacto_numero_no_oficial" por números personales o WhatsApp personal.
`.trim();
}

/* --- Propuesta de pago (Carteras Propias) --- */
function buildPropuestaPagoExtraPrompt() {
  return `
EVALUACIÓN ESPECÍFICA — PROPUESTA DE PAGO (Carteras Propias)
Definición: el cliente **acepta y se compromete** al pago (negociación cerrada), definiendo **monto y/o fecha y/o medio** de pago.

DECISIÓN PREVIA:
• Si **NO** hay propuesta de pago (no hay compromiso verbal claro), devuelve:
  - "propuesta_pago.aceptada": false
  - "propuesta_pago.motivo_no_aplica": "No aplica — sin propuesta de pago."
  - Marca todos los ítems con "aplica": false
  - "consolidado.notaFinal": 0
  - FIN.

${strictEvidenceBlock()}

ÍTEMS CRÍTICOS (peso 100% si aplica):
${PP_ITEMS.map(s => `- ${s}`).join('\n')}

REGLA ESPECÍFICA — DESPEDIDA SEGÚN GUION (ítem 5):
• Para **cumplir**, en la **parte final** de la llamada (último 25% del tiempo) debe existir una despedida que contenga al menos **dos** de estos tres elementos:
  1) **Identificación del agente + empresa** en una forma cercana al guion:
     - Variantes válidas: "Habló con/Le habló Soy [Nombre] de Contacto Solution(s)/Novartec".
     - Se acepta solo el **nombre** o primer nombre del agente.
  2) **Agradecimiento**: “gracias”, “muchas gracias”, “agradezco su atención/tiempo”.
  3) **Buen deseo**: “feliz día/tarde/noche”, “que esté muy bien”, “un excelente día”.
• Ejemplos que **sí cumplen**:
  - "Le habló Ana de Contacto Solutions, muchas gracias, feliz día."
  - "Soy Juan de Novartec, gracias por su tiempo, un excelente día."
• Ejemplos que **NO cumplen**:
  - Solo “gracias, hasta luego” (sin empresa ni buen deseo).
  - Menciones sueltas de la empresa en medio de la llamada que no formen la despedida.
• La **justificación** debe citar literalmente la frase de cierre (con hora aproximada). Si no hay evidencia suficiente → **cumplido=false** para el ítem 5.

ACLARACIONES:
- En (2) “confirmación completa de la negociación”, para **cumplir** exige confirmación **explícita** de monto **y** fecha **y** medio oficial de pago. Si falta cualquiera → **no cumple**.
- En (6) alternativas, valida que sean acordes a la realidad del cliente y a políticas vigentes.

CÁLCULO DE NOTA (binaria):
• Solo ítems con "aplica": true.
• Si **alguno** aplicable es "cumplido=false" → **notaFinal = 0**.
• Si **todos** los aplicables son "cumplido=true" → **notaFinal = 100**.
• Si nada aplica, **notaFinal = 100** (no penaliza).

FRAUDE:
• Canales NO oficiales de pago → "cuenta_no_oficial".
• Contactos NO oficiales (número personal/WhatsApp) → "contacto_numero_no_oficial".
`.trim();
}

/* --- Abono (Carteras Propias) --- */
function buildAbonoExtraPrompt() {
  return `
EVALUACIÓN ESPECÍFICA — ABONO (Carteras Propias)
Definición (operativa): **ABONO** es cuando el cliente se **compromete a realizar un pago parcial** (no liquida la totalidad) **sobre un ACUERDO VIGENTE**, con el fin explícito de **no perder dicho acuerdo ni sus beneficios** (p. ej., descuento, condiciones pactadas).

DECISIÓN PREVIA (clasificación antes de puntuar):
• Marca **"abono.aceptado": true** SOLO si se cumplen ambos criterios en la transcripción:
  A) **Existe ACUERDO VIGENTE** (evidencia textual de “acuerdo/negociación/compromiso vigente”, “para no perder el acuerdo/descuento/beneficio”, “mantener el acuerdo”, etc.).
  B) **Compromiso de PAGO PARCIAL** por parte del cliente (el cliente dice que hará un **abono**/pago parcial). Idealmente con **monto** y/o **fecha** y, si aparece, **canal oficial**.
  — Nota: Si el cliente habla de pagar **todo** o cerrar la obligación completa, eso corresponde a **Propuesta de pago** (no ABONO).

• Si **NO** se cumplen A y B:
  - "abono.aceptado": false
  - "abono.motivo_no_aplica": "No aplica — sin evidencia de acuerdo vigente y/o sin compromiso de pago parcial (abono)."
  - En "consolidado.porAtributo": marca todos los ítems con "aplica": false
  - "consolidado.notaFinal": 0
  - FIN.

${strictEvidenceBlock()}

ÍTEMS CRÍTICOS (peso 100% si aplica):
${ABONO_ITEMS.map(s => `- ${s}`).join('\n')}

ACLARACIONES DE EVIDENCIA PARA ABONO:
• El carácter **parcial** debe quedar claro (citas como: “haré un abono”, “pago parcial”, “no puedo pagar todo pero realizo un abono”, etc.).
• El **acuerdo vigente** debe mencionarse de forma explícita o implícita verificable (citas como: “para no perder el acuerdo/descuento/beneficio”, “mantener el acuerdo que tengo”, “con el convenio/negociación actual”, etc.).
• Si hay **monto y/o fecha** y **canal oficial**, inclúyelos en la justificación cuando corresponda; si faltan, no los inventes.

CÁLCULO DE NOTA (binaria):
• Considera solo ítems con "aplica": true.
• Si **alguno** aplicable tiene "cumplido": false → **notaFinal = 0**.
• Si **todos** los aplicables tienen "cumplido": true → **notaFinal = 100**.
• Si ningún ítem aplica (caso raro manteniendo A y B), notaFinal = 100 (no penaliza).

FRAUDE:
• Señala "cuenta_no_oficial" cuando se pida consignar/transferir a canal NO oficial.
• Señala "contacto_numero_no_oficial" por uso de números/WhatsApp personales.
`.trim();
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

/** Regla binaria 100/0; si no aceptado → 0; si no hay aplicables → 100 (no penaliza) */
function computeBinaryScore(porAtrib = [], accepted = true) {
  if (!accepted) return 0;
  const aplicables = porAtrib.filter(a => a.aplica === true);
  if (aplicables.length === 0) return 100;
  const anyFail = aplicables.some(a => a.cumplido === false);
  return anyFail ? 0 : 100;
}

function ensureBlock(list, _labels) {
  // Si el modelo no devolvió todos los ítems, no forzamos completarlos,
  // pero sí mantenemos lo recibido consistente.
  return normalizePorAtributo(Array.isArray(list) ? list : []);
}

function ensureConsolidadoForType(analisis = {}, type) {
  let accepted = true;
  let rawPorAttr = [];

  if (type === 'novacion') {
    accepted = analisis?.novacion?.aceptada !== false;
    rawPorAttr = analisis?.consolidado?.porAtributo;
    // Garantiza fraude si explícitamente no aceptada
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
  }

  if (type === 'propuesta_pago') {
    accepted = analisis?.propuesta_pago?.aceptada !== false;
    rawPorAttr = analisis?.consolidado?.porAtributo;
  }

  if (type === 'abono') {
    accepted = analisis?.abono?.aceptado !== false;
    rawPorAttr = analisis?.consolidado?.porAtributo;
  }

  const porAtributo = ensureBlock(rawPorAttr);
  const nota = computeBinaryScore(porAtributo, accepted);
  const afectadosCriticos = deriveAffectedCriticos(porAtributo);

  analisis.consolidado = {
    ...(analisis.consolidado || {}),
    notaFinal: nota,
    porAtributo,
    afectadosCriticos
  };
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
  const campKey = keyTipi(campania);

  const isCP = campKey === 'carteras propias';
  const isNovacionCP      = isCP && (tipKey === 'novacion' || tipKey === 'novación');
  const isPropuestaPagoCP = isCP && (tipKey === 'propuesta de pago' || tipKey === 'propuesta_pago');
  const isAbonoCP         = isCP && (tipKey === 'abono');

  // ---- System prompt (siempre con canales oficiales para marcar fraude) ----
  const system = `
Eres un analista de calidad experto en Contact Center. Evalúas transcripciones y devuelves JSON ESTRICTO en español, **sin texto adicional**.
No inventes datos. Si algo no aparece en la transcripción, indícalo como "no_evidencia".
Canales OFICIALES de pago: ${OFFICIAL_PAY_CHANNELS.join(', ')}.
Marca alertas de FRAUDE si el agente pide consignar/transferir a canal NO oficial o da un contacto NO oficial (otro número/WhatsApp personal). Incluye cita breve.
`.trim();

  // ---- Extra prompt específico por tipificación/campaña ----
  let extraTip = (TIPI_RULES[tipKey] || '');
  if (isNovacionCP)       extraTip = buildNovacionExtraPrompt();
  if (isPropuestaPagoCP)  extraTip = buildPropuestaPagoExtraPrompt();
  if (isAbonoCP)          extraTip = buildAbonoExtraPrompt();

  // ---- Instrucciones de salida (JSON) ----
  const commonJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \\"\\")",
  "client_name": "string (si no hay evidencia, \\"\\")",
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
  "agent_name": "string (si no hay evidencia, \\"\\")",
  "client_name": "string (si no hay evidencia, \\"\\")",
  "resumen": "100-150 palabras (claridad de oferta, consentimiento, 1581/1266 si aplica, objeciones, tono)",
  "hallazgos": ["3-6 bullets operativos y específicos sobre lo que sí aparece"],
  "sugerencias_generales": ["2-4 puntos accionables de mejora"],
  "flags": { "novacion_aceptada": true, "ley_1581_mencionada": true, "hubo_objeciones": true, "despedida_adecuada": true },
  "novacion": { "aceptada": true, "motivo_no_aplica": "" },
  "consolidado": {
    "notaFinal": 0,
    "porAtributo": [
      ${NOVACION_ITEMS.map(t =>
        `{"atributo":"${t.replace(/"/g, '\\"')}","aplica":true,"cumplido":true,"justificacion":"","mejora":""}`
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

  const propuestaJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \\"\\")",
  "client_name": "string (si no hay evidencia, \\"\\")",
  "resumen": "100-150 palabras (protocolo, legalidad 1581/1266, cierre y tono)",
  "hallazgos": ["3-6 bullets operativos y específicos sobre lo que sí aparece"],
  "sugerencias_generales": ["2-4 puntos accionables de mejora"],
  "flags": { "propuesta_pago_aceptada": true, "ley_1581_mencionada": true, "hubo_objeciones": true, "despedida_adecuada": true },
  "propuesta_pago": { "aceptada": true, "motivo_no_aplica": "" },
  "consolidado": {
    "notaFinal": 0,
    "porAtributo": [
      ${PP_ITEMS.map(t =>
        `{"atributo":"${t.replace(/"/g, '\\"')}","aplica":true,"cumplido":true,"justificacion":"","mejora":""}`
      ).join(',\n      ')}
    ]
  },
  "fraude": {
    "alertas": [
      { "tipo": "cuenta_no_oficial|contacto_numero_no_oficial|otro", "cita": "frase breve", "riesgo": "alto|medio|bajo" }
    ],
    "observaciones": "string"
  }
}
`.trim();

  const abonoJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \\"\\")",
  "client_name": "string (si no hay evidencia, \\"\\")",
  "resumen": "100-150 palabras (protocolo, legalidad 1581/1266, cierre y tono)",
  "hallazgos": ["3-6 bullets operativos y específicos sobre lo que sí aparece"],
  "sugerencias_generales": ["2-4 puntos accionables de mejora"],
  "flags": { "abono_comprometido": true, "ley_1581_mencionada": true, "hubo_objeciones": true, "despedida_adecuada": true },
  "abono": { "aceptado": true, "motivo_no_aplica": "" },
  "consolidado": {
    "notaFinal": 0,
    "porAtributo": [
      ${ABONO_ITEMS.map(t =>
        `{"atributo":"${t.replace(/"/g, '\\"')}","aplica":true,"cumplido":true,"justificacion":"","mejora":""}`
      ).join(',\n      ')}
    ]
  },
  "fraude": {
    "alertas": [
      { "tipo": "cuenta_no_oficial|contacto_numero_no_oficial|otro", "cita": "frase breve", "riesgo": "alto|medio|bajo" }
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
${
  isNovacionCP       ? novacionJsonShape   :
  isPropuestaPagoCP  ? propuestaJsonShape  :
  isAbonoCP          ? abonoJsonShape      :
  commonJsonShape
}
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
    // bloques opcionales (según tipificación)
    novacion: json?.novacion,
    propuesta_pago: json?.propuesta_pago,
    abono: json?.abono,
    consolidado: json?.consolidado
  };

  // ---- Post-proceso por caso para nota 100/0 y afectados críticos
  if (isNovacionCP)       analisis = ensureConsolidadoForType(analisis, 'novacion');
  if (isPropuestaPagoCP)  analisis = ensureConsolidadoForType(analisis, 'propuesta_pago');
  if (isAbonoCP)          analisis = ensureConsolidadoForType(analisis, 'abono');

  // --- Compatibilidad para renderizadores MD antiguos (aliases planos)
  analisis.afectadosCriticos = Array.isArray(analisis?.consolidado?.afectadosCriticos)
    ? analisis.consolidado.afectadosCriticos
    : [];
  analisis.porAtributo = Array.isArray(analisis?.consolidado?.porAtributo)
    ? analisis.consolidado.porAtributo
    : [];

  // --- Compatibilidad: exponer arreglos "errores_criticos" y "alertas_antifraude"
  if (String(process.env.EXPOSE_CRIT_ARRAYS ?? '1') !== '0') {
    const porAttr = Array.isArray(analisis?.consolidado?.porAtributo)
      ? analisis.consolidado.porAtributo
      : [];

    analisis.errores_criticos = porAttr
      .filter(a => a.aplica === true && a.cumplido === false)
      .map(a => ({
        atributo: a.atributo,
        severidad: 'critico',
        justificacion: a.justificacion || 'no_evidencia',
        mejora: a.mejora || ''
      }));

    analisis.alertas_antifraude = Array.isArray(analisis?.fraude?.alertas)
      ? analisis.fraude.alertas
      : [];

    // Aliases por compatibilidad con integraciones antiguas
    analisis.critical_errors  = analisis.errores_criticos;
    analisis.antifraud_alerts = analisis.alertas_antifraude;
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
