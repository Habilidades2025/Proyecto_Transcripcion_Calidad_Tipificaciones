// ---------- Utils ----------
function $(id) { return document.getElementById(id); }
function basename(p) { if (!p) return null; return p.toString().split(/[\\/]/).pop(); }
function isHttpOrRoot(href) { return typeof href === 'string' && (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')); }
function filenameFromContentDisposition(h) {
  if (!h) return null;
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)(?:")?/i.exec(h);
  if (m && m[1]) {
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }
  return null;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function formatFraudItem(f) {
  if (!f) return '';
  if (typeof f === 'string') return `🚫 ${escapeHtml(f)}`;
  const tipo   = String(f.tipo || '').replace(/_/g, ' ');
  const riesgo = (f.riesgo || 'alto').toUpperCase();
  const cita   = String(f.cita || '').trim();
  return `🚫 [${riesgo}] ${escapeHtml(tipo)}${cita ? ` — “${escapeHtml(cita)}”` : ''}`;
}
function numOrDash(n) { const v = Number(n); return Number.isFinite(v) ? Math.round(v) : '-'; }

// Helpers defensivos
function setTextById(id, text) { const el = $(id); if (el) el.textContent = text ?? ''; }
function setHtmlById(id, html) { const el = $(id); if (el) el.innerHTML = html ?? ''; }

// Tolerancia estructuras
function pick(obj, path, fallback = undefined) {
  if (!obj || !path) return fallback;
  const parts = Array.isArray(path) ? path : String(path).split('.');
  let cur = obj;
  for (const p of parts) { if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p]; else return fallback; }
  return cur;
}
function arr(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }
function flattenPorAtrib(meta) {
  const a = pick(meta, 'porAtributo') || pick(meta, 'consolidado.porAtributo') || [];
  return Array.isArray(a) ? a : [];
}

// ---------- Tabs ----------
const $tabTranscribe  = $('tabTranscribe');
const $tabAnalyze     = $('tabAnalyze');
const $tabConsolidado = $('tabConsolidado');

const $viewTranscribe  = $('viewTranscribe');
const $viewAnalyze     = $('viewAnalyze');
const $viewConsolidado = $('viewConsolidado');

function setTabClasses(active) {
  const map = { transcribe: $tabTranscribe, analyze: $tabAnalyze, consolidado: $tabConsolidado };
  Object.entries(map).forEach(([k, btn]) => { if (btn) btn.className = (k === active) ? 'primary' : 'muted'; });
}
function showTranscribe() { if(!$viewTranscribe||!$viewAnalyze||!$viewConsolidado)return;
  setTabClasses('transcribe'); $viewTranscribe.style.display=''; $viewAnalyze.style.display='none'; $viewConsolidado.style.display='none';
}
function showAnalyze() { if(!$viewTranscribe||!$viewAnalyze||!$viewConsolidado)return;
  setTabClasses('analyze'); $viewTranscribe.style.display='none'; $viewAnalyze.style.display=''; $viewConsolidado.style.display='none';
}
async function showConsolidado() { if(!$viewTranscribe||!$viewAnalyze||!$viewConsolidado)return;
  setTabClasses('consolidado'); $viewTranscribe.style.display='none'; $viewAnalyze.style.display='none'; $viewConsolidado.style.display='';
  await reloadConsolidado();
}
$tabTranscribe?.addEventListener('click', showTranscribe);
$tabAnalyze?.addEventListener('click', showAnalyze);
$tabConsolidado?.addEventListener('click', showConsolidado);

// ---------- TRANSCRIBIR ----------
const $formTx      = $('formTranscribe');
const $txAudios    = $('txAudios');
const $txProvider  = $('txProvider');
const $txLang      = $('txLang');
const $txMode      = $('txMode');
const $txAgentChan = $('txAgentChannel');
const $txBtn       = $('btnTranscribe');
const $txStatus    = $('txStatus');
const $txDownload  = $('txDownloadLink');

async function readErrorMessage(resp) {
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { const j = await resp.json(); if (j?.error) return j.error; } catch {}
  } else {
    try { const t = await resp.text(); if (t) return `${t.slice(0,200)}${t.length>200?'…':''}`; } catch {}
  }
  return `Error HTTP ${resp.status}`;
}

$formTx?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$txAudios?.files?.length) { alert('Adjunta al menos un audio.'); return; }
  const files = Array.from($txAudios.files);
  const many = files.length > 1;

  if ($txStatus)  $txStatus.textContent = '';
  if ($txDownload) { $txDownload.style.display = 'none'; $txDownload.removeAttribute('href'); $txDownload.removeAttribute('download'); }
  if ($txBtn) { $txBtn.disabled = true; $txBtn.textContent = 'Procesando...'; }

  try {
    if (many) {
      const fd = new FormData();
      files.forEach(f => fd.append('audios', f));
      if ($txProvider?.value)   fd.append('provider', $txProvider.value);
      if ($txLang?.value)       fd.append('language', $txLang.value);
      if ($txMode?.value)       fd.append('mode', $txMode.value);
      if ($txAgentChan?.value)  fd.append('agentChannel', $txAgentChan.value);

      if ($txStatus) $txStatus.textContent = `Transcribiendo ${files.length} audios...`;
      const resp = await fetch('/transcribe-zip', { method: 'POST', body: fd, headers: { 'Accept':'application/zip,application/octet-stream,application/json' } });
      if (!resp.ok) { throw new Error(await readErrorMessage(resp)); }
      const blob = await resp.blob();
      const cd = resp.headers.get('Content-Disposition');
      const suggest = filenameFromContentDisposition(cd) || 'transcripciones.zip';
      downloadBlob(blob, suggest);

      if ($txStatus) $txStatus.textContent = `¡Listo! Se descargó ${suggest}`;
      if ($txDownload) {
        const url = URL.createObjectURL(blob);
        $txDownload.href = url; $txDownload.download = suggest; $txDownload.style.display = '';
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } else {
      const fd = new FormData();
      fd.append('audio', files[0]);
      if ($txProvider?.value)   fd.append('provider', $txProvider.value);
      if ($txLang?.value)       fd.append('language', $txLang.value);
      if ($txMode?.value)       fd.append('mode', $txMode.value);
      if ($txAgentChan?.value)  fd.append('agentChannel', $txAgentChan.value);

      if ($txStatus) $txStatus.textContent = `Transcribiendo ${files[0].name}...`;
      const resp = await fetch('/transcribe-txt', { method: 'POST', body: fd, headers: { 'Accept':'text/plain,application/json' } });
      if (!resp.ok) { throw new Error(await readErrorMessage(resp)); }
      const blob = await resp.blob();
      const cd = resp.headers.get('Content-Disposition');
      let suggest = filenameFromContentDisposition(cd);
      if (!suggest) { const base = (files[0].name || 'transcripcion').replace(/\.[^.]+$/, ''); suggest = `${base}.txt`; }
      downloadBlob(blob, suggest);

      if ($txStatus) $txStatus.textContent = `¡Listo! Se descargó ${suggest}`;
      if ($txDownload) {
        const url = URL.createObjectURL(blob);
        $txDownload.href = url; $txDownload.download = suggest; $txDownload.style.display = '';
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    }
  } catch (err) {
    console.error('[TX][ERROR]', err);
    alert('Error transcribiendo: ' + (err?.message || err));
    if ($txStatus) $txStatus.textContent = 'Ocurrió un error. Revisa consola para detalles.';
  } finally {
    if ($txBtn) { $txBtn.disabled = false; $txBtn.textContent = 'Transcribir'; }
  }
});

