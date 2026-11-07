/*
 * Cuaderno de Exámenes: rutas, carga de datos, reproductor de exámenes y resultados.
 *
 * Rutas (hash):
 *   #/                                 -> asignaturas
 *   #/s/:asignatura                    -> simulacros + más falladas
 *   #/s/:asignatura/errores            -> contador de errores
 *   #/s/:asignatura/examen/:n/:modo    -> simulacro n (modo = practica | examen)
 *   #/s/:asignatura/falladas/:n/:modo  -> examen de más falladas n
 *   #/s/:asignatura/repaso/:modo       -> repaso de las falladas del último intento
 */
(() => {
  const SUBJECTS = window.SUBJECTS || [];
  const CONFIG = window.APP_CONFIG || { totalSlots: 30, failedExamCount: 3, failedExamSize: 20 };
  const MODES = { practica: 'Práctica', examen: 'Examen' };
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

  const app = document.getElementById('app');
  const crumbs = document.getElementById('crumbs');
  const announcer = document.getElementById('announcer');

  const dataCache = {};      // asignatura -> datos normalizados
  let session = null;        // examen en curso o recién terminado
  let pendingReview = null;  // preguntas para la ruta de repaso
  let timerId = null;
  let currentHash = location.hash || '#/';

  /* =========================================================================
     Utilidades
     ========================================================================= */

  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const pad = (n) => String(n).padStart(2, '0');

  const formatGrade = (grade) => grade.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  // Iconos de Reicon (js/icons.js). Variante rellena: icon('check-circle:filled').
  const icon = (name, extra = '') =>
    `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">${(window.ICONS || {})[name] || ''}</svg>`;

  // Datos sueltos (etiqueta pequeña sobre valor) en lugar de una fila de chips.
  const facts = (items) => `
    <dl class="facts">${items.filter(Boolean).map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;

  const listFormat = new Intl.ListFormat('es', { style: 'long', type: 'conjunction' });

  // ['Tema 1', 'Tema 2', 'Tema 3.1'] -> 'Temas 1, 2 y 3.1'
  function formatTemas(temas) {
    if (temas.length > 1 && temas.every((t) => /^Tema\s/.test(t))) {
      return `Temas ${listFormat.format(temas.map((t) => t.replace(/^Tema\s+/, '')))}`;
    }
    return listFormat.format(temas);
  }

  function progressBar(value, max, { color = 'accent', size = 'sm', label = '', output = '' } = {}) {
    const pct = max ? Math.round((value / max) * 100) : 0;
    return `
      <div class="progress-bar progress-bar--${color} progress-bar--${size}" role="progressbar"
           aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" ${label ? `aria-label="${esc(label)}"` : ''}>
        ${label ? `<span data-slot="label">${esc(label)}</span>` : ''}
        ${output ? `<span class="progress-bar__output">${output}</span>` : ''}
        <div class="progress-bar__track"><div class="progress-bar__fill" style="width:${pct}%"></div></div>
      </div>`;
  }

  function daysUntil(isoDate) {
    if (!isoDate) return null;
    const target = new Date(`${isoDate}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }

  function confirmDialog({ title, text, okLabel = 'Aceptar', cancelLabel = 'Cancelar', danger = false }) {
    const dialog = document.getElementById('confirm-dialog');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    const ok = document.getElementById('confirm-ok');
    ok.textContent = okLabel;
    ok.className = `button ${danger ? 'button--danger' : 'button--primary'}`;
    document.getElementById('confirm-cancel').textContent = cancelLabel;
    dialog.returnValue = '';
    dialog.showModal();
    ok.focus();
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    });
  }

  /* =========================================================================
     Datos
     ========================================================================= */

  // Formato «banco_examenes_escalable»: un banco de preguntas y versiones que las citan por id.
  // Se traduce a { metadatos, examenes } y solo se quedan las de opción única: las de desarrollo
  // y los casos prácticos no tienen opciones que puntuar.
  function fromQuestionBank(raw) {
    const meta = raw.metadatos || {};
    const penalty = (raw.configuracion_examen?.secciones || [])
      .map((s) => s.correccion?.penalizacion_por_error)
      .find(Boolean);
    const temas = {};
    const subtemas = {};
    (raw.temario || []).forEach((t) => {
      // 'Captura de requisitos (4.1)' -> 'Tema 4.1'; 'T02' -> 'Tema 2'
      const num = t.nombre?.match(/\((\d+(?:\.\d+)*)\)\s*$/)?.[1] || t.id?.match(/^T0*(\d+)$/)?.[1];
      temas[t.id] = num ? `Tema ${num}` : t.nombre;
      // Un subtema único suele ser una lista de palabras clave: entonces se usa el bloque de la pregunta.
      if (t.subtemas?.length > 1) t.subtemas.forEach((s) => { subtemas[s.id] = s.nombre; });
    });
    const bank = Object.fromEntries((raw.banco_preguntas || []).map((q) => [q.id, q]));

    return {
      metadatos: {
        universidad: meta.institucion,
        fecha_parcial: meta.convocatoria?.fecha,
        rubrica: penalty && { penalizacion_por_error: penalty.numerador / penalty.denominador },
      },
      examenes: (raw.versiones || []).map((v) => ({
        version: v.numero,
        codigo: v.codigo,
        preguntas: (v.secciones || [])
          .flatMap((s) => s.preguntas_ids || [])
          .map((id) => bank[id])
          .filter((q) => q && q.tipo === 'opcion_unica')
          .map((q, i) => ({
            ...q,
            numero: i + 1,
            tema: temas[q.tema_id],
            bloque: subtemas[q.subtema_id] || q.bloque,
          })),
      })),
    };
  }

  function normalizeSubject(subject, raw) {
    if (raw.banco_preguntas) raw = fromQuestionBank(raw);
    const meta = raw.metadatos || {};
    const penaltyRaw = meta.rubrica?.penalizacion_por_error;
    const penalty = typeof penaltyRaw === 'number' ? Math.abs(penaltyRaw) : 1 / 3;
    const byId = {};

    const exams = (raw.examenes || [])
      .slice()
      .sort((a, b) => (a.version ?? 0) - (b.version ?? 0))
      .map((exam, examIndex) => {
        const number = examIndex + 1;
        const questions = (exam.preguntas || [])
          .slice()
          .sort((a, b) => (a.numero ?? 0) - (b.numero ?? 0))
          .map((q, qIndex) => {
            const entries = Array.isArray(q.opciones)
              ? q.opciones.map((text, i) => [String.fromCharCode(65 + i), text])
              : Object.entries(q.opciones || {});
            const question = {
              id: q.id || `${subject.id}-${number}-${qIndex + 1}`,
              exam: number,
              number: q.numero ?? qIndex + 1,
              tema: q.tema || 'Sin tema',
              bloque: q.bloque || '',
              text: q.enunciado || '',
              options: entries.map(([key, text]) => ({ key, text })),
              correct: q.respuesta_correcta,
              explanation: q.explicacion || '',
              source: q.fuente_temario || '',
            };
            byId[question.id] = question;
            return question;
          });
        return { number, version: exam.version ?? number, code: exam.codigo || '', questions };
      });

    return { subject, meta, penalty, exams, byId };
  }

  async function loadSubject(subject) {
    if (dataCache[subject.id]) return dataCache[subject.id];
    const response = await fetch(subject.archivo, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status} al leer ${subject.archivo}`);
    const raw = await response.json();
    dataCache[subject.id] = normalizeSubject(subject, raw);
    return dataCache[subject.id];
  }

  // Preguntas falladas ordenadas por nº de fallos, repartidas en varios exámenes.
  function buildFailedExams(data) {
    const fails = Store.getFails(data.subject.id);
    const ranked = Object.entries(fails)
      .filter(([id, f]) => f.count > 0 && data.byId[id])
      .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last)
      .map(([id, f]) => ({ question: data.byId[id], count: f.count }));

    const groups = [];
    for (let i = 0; i < CONFIG.failedExamCount; i++) {
      const items = ranked.slice(i * CONFIG.failedExamSize, (i + 1) * CONFIG.failedExamSize);
      if (!items.length) break;
      groups.push({ index: i + 1, items, max: items[0].count, min: items[items.length - 1].count });
    }
    return { ranked, groups, totalFails: ranked.reduce((sum, r) => sum + r.count, 0) };
  }

  /* =========================================================================
     Rutas
     ========================================================================= */

  function parseRoute() {
    const parts = (location.hash || '#/').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 's' || !parts[1]) return { view: 'home' };
    const sid = parts[1];
    const mode = MODES[parts[4]] ? parts[4] : (MODES[parts[3]] ? parts[3] : 'practica');
    switch (parts[2]) {
      case undefined: return { view: 'subject', sid };
      case 'errores': return { view: 'errors', sid };
      case 'examen': return { view: 'exam', sid, n: Number(parts[3]), mode };
      case 'falladas': return { view: 'failed', sid, n: Number(parts[3]), mode };
      case 'repaso': return { view: 'review', sid, mode };
      default: return { view: 'notfound' };
    }
  }

  const isGuarded = () => !!session && !session.finished && session.answers.some((a) => a !== null);

  window.addEventListener('hashchange', async () => {
    const target = location.hash || '#/';
    if (target === currentHash) return;
    if (isGuarded()) {
      history.replaceState(null, '', currentHash);
      const leave = await confirmDialog({
        title: '¿Abandonar el examen?',
        text: 'Perderás las respuestas de este intento y no contará en tu historial.',
        okLabel: 'Salir',
        cancelLabel: 'Seguir con el examen',
        danger: true,
      });
      if (!leave) return;
      session = null;
      history.replaceState(null, '', target);
    }
    currentHash = target;
    await render();
    focusHeading();
  });

  window.addEventListener('beforeunload', (event) => {
    if (isGuarded()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  function navigate(hash) {
    if (hash === currentHash) render();
    else location.hash = hash;
  }

  function setCrumbs(items) {
    crumbs.innerHTML = items.map((item, i) => {
      const sep = i ? `<span class="crumbs__sep">${icon('angle-right')}</span>` : '';
      return item.href
        ? `${sep}<a href="${item.href}">${esc(item.label)}</a>`
        : `${sep}<span aria-current="page">${esc(item.label)}</span>`;
    }).join('');
  }

  async function render() {
    stopTimer();
    const route = parseRoute();
    if (route.view === 'home') return renderHome();
    if (route.view === 'notfound') return renderNotFound();

    const subject = SUBJECTS.find((s) => s.id === route.sid);
    if (!subject) return renderNotFound();

    let data = dataCache[subject.id];
    if (!data) {
      renderLoading();
      try {
        data = await loadSubject(subject);
      } catch (error) {
        return renderLoadError(subject, error);
      }
    }

    switch (route.view) {
      case 'subject': return renderSubject(data);
      case 'errors': return renderErrors(data);
      case 'exam': return startExam(data, route);
      case 'failed': return startFailedExam(data, route);
      case 'review': return startReview(data, route);
      default: return renderNotFound();
    }
  }

  function show(html) {
    app.innerHTML = html;
    window.scrollTo({ top: 0 });
  }

  // Tras cambiar de vista, el foco va al título para que el lector de pantalla empiece por ahí.
  function focusHeading() {
    const heading = app.querySelector('h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }

  /* =========================================================================
     Vistas generales
     ========================================================================= */

  function renderLoading() {
    app.innerHTML = `<div class="sheet empty-state"><div class="spinner-dots"><span></span><span></span><span></span></div><p>Cargando preguntas…</p></div>`;
  }

  function renderNotFound() {
    setCrumbs([]);
    show(`
      <section class="sheet empty-state">
        <h1 class="page-title">Página no encontrada</h1>
        <a class="button button--primary" href="#/">${icon('home')} Volver al inicio</a>
      </section>`);
  }

  function renderLoadError(subject, error) {
    setCrumbs([{ label: 'Asignaturas', href: '#/' }, { label: subject.corto }]);
    const isFile = location.protocol === 'file:';
    show(`
      <section class="sheet stack">
        <div class="verdict verdict--wrong">
          <h1 class="verdict__title">${icon('danger')} No se ha podido cargar <code>${esc(subject.archivo)}</code></h1>
          <p class="verdict__detail">${esc(error.message)}</p>
        </div>
        ${isFile ? `
          <p>Has abierto la página directamente como archivo, y el navegador bloquea la lectura de JSON locales.
          Tienes dos opciones:</p>
          <ol class="steps">
            <li>Levanta un servidor local en la carpeta del proyecto y abre <code>http://localhost:8000</code>:
              <pre class="code-note">python3 -m http.server 8000</pre></li>
            <li>O selecciona el JSON a mano (solo dura mientras no recargues):</li>
          </ol>` : '<p>Revisa que el archivo exista y que su ruta en <code>js/subjects.js</code> sea correcta.</p>'}
        <label class="button button--secondary file-picker">
          ${icon('folder-open')} Elegir archivo JSON
          <input type="file" accept="application/json,.json" data-subject="${esc(subject.id)}" id="json-picker">
        </label>
      </section>`);

    document.getElementById('json-picker').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        dataCache[subject.id] = normalizeSubject(subject, JSON.parse(await file.text()));
        render();
      } catch (err) {
        renderLoadError(subject, new Error(`El archivo no es un JSON válido: ${err.message}`));
      }
    });
  }

  async function renderHome() {
    setCrumbs([]);
    renderLoading();
    const results = await Promise.allSettled(SUBJECTS.map(loadSubject));

    const cards = SUBJECTS.map((subject, i) => {
      const data = results[i].status === 'fulfilled' ? results[i].value : null;
      const totalQuestions = data ? data.exams.reduce((sum, e) => sum + e.questions.length, 0) : 0;
      const failed = data ? buildFailedExams(data).ranked.length : 0;
      const temas = data
        ? [...new Set(data.exams.flatMap((e) => e.questions.map((q) => q.tema)))].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))
        : [];
      return `
        <a class="card card--default subject-card" href="#/s/${encodeURIComponent(subject.id)}">
          <span class="tape" aria-hidden="true"></span>
          <h2 class="card__title subject-card__title">${esc(subject.nombre)}</h2>
          ${data
            ? `${facts([
                ['Simulacros', data.exams.length],
                ['Preguntas', totalQuestions],
                failed && ['Por repasar', `<span class="text-danger">${failed}</span>`],
              ])}
              <p class="subject-card__temas">${esc(formatTemas(temas))}</p>`
            : '<p class="text-danger">No se pudo leer el JSON</p>'}
          ${icon('arrow-right', 'subject-card__go')}
        </a>`;
    }).join('');

    show(`
      <section class="hero">
        <h1 class="page-title"><span class="highlight">Elige asignatura</span></h1>
        <p class="lead">Practica pregunta a pregunta o haz el examen completo. Lo que falles se apunta en tu contador de errores.</p>
      </section>
      <section class="subject-grid">${cards || '<p class="muted">No hay asignaturas en <code>js/subjects.js</code>.</p>'}</section>`);
  }

  /* =========================================================================
     Asignatura: simulacros + más falladas
     ========================================================================= */

  function modeSwitch(mode) {
    const on = mode === 'examen';
    return `
      <div class="mode-box">
        <button type="button" class="switch switch--lg" role="switch" aria-checked="${on}" data-action="toggle-mode">
          <span class="switch__content" data-slot="switch-content">
            <span class="switch__control"><span class="switch__thumb"></span></span>
            <span class="mode-box__label">Modo examen</span>
          </span>
        </button>
        <p class="mode-box__hint">
          ${on
            ? 'Las soluciones se muestran al <strong>entregar</strong>, con el desglose de nota.'
            : 'La solución aparece <strong>al responder</strong> cada pregunta.'}
        </p>
      </div>`;
  }

  function renderSubject(data) {
    const { subject, meta } = data;
    const sid = encodeURIComponent(subject.id);
    const mode = Store.getPref('mode', 'practica');
    const history = Store.getHistory(subject.id);
    const failedInfo = buildFailedExams(data);
    const days = daysUntil(meta.fecha_parcial);

    setCrumbs([{ label: 'Asignaturas', href: '#/' }, { label: subject.corto || subject.nombre }]);

    // Si todos los simulacros tienen el mismo nº de preguntas se dice una vez en la cabecera, no en cada ficha.
    const sizes = new Set(data.exams.map((e) => e.questions.length));
    const uniformSize = sizes.size === 1 ? [...sizes][0] : null;
    const goIcon = icon(mode === 'examen' ? 'timer' : 'play', 'exam-slot__go');

    const totalSlots = Math.max(CONFIG.totalSlots, data.exams.length);
    const slots = data.exams.map((exam, i) => {
      const n = i + 1;
      const h = history[`examen-${n}`];
      return `
        <a class="exam-slot" href="#/s/${sid}/examen/${n}/${mode}"
           aria-label="Simulacro ${n}, ${exam.questions.length} preguntas${h ? `, última nota ${formatGrade(h.last)}` : ''}">
          <span class="exam-slot__num">${pad(n)}</span>
          ${uniformSize ? '' : `<span class="exam-slot__meta">${exam.questions.length} preguntas</span>`}
          ${h ? `
            <span class="exam-slot__grades">
              <span>Última <strong class="${h.last >= 5 ? 'text-success' : 'text-danger'}">${formatGrade(h.last)}</strong></span>
              ${h.attempts > 1 ? `<span class="exam-slot__best">Mejor ${formatGrade(h.best)} en ${h.attempts} intentos</span>` : ''}
            </span>` : ''}
          ${goIcon}
        </a>`;
    });

    const failedCards = failedInfo.groups.length
      ? failedInfo.groups.map((g) => {
          const roman = ROMAN[g.index - 1] || g.index;
          return `
          <a class="card card--default failed-card" href="#/s/${sid}/falladas/${g.index}/${mode}"
             aria-label="Más falladas ${roman}, ${g.items.length} preguntas">
            <span class="failed-card__stamp" aria-hidden="true">${roman}</span>
            <span class="failed-card__body">
              <strong>${g.items.length} preguntas</strong>
              <span class="muted">${g.min === g.max ? `${g.max} ${g.max === 1 ? 'fallo' : 'fallos'} cada una` : `Entre ${g.min} y ${g.max} fallos`}</span>
            </span>
            ${goIcon}
          </a>`;
        }).join('')
      : `<p class="muted failed-empty">Las preguntas que falles se agruparán aquí en ${CONFIG.failedExamCount} exámenes de hasta ${CONFIG.failedExamSize} preguntas.</p>`;

    show(`
      <section class="hero">
        <h1 class="page-title"><span class="highlight">${esc(subject.nombre)}</span></h1>
        ${facts([
          meta.universidad && ['Universidad', esc(meta.universidad)],
          days !== null && days >= 0 && ['Parcial', days === 0 ? 'Hoy' : `En ${days} ${days === 1 ? 'día' : 'días'}`],
          ['Penalización', `−${formatGrade(data.penalty)} por error`],
        ])}
      </section>

      ${modeSwitch(mode)}

      <section class="section">
        <div class="section__head">
          <h2 class="section__title">Simulacros</h2>
          <span class="muted">${data.exams.length} de ${totalSlots} disponibles${uniformSize ? `, de ${uniformSize} preguntas cada uno` : ''}</span>
        </div>
        <div class="exam-grid">${slots.join('')}</div>
      </section>

      <section class="section">
        <div class="section__head">
          <h2 class="section__title">Más falladas</h2>
          ${failedInfo.ranked.length ? `<a class="button button--tertiary button--sm" href="#/s/${sid}/errores">${icon('chart-bar')} Contador de errores (${failedInfo.ranked.length})</a>` : ''}
        </div>
        <div class="failed-grid">${failedCards}</div>
      </section>`);
  }

  /* =========================================================================
     Contador de errores
     ========================================================================= */

  function renderErrors(data) {
    const { subject } = data;
    const sid = encodeURIComponent(subject.id);
    const { ranked, totalFails } = buildFailedExams(data);

    setCrumbs([
      { label: 'Asignaturas', href: '#/' },
      { label: subject.corto || subject.nombre, href: `#/s/${sid}` },
      { label: 'Contador de errores' },
    ]);

    const rows = ranked.map(({ question: q, count }, i) => `
      <li class="error-row">
        <span class="error-row__rank">${i + 1}</span>
        <div class="error-row__body">
          <p class="error-row__text">${esc(q.text)}</p>
          <p class="meta-line">
            <span>Simulacro ${q.exam}, pregunta ${q.number}</span>
            <span>${esc(q.tema)}</span>
          </p>
          <details class="reveal">
            <summary>${icon('eye')} Ver respuesta correcta</summary>
            <p><strong>${esc(q.correct)}.</strong> ${esc(q.options.find((o) => o.key === q.correct)?.text)}</p>
          </details>
        </div>
        <div class="error-row__side">
          <span class="error-row__count">${count}</span>
          <span class="error-row__unit">${count === 1 ? 'fallo' : 'fallos'}</span>
          <button class="button button--ghost button--sm button--icon-only" data-action="reset-one" data-id="${esc(q.id)}"
                  aria-label="Poner a cero esta pregunta" title="Poner a cero">${icon('eraser')}</button>
        </div>
      </li>`).join('');

    show(`
      <section class="hero">
        <h1 class="page-title"><span class="highlight highlight--red">Contador de errores</span></h1>
        ${ranked.length ? facts([['Preguntas', ranked.length], ['Fallos en total', totalFails]]) : ''}
      </section>
      ${ranked.length ? `
        <section class="sheet">
          <div class="section__head">
            <p class="muted">${ranked.length > CONFIG.failedExamSize ? `Las ${CONFIG.failedExamSize} primeras forman el examen <em>Más falladas I</em>.` : ''}</p>
            <button class="button button--danger-soft button--sm" data-action="reset-all">${icon('trash')} Reiniciar contador</button>
          </div>
          <ol class="error-list">${rows}</ol>
        </section>` : `
        <section class="sheet empty-state">
          <p><strong>El contador está a cero.</strong></p>
          <a class="button button--primary" href="#/s/${sid}">${icon('file-text')} Ir a los simulacros</a>
        </section>`}`);
  }

  /* =========================================================================
     Sesión de examen
     ========================================================================= */

  function startExam(data, route) {
    const exam = data.exams[route.n - 1];
    if (!exam) return renderNotFound();
    const sid = encodeURIComponent(data.subject.id);
    beginSession({
      data,
      key: `examen-${route.n}`,
      title: `Simulacro ${pad(route.n)}`,
      questions: exam.questions,
      mode: route.mode,
      routeBase: `#/s/${sid}/examen/${route.n}`,
    });
  }

  function startFailedExam(data, route) {
    const group = buildFailedExams(data).groups[route.n - 1];
    const sid = encodeURIComponent(data.subject.id);
    if (!group) {
      history.replaceState(null, '', `#/s/${sid}`);
      currentHash = `#/s/${sid}`;
      return renderSubject(data);
    }
    beginSession({
      data,
      key: null,
      title: `Más falladas ${ROMAN[route.n - 1] || route.n}`,
      questions: group.items.map((item) => item.question),
      mode: route.mode,
      routeBase: `#/s/${sid}/falladas/${route.n}`,
    });
  }

  function startReview(data, route) {
    const sid = encodeURIComponent(data.subject.id);
    if (!pendingReview || pendingReview.subjectId !== data.subject.id) {
      history.replaceState(null, '', `#/s/${sid}`);
      currentHash = `#/s/${sid}`;
      return renderSubject(data);
    }
    beginSession({
      data,
      key: null,
      title: pendingReview.title,
      questions: pendingReview.questions,
      mode: route.mode,
      routeBase: `#/s/${sid}/repaso`,
    });
  }

  function beginSession(def) {
    const n = def.questions.length;
    session = {
      def,
      subject: def.data.subject,
      mode: def.mode,
      questions: def.questions,
      answers: new Array(n).fill(null),
      current: 0,
      startedAt: Date.now(),
      finishedAt: null,
      finished: false,
      results: null,
      reviewFilter: 'all',
    };
    const sid = encodeURIComponent(def.data.subject.id);
    setCrumbs([
      { label: 'Asignaturas', href: '#/' },
      { label: def.data.subject.corto || def.data.subject.nombre, href: `#/s/${sid}` },
      { label: def.title },
    ]);
    renderPlayer(true);
    startTimer();
  }

  function restartSession(mode = session.mode) {
    const def = { ...session.def, mode };
    const hash = `${def.routeBase}/${mode}`;
    if (hash !== currentHash) {
      history.replaceState(null, '', hash);
      currentHash = hash;
    }
    beginSession(def);
    focusHeading();
  }

  const isPractice = () => session.mode === 'practica';
  const answeredCount = () => session.answers.filter((a) => a !== null).length;

  function questionState(i) {
    const answer = session.answers[i];
    if (answer === null) return 'blank';
    if (!isPractice()) return 'answered';
    return answer === session.questions[i].correct ? 'correct' : 'wrong';
  }

  function renderPlayer(scrollTop = false) {
    const s = session;
    const q = s.questions[s.current];
    const total = s.questions.length;
    const answer = s.answers[s.current];
    const revealed = isPractice() && answer !== null;
    const fails = Store.getFails(s.subject.id)[q.id]?.count || 0;
    const done = answeredCount();
    const isLast = s.current === total - 1;
    const sid = encodeURIComponent(s.subject.id);

    const options = q.options.map((o) => {
      let cls = '';
      let mark = '';
      if (revealed) {
        if (o.key === q.correct) { cls = 'is-correct'; mark = icon('check', 'option__mark'); }
        else if (o.key === answer) { cls = 'is-wrong'; mark = icon('x', 'option__mark'); }
        else cls = 'is-dim';
      } else if (o.key === answer) {
        cls = 'is-selected';
      }
      return `
        <li>
          <button type="button" class="option ${cls}" data-action="answer" data-key="${esc(o.key)}"
                  aria-pressed="${o.key === answer}" ${revealed ? 'aria-disabled="true"' : ''}>
            <span class="option__key">${esc(o.key)}</span>
            <span class="option__text">${esc(o.text)}</span>
            ${mark}
          </button>
        </li>`;
    }).join('');

    let feedback = '';
    if (revealed) {
      const ok = answer === q.correct;
      feedback = `
        <div class="verdict ${ok ? 'verdict--correct' : 'verdict--wrong'}">
          <p class="verdict__title">${icon(ok ? 'check-circle:filled' : 'x-circle:filled')} ${ok ? 'Correcto.' : `Incorrecto. La correcta es la ${esc(q.correct)}.`}</p>
          ${!ok ? `<p class="verdict__detail">Llevas ${fails} ${fails === 1 ? 'fallo' : 'fallos'} en esta pregunta.</p>` : ''}
          ${q.explanation ? `<p class="postit">${esc(q.explanation)}</p>` : ''}
        </div>`;
    } else if (!isPractice()) {
      feedback = `<p class="hint">Pulsa otra vez la opción marcada para dejarla en blanco.</p>`;
    }

    const navCells = s.questions.map((_, i) => {
      const state = questionState(i);
      return `
      <button type="button" class="nav-cell${state === 'blank' ? '' : ` nav-cell--${state}`}${i === s.current ? ' is-current' : ''}"
              data-action="goto" data-index="${i}" aria-label="Pregunta ${i + 1}" ${i === s.current ? 'aria-current="step"' : ''}>${i + 1}</button>`;
    }).join('');

    let nextButton;
    if (isPractice() && done === total) {
      nextButton = `<button class="button button--primary" data-action="finish">${icon('flag')} Ver resultados</button>`;
    } else if (isLast) {
      nextButton = isPractice()
        ? `<button class="button button--secondary" data-action="next" disabled>Siguiente ${icon('arrow-right')}</button>`
        : `<button class="button button--primary" data-action="finish">${icon('send')} Entregar</button>`;
    } else {
      nextButton = `<button class="button button--primary" data-action="next">Siguiente ${icon('arrow-right')}</button>`;
    }

    const legend = isPractice()
      ? `<span><i class="dot dot--correct"></i> Acertada</span><span><i class="dot dot--wrong"></i> Fallada</span><span><i class="dot"></i> Pendiente</span>`
      : `<span><i class="dot dot--answered"></i> Respondida</span><span><i class="dot"></i> En blanco</span>`;

    const practiceScore = isPractice()
      ? (() => {
          const correct = s.questions.filter((qq, i) => s.answers[i] === qq.correct).length;
          return `<div class="mini-stats"><span class="mini-stats__ok">${icon('check')} ${correct}<span class="sr-only"> acertadas</span></span><span class="mini-stats__ko">${icon('x')} ${done - correct}<span class="sr-only"> falladas</span></span></div>`;
        })()
      : '';

    app.innerHTML = `
      <section class="player">
        <header class="sheet player__head">
          <a class="button button--ghost button--sm back-link" href="#/s/${sid}">${icon('arrow-left')} Salir</a>
          <div class="player__title">
            <h1>${esc(s.def.title)}</h1>
            <p class="player__mode player__mode--${s.mode}">Modo ${MODES[s.mode].toLowerCase()}</p>
          </div>
          <div class="player__tools">
            <span class="timer" title="Tiempo transcurrido">${icon('clock')} <span id="timer">${formatDuration(Date.now() - s.startedAt)}</span></span>
            <button class="button ${isPractice() ? 'button--tertiary' : 'button--primary'} button--sm" data-action="finish">
              ${icon(isPractice() ? 'flag' : 'send')} ${isPractice() ? 'Terminar' : 'Entregar'}
            </button>
          </div>
          <div class="player__progress">
            ${progressBar(done, total, { label: 'Progreso', output: `${done}/${total}`, color: isPractice() ? 'accent' : 'warning' })}
          </div>
        </header>

        <div class="player__body">
          <article class="sheet question" id="question">
            <div class="question__meta">
              <span class="question__count">Pregunta <strong>${s.current + 1}</strong> de ${total}</span>
              <span>${esc(q.tema)}${q.bloque ? `: ${esc(q.bloque)}` : ''}</span>
              ${fails && !revealed ? `<span class="text-danger">Fallada ${fails} ${fails === 1 ? 'vez' : 'veces'}</span>` : ''}
            </div>
            <h2 class="question__text">${esc(q.text)}</h2>
            <ol class="options">${options}</ol>
            <div class="question__feedback">${feedback}</div>
            <div class="question__nav">
              <button class="button button--tertiary" data-action="prev" ${s.current === 0 ? 'disabled' : ''}>${icon('arrow-left')} Anterior</button>
              <span class="keys muted small">
                <span><kbd class="kbd">A</kbd>–<kbd class="kbd">D</kbd> responder</span>
                <span><kbd class="kbd">←</kbd><kbd class="kbd">→</kbd> navegar</span>
              </span>
              ${nextButton}
            </div>
          </article>

          <aside class="sheet navigator" aria-label="Navegación de preguntas">
            <div class="navigator__head">
              <h3>Hoja de respuestas</h3>
              ${practiceScore}
            </div>
            <div class="nav-grid">${navCells}</div>
            <div class="legend">${legend}</div>
          </aside>
        </div>
      </section>`;

    if (scrollTop) {
      window.scrollTo({ top: 0 });
    } else {
      const el = document.getElementById('question');
      if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  function answer(key) {
    const s = session;
    const i = s.current;
    const q = s.questions[i];
    if (isPractice()) {
      if (s.answers[i] !== null) return;
      s.answers[i] = key;
      if (key !== q.correct) Store.addFails(s.subject.id, [q.id]);
      announcer.textContent = key === q.correct ? 'Correcto.' : `Incorrecto. La correcta es la ${q.correct}.`;
    } else {
      s.answers[i] = s.answers[i] === key ? null : key;
    }
    renderPlayer();
  }

  function goTo(index) {
    if (index < 0 || index >= session.questions.length) return;
    session.current = index;
    renderPlayer();
  }

  async function requestFinish() {
    const blanks = session.questions.length - answeredCount();
    if (blanks > 0) {
      const ok = await confirmDialog({
        title: isPractice() ? '¿Terminar la práctica?' : '¿Entregar el examen?',
        text: `Tienes ${blanks} ${blanks === 1 ? 'pregunta' : 'preguntas'} sin responder. Contarán como en blanco (0 puntos).`,
        okLabel: isPractice() ? 'Terminar' : 'Entregar',
        cancelLabel: 'Seguir respondiendo',
      });
      if (!ok) return;
    }
    finishSession();
  }

  function computeResults(s) {
    const items = s.questions.map((q, i) => {
      const a = s.answers[i];
      return { q, index: i, answer: a, status: a === null ? 'blank' : a === q.correct ? 'correct' : 'wrong' };
    });
    const count = (st) => items.filter((it) => it.status === st).length;
    const correct = count('correct');
    const wrong = count('wrong');
    const blank = count('blank');
    const total = items.length;
    const penalty = s.def.data.penalty;
    const grade = total ? ((correct - wrong * penalty) * 10) / total : 0;

    const byTema = new Map();
    for (const it of items) {
      const t = byTema.get(it.q.tema) || { tema: it.q.tema, total: 0, correct: 0, wrong: 0, blank: 0 };
      t.total += 1;
      t[it.status] += 1;
      byTema.set(it.q.tema, t);
    }
    const temas = [...byTema.values()].sort((a, b) => a.tema.localeCompare(b.tema, 'es', { numeric: true }));

    return { items, correct, wrong, blank, total, penalty, grade, temas, duration: s.finishedAt - s.startedAt };
  }

  function finishSession() {
    const s = session;
    s.finished = true;
    s.finishedAt = Date.now();
    stopTimer();
    s.results = computeResults(s);
    // En práctica los fallos ya se apuntaron al responder; en examen se apuntan al entregar.
    if (!isPractice()) {
      Store.addFails(s.subject.id, s.results.items.filter((it) => it.status === 'wrong').map((it) => it.q.id));
    }
    if (s.def.key) Store.recordAttempt(s.subject.id, s.def.key, Math.round(s.results.grade * 100) / 100, s.mode);
    renderResults(true);
    focusHeading();
  }

  /* =========================================================================
     Resultados
     ========================================================================= */

  function renderResults(scrollTop = false) {
    const s = session;
    const r = s.results;
    const sid = encodeURIComponent(s.subject.id);
    const fails = Store.getFails(s.subject.id);
    const passed = r.grade >= 5;
    const filter = s.reviewFilter;
    const visible = r.items.filter((it) => filter === 'all' || it.status === filter);

    const verdict = r.grade >= 9 ? 'Sobresaliente' : r.grade >= 7 ? 'Notable' : r.grade >= 5 ? 'Aprobado' : 'Suspenso';

    const temaRows = r.temas.map((t) => `
      <div class="tema-row">
        <div class="tema-row__head">
          <span class="tema-row__name">${esc(t.tema)}</span>
          <span class="tema-row__nums"><strong>${t.correct}</strong> <span class="muted">de ${t.total}</span></span>
        </div>
        ${progressBar(t.correct, t.total, { color: t.correct / t.total >= 0.5 ? 'success' : 'danger', size: 'md', label: `Aciertos en ${t.tema}` })}
      </div>`).join('');

    const filterBtn = (value, label, n) => `
      <button type="button" class="button button--sm ${filter === value ? 'button--primary' : 'button--tertiary'}"
              data-action="filter" data-filter="${value}" aria-pressed="${filter === value}">${label} <span class="count">${n}</span></button>`;

    const reviewItems = visible.map((it) => {
      const q = it.q;
      const failCount = fails[q.id]?.count || 0;
      const opts = q.options.map((o) => {
        let cls = '';
        let mark = '';
        if (o.key === q.correct) { cls = 'is-correct'; mark = icon('check', 'option__mark'); }
        else if (o.key === it.answer) { cls = 'is-wrong'; mark = icon('x', 'option__mark'); }
        return `<li class="option option--static ${cls}"><span class="option__key">${esc(o.key)}</span><span class="option__text">${esc(o.text)}</span>${mark}</li>`;
      }).join('');
      const status = { correct: 'Acertada', wrong: 'Fallada', blank: 'En blanco' }[it.status];
      return `
        <li class="review-item review-item--${it.status}">
          <div class="review-item__head">
            <span class="review-item__num">${it.index + 1}</span>
            <span class="review-item__status">${status}</span>
            <span class="muted">${esc(q.tema)}</span>
            ${failCount ? `<span class="muted">${failCount} ${failCount === 1 ? 'fallo acumulado' : 'fallos acumulados'}</span>` : ''}
          </div>
          <p class="review-item__text">${esc(q.text)}</p>
          <ol class="options options--review">${opts}</ol>
          ${q.explanation ? `<p class="postit">${esc(q.explanation)}</p>` : ''}
        </li>`;
    }).join('');

    const toReview = r.wrong + r.blank;
    const otherMode = s.mode === 'examen' ? 'practica' : 'examen';

    app.innerHTML = `
      <section class="results">
        <header class="sheet results__head">
          <div class="results__title">
            <h1 class="page-title">${esc(s.def.title)}</h1>
            ${facts([
              ['Aciertos', `<span class="text-success">${r.correct}</span> de ${r.total}`],
              ['Errores', `<span class="text-danger">${r.wrong}</span>`],
              ['En blanco', r.blank],
              ['Modo', MODES[s.mode]],
              ['Tiempo', formatDuration(r.duration)],
            ])}
          </div>
          <div class="grade ${passed ? 'grade--pass' : 'grade--fail'}">
            <span class="grade__value">${formatGrade(r.grade)}</span>
            <span class="grade__max">/ 10</span>
            <span class="grade__verdict">${verdict}</span>
          </div>
        </header>

        <div class="results__cols">
          <section class="sheet">
            <h2 class="section__title">Aciertos por tema</h2>
            <div class="tema-list">${temaRows}</div>
          </section>
          <section class="sheet formula">
            <h2 class="section__title">Cómo se calcula</h2>
            <p class="formula__line">(${r.correct} − ${r.wrong} × ${formatGrade(r.penalty)}) × 10 / ${r.total} = <strong>${formatGrade(r.grade)}</strong></p>
            <p class="muted small">Cada error resta ${formatGrade(r.penalty)} aciertos; las preguntas en blanco no suman ni restan.</p>
            ${r.wrong ? `<p class="small">Se han sumado <strong>${r.wrong}</strong> ${r.wrong === 1 ? 'error' : 'errores'} a tu contador.</p>` : ''}
            <div class="results__actions">
              <button class="button button--primary" data-action="restart">${icon('restart')} Repetir</button>
              <button class="button button--secondary" data-action="restart-mode" data-mode="${otherMode}">${icon(otherMode === 'examen' ? 'timer' : 'lightbulb')} Repetir en modo ${MODES[otherMode].toLowerCase()}</button>
              ${toReview ? `<button class="button button--danger-soft" data-action="review-wrong">${icon('target')} Repasar ${toReview} sin acertar</button>` : ''}
              <a class="button button--tertiary" href="#/s/${sid}">${icon('arrow-left')} Volver a la asignatura</a>
            </div>
          </section>
        </div>

        <section class="sheet">
          <div class="section__head">
            <h2 class="section__title">Revisión pregunta a pregunta</h2>
            <div class="button-row" role="group" aria-label="Filtrar preguntas">
              ${filterBtn('all', 'Todas', r.total)}
              ${filterBtn('wrong', 'Falladas', r.wrong)}
              ${filterBtn('blank', 'En blanco', r.blank)}
              ${filterBtn('correct', 'Acertadas', r.correct)}
            </div>
          </div>
          ${visible.length ? `<ol class="review-list">${reviewItems}</ol>` : `<p class="muted empty-filter">No hay preguntas en este filtro.</p>`}
        </section>
      </section>`;

    if (scrollTop) window.scrollTo({ top: 0 });
  }

  /* =========================================================================
     Temporizador
     ========================================================================= */

  function startTimer() {
    stopTimer();
    timerId = setInterval(() => {
      const el = document.getElementById('timer');
      if (!session || session.finished || !el) return stopTimer();
      el.textContent = formatDuration(Date.now() - session.startedAt);
    }, 1000);
  }

  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
  }

  /* =========================================================================
     Eventos
     ========================================================================= */

  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const action = el.dataset.action;

    switch (action) {
      case 'toggle-mode': {
        const next = Store.getPref('mode', 'practica') === 'examen' ? 'practica' : 'examen';
        Store.setPref('mode', next);
        const data = dataCache[parseRoute().sid];
        if (data) {
          const y = window.scrollY;
          renderSubject(data);
          window.scrollTo({ top: y });
        }
        break;
      }
      case 'answer': return session && !session.finished && answer(el.dataset.key);
      case 'next': return session && goTo(session.current + 1);
      case 'prev': return session && goTo(session.current - 1);
      case 'goto': return session && goTo(Number(el.dataset.index));
      case 'finish': return session && !session.finished && requestFinish();
      case 'filter':
        if (!session?.finished) return;
        session.reviewFilter = el.dataset.filter;
        return renderResults();
      case 'restart': return session && restartSession();
      case 'restart-mode': return session && restartSession(el.dataset.mode);
      case 'review-wrong': {
        const r = session.results;
        pendingReview = {
          subjectId: session.subject.id,
          title: `Repaso de ${session.def.title}`,
          questions: r.items.filter((it) => it.status !== 'correct').map((it) => it.q),
        };
        session = null;
        navigate(`#/s/${encodeURIComponent(pendingReview.subjectId)}/repaso/practica`);
        break;
      }
      case 'reset-one': {
        const data = dataCache[parseRoute().sid];
        Store.resetFails(data.subject.id, el.dataset.id);
        const y = window.scrollY;
        renderErrors(data);
        window.scrollTo({ top: y });
        break;
      }
      case 'reset-all': {
        const data = dataCache[parseRoute().sid];
        const ok = await confirmDialog({
          title: '¿Reiniciar el contador de errores?',
          text: 'Se borrarán todos los fallos apuntados de esta asignatura y los exámenes de "Más falladas" quedarán vacíos.',
          okLabel: 'Reiniciar',
          danger: true,
        });
        if (ok) {
          Store.resetFails(data.subject.id);
          renderErrors(data);
        }
        break;
      }
      default:
        break;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (!session || session.finished || !document.getElementById('question')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.target.closest('input, textarea, select')) return;

    const q = session.questions[session.current];
    const key = event.key.toUpperCase();
    const byNumber = /^[1-9]$/.test(event.key) ? q.options[Number(event.key) - 1] : null;
    const option = q.options.find((o) => o.key === key) || byNumber;

    if (option) {
      event.preventDefault();
      answer(option.key);
    } else if (event.key === 'ArrowRight' || (event.key === 'Enter' && !event.target.closest('button, a'))) {
      event.preventDefault();
      goTo(session.current + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goTo(session.current - 1);
    }
  });

  render();
})();
