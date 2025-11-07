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

/**
 * Heurística actualizada:
 * - Solo devuelve los 4 tipos definidos y SIN "riesgo":
 *   1) "No dice número de cuenta"
 *   2) "Dice número de cuenta parcialmente"
 *   3) "Dice número de cuenta diferente"
 *   4) "Indica al cliente que le va a marcar desde otro número"
 */
function detectFraudHeuristics(transcriptText = '') {
  const txt = String(transcriptText || '');
  if (!txt) return [];
  const out = [];
  const push = (tipo, cita) => {
    if (!tipo || !cita) return;
    out.push({ tipo, cita: String(cita).trim().slice(0, 200) });
  };
  const around = (i) => txt.slice(Math.max(0, i - 60), Math.min(txt.length, i + 120)).replace(/\s+/g, ' ').trim();

  // A) Indica al cliente que le va a marcar desde otro número
  const reAltNum = /\b(le\s+(?:voy\s+a\s+)?marcar|le\s+marco|te\s+marco|te\s+llamo|le\s+llamo)\s+desde\s+otro\s+n[úu]mero\b|\bmi\s+(?:whatsapp|celular)\s+es\b|\bn[úu]mero\s+personal\b/ig;
  let m;
  while ((m = reAltNum.exec(txt)) !== null) push('Indica al cliente que le va a marcar desde otro número', around(m.index));

  // B) Cuentas / consignaciones: detectar contexto de pago
  const reContextoBanco = /\b(cuenta|ahorros|corriente|consignar|consignación|transferir|depositar|dep[oó]sito|bancolombia|davivienda|bbva|colpatria|bog[oó]ta|efecty|baloto|nequi|daviplata|convenio)\b/i;
  const hayContextoBanco = reContextoBanco.test(txt);

  // ¿Hay dígitos?
  const hayDigitos = /\d[\d\s.-]{2,}/.test(txt);

  if (hayContextoBanco && !hayDigitos) {
    push('No dice número de cuenta', txt.slice(0, 200));
  }

  // C) Parcial vs diferente
  const reCuenta = /\b(cuenta(?:\s+de\s+(?:ahorros|corriente))?|consignar|consignación|transferir|dep[oó]sitar|nequi|daviplata|bancolombia|davivienda|bbva|colpatria|banco\s+de\s+bog[oó]t[aá]|efecty|baloto|convenio)\b[\s\S]{0,60}(\b\d[\d\s.-]{1,}\b)/ig;
  const onlyDigits = (s='') => String(s).replace(/\D/g, '');
  const looksMasked = (s='') => /(?:\*|x){2,}|termina(?:do)?\s+en\s+\d{2,4}/i.test(String(s));

  while ((m = reCuenta.exec(txt)) !== null) {
    const crudo = m[2];
    const dig = onlyDigits(crudo);
    if (looksMasked(crudo) || dig.length < 8) {
      push('Dice número de cuenta parcialmente', around(m.index));
    } else {
      if (dig.length >= 8 && dig.length <= 14) {
        push('Dice número de cuenta diferente', around(m.index));
      } else {
        push('Dice número de cuenta parcialmente', around(m.index));
      }
    }
  }

  // dedup
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
  '1. Indaga motivo del no pago',
  '2. Debate objeciones según situación del cliente',
  '3. Informa que la llamada es grabada y monitoreada (Ley 1581)',
  '4. Usa guion completo establecido por la campaña',
  '5. Evita argumentos engañosos con el cliente',
  '6. Utiliza vocabulario prudente y respetuoso'
];

function getItemsForType(type) {
  switch (type) {
    case 'novacion':             return NOVACION_ITEMS;
    case 'propuesta_pago':       return PP_ITEMS;
    case 'abono':                return ABONO_ITEMS;
    case 'pago_cuotas':          return PAGO_CUOTAS_ITEMS;
    case 'posible_negociacion':  return POSIBLENEG_ITEMS;
    case 'renuente':             return RENUENTES_ITEMS;
    default:                     return [];
  }
}


/* ===== Mapa de ítems por tipificación ===== */
const ITEMS_BY_TIPKEY = {
  'novacion': NOVACION_ITEMS,
  'novación': NOVACION_ITEMS,
  'propuesta de pago': PP_ITEMS,
  'propuesta_pago': PP_ITEMS,
  'abono': ABONO_ITEMS,
  'pago a cuotas': PAGO_CUOTAS_ITEMS,
  'pago_a_cuotas': PAGO_CUOTAS_ITEMS,
  'pago cuotas': PAGO_CUOTAS_ITEMS,
  'posible negociacion': POSIBLENEG_ITEMS,
  'posible_negociacion': POSIBLENEG_ITEMS,
  'renuentes': RENUENTES_ITEMS,
  'renuente': RENUENTES_ITEMS,
  'cliente renuente': RENUENTES_ITEMS,
  'cliente_renuente': RENUENTES_ITEMS
};
function getItemsForTipKey(tipKey = '') {
  const k = keyTipi(tipKey);
  return ITEMS_BY_TIPKEY[k] || [];
}

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
  - "consolidado.notaFinal": 100 (no penaliza por mal tipificación)
  - FIN.