// ---------- Analizar (BATCH) ----------
const $formBatch   = $('formBatch');
const $audios      = $('audios');
const $provider    = $('provider');

// IDs del HTML (sin tildes)
const $campania     = $('campania');
const $tipiField    = $('tipificacion-field');
const $tipificacion = $('tipificacion');

// Progreso
const $progressCard = $('progressCard');
const $lblProgress  = $('lblProgress');
const $barProgress  = $('barProgress');
const $listProgress = $('listProgress');

// Resultados
const $resultsCard    = $('resultsCard');
const $detIndividual  = $('detIndividual');
const $countInd       = $('countInd');
const $individualList = $('individualList');

const $grpTotal   = $('grpTotal');
const $grpAvg     = $('grpAvg');
const $grpResumen = $('grpResumen');
const $grpHall    = $('grpHall');
// ATENCIÓN: grpCrit debe ser un <ul id="grpCrit"> en HTML (ver sección HTML abajo)
const $grpCrit    = $('grpCrit');
const $grpPlan    = $('grpPlan');

// Fraude (grupo)
const $grpFraudeCard = $('grpFraudeCard');
const $grpFraudeList = $('grpFraudeList') || $('grpFraude');

// Prompts por Tipificación
const TIPI_PROMPTS = {
  'Novación': `
Analiza la llamada "Novación".
- Detecta si el cliente ya pagó o pagará: intención real, fecha y (si existe) monto y canal oficial.
- Si faltan datos (monto/fecha/canal), marca "no_evidencia".
- Devuelve: resumen (100-150 palabras), hallazgos[], fraude.alertas[].`.trim(),
  'Propuesta de pago': `
Analiza la llamada "Propuesta de pago".
- Verifica recordatorio/fecha límite/beneficios; no fuerces negociación si el cliente solo confirma.
- Devuelve: resumen, hallazgos[], fraude.alertas[].`.trim(),
  'Abono': `
Analiza la llamada "Abono".
- Extrae SOLO lo dicho: monto, fecha(s) y canal oficial. Si no se cierra, marca "negociacion_no_cerrada".
- Devuelve: resumen, hallazgos[], fraude.alertas[].`.trim(),
  'Pago a cuotas': `
Analiza la llamada "Pago a cuotas".
- Verifica aceptación formal del plan en cuotas y confirmación completa: número de cuotas, valor por cuota, fecha de inicio y medio de pago.
- Devuelve: resumen, hallazgos[], fraude.alertas[].`.trim(),
  'Posible negociación': `
Analiza la llamada "Posible negociación".
- Busca señales de intención de negociar sin compromiso formal; identifica siguiente paso, motivo de no pago, alternativas sin cerrar.
- Si no hay objeciones, ese ítem no aplica. Devuelve: resumen, hallazgos[], fraude.alertas[].`.trim(),
  'Renuentes': `
Analiza la llamada "Renuentes".
- Verifica resistencia del cliente y manejo del asesor (control emocional, reformulación empática, alternativas, trazabilidad).
- Si no hubo objeciones, ese ítem no aplica. Devuelve: resumen, hallazgos[], fraude.alertas[].`.trim()
};

