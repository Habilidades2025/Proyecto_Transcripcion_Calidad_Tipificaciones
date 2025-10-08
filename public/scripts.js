// ---------- Utils ----------
function $(id) { return document.getElementById(id); }
function setOut(obj) { const out = $('out'); if (out) out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2); }
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
// Num seguro para UI (para la Nota)
function numOrDash(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : '-';
}

// Helpers defensivos (evitan "Cannot set properties of null")
function setTextById(id, text) { const el = $(id); if (el) el.textContent = text ?? ''; }
function setHtmlById(id, html) { const el = $(id); if (el) el.innerHTML = html ?? ''; }
function renderListById(id, items) {
  const el = $(id);
  if (!el) return;
  if (!Array.isArray(items) || items.length === 0) { el.innerHTML = '<li>—</li>'; return; }
  el.innerHTML = items.map(i => `<li>${i}</li>`).join('');
}

// ---- Helpers nuevos para tolerancia a estructuras anidadas/planas ----
function pick(obj, path, fallback = undefined) {
  if (!obj || !path) return fallback;
  const parts = Array.isArray(path) ? path : String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, p)) {
      cur = cur[p];
    } else {
      return fallback;
    }
  }
  return cur;
}
function arr(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }
// Normaliza porAtributo (venga en meta.porAtributo o consolidado.porAtributo)
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
  Object.entries(map).forEach(([k, btn]) => {
    if (!btn) return;
    btn.className = (k === active) ? 'primary' : 'muted';
  });
}
function showTranscribe() {
  if (!$viewTranscribe || !$viewAnalyze || !$viewConsolidado) return;
  setTabClasses('transcribe');
  $viewTranscribe.style.display = '';
  $viewAnalyze.style.display = 'none';
  $viewConsolidado.style.display = 'none';
}
function showAnalyze() {
  if (!$viewTranscribe || !$viewAnalyze || !$viewConsolidado) return;
  setTabClasses('analyze');
  $viewTranscribe.style.display = 'none';
  $viewAnalyze.style.display = '';
  $viewConsolidado.style.display = 'none';
}
async function showConsolidado() {
  if (!$viewTranscribe || !$viewAnalyze || !$viewConsolidado) return;
  setTabClasses('consolidado');
  $viewTranscribe.style.display = 'none';
  $viewAnalyze.style.display = 'none';
  $viewConsolidado.style.display = '';
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

      if ($txStatus) $txStatus.textContent = `Transcribiendo ${files.length} audios... (esto puede tardar)`;
      const resp = await fetch('/transcribe-zip', { method: 'POST', body: fd });
      if (!resp.ok) { const err = await safeJson(resp); throw new Error(err?.error || `Error HTTP ${resp.status}`); }
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
      const resp = await fetch('/transcribe-txt', { method: 'POST', body: fd });
      if (!resp.ok) { const err = await safeJson(resp); throw new Error(err?.error || `Error HTTP ${resp.status}`); }
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
    if ($txStatus) $txStatus.textContent = 'Ocurrió un error. Intenta nuevamente.';
  } finally {
    if ($txBtn) { $txBtn.disabled = false; $txBtn.textContent = 'Transcribir'; }
  }
});

async function safeJson(resp) { try { return await resp.json(); } catch { return null; } }

// ---------- Analizar (BATCH) ----------
const $formBatch   = $('formBatch');
const $matrix      = $('matrix');
const $audios      = $('audios');
const $provider    = $('provider');
const $scriptFile  = $('scriptFile'); // input opcional para guion

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

const $metodologia  = $('metodologia');
const $carteraField = $('cartera-field');
const $cartera      = $('cartera');

const $grpTotal   = $('grpTotal');
const $grpAvg     = $('grpAvg');
const $grpResumen = $('grpResumen');
const $grpHall    = $('grpHall');
const $grpCrit    = $('grpCrit');
const $grpPlan    = $('grpPlan');

// Fraude (grupo)
const $grpFraudeCard = $('grpFraudeCard');                         // contenedor (se oculta si no hay alertas)
const $grpFraudeList = $('grpFraudeList') || $('grpFraude');       // <ul>