${strictEvidenceBlock()}

ÍTEMS CRÍTICOS (peso 100% si aplica):
${NOVACION_ITEMS.map(s => `- ${s}`).join('\n')}

CÁLCULO DE NOTA (binaria):
• Considera solo ítems con "aplica": true.
• Si **alguno** aplicable tiene "cumplido": false → **notaFinal = 0**.
• Si **todos** los aplicables tienen "cumplido": true → **notaFinal = 100**.
• Si ningún ítem aplica (caso raro), notaFinal = 100 (no penaliza).

FRAUDE (solo tipos permitidos + "cita"):
• "No dice número de cuenta"
• "Dice número de cuenta parcialmente"
• "Dice número de cuenta diferente"
• "Indica al cliente que le va a marcar desde otro número"
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
  - "consolidado.notaFinal": 100 (no penaliza por mal tipificación)
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

FRAUDE (solo tipos permitidos + "cita"):
• "No dice número de cuenta"
• "Dice número de cuenta parcialmente"
• "Dice número de cuenta diferente"
• "Indica al cliente que le va a marcar desde otro número"
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
• Si NO: "abono.aceptado": false; todos "aplica": false; "notaFinal": 100 (no penaliza por mal tipificación); FIN.

${strictEvidenceBlock()}

ÍTEMS CRÍTICOS (peso 100% si aplica):
${ABONO_ITEMS.map(s => `- ${s}`).join('\n')}

CÁLCULO DE NOTA (binaria):
• Considera solo ítems con "aplica": true.
• Algún aplicable en false → **0**.
• Todos true → **100**.
• Ninguno aplica → **100**.

FRAUDE (solo tipos permitidos + "cita"):
• "No dice número de cuenta"
• "Dice número de cuenta parcialmente"
• "Dice número de cuenta diferente"
• "Indica al cliente que le va a marcar desde otro número"
`.trim();
}

/* --- Pago a cuotas --- */
function buildPagoCuotasExtraPrompt() {
  return `
EVALUACIÓN ESPECÍFICA — PAGO A CUOTAS (Carteras Propias)
Definición: plan en cuotas con **número de cuotas**, **valor por cuota**, **fecha de inicio** y (si aparece) **canal oficial**.

DECISIÓN PREVIA:
• Si **NO** hay aceptación formal: "pago_cuotas.aceptado": false; todas "aplica": false; nota 100 (no penaliza por mal tipificación); FIN.

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

FRAUDE (solo tipos permitidos + "cita"):
• "No dice número de cuenta"
• "Dice número de cuenta parcialmente"
• "Dice número de cuenta diferente"
• "Indica al cliente que le va a marcar desde otro número"
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
  - Todas "aplica": false; "notaFinal": 100 (no penaliza por mal tipificación); FIN.

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

FRAUDE (solo tipos permitidos + "cita"):
• "No dice número de cuenta"
• "Dice número de cuenta parcialmente"
• "Dice número de cuenta diferente"
• "Indica al cliente que le va a marcar desde otro número"
`.trim();
}

/* --- Renuentes (actualizado a 10 ítems, sin “confirmación completa”) --- */
function buildRenuenteExtraPrompt() {
  return `
EVALUACIÓN — CLIENTE RENUENTE (Carteras Propias)
Definición operativa: el titular evita comprometerse (resistencia activa o pasiva). Se considera renuente cuando hay negativa explícita, evasión sostenida, dilación recurrente o bloqueo de la gestión (p. ej., interrumpe, cambia de tema, no permite argumentar).

DECISIÓN PREVIA (aplicabilidad del caso):
• Si NO hay señales razonables de renuencia (p. ej., corte técnico inmediato sin interacción real), devuelve:
  - "renuente.aplica": false
  - "renuente.motivo_no_aplica": "No aplica — sin evidencia suficiente de renuencia."
  - Marca todos los ítems con "aplica": false (no penaliza)
  - "consolidado.notaFinal": 100
  - FIN.
• Si SÍ hay renuencia (aunque el cliente cuelgue luego), devuelve:
  - "renuente.aplica": true
  - Evalúa ítems con la regla de evidencia (abajo).
  - Cuando el **corte/cuélgue del cliente** impida ejecutar un ítem, usa **"aplica": false** y en "justificacion" escribe **"no_aplica_por_corte_cliente"** (no penaliza).
  - Nunca marques "cumplido=false" por un ítem que el asesor **no pudo ejecutar** por corte del cliente.