// Campaña + Tipificación dependientes
(function initCampaniaTipi() {
  if ($campania) {
    $campania.innerHTML = `
      <option value="">Selecciona campaña</option>
      <option value="Carteras Propias">Carteras Propias</option>
    `;
  }
  if ($tipiField) $tipiField.style.display = 'none';

  const TIPIS_BY_CAMPAIGN = {
    'Carteras Propias': ['Novación', 'Propuesta de pago', 'Abono', 'Pago a cuotas', 'Posible negociación', 'Renuentes']
  };

  const fillTipisForCampaign = () => {
    const camp = $campania?.value || '';
    if (!$tipificacion) return;
    if (!camp) {
      $tipificacion.innerHTML = `<option value="">Selecciona tipificación</option>`;
      if ($tipiField) $tipiField.style.display = 'none';
      return;
    }
    const list = TIPIS_BY_CAMPAIGN[camp] || [];
    $tipificacion.innerHTML = `<option value="">Selecciona tipificación</option>` +
      list.map(t => `<option value="${t}">${t}</option>`).join('');
    if ($tipiField) $tipiField.style.display = '';
  };

  $campania?.addEventListener('change', fillTipisForCampaign);
  fillTipisForCampaign();
})();

let evtSource = null;

async function postFormExpectJson(url, fd) {
  const resp = await fetch(url, { method: 'POST', body: fd, headers: { 'Accept':'application/json' } });
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const payload = await resp.json().catch(() => null);
    return { ok: resp.ok && !!payload, status: resp.status, ct, payload };
  } else {
    const txt = await resp.text().catch(() => '');
    return { ok: false, status: resp.status, ct, payload: { _html: txt } };
  }
}