$metodologia?.addEventListener('change', function () {
  const metodologia = this.value;
  if ($cartera) $cartera.innerHTML = '<option value="">Selecciona cartera</option>';

  if (metodologia === 'cobranza') {
    if ($carteraField) $carteraField.style.display = 'block';
    [
      { value: 'carteras_bogota',   text: 'Carteras propias Bogotá'  },
      { value: 'carteras_medellin', text: 'Carteras propias Medellín'}
    ].forEach(op => {
      const option = document.createElement('option');
      option.value = op.value; option.textContent = op.text;
      $cartera?.appendChild(option);
    });
  } else {
    if ($carteraField) $carteraField.style.display = 'none';
  }
});

let evtSource = null;

$formBatch?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$matrix?.files?.length || !$audios?.files?.length) { alert('Adjunta una matriz y al menos un audio.'); return; }

  if ($progressCard) $progressCard.style.display = '';
  if ($resultsCard)  $resultsCard.style.display  = 'none';
  if ($listProgress) $listProgress.innerHTML     = '';
  if ($lblProgress)  $lblProgress.textContent    = `0 / ${$audios.files.length}`;
  if ($barProgress)  $barProgress.style.width    = '0%';

  const fd = new FormData();
  fd.append('matrix', $matrix.files[0]);
  Array.from($audios.files).forEach(f => fd.append('audios', f));
  if ($provider?.value)    fd.append('provider', $provider.value);
  if ($metodologia?.value) fd.append('metodologia', $metodologia.value);
  if ($cartera?.value)     fd.append('cartera', $cartera.value);
  if ($scriptFile?.files?.[0]) fd.append('script', $scriptFile.files[0]);

  try {
    const r = await fetch('/batch/start', { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) { alert(j?.error || 'No se pudo iniciar el lote'); return; }
    startSSE(j.jobId);
  } catch (err) {
    alert('Error iniciando lote: ' + (err?.message || err));
  }
});

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
    const r = await fetch(`/batch/result/${jobId}`);
    const j = await r.json();
    if (!r.ok) { alert(j?.error || 'Error obteniendo resultados'); return; }
    renderBatchResults(j);
  } catch (err) {
    alert('Error obteniendo resultados: ' + (err?.message || err));
  }
}