${strictEvidenceBlock()}

DETECCIÓN DE CORTE/INTERRUPCIÓN DEL CLIENTE (neutralizar ítems imposibilitados):
Considera como **corte del cliente** cuando se observe alguno de estos patrones, especialmente en los **últimos turnos**:
• Cliente dice: “un momento”, “permítame”, “espéreme”, “deme un segundo/segundito”, “ya le confirmo”, y **no vuelve** a intervenir antes del fin.
• El agente intenta reconectar: “¿Aló?”, “¿Me escucha?”, “¿Señor/Señora?”, “Disculpe?”, “¿sigue en línea?” y **no hay respuesta** del cliente, final abrupto.
• Frases del cliente de cierre tajante seguidas de fin inmediato: “no me interesa”, “no vuelvan a llamar”, “esa deuda no es mía”, “número equivocado”.
• Silencio prolongado/ausencia de turnos del cliente o anotación del sistema/ASR de desconexión.
Ante esto:
  - Marca **"aplica": false** únicamente en los ítems que **no pudieron ejecutarse** por el corte y usa "justificacion":"no_aplica_por_corte_cliente".
  - Si **TODOS** los ítems quedan en "aplica": false (corte muy temprano) → **notaFinal = 100**.
  - Además, incluye ` + '`flags.corte_cliente=true`' + ` y añade la etiqueta "corte_cliente" (si tu salida maneja "etiquetas").

ÍTEMS A AUDITAR (únicos y críticos en este caso):
${RENUENTES_ITEMS.map(s => `- ${s}`).join('\n')}

REGLAS POR ÍTEM (citas literales obligatorias):
1) Indaga motivo del no pago
   • Evidencia válida: **pregunta abierta del asesor** (p. ej., “¿Cuál es el motivo…?”, “¿Por qué no ha podido…?”, “¿Qué le impidió…?”).
   • Solo la **respuesta del cliente** sin pregunta → "cumplido": false.
   • Si el cliente **corta antes** de que el asesor pueda indagar → "aplica": false; "justificacion":"no_aplica_por_corte_cliente".

2) Debate objeciones según situación del cliente
   • Si hay objeciones (explícitas o implícitas), la evidencia debe mostrar **reformulación/validación + alternativa/beneficio**.
   • Si **no hubo objeciones** → **"aplica": false** (no penaliza).
   • Si hubo objeciones pero el **corte** impidió debatir → "aplica": false; "justificacion":"no_aplica_por_corte_cliente".

3) Informa que la llamada es grabada y monitoreada (Ley 1581)
   • La cita debe contener **“1581”** (acepta “15 81”) o mención explícita a **ley + protección/tratamiento de datos**.
   • “La llamada es grabada” **sin ley** → **no_evidencia** (cumplido=false).
   • Si el **corte** ocurre antes de informar → "aplica": false; "justificacion":"no_aplica_por_corte_cliente".

4) Usa guion completo establecido por la campaña
   • Evidencia esperada (≥1 trazo claro del guion): **presentación + empresa**, **canales/cuentas corporativas** (no números personales), **trazabilidad/recordatorio institucional**.
   • Listar bancos/medios **sin** aclarar que son **corporativos/empresariales** **no** cumple.
   • Si el **corte** impide usar el guion → "aplica": false; "justificacion":"no_aplica_por_corte_cliente".

5) Evita argumentos engañosos con el cliente
   • Marca **false** si hay promesas no autorizadas, amenazas improcedentes, o información confusa (p. ej., “si no paga hoy lo embargan mañana” sin sustento).
   • Si no hay evidencia de engaño → **cumplido=true** por defecto (no inventes incumplimientos).
   • Si el corte impide evaluar y **no** hay evidencia de engaño → "aplica": false; "justificacion":"no_aplica_por_corte_cliente".

6) Utiliza vocabulario prudente y respetuoso
   • Marca **false** por insultos, descalificaciones, tono burlesco o trato desconsiderado.
   • Si no hay evidencia de irrespeto → **cumplido=true** por defecto.
   • Si el corte impide evaluar y no hay evidencia en contra → "aplica": false; "justificacion":"no_aplica_por_corte_cliente".

CÁLCULO DE NOTA (binario):
• Considera solo los ítems con **"aplica": true**.
• Si **alguno** aplicable está "cumplido=false" → **notaFinal = 0**.
• Si **todos** los aplicables están "cumplido=true" → **notaFinal = 100**.
• Si **ningún** ítem aplica (todos "aplica": false, p. ej., por corte temprano) → **notaFinal = 100**.

FRAUDE (reporta **solo** estos tipos + "cita" breve verificable):
• "No dice número de cuenta"
• "Dice número de cuenta parcialmente"
• "Dice número de cuenta diferente"
• "Indica al cliente que le va a marcar desde otro número"
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