$formBatch?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$audios?.files?.length) { alert('Adjunta al menos un audio.'); return; }

  const tipiVisible = $tipiField && $tipiField.style.display !== 'none';
  if (tipiVisible && !$tipificacion?.value) { alert('Selecciona una tipificación.'); return; }

  if ($progressCard) $progressCard.style.display = '';
  if ($resultsCard)  $resultsCard.style.display  = 'none';
  if ($listProgress) $listProgress.innerHTML     = '';
  if ($lblProgress)  $lblProgress.textContent    = `0 / ${$audios.files.length}`;
  if ($barProgress)  $barProgress.style.width    = '0%';

  const fd = new FormData();
  Array.from($audios.files).forEach(f => fd.append('audios', f));
  if ($provider?.value)   fd.append('provider', $provider.value);
  if ($campania?.value) { fd.append('campania', $campania.value); fd.append('campaña', $campania.value); }
  if ($tipificacion?.value) {
    fd.append('tipificacion', $tipificacion.value);
    fd.append('tipi_prompt', TIPI_PROMPTS[$tipificacion.value] || '');
  }

  try {
    // 1) Intentar flujo SSE
    let r = await postFormExpectJson('/batch/start', fd);
    if (r.ok && r.payload?.jobId) { startSSE(r.payload.jobId); return; }

    // 2) Fallback a proceso directo
    r = await postFormExpectJson('/batch', fd);
    if (r.ok && Array.isArray(r.payload?.results)) {
      markProgressDone(Array.from($audios.files));
      renderBatchResultsNew(r.payload);
      return;
    }

    // 3) Mostrar diagnóstico
    const htmlSnippet = (r.payload?._html || '').slice(0, 200);
    console.error('[BATCH] Respuesta no JSON', { status:r.status, ct:r.ct, htmlSnippet });
    alert(`Error iniciando lote: ${r.status} (${r.ct}). ${htmlSnippet ? 'Detalle: '+htmlSnippet : ''}`);
  } catch (err) {
    alert('Error iniciando lote: ' + (err?.message || err));
  }
});

function markProgressDone(files) {
  if ($lblProgress) $lblProgress.textContent = `${files.length} / ${files.length}`;
  if ($barProgress) $barProgress.style.width = '100%';
  if ($listProgress) {
    const frag = document.createDocumentFragment();
    files.forEach((f, idx) => {
      const d = document.createElement('div');
      d.textContent = `✅ ${idx + 1}. ${f.name}`;
      frag.appendChild(d);
    });
    $listProgress.innerHTML = '';
    $listProgress.appendChild(frag);
  }
}

function startSSE(jobId) {
  if (evtSource) { evtSource.close(); evtSource = null; }
  evtSource = new EventSource(`/batch/progress/${jobId}`);
  evtSource.addEventListener('progress', (ev) => {
    const data = JSON.parse(ev.data);
    updateProgressUI(data);
    if (data.status === 'done') {
      evtSource.close(); evtSource = null;
      loadBatchResult(jobId);
    }
  });
  evtSource.onerror = () => { evtSource?.close(); evtSource = null; };
}

function updateProgressUI(p) {
  const total = Number(p.total || 0);
  const done  = Number(p.done || 0);
  if ($lblProgress) $lblProgress.textContent = `${done} / ${total}`;
  const pct = total ? Math.round((done / total) * 100) : 0;
  if ($barProgress) $barProgress.style.width = `${pct}%`;

  if ($listProgress) {
    const frag = document.createDocumentFragment();
    (p.items || []).forEach((it, idx) => {
      const d = document.createElement('div');
      const st = it.status;
      const icon = st === 'done' ? '✅' : (st === 'error' ? '❌' : '⏳');
      d.textContent = `${icon} ${idx + 1}. ${it.name}`;
      frag.appendChild(d);
    });
    $listProgress.innerHTML = '';
    $listProgress.appendChild(frag);
  }
}

async function loadBatchResult(jobId) {
  try {
    const r = await fetch(`/batch/result/${jobId}`, { headers: { 'Accept':'application/json' }});
    const j = await r.json();
    if (!r.ok) { throw new Error(j?.error || `HTTP ${r.status}`); }
    renderBatchResults(j);
  } catch (err) {
    alert('Error obteniendo resultados: ' + (err?.message || err));
  }
}

/* ===== Agregador grupal ===== */
function buildPlanFromAfectados(afectadosTop = []) {
  if (!afectadosTop.length) return '';
  const SUG = [
    { k: 'Indaga motivo', s: 'Estandarizar pregunta abierta sobre motivo de no pago y repregunta de profundidad.' },
    { k: 'Despedida', s: 'Cerrar con nombre + empresa + agradecimiento + buen deseo (según guion).' },
    { k: 'Ley 1581', s: 'Insertar aviso de grabación/tratamiento de datos en el primer tercio de la llamada.' },
    { k: 'Usa guion', s: 'Reforzar speech del guion y mención de pagos SOLO a cuentas/canales corporativos.' },
    { k: 'Evita argumentos engañosos', s: 'Prohibir promesas no verificables o presiones; usar lenguaje prudente.' },
    { k: 'Debate objeciones', s: 'Aplicar técnica de reencuadre y beneficio-consecuencia según política vigente.' },
    { k: 'Ofrece alternativas', s: 'Presentar 2–3 opciones reales alineadas a la situación del cliente.' }
  ];
  const lines = [];
  for (const a of afectadosTop.slice(0, 4)) {
    const f = SUG.find(x => a.text.toLowerCase().includes(x.k.toLowerCase()));
    if (f) lines.push(`• ${f.s}`);
  }
  if (!lines.length) lines.push('• Mantener foco en beneficios/consecuencias, legalidad 1581 y cierre con guion.');
  return lines.join('\n');
}

