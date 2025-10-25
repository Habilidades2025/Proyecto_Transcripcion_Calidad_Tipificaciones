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

  // se inyectan dinámicamente por campaña:
  'novacion': '',
  'propuesta de pago': '',
  'abono': '',
  'pago a cuotas': '',
  // NUEVO: placeholders para tipis nuevas
  'posible negociación': '',
  'renuentes': ''
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

/** Pago a cuotas — (mismos ítems que usabas para "Acuerdo a cuotas") */
const PAGO_CUOTAS_ITEMS = [
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

const NOVACION_ITEMS = [
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

const POSIBLENEG_ITEMS = [
  '1. Informa beneficios y consecuencias de no pago',
  '2. Indaga motivo del no pago',
  '3. Solicita autorización para contacto por otros medios',
  '4. Despedida según guion establecido',
  '5. Ofrece alternativas acordes a la realidad del cliente y políticas vigentes',
  '6. Debate objeciones según situación del cliente',
  '7. Informa que la llamada es grabada y monitoreada (Ley 1581)',
  '8. Usa guion completo establecido por la campaña',
  '9. Evita argumentos engañosos con el cliente',
  '10. Utiliza vocabulario prudente y respetuoso'
];

const RENUENTES_ITEMS = [
  // 10 ítems (ya sin “confirmación completa”)
  '1. Informa beneficios y consecuencias de no pago',
  '2. Indaga motivo del no pago',
  '3. Solicita autorización para contacto por otros medios',
  '4. Despedida según guion establecido',
  '5. Ofrece alternativas acordes a la realidad del cliente y políticas vigentes',
  '6. Debate objeciones según situación del cliente',
  '7. Informa que la llamada es grabada y monitoreada (Ley 1581)',
  '8. Usa guion completo establecido por la campaña',
  '9. Evita argumentos engañosos con el cliente',
  '10. Utiliza vocabulario prudente y respetuoso'
];

/* =============== Prompts específicos por caso =============== */
function strictEvidenceBlock() {
  return `
REGLA DE EVIDENCIA (muy estricta):
• Para marcar **cumplido=true** en un ítem, la "justificacion" DEBE incluir **cita literal** (≈8+ palabras) y, si existe, el tiempo (“00:38”).
• Si **no hay cita literal**, escribe "no_evidencia" y pon **cumplido=false**.
• Frases genéricas (“sí, correcto”, “perfecto”) **no valen** como evidencia.
• No infieras ni parafrasees: ante duda, **no_evidencia**.

REGLAS DE VALIDACIÓN ESPECÍFICAS:
• “Indaga motivo del no pago”: la cita debe ser **la pregunta del agente** (p.ej., “¿Cuál es el motivo…?”, “¿Por qué no ha podido…?”, “¿Qué le impidió…?”). Si la justificación es solo una **respuesta del cliente** o una **preocupación** del cliente → **no_evidencia**.
• “Ley 1581”: la cita debe contener **“1581”** (acepta dígitos con espacios: “15 81”) o una mención explícita a **protección/tratamiento de datos** + “ley”. “Llamada grabada” sin “1581” **no es suficiente**.
• “Autorización para otros medios”: la evidencia debe mostrar **pregunta de autorización** y **aceptación del cliente**. Pedir “envíe el soporte por WhatsApp” **no es autorización**.
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
• Para **cumplir**, en la **parte final** de la llamada (último 25%) debe existir una despedida que contenga al menos **dos** de estos tres elementos:
  1) **Identificación del agente + empresa** (variantes válidas: “Habló con…/Le habló…/Soy… [Nombre] de Contacto Solutions/Novartec/Novatech”).
  2) **Agradecimiento**.
  3) **Buen deseo**.
• Citar literalmente la frase de cierre (con hora). Si no hay evidencia suficiente → **cumplido=false**.

ACLARACIONES:
- En “confirmación completa de la negociación”, exige monto **y** fecha **y** medio oficial.

CÁLCULO DE NOTA (binaria):
• Solo ítems con "aplica": true.
• Si **alguno** aplicable es "cumplido=false" → **notaFinal = 0**.
• Si **todos** los aplicables son "cumplido=true" → **notaFinal = 100**.
• Si nada aplica, **notaFinal = 100**.

FRAUDE:
• Canales NO oficiales de pago → "cuenta_no_oficial".
• Contactos NO oficiales (número personal/WhatsApp) → "contacto_numero_no_oficial".
`.trim();
}

/* --- Abono (Carteras Propias) --- */
function buildAbonoExtraPrompt() {
  return `
EVALUACIÓN ESPECÍFICA — ABONO (Carteras Propias)
Definición (operativa): **ABONO** = compromiso de **pago parcial** sobre un **acuerdo vigente** para **no perder** el acuerdo.

DECISIÓN PREVIA:
• Marca "abono.aceptado": true SOLO si:
  A) hay **acuerdo vigente**, y
  B) hay **compromiso de pago parcial** (ideal con monto/fecha y canal oficial).
• Si NO: "abono.aceptado": false; todos "aplica": false; "notaFinal": 0; FIN.

${strictEvidenceBlock()}

ÍTEMS CRÍTICOS (peso 100% si aplica):
${ABONO_ITEMS.map(s => `- ${s}`).join('\n')}

CÁLCULO DE NOTA (binaria):
• Considera solo ítems con "aplica": true.
• Algún aplicable en false → **0**.
• Todos true → **100**.
• Ninguno aplica → **100**.

FRAUDE:
• "cuenta_no_oficial" cuando pidan consignar a canal NO oficial.
• "contacto_numero_no_oficial" por números/WhatsApp personales.
`.trim();
}

/* --- Pago a cuotas --- */
function buildPagoCuotasExtraPrompt() {
  return `
EVALUACIÓN ESPECÍFICA — PAGO A CUOTAS (Carteras Propias)
Definición: plan en cuotas con **número de cuotas**, **valor por cuota**, **fecha de inicio** y (si aparece) **canal oficial**.

DECISIÓN PREVIA:
• Si **NO** hay aceptación formal: "pago_cuotas.aceptado": false; todas "aplica": false; nota 0; FIN.

${strictEvidenceBlock()}

REGLAS POR ÍTEM (citas literales):
1) Beneficios y consecuencias: ≥1 beneficio **y** ≥1 consecuencia.
2) Confirmación completa: número de cuotas + valor por cuota + primera fecha + canal oficial.
3) Indaga motivo: pregunta abierta real.
4) Autorización: evidencia explícita de autorización.
5) Despedida: ver regla.
6) Alternativas acordes a política.
7) Objeciones: si **no hubo**, **aplica=false** (no penaliza).
8) Ley 1581: debe verse “1581” (acepta “15 81”).
9) Guion: solo recaudo **corporativo** y **canales oficiales**.
10) Evita argumentos engañosos.
11) Vocabulario prudente y respetuoso.

ÍTEMS CRÍTICOS:
${PAGO_CUOTAS_ITEMS.map(s => `- ${s}`).join('\n')}

CÁLCULO DE NOTA:
• Algún aplicable false → 0; todos true → 100; nada aplica → 100.
`.trim();
}

/* --- Posible negociación — (calibrada) --- */
function buildPosibleNegociacionExtraPrompt() {
  return `
EVALUACIÓN — POSIBLE NEGOCIACIÓN (Carteras Propias)
Definición: el cliente muestra **disposición** a negociar/recibir información **sin** compromiso formal (no hay monto/fecha/medio cerrados).

DECISIÓN PREVIA:
• Si **NO** hay señales claras de posible negociación:
  - "posible_negociacion.aplica": false
  - "posible_negociacion.motivo_no_aplica": "No aplica — sin posible negociación."
  - Todas "aplica": false; "notaFinal": 0; FIN.

${strictEvidenceBlock()}

VOCABULARIO VÁLIDO (beneficios/consecuencias):
• Beneficios (ejemplos): **descuento**, **condonación de intereses/mora**, **normalización**, **evitar reporte negativo**, **reactivación**, **acceso a acuerdo/plan**.
• Consecuencias (ejemplos): **reporte en centrales**, **proceso jurídico/embargos**, **incremento de intereses/cargos por mora**, **bloqueo/cancelación**.
• **No válido** para #1: “estafa”, “publicación”, “miedo”, u otras frases que **no** sean beneficio/consecuencia **de no pago**.

REGLAS POR ÍTEM:
1) Beneficios+consecuencias: requiere ≥1 de cada tipo con **citas**. “Estafa/publicación” **no cuentan**.
2) Indaga motivo: **pregunta abierta del agente**; respuestas del cliente **no sustituyen** la pregunta.
3) Autorización otros medios: **pregunta de autorización** + **aceptación**.
4) Despedida (guion): se acepta como **cumple** si hay **identificación del agente + empresa** (p.ej., “Recuerde que le habló … de Novartec/Contacto Solutions”), aunque no haya agradecimiento/deseo.
6) Objeciones: si **no hubo**, marca **aplica=false** y **cumplido=true**.
7) Ley 1581: aceptar también **“15 81”** con espacios.
8) Guion (canales oficiales): aclarar que **solo** se recauda a **cuentas/canales corporativos** (variantes válidas).

CÁLCULO DE NOTA:
• Solo ítems con "aplica": true. Algún false → 0; todos true → 100; nada aplica → 100.

FRAUDE:
• "cuenta_no_oficial" ante consignación a canal NO oficial.
• "contacto_numero_no_oficial" por número/WhatsApp personal.
`.trim();
}

/* --- Renuentes (actualizado a 10 ítems, sin “confirmación completa”) --- */
function buildRenuenteExtraPrompt() {
  return `
EVALUACIÓN — CLIENTE RENUENTE (Carteras Propias)
Definición: el titular evita comprometerse (resistencia activa/pasiva).

DECISIÓN PREVIA:
• Si no hay renuencia: "renuente.aplica": false; todas "aplica": false; nota 0; FIN.

${strictEvidenceBlock()}

APLICABILIDAD Y REGLAS:
• Ítem 5 (alternativas) y 6 (objeciones): si no se presentan, **aplica=false**.
• Resto igual que en Pago a cuotas.

ÍTEMS CRÍTICOS:
${RENUENTES_ITEMS.map(s => `- ${s}`).join('\n')}

CÁLCULO:
• Algún aplicable false → 0; todos true → 100; nada aplica → 100.
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
  return normalizePorAtributo(Array.isArray(list) ? list : []);
}

function ensureConsolidadoForType(analisis = {}, type) {
  let accepted = true;
  let rawPorAttr = [];

  if (type === 'novacion') {
    accepted = analisis?.novacion?.aceptada !== false;
    rawPorAttr = analisis?.consolidado?.porAtributo;
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

  if (type === 'pago_cuotas') {
    accepted = analisis?.pago_cuotas?.aceptado !== false;
    rawPorAttr = analisis?.consolidado?.porAtributo;
  }

  if (type === 'posible_negociacion') {
    accepted = analisis?.posible_negociacion?.aplica !== false;
    rawPorAttr = analisis?.consolidado?.porAtributo;
  }

  if (type === 'renuente') {
    accepted = analisis?.renuente?.aplica !== false;
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

/* ===== Helpers de calibración SOLO para "Posible negociación" ===== */
function norm(s='') {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function findLey1581(text='') {
  const t = norm(text);
  const m = /ley\s*1\s*5\s*8\s*1\b|\b1\s*5\s*8\s*1\b|\b1581\b/.exec(t);
  return m ? m[0] : null;
}
function containsCompany(s='') {
  const t = norm(s);
  return (
    t.includes('novartec') ||
    t.includes('novatec') ||
    t.includes('novatech') ||
    t.includes('novartek') ||
    t.includes('contacto solution') ||
    t.includes('contacto solutions') ||
    t.includes('contact solution') ||
    t.includes('contact solutions') ||
    t.includes('contacto a solution') ||
    t.includes('contacto a solutions')
  );
}
function containsAgentIdPhrase(s='') {
  const t = norm(s);
  return (
    t.includes('recuerde que le hablo') ||
    t.includes('recuerde que le hablo') ||
    t.includes('le hablo ') || t.includes('le hablo,') ||
    t.includes('le hablo.') || t.includes('le hablo;') ||
    t.includes('le hablo') || t.includes('le hablo') ||
    t.includes('le hablo') ||
    t.includes('le hablo') ||
    t.includes('le habló') || t.includes('le hablo') || t.includes('le hablo') ||
    t.includes('hablo con') || t.includes('habló con') ||
    t.includes('soy ') || t.includes('mi nombre')
  );
}
function findFarewellEvidence(just='', transcript='') {
  // 1) ¿Ya viene en la justificación?
  if (just && containsAgentIdPhrase(just) && containsCompany(just)) return just;
  // 2) Buscar en la transcripción líneas con “Agente: …”
  const lines = String(transcript||'').split(/\r?\n/);
  for (const ln of lines.reverse()) {
    const l = ln.trim();
    if (!l) continue;
    const lower = norm(l);
    if ((lower.includes('agente:') || lower.includes('asesor:') || lower.includes('asesora:') || true) &&
        containsAgentIdPhrase(l) && containsCompany(l)) {
      return l.slice(0, 220);
    }
  }
  // 3) Búsqueda laxa
  const t = String(transcript||'');
  if (containsAgentIdPhrase(t) && containsCompany(t)) {
    const idx = norm(t).indexOf('habl');
    const start = Math.max(0, idx - 60);
    return t.slice(start, start + 220);
  }
  return null;
}
const BENEFICIO_LEX = [
  'descuento','condonacion','condonación','normalizacion','normalización',
  'evitar reporte','quitar reporte','levantar reporte','mejorar calificacion','reactivacion','reactivación',
  'plan de pagos','acuerdo de pago','acceso a acuerdo','financiacion','financiación','reliquidacion','novacion','novación'
];
const CONSECUENCIA_LEX = [
  'reporte','centrales','juridico','jurídico','embargo','proceso','prejuridico','prejurídico',
  'intereses','mora','incremento','castigo','bloqueo','cancelacion','cancelación','suspension','suspensión',
  'traslado a juridica','juridica','jurídica'
];
const INVALID_BENCONS = ['estafa','publicacion','publicación','miedo','preocupacion','preocupación'];

function hasAnyLex(s='', lex=[]) {
  const t = norm(s);
  return lex.some(k => t.includes(norm(k)));
}
function hasBenefitAndConsequence(text='') {
  const t = norm(text);
  if (INVALID_BENCONS.some(k => t.includes(k))) return false;
  const hasB = hasAnyLex(t, BENEFICIO_LEX);
  const hasC = hasAnyLex(t, CONSECUENCIA_LEX);
  return hasB && hasC;
}

// --- NUEVO: evidencia de guion corporativo/empresarial (no valen listados de bancos) ---
function hasCorporateChannelEvidence(text='') {
  const t = norm(text);
  if (
    t.includes('cuentas empres') || t.includes('cuenta empres') ||
    t.includes('cuentas corporativ') || t.includes('canales corporativ') || t.includes('canal corporativ') ||
    t.includes('a nombre de la compan') || t.includes('a nombre de la compañ') || t.includes('a nombre de la empresa') ||
    (t.includes('recaud') && (t.includes('empres') || t.includes('corporativ') || t.includes('compania') || t.includes('compañia') || t.includes('empresa')))
  ) {
    return true;
  }
  return false;
}
function findCorporateEvidenceLine(transcript='') {
  const lines = String(transcript||'').split(/\r?\n/);
  for (const ln of lines) {
    if (hasCorporateChannelEvidence(ln)) return ln;
  }
  return null;
}

function calibratePosibleNegociacion(analisis={}, transcript='') {
  if (!analisis?.consolidado?.porAtributo) return analisis;
  const por = ensureBlock(analisis.consolidado.porAtributo);

  for (const a of por) {
    const label = norm(a?.atributo || '');

    // Ítem 4 — Despedida según guion establecido (aceptar identificación + empresa)
    if (label.startsWith('4.') && label.includes('despedida')) {
      if (a.aplica !== false && a.cumplido === false) {
        const ev = findFarewellEvidence(a.justificacion, transcript);
        if (ev) {
          a.cumplido = true;
          if (!a.justificacion || a.justificacion === 'no_evidencia') {
            a.justificacion = `"${String(ev).trim()}"`;
          }
        }
      }
    }

    // Ítem 7 — Ley 1581 (aceptar "15 81" y forzar NO CUMPLE si no hay ley)
    if (label.startsWith('7.') || label.includes('1581') || label.includes('grabada')) {
      if (a.aplica !== false) {
        const hasLaw = !!(findLey1581(a.justificacion) || findLey1581(transcript));
        if (hasLaw) {
          a.cumplido = true;
          if (!a.justificacion || a.justificacion === 'no_evidencia') {
            const line = (String(transcript||'').split(/\r?\n/).find(l => findLey1581(l)) || 'Se menciona la ley 1581 (o “15 81”) y tratamiento/protección de datos.');
            a.justificacion = `"${line.trim().slice(0,220)}"`;
          }
        } else {
          a.cumplido = false;
          a.justificacion = 'no_evidencia';
        }
      }
    }

    // Ítem 1 — Beneficios y consecuencias (endurecido)
    if (label.startsWith('1.') && label.includes('beneficios') && label.includes('consecuencias')) {
      const source = a.justificacion && a.justificacion !== 'no_evidencia'
        ? a.justificacion
        : transcript;
      const ok = hasBenefitAndConsequence(source);
      if (!ok) {
        a.cumplido = false;
        if (!a.justificacion || a.justificacion === 'no_evidencia') {
          a.justificacion = 'no_evidencia';
        } else if (INVALID_BENCONS.some(k => norm(a.justificacion).includes(k))) {
          a.justificacion = 'no_evidencia';
        }
      }
    }

    // Ítem 8 — Guion completo (debe aclarar CUENTAS/CANALES CORPORATIVOS/EMPRESARIALES)
    // Listar bancos/medios NO es suficiente.
    if (label.startsWith('8.') || (label.includes('guion') && label.includes('campana'))) {
      if (a.aplica !== false) {
        const source = (a.justificacion && a.justificacion !== 'no_evidencia') ? a.justificacion : transcript;
        const okCorp = hasCorporateChannelEvidence(source) || hasCorporateChannelEvidence(transcript);
        if (okCorp) {
          a.cumplido = true;
          if (!a.justificacion || a.justificacion === 'no_evidencia') {
            const line = findCorporateEvidenceLine(transcript) || 'Se aclara que el recaudo es únicamente por cuentas/canales corporativos a nombre de la compañía.';
            a.justificacion = `"${line.trim().slice(0,220)}"`;
          }
        } else {
          a.cumplido = false;
          a.justificacion = 'no_evidencia';
        }
      }
    }
  }

  analisis.consolidado.porAtributo = por;
  return analisis;
}

/* ===== NUEVO: Calibración SOLO para "Renuentes" (actualizada a 10 ítems) ===== */
function calibrateRenuente(analisis={}, transcript='') {
  if (!analisis?.consolidado?.porAtributo) return analisis;
  const por = ensureBlock(analisis.consolidado.porAtributo);

  for (const a of por) {
    const label = norm(a?.atributo || '');

    // Ítem 4 — Despedida (aceptar identificación + empresa)
    if (label.startsWith('4.') && label.includes('despedida')) {
      if (a.aplica !== false && a.cumplido === false) {
        const ev = findFarewellEvidence(a.justificacion, transcript);
        if (ev) {
          a.cumplido = true;
          if (!a.justificacion || a.justificacion === 'no_evidencia') {
            a.justificacion = `"${String(ev).trim()}"`;
          }
        }
      }
    }

    // Ítem 7 — Ley 1581 (aceptar "15 81"; forzar NO CUMPLE si no hay ley)
    // ¡OJO! No anclamos por número; buscamos '1581' o 'grabada' en el label o evidencia.
    if (label.includes('1581') || label.includes('grabada')) {
      if (a.aplica !== false) {
        const hasLaw = !!(findLey1581(a.justificacion) || findLey1581(transcript));
        if (hasLaw) {
          a.cumplido = true;
          if (!a.justificacion || a.justificacion === 'no_evidencia') {
            const line = (String(transcript||'').split(/\r?\n/).find(l => findLey1581(l)) || 'Se menciona la ley 1581 (o “15 81”) y tratamiento/protección de datos.');
            a.justificacion = `"${line.trim().slice(0,220)}"`;
          }
        } else {
          a.cumplido = false;
          a.justificacion = 'no_evidencia';
        }
      }
    }

    // Ítem 1 — Beneficios y consecuencias (mismo endurecimiento)
    if (label.startsWith('1.') && label.includes('beneficios') && label.includes('consecuencias')) {
      const source = a.justificacion && a.justificacion !== 'no_evidencia'
        ? a.justificacion
        : transcript;
      const ok = hasBenefitAndConsequence(source);
      if (!ok) {
        a.cumplido = false;
        if (!a.justificacion || a.justificacion === 'no_evidencia') {
          a.justificacion = 'no_evidencia';
        } else if (INVALID_BENCONS.some(k => norm(a.justificacion).includes(k))) {
          a.justificacion = 'no_evidencia';
        }
      }
    }

    // Ítem 8 — Guion completo (CUENTAS/CANALES CORPORATIVOS/EMPRESARIALES obligatorios)
    if (label.startsWith('8.') || (label.includes('guion') && label.includes('campana'))) {
      if (a.aplica !== false) {
        const source = (a.justificacion && a.justificacion !== 'no_evidencia') ? a.justificacion : transcript;
        const okCorp = hasCorporateChannelEvidence(source) || hasCorporateChannelEvidence(transcript);
        if (okCorp) {
          a.cumplido = true;
          if (!a.justificacion || a.justificacion === 'no_evidencia') {
            const line = findCorporateEvidenceLine(transcript) || 'Se aclara que el recaudo es únicamente por cuentas/canales corporativos a nombre de la compañía.';
            a.justificacion = `"${line.trim().slice(0,220)}"`;
          }
        } else {
          a.cumplido = false;
          a.justificacion = 'no_evidencia';
        }
      }
    }
  }

  analisis.consolidado.porAtributo = por;
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
  const isNovacionCP       = isCP && (tipKey === 'novacion' || tipKey === 'novación');
  const isPropuestaPagoCP  = isCP && (tipKey === 'propuesta de pago' || tipKey === 'propuesta_pago');
  const isAbonoCP          = isCP && (tipKey === 'abono');
  const isPagoCuotasCP     = isCP && (tipKey === 'pago a cuotas' || tipKey === 'pago_a_cuotas' || tipKey === 'pago cuotas');
  const isPosibleNegociacionCP = isCP && (tipKey === 'posible negociacion' || tipKey === 'posible_negociacion');
  const isRenuentesCP          = isCP && (tipKey === 'renuentes' || tipKey === 'renuente' || tipKey === 'cliente renuente' || tipKey === 'cliente_renuente');

  // ---- System prompt ----
  const system = `
Eres un analista de calidad experto en Contact Center. Evalúas transcripciones y devuelves JSON ESTRICTO en español, **sin texto adicional**.
No inventes datos. Si algo no aparece en la transcripción, indícalo como "no_evidencia".
Canales OFICIALES de pago: ${OFFICIAL_PAY_CHANNELS.join(', ')}.
Marca alertas de FRAUDE si el agente pide consignar/transferir a canal NO oficial o da un contacto NO oficial (otro número/WhatsApp personal). Incluye cita breve.
`.trim();

  // ---- Extra prompt específico por tipificación/campaña ----
  let extraTip = (TIPI_RULES[tipKey] || '');
  if (isNovacionCP)             extraTip = buildNovacionExtraPrompt();
  if (isPropuestaPagoCP)        extraTip = buildPropuestaPagoExtraPrompt();
  if (isAbonoCP)                extraTip = buildAbonoExtraPrompt();
  if (isPagoCuotasCP)           extraTip = buildPagoCuotasExtraPrompt();
  if (isPosibleNegociacionCP)   extraTip = buildPosibleNegociacionExtraPrompt();
  if (isRenuentesCP)            extraTip = buildRenuenteExtraPrompt();

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

  const pagoCuotasJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \\"\\")",
  "client_name": "string (si no hay evidencia, \\"\\")",
  "resumen": "100-150 palabras (condiciones del plan en cuotas, legalidad 1581/1266, objeciones, cierre y tono)",
  "hallazgos": ["3-6 bullets operativos y específicos sobre lo que sí aparece"],
  "sugerencias_generales": ["2-4 puntos accionables de mejora"],
  "flags": { "pago_cuotas_aceptado": true, "ley_1581_mencionada": true, "hubo_objeciones": true, "despedida_adecuada": true },
  "pago_cuotas": { "aceptado": true, "motivo_no_aplica": "" },
  "consolidado": {
    "notaFinal": 0,
    "porAtributo": [
      ${PAGO_CUOTAS_ITEMS.map(t =>
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

  // NUEVO — Shapes para Posible negociación y Renuentes
  const posibleNegJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \\"\\")",
  "client_name": "string (si no hay evidencia, \\"\\")",
  "resumen": "100-150 palabras (señales de disposición, exploración de motivo, alternativas sin comprometer, trazabilidad y tono)",
  "hallazgos": ["3-6 bullets operativos y específicos sobre lo que sí aparece"],
  "sugerencias_generales": ["2-4 puntos accionables de mejora"],
  "flags": { "posible_negociacion_detectada": true, "ley_1581_mencionada": true, "hubo_objeciones": true, "despedida_adecuada": true },
  "posible_negociacion": { "aplica": true, "motivo_no_aplica": "" },
  "consolidado": {
    "notaFinal": 0,
    "porAtributo": [
      ${POSIBLENEG_ITEMS.map(t =>
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

  const renuentesJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \\"\\")",
  "client_name": "string (si no hay evidencia, \\"\\")",
  "resumen": "100-150 palabras (tipo de resistencia, control emocional, reformulación, valor/beneficios, trazabilidad y tono)",
  "hallazgos": ["3-6 bullets operativos y específicos sobre lo que sí aparece"],
  "sugerencias_generales": ["2-4 puntos accionables de mejora"],
  "flags": { "cliente_renuente": true, "ley_1581_mencionada": true, "hubo_objeciones": true, "despedida_adecuada": true },
  "renuente": { "aplica": true, "motivo_no_aplica": "" },
  "consolidado": {
    "notaFinal": 0,
    "porAtributo": [
      ${RENUENTES_ITEMS.map(t =>
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
  isNovacionCP             ? novacionJsonShape        :
  isPropuestaPagoCP        ? propuestaJsonShape       :
  isAbonoCP                ? abonoJsonShape           :
  isPagoCuotasCP           ? pagoCuotasJsonShape      :
  isPosibleNegociacionCP   ? posibleNegJsonShape      :
  isRenuentesCP            ? renuentesJsonShape       :
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
    pago_cuotas: json?.pago_cuotas,
    posible_negociacion: json?.posible_negociacion,  // NUEVO
    renuente: json?.renuente,                        // NUEVO
    // compat histórico por si algo aguas arriba aún lee acuerdo_cuotas
    acuerdo_cuotas: json?.acuerdo_cuotas,
    consolidado: json?.consolidado
  };

  // ===== Calibración SOLO para "Posible negociación" / "Renuentes" (antes de nota y críticos) =====
  if (isPosibleNegociacionCP && analisis?.consolidado?.porAtributo) {
    analisis = calibratePosibleNegociacion(analisis, String(transcript || ''));
  }
  if (isRenuentesCP && analisis?.consolidado?.porAtributo) {
    analisis = calibrateRenuente(analisis, String(transcript || ''));
  }

  // ---- Post-proceso por caso para nota 100/0 y afectados críticos
  if (isNovacionCP)             analisis = ensureConsolidadoForType(analisis, 'novacion');
  if (isPropuestaPagoCP)        analisis = ensureConsolidadoForType(analisis, 'propuesta_pago');
  if (isAbonoCP)                analisis = ensureConsolidadoForType(analisis, 'abono');
  if (isPagoCuotasCP)           analisis = ensureConsolidadoForType(analisis, 'pago_cuotas');
  if (isPosibleNegociacionCP)   analisis = ensureConsolidadoForType(analisis, 'posible_negociacion');
  if (isRenuentesCP)            analisis = ensureConsolidadoForType(analisis, 'renuente');

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
