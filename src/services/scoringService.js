// src/services/scoringService.js

/**
 * Calcula la nota final a partir del análisis y la matriz.
 * - Respeta "No aplica" (aplica=false o status='NA') y NO penaliza ni entra al denominador.
 * - Modo estricto (STRICT_APPLICA=1): si no hay evidencia del LLM para el atributo, se considera NA por defecto.
 * - Respeta lista de auto-NA impuesta por el route: analysis._autoNA.
 * - Lee primero analysis.porAtributo (nuevo) y cae a analysis.atributos (legacy).
 * - Mantiene compat: { notaBase, totalDeducciones, notaFinal, porCategoria, porAtributo }.
 * - Añade campo opcional: atributosCriticos (los que APLICAN y NO se cumplieron con peso >= umbral).
 */

const STRICT_APPLICA = String(process.env.STRICT_APPLICA || '0') !== '0';

export function scoreFromMatrix(analysis = {}, matrix = [], opts = {}) {
  const norm = (s) => String(s || '').trim().toLowerCase();

  // Umbral para considerar crítico por peso.
  const CRIT_THR = Number(process.env.CRITICAL_WEIGHT_VALUE ?? opts.criticalWeight ?? 100);

  // ---- Mapas desde la matriz ----
  const mPeso = new Map();       // atributo (norm) -> peso (number)
  const mCat  = new Map();       // atributo (norm) -> categoría (string)
  const mName = [];              // orden de la matriz

  for (const m of (matrix || [])) {
    const key = norm(m.atributo ?? m.Atributo);
    if (!key) continue;
    const peso = safeNum(m.peso ?? m.Peso);
    mPeso.set(key, peso);
    mCat.set(key, String(m.categoria ?? m.Categoria ?? '').trim());
    mName.push(key);
  }

  // ---- Análisis: prioriza porAtributo; fallback a atributos (legacy) ----
  const llmList = Array.isArray(analysis?.porAtributo)
    ? analysis.porAtributo
    : (Array.isArray(analysis?.atributos) ? analysis.atributos : []);

  const aMap = new Map(); // atributo (norm) -> entry del LLM
  for (const a of llmList) {
    const key = norm(a?.atributo);
    if (!key || aMap.has(key)) continue;
    aMap.set(key, a);
  }

  // Auto-NA que puede venir del route (guard-rails deterministas)
  const autoNA = new Set(Array.isArray(analysis?._autoNA) ? analysis._autoNA.map((x) => String(x || '').trim()) : []);

  // ---- Construimos porAtributo en el orden de la matriz ----
  const porAtributo = [];
  const afectadosCriticos = [];
  let totalDeducciones = 0;

  for (const key of mName) {
    const atributo  = displayFromKey(key);
    const categoria = mCat.get(key) ?? 'Sin categoría';
    const peso      = mPeso.get(key) ?? 0;
    const critico   = peso >= CRIT_THR;

    const src = aMap.get(key) || null;

    // === Determinar APLICABILIDAD ===
    // 1) Por defecto
    let aplica = true;
    let status = 'OK';

    // 2) Auto-NA del route
    if (autoNA.has(atributo)) {
      aplica = false;
      status = 'NA';
    }

    // 3) Lo que diga el LLM
    const statusStr = String(src?.status || '').trim().toLowerCase();
    if (src && (src.aplica === false || statusStr === 'na' || statusStr === 'n/a' || /no\s*aplica/.test(statusStr))) {
      aplica = false;
      status = 'NA';
    }

    // 4) Modo estricto: si NO hay entrada del LLM, por defecto NA
    if (!src && STRICT_APPLICA) {
      aplica = false;
      status = 'NA';
    }

    // === Determinar CUMPLIMIENTO ===
    let cumplido = null;
    let mejora   = null;
    let justif   = '';

    if (aplica) {
      if (src && typeof src.cumplido === 'boolean') {
        cumplido = !!src.cumplido;
        mejora   = pickClean(src?.mejora);
        justif   = pickJustificacion(src?.justificacion, cumplido, critico);
      } else {
        // Si APLICA pero no tenemos veredicto del LLM:
        //  - En estricto: lo pasamos a NA para no castigar silencios.
        //  - En no estricto: mantenemos tu heurística original (fail-closed para críticos).
        if (STRICT_APPLICA) {
          aplica = false;
          status = 'NA';
          cumplido = null;
          mejora = null;
          justif = 'No Aplica (política estricta: no hay evidencia textual suficiente).';
        } else {
          cumplido = !critico; // tu comportamiento previo
          mejora   = cumplido ? null : 'Definir acciones concretas para cumplir el criterio.';
          justif   = pickJustificacion(null, cumplido, critico);
        }
      }
    } else {
      // No aplica → no penaliza y no entra al denominador
      cumplido = null;
      mejora   = null;
      justif   = src?.justificacion || 'No aplica en esta llamada (no se cumplen condiciones de activación del criterio).';
    }

    // === Deducción / afectados ===
    const deduccion = (aplica && cumplido === false) ? peso : 0;
    totalDeducciones += deduccion;

    if (aplica && cumplido === false && critico) {
      afectadosCriticos.push(atributo);
    }

    // Empujar detalle
    porAtributo.push({
      atributo,
      categoria,
      peso,
      critico,
      aplica,               // visible para el front
      status,               // 'OK' | 'NA'
      cumplido,             // true | false | null (si NA)
      deduccion,
      justificacion: justif || undefined,
      mejora: mejora || undefined,
      reconocimiento: pickClean(src?.reconocimiento)
    });
  }

  // ---- Elementos del análisis que no están en la matriz (informativos, peso 0) ----
  for (const [key, src] of aMap.entries()) {
    if (mPeso.has(key)) continue; // ya considerado
    porAtributo.push({
      atributo: src?.atributo || displayFromKey(key),
      categoria: src?.categoria || 'Fuera de matriz',
      peso: 0,
      critico: false,
      aplica: src?.aplica !== false,
      status: (src?.aplica === false || String(src?.status || '').toUpperCase() === 'NA') ? 'NA' : 'OK',
      cumplido: typeof src?.cumplido === 'boolean' ? !!src.cumplido : null,
      deduccion: 0,
      justificacion: src?.justificacion || 'Atributo no presente en la matriz (solo informativo).',
      mejora: pickClean(src?.mejora),
      reconocimiento: pickClean(src?.reconocimiento)
    });
  }

  // ---- Agregación por categoría (ignora NA en el denominador) ----
  const porCategoriaMap = new Map();
  for (const a of porAtributo) {
    const cat = a.categoria || 'Sin categoría';
    if (!porCategoriaMap.has(cat)) {
      porCategoriaMap.set(cat, {
        categoria: cat,
        cumplimiento: { cumplidos: 0, noCumplidos: 0, porcentaje: 0 },
        na: 0,
        recomendaciones: new Set()
      });
    }
    const c = porCategoriaMap.get(cat);

    if (a.aplica === false || a.status === 'NA') {
      c.na += 1;
    } else if (a.cumplido === true) {
      c.cumplimiento.cumplidos += 1;
    } else if (a.cumplido === false) {
      c.cumplimiento.noCumplidos += 1;
      if (a.mejora) c.recomendaciones.add(a.mejora);
    }
  }

  const porCategoria = [];
  for (const [cat, data] of porCategoriaMap.entries()) {
    const totalAplicables = data.cumplimiento.cumplidos + data.cumplimiento.noCumplidos;
    data.cumplimiento.porcentaje = totalAplicables
      ? Math.round((data.cumplimiento.cumplidos / totalAplicables) * 100)
      : 0;

    porCategoria.push({
      categoria: cat,
      cumplimiento: data.cumplimiento,
      recomendaciones: Array.from(data.recomendaciones),
      noAplica: data.na
    });
  }

  // ---- Nota final ----
  const notaBase = 100;
  const notaFinal = clamp0to100(notaBase - totalDeducciones);

  return {
    notaBase,
    totalDeducciones,
    notaFinal,
    porCategoria,
    porAtributo,
    // útil para el front que muestra "Afectados (críticos)":
    atributosCriticos: afectadosCriticos
  };
}

/* -------------------- helpers -------------------- */

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function clamp0to100(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function displayFromKey(key) {
  // Reconstruye un nombre "bonito" desde el key normalizado (fallback)
  return String(key || '')
    .split(' ')
    .map(w => (w ? (w[0].toUpperCase() + w.slice(1)) : ''))
    .join(' ');
}
function pickJustificacion(srcJust, cumplido, critico) {
  const j = String(srcJust || '').trim();
  if (j) return j;
  if (cumplido === true) return 'No se evidencia incumplimiento.';
  if (cumplido === false) {
    return critico
      ? 'Incumplimiento crítico: no se encontró evidencia de cumplimiento.'
      : 'Incumplimiento: evidencia insuficiente de cumplimiento.';
  }
  return 'No aplica en esta llamada.';
}
function pickClean(v) {
  const t = String(v ?? '').trim();
  return t ? t : undefined;
}

export default { scoreFromMatrix };