function aggregateGroupV2(items, opts = {}) {
  const out = { total: items.length, promedio: 0, resumen: '', hallTop: [], afectadosTop: [], fraudeTop: [] };

  if (!items.length) return out;

  // promedio
  let sum = 0, nNotas = 0;
  // hallazgos
  const hallCounts = new Map();
  // afectados
  const afCounts = new Map();
  // fraude
  const fraudes = [];

  items.forEach(it => {
    const a = it?.analisis || it?.meta?.analisis || {};
    const nota = Number(
      (a?.consolidado?.notaFinal) ??
      (it?.consolidado?.notaFinal) ??
      (it?.meta?.consolidado?.notaFinal) ??
      it?.nota
    );
    if (Number.isFinite(nota)) { sum += nota; nNotas++; }

    (a?.hallazgos || []).forEach(h => hallCounts.set(h, (hallCounts.get(h) || 0) + 1));

    // afectados por porAtributo (aplica true && cumplido false)
    const porAttr = a?.consolidado?.porAtributo || it?.meta?.consolidado?.porAtributo || [];
    if (Array.isArray(porAttr) && porAttr.length) {
      porAttr.forEach(x => {
        if (x && x.aplica === true && x.cumplido === false && x.atributo) {
          afCounts.set(x.atributo, (afCounts.get(x.atributo) || 0) + 1);
        }
      });
    } else {
      // fallback por lista simple de strings
      (a?.afectadosCriticos || it?.meta?.afectadosCriticos || []).forEach(t => {
        if (t) afCounts.set(t, (afCounts.get(t) || 0) + 1);
      });
    }

    (a?.fraude?.alertas || []).forEach(x => fraudes.push(x));
  });

  out.promedio = nNotas ? Math.round(sum / nNotas) : 0;
  out.hallTop = Array.from(hallCounts.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([text,count])=>`${text} (${count})`);
  out.afectadosTop = Array.from(afCounts.entries()).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([text,count])=>({ text, count }));
  out.fraudeTop = fraudes.slice(0,10);

  // resumen sintético
  const h1 = out.hallTop[0]?.replace(/\s\(\d+\)$/, '') || '';
  const h2 = out.hallTop[1]?.replace(/\s\(\d+\)$/, '') || '';
  const a1 = out.afectadosTop[0]?.text || '';
  const a2 = out.afectadosTop[1]?.text || '';
  out.resumen = [
    `Se analizaron ${out.total} llamada(s).`,
    `Promedio de nota: ${out.promedio}.`,
    h1 ? `Hallazgos frecuentes: ${h1}${h2 ? `, ${h2}` : ''}.` : '',
    a1 ? `Ítems más afectados: ${a1}${a2 ? `, ${a2}` : ''}.` : ''
  ].filter(Boolean).join(' ');

  out.planMejora = buildPlanFromAfectados(out.afectadosTop);
  return out;
}