/** Regla binaria 100/0
 * - Si NO aceptado (mal tipificada) → **100** (NO penaliza)
 * - Si no hay aplicables → **100**
 * - Si alguno aplicable falla → **0**
 * - Si todos aplicables cumplen → **100**
 */
function computeBinaryScore(porAtrib = [], accepted = true) {
  if (!accepted) return 100;             // NO penaliza mal tipificación
  const aplicables = porAtrib.filter(a => a.aplica === true);
  if (aplicables.length === 0) return 100;
  const anyFail = aplicables.some(a => a.cumplido === false);
  return anyFail ? 0 : 100;
}

function ensureBlock(list, _labels) {
  return normalizePorAtributo(Array.isArray(list) ? list : []);
}

/** Construye un porAtributo por defecto para asegurar visibilidad en reportes */
function buildDefaultPorAtributo(tipKey, { accepted }) {
  const labels = getItemsForTipKey(tipKey);
  const none = labels.map(atributo => ({
    atributo,
    // Si NO está aceptada (mal tipificada), no aplica y no penaliza.
    aplica: accepted ? true : false,
    // Si está aceptada y no hay evidencia, marcamos no cumplido (visibilidad).
    cumplido: accepted ? false : true,
    justificacion: accepted ? 'no_evidencia' : 'no_aplica',
    mejora: ''
  }));
  return none;
}

/** ===== Segundo pase: obligar porAtributo ===== */
async function secondPassPorAtributo({ client, model, transcript, tipKey }) {
  const labels = getItemsForTipKey(tipKey);
  if (!labels.length) return [];

  const onlyJson = `
Devuelve SOLO este JSON con EXACTAMENTE ${labels.length} elementos en ese orden:

{
  "porAtributo": [
    ${labels.map(t => `{"atributo":"${t.replace(/"/g,'\\"')}","aplica":true,"cumplido":false,"justificacion":"no_evidencia","mejora":""}`).join(',\n    ')}
  ]
}

REGLAS:
- Usa esos títulos tal cual y en ese ORDEN.
- Si hay evidencia literal (≈8+ palabras) + tiempo, pon "cumplido=true" y cita en "justificacion".
- Si no hay evidencia, deja "cumplido=false" y "justificacion":"no_evidencia".
- Si realmente no aplica, usa "aplica=false" y "justificacion":"no_aplica".
- NO devuelvas arreglos vacíos. NO agregues ni quites campos.
`.trim();

  const sys = `
Eres auditor. Construye únicamente el bloque "porAtributo" para evaluación de calidad de llamadas.
Cita literal cuando cumplido=true; si no hay evidencia, usa "no_evidencia".
`.trim();

  const user = `
Tipificación: ${tipKey}
Transcripción:
${String(transcript || '').slice(0, Number(process.env.ANALYSIS_MAX_INPUT_CHARS) || 20000)}