function renderBatchResults(result) {
  if ($resultsCard) $resultsCard.style.display = '';

  const items = (result.items || []).filter(it => it.status === 'done' && it.meta);
  if ($countInd) $countInd.textContent = String(items.length);

  if ($individualList) $individualList.innerHTML = '';
  items.forEach((it) => {
    const meta = it.meta || {};

    // --- Normalización de campos (flat y nested) ---
    const analisis    = pick(meta, 'analisis') || pick(meta, 'analysis') || {};
    const consolidado = pick(meta, 'consolidado') || pick(meta, 'scoring') || {};

    const agente  = pick(meta, 'agente') || pick(meta, 'agent') || pick(meta, 'metadata.agentName') || pick(analisis, 'agent_name') || '-';
    const cliente = pick(meta, 'cliente') || pick(meta, 'client') || pick(meta, 'metadata.customerName') || pick(analisis, 'client_name') || '-';
    const callId  = pick(meta, 'metadata.callId') || pick(meta, 'callId') || '';

    const nota    = numOrDash(pick(meta, 'nota') ?? pick(consolidado, 'notaFinal'));

    // Hallazgos: preferir analisis.hallazgos; fallback a meta.hallazgos
    const hallazgos = pick(analisis, 'hallazgos') || pick(meta, 'hallazgos') || [];

    // Afectados críticos: SIEMPRE desde scoring/analysis (backend), jamás de “texto”
    const afectadosCriticos =
      pick(consolidado, 'afectadosCriticos') ||
      pick(analisis, 'afectadosCriticos') ||
      pick(meta, 'afectadosCriticos') || [];

    // No aplica (excluidos)
    const noAplican =
      pick(consolidado, 'noAplican') ||
      pick(analisis, 'noAplican') ||
      pick(meta, 'noAplican') || [];

    // Plan de mejora por llamada (desde porAtributo donde cumplido=false con mejora)
    const porAtrib = flattenPorAtrib(meta);
    const mejoras = porAtrib
      .filter(a => a && a.aplica !== false && a.cumplido === false && a.mejora)
      .map(a => `<li><strong>${escapeHtml(a.atributo)}</strong>: ${escapeHtml(a.mejora)}</li>`);

    // Transcripción marcada (mantener indentación)
    const transcriptMarked = String(pick(meta, 'transcriptMarked') || '').trim();
    const transcriptBlock = transcriptMarked
      ? `<section style="margin:8px 0;">
           <div style="font-weight:600;margin-bottom:4px;">Transcripción (tiempos y rol)</div>
           <pre style="white-space:pre-wrap; font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:0.95rem;">${escapeHtml(transcriptMarked)}</pre>
         </section>`
      : '';

    const resumen = pick(meta, 'resumen') || pick(analisis, 'resumen') || '';

    const det = document.createElement('details');
    det.innerHTML = `
      <summary><b>${escapeHtml(agente)}</b> — ${escapeHtml(cliente)} · <span class="pill">Nota: ${nota}</span> · <small>${escapeHtml(callId)}</small></summary>
      <div style="padding:8px 12px">
        <p><b>Resumen:</b> ${resumen ? escapeHtml(resumen) : '(sin resumen)'}</p>

        <p><b>Hallazgos:</b></p>
        <ul>${(hallazgos || []).map(h => `<li>${escapeHtml(h)}</li>`).join('') || '<li>—</li>'}</ul>

        <p><b>Afectados (críticos, desde scoring):</b></p>
        <ul>${(arr(afectadosCriticos).length ? arr(afectadosCriticos).map(a => `<li>${escapeHtml(a)}</li>`).join('') : '<li>—</li>')}</ul>

        <p><b>No aplica (excluidos del cómputo):</b></p>
        <ul>${(arr(noAplican).length ? arr(noAplican).map(a => `<li>${escapeHtml(a)}</li>`).join('') : '<li>—</li>')}</ul>

        ${mejoras.length ? `
          <p><b>Plan de mejora:</b></p>
          <ul>${mejoras.join('')}</ul>
        ` : ''}

        ${(() => {
          // Render opcional: tabla compacta de porAtributo (útil para depurar NA vs incumplidos)
          if (!porAtrib.length) return '';
          const rows = porAtrib.map(a => {
            const badge = (a.aplica === false || String(a.status||'').toUpperCase()==='NA') ? 'NA' : (a.cumplido ? '✅' : '❌');
            const peso  = Number(a.peso ?? 0);
            return `
              <tr>
                <td>${escapeHtml(a.atributo || '')}</td>
                <td style="text-align:center">${badge}</td>
                <td style="text-align:right">${peso}</td>
                <td>${escapeHtml(a.justificacion || '')}</td>
              </tr>
            `;
          }).join('');
          return `
            <details style="margin-top:10px;">
              <summary style="cursor:pointer;font-weight:600;">Detalle por atributo</summary>
              <div style="overflow:auto;">
                <table class="mini">
                  <thead><tr><th>Atributo</th><th>Estado</th><th>Peso</th><th>Justificación</th></tr></thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>
            </details>
          `;
        })()}

        ${transcriptBlock}
      </div>
    `;
    if ($individualList) $individualList.appendChild(det);
  });

  // Resumen grupal
  const g = result.group || {};
  setTextById('grpTotal',   String(g.total ?? g.totalCalls ?? 0));
  setTextById('grpAvg',     String(Number.isFinite(+g.promedio) ? Math.round(+g.promedio) : (g.averageScore ?? 0)));
  setTextById('grpResumen', g.resumen || '');

  if ($grpHall) $grpHall.innerHTML = (g.topHallazgos || g.hallazgos || []).map(h => `<li>${escapeHtml(h)}</li>`).join('') || '<li>—</li>';

  // Afectados críticos grupales (si el backend los resume)
  const critGroup = g.atributosCriticos || g.afectadosCriticos || [];
  setTextById('grpCrit',   Array.isArray(critGroup) ? critGroup.join(', ') : '—');
  setTextById('grpPlan',   g.planMejora || '');

  // Fraude (grupo)
  let topFraude = g.fraudeAlertasTop || g.topFraude || g.fraude || [];
  if (!Array.isArray(topFraude)) topFraude = [];

  const groupHasFraud = topFraude.length > 0;

  if ($grpFraudeCard) $grpFraudeCard.style.display = groupHasFraud ? '' : 'none';
  if ($grpFraudeList) {
    $grpFraudeList.innerHTML = groupHasFraud
      ? topFraude.map(x => `<li>${formatFraudItem(x)}</li>`).join('')
      : '';
  }
}

// ---------- Consolidado ----------
const $btnReload = $('btnReload');
const $summary   = $('summary');
const $tbody     = document.querySelector('#tbl tbody');

// (plegables) — Por agente / Por categoría
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
    // soporta forma nueva { categoria, cumplimiento: { porcentaje } }
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
showTranscribe();