// Fallback cuando /batch devuelve results directamente
function renderBatchResultsNew(payload) {
  if ($resultsCard) $resultsCard.style.display = '';

  const okItems = Array.isArray(payload?.results) ? payload.results.filter(x => x?.ok) : [];
  if ($countInd) $countInd.textContent = String(okItems.length);
  if ($individualList) $individualList.innerHTML = '';

  okItems.forEach((it, idx) => {
    const name      = it?.fileName || `audio_${idx+1}`;
    const analisis  = it?.analisis || {};
    const agente    = analisis?.agent_name || '-';
    const cliente   = analisis?.client_name || '-';
    const resumen   = analisis?.resumen || '';
    const hallazgos = analisis?.hallazgos || [];
    const fraude    = (analisis?.fraude?.alertas || []).map(formatFraudItem);
    const transcriptMarked = String(it?.transcriptMarked || '').trim();

    const det = document.createElement('details');
    det.innerHTML = `
      <summary><b>${escapeHtml(agente)}</b> — ${escapeHtml(cliente)} · <small>${escapeHtml(name)}</small></summary>
      <div style="padding:8px 12px">
        <p><b>Resumen:</b> ${resumen ? escapeHtml(resumen) : '(sin resumen)'}</p>
        <p><b>Hallazgos:</b></p>
        <ul>${hallazgos.length ? hallazgos.map(h => `<li>${escapeHtml(h)}</li>`).join('') : '<li>—</li>'}</ul>
        ${fraude.length ? `<p><b>Alertas de fraude:</b></p><ul>${fraude.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
        ${transcriptMarked ? `
        <section style="margin:8px 0;">
          <div style="font-weight:600;margin-bottom:4px;">Transcripción (tiempos y rol)</div>
          <pre style="white-space:pre-wrap; font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:0.95rem;">${escapeHtml(transcriptMarked)}</pre>
        </section>` : ''}
      </div>
    `;
    $individualList?.appendChild(det);
  });

  // Resumen grupal COMPLETO
  const g = aggregateGroupV2(okItems);
  setTextById('grpTotal',   String(g.total));
  setTextById('grpAvg',     String(g.promedio));
  setTextById('grpResumen', g.resumen || '');
  setHtmlById('grpHall', g.hallTop.length ? g.hallTop.map(h => `<li>${escapeHtml(h)}</li>`).join('') : '<li>—</li>');
  setHtmlById('grpCrit', g.afectadosTop.length ? g.afectadosTop.map(a => `<li>${escapeHtml(a.text)} (${a.count})</li>`).join('') : '<li>—</li>');
  setTextById('grpPlan', g.planMejora || '—');

  const hasFraud = Array.isArray(g.fraudeTop) && g.fraudeTop.length > 0;
  if ($grpFraudeCard) $grpFraudeCard.style.display = hasFraud ? '' : 'none';
  if ($grpFraudeList) {
    $grpFraudeList.innerHTML = hasFraud ? g.fraudeTop.map(x => `<li>${formatFraudItem(x)}</li>`).join('') : '';
  }
}

// --------- Render por lotes (SSE tradicional) ---------
function renderBatchResults(result) {
  if ($resultsCard) $resultsCard.style.display = '';

  const items = (result.items || []).filter(it => it.status === 'done' && it.meta);
  if ($countInd) $countInd.textContent = String(items.length);

  if ($individualList) $individualList.innerHTML = '';
  items.forEach((it) => {
    const meta        = it.meta || {};
    const analisis    = pick(meta, 'analisis') || pick(meta, 'analysis') || {};
    const consolidado = pick(meta, 'consolidado') || pick(meta, 'scoring') || {};

    const agente  = pick(meta, 'agente') || pick(meta, 'agent') || pick(meta, 'metadata.agentName') || pick(analisis, 'agent_name') || '-';
    const cliente = pick(meta, 'cliente') || pick(meta, 'client') || pick(meta, 'metadata.customerName') || pick(analisis, 'client_name') || '-';
    const callId  = pick(meta, 'metadata.callId') || pick(meta, 'callId') || '';

    const nota    = numOrDash(pick(meta, 'nota') ?? pick(consolidado, 'notaFinal'));
    const hallazgos = pick(analisis, 'hallazgos') || pick(meta, 'hallazgos') || [];
    const afectadosCriticos = pick(consolidado, 'afectadosCriticos') || pick(analisis, 'afectadosCriticos') || pick(meta, 'afectadosCriticos') || [];
    const noAplican = pick(consolidado, 'noAplican') || pick(analisis, 'noAplican') || pick(meta, 'noAplican') || [];

    const campania = pick(meta, 'metadata.campania') || pick(meta, 'campania') || '';
    const tipificacion = pick(meta, 'metadata.tipificacion') || pick(meta, 'tipificacion') || '';

    const fraude = (pick(analisis, 'fraude.alertas') || []).map(formatFraudItem);

    const porAtrib = flattenPorAtrib(meta);
    const mejoras = porAtrib.filter(a => a && a.aplica !== false && a.cumplido === false && a.mejora)
      .map(a => `<li><strong>${escapeHtml(a.atributo)}</strong>: ${escapeHtml(a.mejora)}</li>`);

    const transcriptMarked = String(pick(meta, 'transcriptMarked') || '').trim();
    const transcriptBlock = transcriptMarked
      ? `<section style="margin:8px 0;">
           <div style="font-weight:600;margin-bottom:4px;">Transcripción (tiempos y rol)</div>
           <pre style="white-space:pre-wrap; font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:0.95rem;">${escapeHtml(transcriptMarked)}</pre>
         </section>` : '';

    const resumen = pick(meta, 'resumen') || pick(analisis, 'resumen') || '';

    const det = document.createElement('details');
    det.innerHTML = `
      <summary><b>${escapeHtml(agente)}</b> — ${escapeHtml(cliente)} · <span class="pill">Nota: ${nota}</span> · <small>${escapeHtml(callId)}</small></summary>
      <div style="padding:8px 12px">
        ${campania || tipificacion ? `<p><b>Campaña:</b> ${escapeHtml(campania || '—')} · <b>Tipificación:</b> ${escapeHtml(tipificacion || '—')}</p>` : ''}
        <p><b>Resumen:</b> ${resumen ? escapeHtml(resumen) : '(sin resumen)'}</p>
        <p><b>Hallazgos:</b></p>
        <ul>${(hallazgos || []).map(h => `<li>${escapeHtml(h)}</li>`).join('') || '<li>—</li>'}</ul>
        ${fraude.length ? `<p><b>Alertas de fraude:</b></p><ul>${fraude.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
        <p><b>Afectados críticos:</b></p>
        <ul>${(arr(afectadosCriticos).length ? arr(afectadosCriticos).map(a => `<li>${escapeHtml(a)}</li>`).join('') : '<li>—</li>')}</ul>
        ${arr(noAplican).length
          ? `<p><b>No aplica:</b></p><ul>${arr(noAplican).map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
          : '' }
        ${mejoras.length ? `<p><b>Plan de mejora:</b></p><ul>${mejoras.join('')}</ul>` : ''}
        ${transcriptBlock}
      </div>
    `;
    $individualList?.appendChild(det);
  });

  // Resumen grupal COMPLETO (si el backend no lo trae, lo calculamos)
  let g = result.group || {};
  if (!g || (!g.resumen && !g.topHallazgos && !g.afectadosCriticos)) {
    const normalized = items.map(it => ({ analisis: it.meta?.analisis, meta: it.meta }));
    g = aggregateGroupV2(normalized);
  } else {
    // normaliza a nuestra UI
    const g2 = aggregateGroupV2(items.map(it => ({ analisis: it.meta?.analisis, meta: it.meta })));
    g.total = g.total ?? g2.total;
    g.promedio = g.promedio ?? g2.promedio;
    g.resumen = g.resumen ?? g2.resumen;
    g.topHallazgos = g.topHallazgos ?? g2.hallTop;
    g.afectadosCriticos = g.afectadosCriticos ?? g2.afectadosTop.map(a => `${a.text} (${a.count})`);
    g.planMejora = g.planMejora ?? g2.planMejora;
  }

  setTextById('grpTotal',   String(g.total ?? items.length ?? 0));
  setTextById('grpAvg',     String(Number.isFinite(+g.promedio) ? Math.round(+g.promedio) : (g.averageScore ?? 0)));
  setTextById('grpResumen', g.resumen || '');
  setHtmlById('grpHall', (g.topHallazgos || g.hallazgos || g.hallTop || []).map(h => `<li>${escapeHtml(h)}</li>`).join('') || '<li>—</li>');
  const critGroup = g.afectadosCriticos || g.atributosCriticos || [];
  setHtmlById('grpCrit', Array.isArray(critGroup) && critGroup.length ? critGroup.map(x => `<li>${escapeHtml(x)}</li>`).join('') : '<li>—</li>');
  setTextById('grpPlan',   g.planMejora || '');

  // fraude (grupo) desde items si no viene
  const fraudesGrupo = [];
  items.forEach(it => {
    const arr = pick(it, 'meta.analisis.fraude.alertas') || [];
    arr.forEach(x => fraudesGrupo.push(x));
  });
  const hasFraud = fraudesGrupo.length > 0;
  if ($grpFraudeCard) $grpFraudeCard.style.display = hasFraud ? '' : 'none';
  if ($grpFraudeList) {
    $grpFraudeList.innerHTML = hasFraud
      ? fraudesGrupo.slice(0, 10).map(x => `<li>${formatFraudItem(x)}</li>`).join('')
      : '';
  }
}

// ---------- Consolidado ----------
const $btnReload = $('btnReload');
const $summary   = $('summary');
const $tbody     = document.querySelector('#tbl tbody');

function renderSummaryCompatible(s) {
  const isOld = s && (s.totalCalls !== undefined || s.byAgent || s.byCategory);
  const total = isOld ? (s.totalCalls ?? 0) : (s.total ?? 0);
  const prom  = isOld ? (s.averageScore ?? 0) : (s.promedio ?? 0);
  const promTxt = Number.isFinite(+prom) ? Math.round(+prom) : prom;

  let html = `
    <div class="pill">Total llamadas: <b>${total}</b></div>
    <div class="pill">Promedio: <b>${promTxt}</b></div>
  `;

  html += `
    <details id="secPorAgente" open>
      <summary style="font-weight:600; cursor:pointer;">Por agente</summary>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
  `;
  if (isOld && s.byAgent) {
    const chips = Object.entries(s.byAgent).map(([k, v]) =>
      `<span class="pill">${k || 'Sin agente'}: ${v.count} (${Math.round(v.avgScore || 0)})</span>`
    );
    html += chips.join('') || '<span>—</span>';
  } else if (Array.isArray(s?.porAgente)) {
    const chips = s.porAgente.map(a =>
      `<span class="pill">${a.agente || 'Sin agente'}: ${a.total} (${Math.round(a.promedio || 0)})</span>`
    );
    html += chips.join('') || '<span>—</span>';
  } else {
    html += '<span>—</span>';
  }
  html += `</div></details>`;

  html += `
    <details id="secPorCategoria">
      <summary style="font-weight:600; cursor:pointer;">Por categoría</summary>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
  `;
  if (isOld && s.byCategory) {
    const chips = Object.entries(s.byCategory).map(([k, v]) =>
      `<span class="pill">${k}: ${Math.round(v.avgCumplimiento || 0)}%</span>`
    );
    html += chips.join('') || '<span>—</span>';
  } else if (Array.isArray(s?.porCategoria)) {
    const chips = s.porCategoria.map(c =>
      `<span class="pill">${(c.categoria || c.atributo || 'Categoría')}: ${Math.round((c.cumplimiento?.porcentaje ?? c.porcentaje) || 0)}%</span>`
    );
    html += chips.join('') || '<span>—</span>';
  } else {
    html += '<span>—</span>';
  }
  html += `</div></details>`;

  return html;
}

async function loadSummary() {
  if (!$summary) return;
  try {
    const r = await fetch('/audits/summary');
    const s = await r.json();
    if (!r.ok) throw new Error(s?.error || 'Error summary');
    $summary.innerHTML = renderSummaryCompatible(s);
  } catch (e) {
    $summary.innerHTML = `<span style="color:#b00">Error cargando resumen: ${e.message || e}</span>`;
  }
}

async function loadAudits() {
  if (!$tbody) return;
  try {
    const r = await fetch('/audits');
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'Error audits');

    const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []);
    $tbody.innerHTML = '';

    items.forEach(it => {
      const tr = document.createElement('tr');
      const ts = it?.metadata?.timestamp ? new Date(it.metadata.timestamp).toLocaleString() : '-';
      const call  = it?.metadata?.callId || '-';
      const ag    = it?.metadata?.agentName    || it?.analisis?.agent_name  || '-';
      const cli   = it?.metadata?.customerName || it?.analisis?.client_name || '-';
      const nota  = numOrDash(it?.consolidado?.notaFinal);

      const callId = it?.metadata?.callId || '';
      let reporteHtml = '—';
      if (callId) {
        const href = it?.reportPath
          ? (isHttpOrRoot(it.reportPath) ? it.reportPath : ('/audits/files/' + basename(it.reportPath)))
          : (`/audits/files/${callId}.md`);
        reporteHtml = `<a href="${href}" target="_blank" rel="noopener">MD</a>`;
      }

      tr.innerHTML = `
        <td>${ts}</td>
        <td>${call}</td>
        <td>${ag}</td>
        <td>${cli}</td>
        <td>${nota}</td>
        <td>${reporteHtml}</td>
      `;
      $tbody.appendChild(tr);
    });

    if ($tbody.children.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'Sin auditorías aún.';
      tr.appendChild(td);
      $tbody.appendChild(tr);
    }
  } catch (e) {
    $tbody.innerHTML = `<tr><td colspan="6" style="color:#b00">Error cargando auditorías: ${e.message || e}</td></tr>`;
  }
}

async function reloadConsolidado() { await Promise.all([loadSummary(), loadAudits()]); }
$('btnReload')?.addEventListener('click', reloadConsolidado);

// ---------- Estado inicial ----------
showAnalyze(); // Analizar es la vista por defecto