${onlyJson}
`.trim();

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.1,
    max_tokens: Math.min(Number(process.env.ANALYSIS_MAX_TOKENS_2ND_PASS) || 1000, 1500),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ]
  });

  const raw = completion.choices?.[0]?.message?.content || '';
  const obj = forceJson(raw);
  const arr = Array.isArray(obj?.porAtributo) ? obj.porAtributo : [];
  return normalizePorAtributo(arr);
}

/** Si el modelo no trajo porAtributo, intenta segundo pase; si falla, usa fallback local. */
async function ensureItemsBlock({
  analisis, client, model, transcript, tipKey, accepted
}) {
  const already = Array.isArray(analisis?.consolidado?.porAtributo) && analisis.consolidado.porAtributo.length > 0;
  if (already) return analisis;

  let arr = await secondPassPorAtributo({ client, model, transcript, tipKey });
  if (!arr.length) {
    arr = buildDefaultPorAtributo(tipKey, { accepted });
    analisis._warn_por_atributo = 'fallback_local';
  } else {
    analisis._warn_por_atributo = 'second_pass_ok';
  }

  analisis.consolidado = {
    ...(analisis.consolidado || {}),
    porAtributo: arr
  };
  analisis.porAtributo = arr; // compat
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
    t.includes('le hablo ') || t.includes('le habló') ||
    t.includes('hablo con') || t.includes('habló con') ||
    t.includes('soy ') || t.includes('mi nombre')
  );
}
function findFarewellEvidence(just='', transcript='') {
  if (just && containsAgentIdPhrase(just) && containsCompany(just)) return just;
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

// --- evidencia de guion corporativo/empresarial (no valen listados de bancos) ---
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
/** Divide la transcripción marcada en turnos {t,speaker,text} */
function splitTurns(marked='') {
  const lines = String(marked||'').split(/\r?\n/);
  const out = [];
  for (const ln of lines) {
    const m = /^(?:\s*(\d{2}:\d{2})\s+)?\s*(Agente|Asesor|Asesora|Cliente)\s*:\s*(.*)$/.exec(ln);
    if (m) {
      out.push({ t: m[1] || '', speaker: m[2].toLowerCase(), text: m[3].trim() });
    } else if (ln.trim()) {
      out.push({ t: '', speaker: 'otro', text: ln.trim() });
    }
  }
  return out;
}

/** Heurística de corte por parte del cliente (hold sin retorno, monólogo final del agente, frase truncada) */
function detectClientCut(markedOrPlain='') {
  const txt = String(markedOrPlain||'');
  const turns = splitTurns(txt);
  const last5 = turns.slice(-5);
  const lastClientIdx = [...turns].reverse().findIndex(u => u.speaker.includes('cliente'));
  const lastAgentIdx  = [...turns].reverse().findIndex(u => u.speaker.includes('agente') || u.speaker.includes('asesor'));
  const last = turns[turns.length - 1] || { t:'', speaker:'', text:'' };

  const HOLD_RE = /\b(un\s*momento|perm[ií]tame|esp[eé]reme|deme\s+(?:un\s+)?segund(?:o|ito)|ya\s+le\s+confirmo|ya\s+le\s+digo|ya\s+reviso|ya\s+miro)\b/i;
  const RECONTACT_RE = /\b(al[oó]|me\s+escucha|sigue\s+en\s+l[ií]nea|disculpe|¿al[oó]\??)\b/i;

  // 1) Cliente dice "un momento/permítame..." y no vuelve a hablar
  const clientHoldIdx = turns.findIndex(u => u.speaker.includes('cliente') && HOLD_RE.test(u.text));
  const hasHoldNoReturn = clientHoldIdx !== -1 && turns.slice(clientHoldIdx + 1).every(u => !u.speaker.includes('cliente'));

  // 2) Monólogo de reconexión del agente al final sin respuesta del cliente
  const last3 = turns.slice(-3);
  const agentRecontactAtEnd = last3.some(u => (u.speaker.includes('agente') || u.speaker.includes('asesor')) && RECONTACT_RE.test(u.text))
                             && !last3.some(u => u.speaker.includes('cliente'));

  // 3) Frase final truncada (muy corta o termina en conectores)
  const TRUNC_END_RE = /(,\s*|-\s*|\bde$|\bque$|\bpara$|\.\.\.$)/i;
  const truncatedTail = last.text.length > 0 && (last.text.length < 12 || TRUNC_END_RE.test(last.text));

  const cut = hasHoldNoReturn || agentRecontactAtEnd || truncatedTail;
  let reason = '';
  if (hasHoldNoReturn) reason = 'hold_sin_retorno';
  else if (agentRecontactAtEnd) reason = 'monologo_agente_final';
  else if (truncatedTail) reason = 'frase_truncada';

  const quote = hasHoldNoReturn
    ? (turns[clientHoldIdx]?.text || '')
    : (last.text || '');
  const at = hasHoldNoReturn ? (turns[clientHoldIdx]?.t || '') : (last.t || '');

  return { cut, reason, quote: quote.slice(0,200), at };
}

/** Añade etiqueta sin duplicar */
function pushEtiqueta(analisis, tag) {
  analisis.etiquetas = Array.isArray(analisis.etiquetas) ? analisis.etiquetas : [];
  if (!analisis.etiquetas.includes(tag)) analisis.etiquetas.push(tag);
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

function calibrateRenuente(analisis = {}, transcript = '') {
  if (!analisis?.consolidado?.porAtributo) return analisis;
  const por = ensureBlock(analisis.consolidado.porAtributo);

  // --- detectar corte del cliente
  const cutInfo = detectClientCut(String(transcript || ''));
  if (cutInfo.cut) {
    // Neutralizar SOLO ítems imposibilitados (1–4) con no_aplica_por_corte_cliente
    for (const a of por) {
      const name = String(a?.atributo || '').toLowerCase();
      const is1 = name.startsWith('1.') && name.includes('indaga motivo');
      const is2 = name.startsWith('2.') && name.includes('debate objeciones');
      const is3 = name.startsWith('3.') && (name.includes('1581') || name.includes('grabada'));
      const is4 = name.startsWith('4.') && (name.includes('guion') || name.includes('guión'));
      if (is1 || is2 || is3 || is4) {
        a.aplica = false;
        a.cumplido = true; // neutralizado
        if (!a.justificacion || a.justificacion === 'no_evidencia') {
          a.justificacion = 'no_aplica_por_corte_cliente';
        }
      }
    }
    // Señalizar
    analisis.flags = { ...(analisis.flags || {}), corte_cliente: true };
    pushEtiqueta(analisis, 'corte_cliente');
    // Opcional: agrega hallazgo claro (no obligatorio)
    analisis.hallazgos = Array.isArray(analisis.hallazgos) ? analisis.hallazgos : [];
    const nota = cutInfo.at ? ` (${cutInfo.at})` : '';
    analisis.hallazgos.unshift(`Corte del cliente (${cutInfo.reason.replace(/_/g,' ')}) — "${cutInfo.quote}"${nota}`.trim());
  }

  // --- Reglas adicionales ya existentes para 1581 / guion (solo si siguen aplicando)
  for (const a of por) {
    // si ya quedó neutralizado (aplica=false) no tocar
    if (a.aplica === false) continue;

    const label = norm(a?.atributo || '');

    // Ley 1581
    if (label.includes('1581') || label.includes('grabada')) {
      const hasLaw = !!(findLey1581(a.justificacion) || findLey1581(transcript));
      if (hasLaw) {
        a.cumplido = true;
        if (!a.justificacion || a.justificacion === 'no_evidencia') {
          const line = (String(transcript||'').split(/\r?\n/).find(l => findLey1581(l)) || 'Se menciona la ley 1581 (o “15 81”).');
          a.justificacion = `"${line.trim().slice(0,220)}"`;
        }
      } else {
        a.cumplido = false;
        a.justificacion = 'no_evidencia';
      }
    }

    // Guion/canales corporativos
    if (label.includes('guion') || label.includes('guión')) {
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

    // Ítems 5 y 6: mantener criterio “por defecto true” si no hay evidencia en contra
    if (label.startsWith('5.') && label.includes('engaños')) {
      // Si no hay evidencia de engaño, se deja true (ya venía así)
    }
    if (label.startsWith('6.') && (label.includes('vocabulario') || label.includes('respetuoso'))) {
      // Si no hay irrespeto explícito, se deja true
    }
  }

  analisis.consolidado.porAtributo = por;
  return analisis;
}

/** Consolidación: lee porAtributo existente y calcula nota/criticos.
 * Respeta la regla de NO penalizar llamadas mal tipificadas.*/
function ensureConsolidadoForType(analisis = {}, type) {
  // ---- detectar mal tipificada según el tipo ----
  let malTipificada = false;
  let motivoMalTipificada = '';

  if (type === 'novacion' && analisis?.novacion?.aceptada === false) {
    malTipificada = true; motivoMalTipificada = 'No hay aceptación formal de novación';
  } else if (type === 'propuesta_pago' && analisis?.propuesta_pago?.aceptada === false) {
    malTipificada = true; motivoMalTipificada = 'Sin propuesta de pago aceptada';
  } else if (type === 'abono' && analisis?.abono?.aceptado === false) {
    malTipificada = true; motivoMalTipificada = 'No aplica abono sobre acuerdo vigente';
  } else if (type === 'pago_cuotas' && analisis?.pago_cuotas?.aceptado === false) {
    malTipificada = true; motivoMalTipificada = 'No hay aceptación de pago a cuotas';
  } else if (type === 'posible_negociacion' && analisis?.posible_negociacion?.aplica === false) {
    malTipificada = true; motivoMalTipificada = 'Sin posible negociación';
  } else if (type === 'renuente' && analisis?.renuente?.aplica === false) {
    malTipificada = true; motivoMalTipificada = 'Sin evidencia de renuencia';
  }

  // ---- si está mal tipificada: neutralizar ítems y fijar 100 ----
  if (malTipificada) {
    analisis.llamada_mal_tipificada = true;
    analisis.motivo_mal_tipificada = motivoMalTipificada;

    // 1) Tomamos los ítems que ya hayan venido del modelo;
    //    si no hay, sembramos con el catálogo del tipo (para que el front los vea pero NO apliquen)
    let actuales = Array.isArray(analisis?.consolidado?.porAtributo)
      ? normalizePorAtributo(analisis.consolidado.porAtributo)
      : [];
    if (actuales.length === 0) {
      actuales = getItemsForType(type).map(t => ({
        atributo: t, aplica: false, cumplido: true, justificacion: 'no_aplica_por_tipificacion', mejora: ''
      }));
    }

    const porAtributoNeutral = neutralizeItems(actuales, 'no_aplica_por_tipificacion');

    analisis.consolidado = {
      ...(analisis.consolidado || {}),
      notaFinal: 100,
      porAtributo: porAtributoNeutral,
      afectadosCriticos: []
    };

    // Aliases/compat para front/Excel
    analisis.afectadosCriticos = [];
    analisis.porAtributo = porAtributoNeutral;
    analisis.errores_criticos = [];
    analisis.critical_errors = [];
    // Mantén antifraude tal cual venga
    analisis.alertas_antifraude = Array.isArray(analisis?.fraude?.alertas) ? analisis.fraude.alertas : [];
    analisis.antifraud_alerts = analisis.alertas_antifraude;

    return analisis; // << importante: salimos aquí, no seguimos con la rama "normal"
  }

  // ---- si NO está mal tipificada: flujo normal (nota binaria) ----
  const rawPorAttr = normalizePorAtributo(analisis?.consolidado?.porAtributo || []);
  const porAtributo = ensureBlock(rawPorAttr);
  const nota = computeBinaryScore(porAtributo, true);
  const afectadosCriticos = deriveAffectedCriticos(porAtributo);

  analisis.consolidado = {
    ...(analisis.consolidado || {}),
    notaFinal: nota,
    porAtributo,
    afectadosCriticos
  };

  return analisis;
}

function neutralizeItems(list = [], reason = 'no_aplica_por_tipificacion') {
  const base = Array.isArray(list) ? list : [];
  return base.map(a => ({
    atributo: String(a?.atributo || a?.categoria || '').trim() || '(ítem)',
    aplica: false,
    cumplido: true,
    justificacion: (a?.justificacion && a.justificacion !== 'no_evidencia')
      ? a.justificacion
      : reason,
    mejora: ''
  }));
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
  const MAX_TOKENS = Number(process.env.ANALYSIS_MAX_TOKENS) || 2200; // ↑ ampliado

  const tipKey = keyTipi(tipificacion);
  const campKey = keyTipi(campania);

  const isCP = campKey === 'carteras propias';
  const isNovacionCP       = isCP && (tipKey === 'novacion' || tipKey === 'novación');
  const isPropuestaPagoCP  = isCP && (tipKey === 'propuesta de pago' || tipKey === 'propuesta_pago');
  const isAbonoCP          = isCP && (tipKey === 'abono');
  const isPagoCuotasCP     = isCP && (tipKey === 'pago a cuotas' || tipKey === 'pago_a_cuotas' || tipKey === 'pago cuotas');
  const isPosibleNegociacionCP = isCP && (tipKey === 'posible negociacion' || tipKey === 'posible_negociacion');
  const isRenuentesCP          = isCP && (tipKey === 'renuentes' || tipKey === 'renuente' || tipKey === 'cliente renuente' || tipKey === 'cliente_renuente');

  // ---- System prompt (actualizado a 4 tipos de fraude y sin "riesgo") ----
  const system = `
Eres un analista de calidad experto en Contact Center. Evalúas transcripciones y devuelves JSON ESTRICTO en español, **sin texto adicional**.
No inventes datos. Si algo no aparece en la transcripción, indícalo como "no_evidencia".
Canales OFICIALES de pago: ${OFFICIAL_PAY_CHANNELS.join(', ')}.
Marca alertas de FRAUDE **usando solo estos tipos** (sin "riesgo") e incluyendo "cita" breve verificable:
- "No dice número de cuenta"
- "Dice número de cuenta parcialmente"
- "Dice número de cuenta diferente"
- "Indica al cliente que le va a marcar desde otro número"
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
  "agent_name": "string (si no hay evidencia, \"\")",
  "client_name": "string (si no hay evidencia, \"\")",
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
      { "tipo": "No dice número de cuenta|Dice número de cuenta parcialmente|Dice número de cuenta diferente|Indica al cliente que le va a marcar desde otro número", "cita": "frase breve" }
    ],
    "observaciones": "string"
  }
}
`.trim();

  const novacionJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \"\")",
  "client_name": "string (si no hay evidencia, \"\")",
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
      { "tipo": "No dice número de cuenta|Dice número de cuenta parcialmente|Dice número de cuenta diferente|Indica al cliente que le va a marcar desde otro número", "cita": "frase breve" }
    ],
    "observaciones": "string"
  }
}
`.trim();

  const propuestaJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \"\")",
  "client_name": "string (si no hay evidencia, \"\")",
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
      { "tipo": "No dice número de cuenta|Dice número de cuenta parcialmente|Dice número de cuenta diferente|Indica al cliente que le va a marcar desde otro número", "cita": "frase breve" }
    ],
    "observaciones": "string"
  }
}
`.trim();

  const abonoJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \"\")",
  "client_name": "string (si no hay evidencia, \"\")",
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
      { "tipo": "No dice número de cuenta|Dice número de cuenta parcialmente|Dice número de cuenta diferente|Indica al cliente que le va a marcar desde otro número", "cita": "frase breve" }
    ],
    "observaciones": "string"
  }
}
`.trim();

  const pagoCuotasJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \"\")",
  "client_name": "string (si no hay evidencia, \"\")",
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
      { "tipo": "No dice número de cuenta|Dice número de cuenta parcialmente|Dice número de cuenta diferente|Indica al cliente que le va a marcar desde otro número", "cita": "frase breve" }
    ],
    "observaciones": "string"
  }
}
`.trim();

  // NUEVO — Shapes para Posible negociación y Renuentes
  const posibleNegJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \"\")",
  "client_name": "string (si no hay evidencia, \"\")",
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
      { "tipo": "No dice número de cuenta|Dice número de cuenta parcialmente|Dice número de cuenta diferente|Indica al cliente que le va a marcar desde otro número", "cita": "frase breve" }
    ],
    "observaciones": "string"
  }
}
`.trim();

  const renuentesJsonShape = `
{
  "agent_name": "string (si no hay evidencia, \"\")",
  "client_name": "string (si no hay evidencia, \"\")",
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
      { "tipo": "No dice número de cuenta|Dice número de cuenta parcialmente|Dice número de cuenta diferente|Indica al cliente que le va a marcar desde otro número", "cita": "frase breve" }
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
    novacion: json?.novacion,
    propuesta_pago: json?.propuesta_pago,
    abono: json?.abono,
    pago_cuotas: json?.pago_cuotas,
    posible_negociacion: json?.posible_negociacion,
    renuente: json?.renuente,
    acuerdo_cuotas: json?.acuerdo_cuotas,
    consolidado: json?.consolidado || {}
  };

  // ==== Forzar que existan ítems cuando la tipificación aplica ====
  const acceptedByType =
    (isNovacionCP            ? analisis?.novacion?.aceptada !== false :
    isPropuestaPagoCP        ? analisis?.propuesta_pago?.aceptada !== false :
    isAbonoCP                ? analisis?.abono?.aceptado !== false :
    isPagoCuotasCP           ? analisis?.pago_cuotas?.aceptado !== false :
    isPosibleNegociacionCP   ? analisis?.posible_negociacion?.aplica !== false :
    isRenuentesCP            ? analisis?.renuente?.aplica !== false :
    true);

  if (isCP) {
    analisis = await ensureItemsBlock({
      analisis,
      client,
      model,
      transcript: String(transcript || ''),
      tipKey,
      accepted: acceptedByType
    });
  }

  // ===== Calibración SOLO para "Posible negociación" / "Renuentes" (ya con porAtributo) =====
  if (isPosibleNegociacionCP) {
    analisis = calibratePosibleNegociacion(analisis, String(transcript || ''));
  }
  if (isRenuentesCP) {
    analisis = calibrateRenuente(analisis, String(transcript || ''));
  }

  // ---- Post-proceso por caso para nota 100/0 y afectados críticos
  if (isNovacionCP)             analisis = ensureConsolidadoForType(analisis, 'novacion', acceptedByType);
  if (isPropuestaPagoCP)        analisis = ensureConsolidadoForType(analisis, 'propuesta_pago', acceptedByType);
  if (isAbonoCP)                analisis = ensureConsolidadoForType(analisis, 'abono', acceptedByType);
  if (isPagoCuotasCP)           analisis = ensureConsolidadoForType(analisis, 'pago_cuotas', acceptedByType);
  if (isPosibleNegociacionCP)   analisis = ensureConsolidadoForType(analisis, 'posible_negociacion', acceptedByType);
  if (isRenuentesCP)            analisis = ensureConsolidadoForType(analisis, 'renuente', acceptedByType);

  // === Etiqueta "mal tipificada" (para Excel)
  {
    let mal = false, motivo = '';

    if (isNovacionCP && analisis?.novacion?.aceptada === false) {
      mal = true; motivo = 'No hay aceptación formal de novación.';
    } else if (isPropuestaPagoCP && analisis?.propuesta_pago?.aceptada === false) {
      mal = true; motivo = 'Sin propuesta de pago aceptada.';
    } else if (isAbonoCP && analisis?.abono?.aceptado === false) {
      mal = true; motivo = 'No aplica abono sobre acuerdo vigente.';
    } else if (isPagoCuotasCP && analisis?.pago_cuotas?.aceptado === false) {
      mal = true; motivo = 'No hay aceptación de pago a cuotas.';
    } else if (isPosibleNegociacionCP && analisis?.posible_negociacion?.aplica === false) {
      mal = true; motivo = 'Sin posible negociación.';
    } else if (isRenuentesCP && analisis?.renuente?.aplica === false) {
      mal = true; motivo = 'Sin evidencia de renuencia.';
    }

    analisis.llamada_mal_tipificada = mal;
    analisis.motivo_mal_tipificada = motivo;
    analisis.etiquetas = Array.isArray(analisis.etiquetas) ? analisis.etiquetas : [];
    if (mal && !analisis.etiquetas.includes('mal_tipificada')) analisis.etiquetas.push('mal_tipificada');
  }

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

    analisis.errores_riticos /* legacy typo guard */;
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

  // Merge con heurística local anti-fraude (sin duplicar) — ahora SIN "riesgo"
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
