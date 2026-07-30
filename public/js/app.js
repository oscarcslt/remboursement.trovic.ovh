(() => {
  'use strict';

  const STATUS_LABELS = {
    en_cours: 'En cours',
    pause: 'En pause',
    termine: 'Terminé',
    conteste: 'Contesté',
    a_relancer: 'À relancer'
  };

  const STATUS_BADGE_CLASSES = {
    en_cours: 'bg-teal-50 text-teal-700',
    pause: 'bg-victor-50 text-victor-700',
    termine: 'bg-teal-50 text-teal-700',
    conteste: 'bg-mama-50 text-mama-700',
    a_relancer: 'bg-coral-50 text-coral-700'
  };

  const state = {
    projects: [],
    search: '',
    statusFilter: 'all',
    sortBy: 'date',
    view: 'dashboard',
    createPanelOpen: false,
    currentProjectId: null,
    currentProject: null,
    mode: 'public',
    txFilter: 'all',
    darkMode: false,
    verifiedCodes: {}, // { [projectId]: { maman: code, victor: code } }
    pendingConfirm: null,
    contestTarget: null,
    creating: false,
    summary: { monthTotal: 0, weekTotal: 0 }
  };

  const app = document.getElementById('app');

  // ---------- Utilities ----------

  const currencyFmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
  const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  const monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

  function money(n) {
    return currencyFmt.format(Number(n) || 0);
  }
  function fmtDate(d) {
    return dateFmt.format(new Date(d));
  }
  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function addMonths(date, n) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + n);
    return d;
  }

  function toast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    const colors = type === 'error'
      ? 'bg-coral-600 text-white'
      : 'bg-teal-600 text-white';
    el.className = `toast ${colors} px-4 py-3 rounded-2xl shadow-lg text-sm font-medium max-w-xs`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s ease';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  async function api(path, options = {}) {
    const res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    if (res.status === 204) return null;
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (!res.ok) {
      const message = (body && body.error) || 'Une erreur est survenue.';
      throw new Error(message);
    }
    return body;
  }

  function withBusy(btn, fn) {
    return async (...args) => {
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      const originalDisabled = btn.disabled;
      btn.disabled = true;
      try {
        await fn(...args);
      } catch (err) {
        toast(err.message || 'Erreur', 'error');
      } finally {
        btn.dataset.busy = '0';
        btn.disabled = originalDisabled;
      }
    };
  }

  // 2-click confirm helper: first click arms, second click (within 4s) fires callback
  function confirmClick(key, el, label, confirmLabel, onConfirm) {
    if (state.pendingConfirm && state.pendingConfirm.key === key) {
      clearTimeout(state.pendingConfirm.timeout);
      state.pendingConfirm = null;
      onConfirm();
      return;
    }
    if (state.pendingConfirm) {
      clearTimeout(state.pendingConfirm.timeout);
    }
    el.textContent = confirmLabel;
    el.classList.add('ring-2', 'ring-coral-600');
    const timeout = setTimeout(() => {
      state.pendingConfirm = null;
      el.textContent = label;
      el.classList.remove('ring-2', 'ring-coral-600');
    }, 4000);
    state.pendingConfirm = { key, timeout };
  }

  function icons() {
    if (window.lucide) window.lucide.createIcons();
  }

  // ---------- Data loading ----------

  async function loadProjects() {
    const archived = state.statusFilter === 'archived' ? '1' : '0';
    state.projects = await api(`/projects?archived=${archived}`);
  }

  async function loadSummary() {
    state.summary = await api('/projects/summary');
  }

  async function refreshDashboard() {
    await Promise.all([loadProjects(), loadSummary()]);
    render();
  }

  async function openProject(id) {
    state.currentProject = await api(`/projects/${id}`);
    state.currentProjectId = id;
    state.view = 'detail';
    state.mode = 'public';
    state.txFilter = 'all';
    render();
  }

  async function refreshCurrentProject() {
    state.currentProject = await api(`/projects/${state.currentProjectId}`);
  }

  // ---------- Regularity score ----------

  function computeRegularityStars(transactions) {
    const versements = transactions
      .filter((t) => t.type === 'versement')
      .map((t) => new Date(t.occurredAt).getTime())
      .sort((a, b) => a - b);
    if (versements.length < 3) return null;
    const gaps = [];
    for (let i = 1; i < versements.length; i += 1) {
      gaps.push((versements[i] - versements[i - 1]) / (1000 * 60 * 60 * 24));
    }
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean <= 0) return 5;
    const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv < 0.15) return 5;
    if (cv < 0.3) return 4;
    if (cv < 0.5) return 3;
    if (cv < 0.8) return 2;
    return 1;
  }

  // ---------- Schedule (échéancier) ----------

  function buildSchedule(project) {
    if (project.status === 'termine') return { kind: 'done' };
    if (!project.monthlyBudget || project.monthlyBudget <= 0) return { kind: 'no_budget' };
    if (project.paused) return { kind: 'paused' };

    const monthly = Number(project.monthlyBudget);
    const remaining = Number(project.remaining);
    const n = Math.max(1, Math.ceil(remaining / monthly));
    const today = new Date();
    const entries = [];
    let cumulativeExpected = 0;

    for (let i = 0; i < n; i += 1) {
      const isLast = i === n - 1;
      const amount = isLast ? Math.round((remaining - monthly * (n - 1)) * 100) / 100 : monthly;
      cumulativeExpected += amount;
      const dueDate = addMonths(project.createdAt, i + 1);
      const late = dueDate <= today && project.paid < cumulativeExpected - 0.01;
      entries.push({ index: i + 1, dueDate, amount, late });
    }
    return { kind: 'ok', entries, months: n, remaining };
  }

  // ---------- Dashboard rendering ----------

  function filteredProjects() {
    let list = [...state.projects];
    const q = state.search.trim().toLowerCase();
    if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));

    if (state.statusFilter !== 'all' && state.statusFilter !== 'archived') {
      list = list.filter((p) => p.status === state.statusFilter);
    }

    switch (state.sortBy) {
      case 'remaining':
        list.sort((a, b) => b.remaining - a.remaining);
        break;
      case 'progress':
        list.sort((a, b) => a.progress - b.progress);
        break;
      default:
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    return list;
  }

  function renderDashboard() {
    const visible = filteredProjects();
    const active = state.projects.filter((p) => !p.archived || state.statusFilter === 'archived');

    const totalRemaining = active.reduce((s, p) => s + p.remaining, 0);
    const totalPaid = active.reduce((s, p) => s + p.paid, 0);
    const count = active.length;
    const globalProgress = active.length
      ? active.reduce((s, p) => s + p.progress, 0) / active.length
      : 0;

    const lateProjects = state.projects.filter((p) => p.late);

    app.innerHTML = `
      <section class="grain-banner bg-teal-50 border border-teal/20 rounded-2xl p-4 text-sm text-teal-700">
        <p><strong>Comment ça marche :</strong> Victor crée un projet, verse les remboursements au fil de l'eau,
        et Maman peut consulter l'avancement à tout moment et signaler une contestation si un montant lui semble incorrect.
        Chaque mode (Maman / Victor) est protégé par un code personnel.</p>
      </section>

      ${lateProjects.length ? `
      <section class="grain-banner bg-coral-50 border border-coral/30 rounded-2xl p-4 flex items-center gap-3">
        <i data-lucide="alert-triangle" class="w-5 h-5 text-coral-700 shrink-0"></i>
        <p class="text-sm text-coral-700">
          ${lateProjects.length === 1
            ? `Le projet <strong>${esc(lateProjects[0].name)}</strong> n'a reçu aucun versement depuis plus de 35 jours.`
            : `<strong>${lateProjects.length} projets</strong> n'ont reçu aucun versement depuis plus de 35 jours.`}
        </p>
      </section>` : ''}

      <section class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        ${summaryCard('wallet', 'Reste à payer', money(totalRemaining), 'text-coral-700')}
        ${summaryCard('check-circle', 'Déjà versé', money(totalPaid), 'text-teal-700')}
        ${summaryCard('folder', 'Projets suivis', String(count), 'text-ink')}
        ${summaryCard('trending-up', 'Progression globale', `${globalProgress.toFixed(1)}%`, 'text-teal-700')}
      </section>

      <section class="grid sm:grid-cols-2 gap-3 sm:gap-4">
        <div class="bg-card border border-border rounded-2xl p-4">
          <p class="text-xs uppercase tracking-wide text-muted mb-1">Versé ce mois-ci (${esc(monthFmt.format(new Date()))})</p>
          <p class="font-serif text-2xl font-semibold text-teal-700">${money(state.summary.monthTotal)}</p>
        </div>
        <div class="bg-card border border-border rounded-2xl p-4">
          <p class="text-xs uppercase tracking-wide text-muted mb-1">Versé cette semaine</p>
          <p class="font-serif text-2xl font-semibold text-teal-700">${money(state.summary.weekTotal)}</p>
        </div>
      </section>

      ${renderComparativeChart(active)}

      <section id="create-panel-wrapper"></section>

      <section class="flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
        <div class="relative flex-1 max-w-md">
          <i data-lucide="search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted"></i>
          <input id="search-input" type="text" value="${esc(state.search)}" placeholder="Rechercher un projet…"
            class="w-full pl-9 pr-3 py-2.5 rounded-2xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-teal/40" />
        </div>
        <div class="flex flex-wrap gap-2 items-center">
          <select id="status-filter" class="border border-border bg-card rounded-2xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal/40">
            <option value="all" ${state.statusFilter === 'all' ? 'selected' : ''}>Tous</option>
            <option value="en_cours" ${state.statusFilter === 'en_cours' ? 'selected' : ''}>En cours</option>
            <option value="termine" ${state.statusFilter === 'termine' ? 'selected' : ''}>Terminés</option>
            <option value="conteste" ${state.statusFilter === 'conteste' ? 'selected' : ''}>Contestés</option>
            <option value="a_relancer" ${state.statusFilter === 'a_relancer' ? 'selected' : ''}>À relancer</option>
            <option value="archived" ${state.statusFilter === 'archived' ? 'selected' : ''}>Archivés</option>
          </select>
          <select id="sort-by" class="border border-border bg-card rounded-2xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal/40">
            <option value="date" ${state.sortBy === 'date' ? 'selected' : ''}>Trier : date</option>
            <option value="remaining" ${state.sortBy === 'remaining' ? 'selected' : ''}>Trier : reste à payer</option>
            <option value="progress" ${state.sortBy === 'progress' ? 'selected' : ''}>Trier : progression</option>
          </select>
          <button id="export-csv-btn" class="flex items-center gap-2 border border-border bg-card px-3 py-2.5 rounded-2xl text-sm font-medium hover:bg-paper transition">
            <i data-lucide="download" class="w-4 h-4"></i> Export CSV
          </button>
        </div>
      </section>

      <section id="projects-grid" class="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
        ${visible.length ? visible.map(projectCard).join('') : ''}
      </section>
      ${!state.projects.length ? emptyState() : (!visible.length ? noResultsState() : '')}
    `;

    renderCreatePanel();
    icons();
    bindDashboardEvents();
  }

  function summaryCard(icon, label, value, valueClass) {
    return `
      <div class="bg-card border border-border rounded-2xl p-4 project-card">
        <div class="flex items-center gap-2 text-muted text-xs uppercase tracking-wide mb-2">
          <i data-lucide="${icon}" class="w-4 h-4"></i> ${label}
        </div>
        <p class="font-serif text-xl sm:text-2xl font-semibold ${valueClass}">${value}</p>
      </div>`;
  }

  function renderComparativeChart(projects) {
    if (!projects.length) return '';
    const sorted = [...projects].sort((a, b) => b.progress - a.progress).slice(0, 8);
    return `
      <section class="bg-card border border-border rounded-2xl p-4 sm:p-5">
        <h2 class="font-serif text-lg font-semibold mb-3">Progression comparée</h2>
        <div class="space-y-2.5">
          ${sorted.map((p) => `
            <div>
              <div class="flex justify-between text-xs text-muted mb-1">
                <span class="truncate pr-2">${esc(p.name)}</span>
                <span>${p.progress.toFixed(0)}%</span>
              </div>
              <div class="progress-track h-2.5">
                <div class="progress-fill ${p.progress >= 100 ? 'done' : ''}" style="width:${Math.max(2, p.progress)}%"></div>
              </div>
            </div>`).join('')}
        </div>
      </section>`;
  }

  function projectCard(p) {
    const badge = STATUS_BADGE_CLASSES[p.status] || 'bg-paper text-ink';
    const nextMilestoneText = p.nextMilestone
      ? `Prochain objectif : ${p.nextMilestone}% <span class="text-muted">(encore ${(p.nextMilestone - p.progress).toFixed(1)}%)</span>`
      : 'Tous les objectifs sont atteints';

    return `
      <article class="project-card bg-card border border-border rounded-2xl p-4 sm:p-5 flex flex-col gap-3">
        <div class="flex items-start justify-between gap-2">
          <h3 class="font-serif text-lg font-semibold leading-snug">${esc(p.name)}</h3>
          <div class="flex items-center gap-1.5 shrink-0">
            ${p.contested ? '<span class="w-2.5 h-2.5 rounded-full bg-coral-600" title="Contestation active"></span>' : ''}
            <span class="text-xs font-medium px-2.5 py-1 rounded-full ${badge}">${STATUS_LABELS[p.status]}</span>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2 text-sm">
          <div>
            <p class="text-muted text-xs">Reste à payer</p>
            <p class="font-semibold text-coral-700">${money(p.remaining)}</p>
          </div>
          <div>
            <p class="text-muted text-xs">Déjà versé</p>
            <p class="font-semibold text-teal-700">${money(p.paid)}</p>
          </div>
        </div>

        <div>
          <div class="flex justify-between text-xs text-muted mb-1">
            <span>${p.progress.toFixed(1)}%</span>
          </div>
          <div class="progress-track h-3">
            <div class="progress-fill ${p.progress >= 100 ? 'done' : ''}" style="width:${Math.max(2, p.progress)}%"></div>
          </div>
        </div>

        <p class="text-xs text-muted">${nextMilestoneText}</p>

        ${p.late ? `
        <p class="text-xs text-coral-700 flex items-center gap-1">
          <i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i> Aucun versement depuis plus de 35 jours
        </p>` : ''}

        <button data-open="${p.id}" class="mt-1 w-full flex items-center justify-center gap-2 bg-teal text-white py-2.5 rounded-2xl font-medium hover:bg-teal-700 transition">
          Ouvrir le suivi <i data-lucide="arrow-right" class="w-4 h-4"></i>
        </button>
      </article>`;
  }

  function emptyState() {
    return `
      <div class="col-span-full text-center py-16 bg-card border border-dashed border-border rounded-2xl">
        <i data-lucide="sparkles" class="w-8 h-8 mx-auto text-teal mb-3"></i>
        <p class="font-serif text-lg font-semibold mb-1">Aucun projet pour l'instant</p>
        <p class="text-muted text-sm">Crée ton premier projet de remboursement pour commencer le suivi en famille.</p>
      </div>`;
  }

  function noResultsState() {
    return `
      <div class="col-span-full text-center py-16 bg-card border border-dashed border-border rounded-2xl">
        <i data-lucide="search-x" class="w-8 h-8 mx-auto text-muted mb-3"></i>
        <p class="font-serif text-lg font-semibold mb-1">Aucun résultat</p>
        <p class="text-muted text-sm">Essaie une autre recherche ou change les filtres.</p>
      </div>`;
  }

  // ---------- Create project panel ----------

  function renderCreatePanel() {
    const wrapper = document.getElementById('create-panel-wrapper');
    if (!wrapper) return;
    if (!state.createPanelOpen) {
      wrapper.innerHTML = '';
      return;
    }
    wrapper.innerHTML = `
      <div class="panel-enter bg-card border border-border rounded-2xl p-5 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="font-serif text-xl font-semibold">Nouveau projet</h2>
          <button id="close-create-panel" class="text-muted hover:text-ink"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <form id="create-form" class="grid sm:grid-cols-2 gap-4">
          <label class="flex flex-col gap-1 text-sm sm:col-span-2">
            Nom du projet *
            <input name="name" required maxlength="80" class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal/40" placeholder="Ex : Réparation voiture" />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Montant total à rembourser *
            <input name="totalAmount" type="number" min="0.01" step="0.01" required class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal/40" />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Apport de départ
            <input name="initialContribution" type="number" min="0" step="0.01" value="0" class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal/40" />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Budget mensuel estimé *
            <input name="monthlyBudget" type="number" min="0.01" step="0.01" required class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal/40" />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Jalons personnalisés (optionnel)
            <input name="milestones" placeholder="25,50,75,100" class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal/40" />
          </label>
          <label class="flex flex-col gap-1 text-sm sm:col-span-2">
            Note (optionnel)
            <textarea name="note" maxlength="500" rows="2" class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal/40"></textarea>
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Code Maman *
            <input name="secretCode" required class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal/40" />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Code Victor *
            <input name="adminCode" required class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal/40" />
          </label>
          <div class="sm:col-span-2 flex justify-end gap-2 pt-2">
            <button type="button" id="cancel-create" class="border border-border rounded-2xl px-4 py-2.5 font-medium hover:bg-paper transition">Annuler</button>
            <button type="submit" id="submit-create" class="bg-teal text-white rounded-2xl px-5 py-2.5 font-medium hover:bg-teal-700 transition">Créer le projet</button>
          </div>
        </form>
      </div>`;
    icons();

    document.getElementById('close-create-panel').onclick = () => { state.createPanelOpen = false; renderCreatePanel(); };
    document.getElementById('cancel-create').onclick = () => { state.createPanelOpen = false; renderCreatePanel(); };

    const form = document.getElementById('create-form');
    const submitBtn = document.getElementById('submit-create');
    form.onsubmit = withBusy(submitBtn, async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const milestonesRaw = String(data.get('milestones') || '').trim();
      const milestones = milestonesRaw
        ? milestonesRaw.split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n))
        : undefined;

      await api('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('name'),
          totalAmount: Number(data.get('totalAmount')),
          initialContribution: Number(data.get('initialContribution') || 0),
          monthlyBudget: Number(data.get('monthlyBudget')),
          note: data.get('note') || null,
          secretCode: data.get('secretCode'),
          adminCode: data.get('adminCode'),
          milestones
        })
      });
      toast('Projet créé avec succès.');
      state.createPanelOpen = false;
      await refreshDashboard();
    });
  }

  // ---------- CSV export ----------

  function exportCSV() {
    const rows = filteredProjects();
    const header = ['Nom', 'Total', 'Versé', 'Reste', 'Progression (%)', 'Statut', 'Budget mensuel'];
    const lines = [header.join(';')];
    for (const p of rows) {
      lines.push([
        `"${p.name.replace(/"/g, '""')}"`,
        p.totalAmount.toFixed(2),
        p.paid.toFixed(2),
        p.remaining.toFixed(2),
        p.progress.toFixed(1),
        STATUS_LABELS[p.status] || p.status,
        p.monthlyBudget.toFixed(2)
      ].join(';'));
    }
    const csv = `﻿${lines.join('\r\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `projets-remboursement-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- Dashboard events ----------

  function bindDashboardEvents() {
    const searchInput = document.getElementById('search-input');
    searchInput.oninput = () => { state.search = searchInput.value; render(); preserveFocus(searchInput); };

    document.getElementById('status-filter').onchange = async (e) => {
      state.statusFilter = e.target.value;
      await refreshDashboard();
    };
    document.getElementById('sort-by').onchange = (e) => { state.sortBy = e.target.value; render(); };
    document.getElementById('export-csv-btn').onclick = exportCSV;

    document.querySelectorAll('[data-open]').forEach((btn) => {
      btn.onclick = () => openProject(Number(btn.dataset.open));
    });
  }

  function preserveFocus(input) {
    const val = input.value;
    input.focus();
    input.setSelectionRange(val.length, val.length);
  }

  // ---------- Code modal ----------

  function askCode(role) {
    return new Promise((resolve) => {
      const modal = document.getElementById('code-modal');
      const title = document.getElementById('code-modal-title');
      const subtitle = document.getElementById('code-modal-subtitle');
      const input = document.getElementById('code-modal-input');
      const error = document.getElementById('code-modal-error');
      const confirmBtn = document.getElementById('code-modal-confirm');

      title.textContent = role === 'maman' ? 'Réglage maman' : 'Réglage Victor';
      subtitle.textContent = `Entre le code ${role === 'maman' ? 'maman' : 'Victor'} pour accéder à ce mode.`;
      input.value = '';
      error.classList.add('hidden');
      modal.classList.remove('hidden');
      setTimeout(() => input.focus(), 50);

      function close(result) {
        modal.classList.add('hidden');
        confirmBtn.onclick = null;
        document.querySelectorAll('[data-close-code-modal]').forEach((el) => { el.onclick = null; });
        input.onkeydown = null;
        resolve(result);
      }

      document.querySelectorAll('[data-close-code-modal]').forEach((el) => {
        el.onclick = () => close(null);
      });

      async function attempt() {
        const code = input.value;
        try {
          const { ok } = await api(`/projects/${state.currentProjectId}/verify`, {
            method: 'POST',
            body: JSON.stringify({ role, code })
          });
          if (ok) {
            close(code);
          } else {
            error.classList.remove('hidden');
          }
        } catch (err) {
          error.textContent = err.message;
          error.classList.remove('hidden');
        }
      }

      confirmBtn.onclick = attempt;
      input.onkeydown = (e) => { if (e.key === 'Enter') attempt(); };
    });
  }

  async function switchMode(role) {
    if (role === 'public') { state.mode = 'public'; renderDetail(); return; }
    const cached = state.verifiedCodes[state.currentProjectId]?.[role];
    if (cached) { state.mode = role; renderDetail(); return; }
    const code = await askCode(role);
    if (code === null) return;
    state.verifiedCodes[state.currentProjectId] = state.verifiedCodes[state.currentProjectId] || {};
    state.verifiedCodes[state.currentProjectId][role] = code;
    state.mode = role;
    renderDetail();
  }

  function codeFor(role) {
    return state.verifiedCodes[state.currentProjectId]?.[role] || '';
  }

  // ---------- Detail view ----------

  function renderDetail() {
    const p = state.currentProject;
    const badge = STATUS_BADGE_CLASSES[p.status] || 'bg-paper text-ink';
    const schedule = buildSchedule(p);
    const stars = computeRegularityStars(p.transactions);

    const modeBtn = (role, label, activeClasses) => `
      <button data-mode="${role}" class="px-4 py-2 rounded-2xl text-sm font-medium border transition ${
        state.mode === role ? activeClasses : 'border-border bg-card hover:bg-paper'
      }">${label}</button>`;

    app.innerHTML = `
      <button id="back-btn" class="flex items-center gap-2 text-sm text-muted hover:text-ink transition">
        <i data-lucide="arrow-left" class="w-4 h-4"></i> Tous les projets
      </button>

      <section class="bg-card border border-border rounded-2xl p-5 sm:p-6 space-y-4 panel-enter">
        <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h2 class="font-serif text-2xl font-semibold">${esc(p.name)}</h2>
            ${p.note ? `<p class="text-muted text-sm mt-1">${esc(p.note)}</p>` : ''}
            ${p.archived ? '<p class="text-xs text-victor-700 mt-1">Ce projet est archivé.</p>' : ''}
          </div>
          <span class="text-xs font-medium px-3 py-1.5 rounded-full self-start ${badge}">${STATUS_LABELS[p.status]}</span>
        </div>

        <div class="flex flex-wrap gap-2">
          ${modeBtn('public', 'Vue publique', 'border-teal bg-teal text-white')}
          ${modeBtn('maman', 'Réglage maman', 'border-mama-200 bg-mama-50 text-mama-700')}
          ${modeBtn('victor', 'Réglage Victor', 'border-victor-200 bg-victor-50 text-victor-700')}
        </div>

        <div class="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p class="text-muted text-xs">Montant total</p>
            <p class="font-semibold">${money(p.totalAmount)}</p>
          </div>
          <div>
            <p class="text-muted text-xs">Versé</p>
            <p class="font-semibold text-teal-700">${money(p.paid)}</p>
          </div>
          <div>
            <p class="text-muted text-xs">Reste à payer</p>
            <p class="font-semibold text-coral-700">${money(p.remaining)}</p>
          </div>
        </div>

        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-muted">Progression</span>
            <span class="font-semibold">${p.progress.toFixed(1)}%</span>
          </div>
          <div class="progress-track h-4">
            <div class="progress-fill ${p.progress >= 100 ? 'done' : ''}" style="width:${Math.max(2, p.progress)}%"></div>
          </div>
        </div>

        <p class="text-sm text-muted">${estimationText(p)}</p>

        ${stars !== null ? `
        <div class="flex items-center gap-1 text-sm">
          <span class="text-muted">Régularité des versements :</span>
          ${[1, 2, 3, 4, 5].map((i) => `<i data-lucide="star" class="w-4 h-4 ${i <= stars ? 'text-coral-600 fill-coral-600' : 'text-border'}"></i>`).join('')}
        </div>` : ''}
      </section>

      <section class="grid lg:grid-cols-2 gap-4">
        ${renderMilestones(p)}
        ${renderSchedule(schedule)}
      </section>

      ${renderChart(p.transactions, p.totalAmount)}

      ${state.mode === 'maman' ? renderMamanPanel(p) : ''}
      ${state.mode === 'victor' ? renderVictorPanel(p, schedule) : ''}

      ${renderHistory(p)}
    `;

    icons();
    bindDetailEvents(schedule);
  }

  function estimationText(p) {
    if (p.status === 'termine') return 'Ce remboursement est terminé. Bravo !';
    if (p.paused) return 'Le suivi est en pause : aucune estimation de durée pour le moment.';
    if (!p.monthlyBudget || p.monthlyBudget <= 0) return "Ajoute un budget mensuel pour estimer la durée restante.";
    const months = Math.ceil(p.remaining / p.monthlyBudget);
    return `Environ ${months} mois au budget indiqué (${money(p.monthlyBudget)}/mois).`;
  }

  function renderMilestones(p) {
    const milestones = p.milestones;
    return `
      <div class="bg-card border border-border rounded-2xl p-5 space-y-3">
        <h3 class="font-serif text-lg font-semibold">Objectifs intermédiaires</h3>
        <div class="flex items-center justify-between">
          ${milestones.map((m) => {
            const reached = p.progress >= m - 0.001;
            return `
            <div class="flex flex-col items-center gap-1.5 flex-1">
              <div class="milestone-dot w-9 h-9 rounded-full border-2 flex items-center justify-center text-xs font-semibold ${
                reached ? 'bg-teal border-teal text-white' : 'border-border text-muted'
              }">${m}%</div>
            </div>`;
          }).join('')}
        </div>
        <p class="text-xs text-muted">${
          p.nextMilestone
            ? `Encore ${(p.nextMilestone - p.progress).toFixed(1)}% avant le jalon des ${p.nextMilestone}%.`
            : 'Tous les objectifs sont atteints.'
        }</p>
      </div>`;
  }

  function renderSchedule(schedule) {
    let body;
    if (schedule.kind === 'done') body = '<p class="text-sm text-muted">Remboursement terminé : plus aucune échéance à venir.</p>';
    else if (schedule.kind === 'paused') body = '<p class="text-sm text-muted">Le suivi est en pause : pas d\'échéancier pour le moment.</p>';
    else if (schedule.kind === 'no_budget') body = '<p class="text-sm text-muted">Ajoute un budget mensuel pour générer un échéancier.</p>';
    else {
      body = `
        <p class="text-xs text-muted mb-2">${schedule.months} mois restants · ${money(schedule.remaining)} au total</p>
        <ul class="space-y-1.5 max-h-56 overflow-y-auto pr-1">
          ${schedule.entries.map((e) => `
            <li class="flex justify-between items-center text-sm px-3 py-2 rounded-xl ${e.late ? 'bg-coral-50 text-coral-700' : 'bg-paper'}">
              <span>${esc(monthFmt.format(e.dueDate))}${e.late ? ' <span class="text-xs">(en retard)</span>' : ''}</span>
              <span class="font-medium">${money(e.amount)}</span>
            </li>`).join('')}
        </ul>`;
    }
    return `
      <div class="bg-card border border-border rounded-2xl p-5">
        <h3 class="font-serif text-lg font-semibold mb-2">Échéancier mensuel</h3>
        ${body}
      </div>`;
  }

  function renderChart(transactions, totalAmount) {
    const versements = transactions
      .filter((t) => t.type === 'versement')
      .slice()
      .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));

    if (versements.length < 2 || totalAmount <= 0) {
      return `
        <div class="bg-card border border-border rounded-2xl p-5">
          <h3 class="font-serif text-lg font-semibold mb-2">Progression dans le temps</h3>
          <p class="text-sm text-muted">Pas encore assez de données pour tracer un graphique.</p>
        </div>`;
    }

    const W = 600, H = 160, PAD = 12;
    const t0 = new Date(versements[0].occurredAt).getTime();
    const t1 = new Date(versements[versements.length - 1].occurredAt).getTime();
    const span = Math.max(1, t1 - t0);

    let cumulative = 0;
    const points = versements.map((v) => {
      cumulative += Number(v.amount);
      const x = PAD + ((new Date(v.occurredAt).getTime() - t0) / span) * (W - PAD * 2);
      const y = H - PAD - (Math.min(1, cumulative / totalAmount)) * (H - PAD * 2);
      return { x, y };
    });

    const polyline = points.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
    const last = points[points.length - 1];

    return `
      <div class="bg-card border border-border rounded-2xl p-5">
        <h3 class="font-serif text-lg font-semibold mb-2">Progression dans le temps</h3>
        <svg viewBox="0 0 ${W} ${H}" class="w-full h-40">
          <polyline points="${polyline}" fill="none" stroke="#176b68" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
          <circle cx="${last.x}" cy="${last.y}" r="5" fill="#e9604c" />
        </svg>
      </div>`;
  }

  function renderMamanPanel(p) {
    return `
      <section class="bg-mama-50 border border-mama-200 rounded-2xl p-5 space-y-4 panel-enter">
        <h3 class="font-serif text-lg font-semibold text-mama-700">Réglage maman</h3>
        <p class="text-sm text-mama-700/80">Tu peux consulter l'historique complet ci-dessous et contester un versement si un montant te semble incorrect.</p>
        ${state.contestTarget ? `
        <form id="contest-form" class="space-y-2 bg-card rounded-2xl p-4 border border-mama-200">
          <p class="text-sm font-medium">Contester le versement du ${esc(fmtDate(state.contestTarget.occurredAt))} (${money(state.contestTarget.amount)})</p>
          <textarea name="motif" required maxlength="300" rows="2" placeholder="Motif de la contestation…" class="w-full border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-mama-200"></textarea>
          <div class="flex justify-end gap-2">
            <button type="button" id="cancel-contest" class="border border-border rounded-2xl px-4 py-2 text-sm font-medium hover:bg-paper transition">Annuler</button>
            <button type="submit" id="submit-contest" class="bg-mama-700 text-white rounded-2xl px-4 py-2 text-sm font-medium hover:opacity-90 transition">Signaler la contestation</button>
          </div>
        </form>` : '<p class="text-xs text-mama-700/70">Choisis "Contester" sur une ligne de l\'historique ci-dessous.</p>'}
      </section>`;
  }

  function renderVictorPanel(p, schedule) {
    return `
      <section class="bg-victor-50 border border-victor-200 rounded-2xl p-5 space-y-5 panel-enter">
        <h3 class="font-serif text-lg font-semibold text-victor-700">Réglage Victor</h3>

        <form id="add-tx-form" class="grid sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
          <label class="flex flex-col gap-1 text-sm">
            Montant du versement
            <input name="amount" type="number" min="0.01" step="0.01" required class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-victor-200" />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Note (optionnel)
            <input name="note" maxlength="300" class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-victor-200" />
          </label>
          <button type="submit" id="add-tx-submit" class="bg-victor-700 text-white rounded-2xl px-4 py-2.5 font-medium hover:opacity-90 transition whitespace-nowrap">Ajouter le versement</button>
        </form>

        <div class="flex flex-wrap gap-2">
          <button id="settle-btn" ${schedule.kind !== 'ok' ? 'disabled' : ''} class="flex items-center gap-2 border border-victor-200 bg-card px-4 py-2.5 rounded-2xl text-sm font-medium hover:bg-paper transition disabled:opacity-40 disabled:cursor-not-allowed">
            <i data-lucide="calendar-check" class="w-4 h-4"></i> Régler une échéance
          </button>
          <button id="pause-btn" class="flex items-center gap-2 border border-victor-200 bg-card px-4 py-2.5 rounded-2xl text-sm font-medium hover:bg-paper transition">
            <i data-lucide="${p.paused ? 'play' : 'pause'}" class="w-4 h-4"></i> ${p.paused ? 'Reprendre' : 'Mettre en pause'}
          </button>
          ${p.status === 'termine' || p.archived ? `
          <button id="archive-btn" class="flex items-center gap-2 border border-victor-200 bg-card px-4 py-2.5 rounded-2xl text-sm font-medium hover:bg-paper transition">
            <i data-lucide="archive" class="w-4 h-4"></i> ${p.archived ? 'Désarchiver' : 'Archiver'}
          </button>` : ''}
        </div>

        <form id="note-form" class="space-y-2">
          <label class="flex flex-col gap-1 text-sm">
            Note du projet
            <textarea name="note" maxlength="500" rows="2" class="border border-border rounded-2xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-victor-200">${esc(p.note || '')}</textarea>
          </label>
          <div class="flex justify-end">
            <button type="submit" id="save-note-btn" class="border border-victor-200 bg-card px-4 py-2 rounded-2xl text-sm font-medium hover:bg-paper transition">Enregistrer la note</button>
          </div>
        </form>

        <div class="border-t border-victor-200 pt-4">
          <p class="text-sm font-medium text-coral-700 mb-2">Zone de suppression</p>
          <button id="delete-project-btn" class="flex items-center gap-2 bg-coral-600 text-white px-4 py-2.5 rounded-2xl text-sm font-medium hover:bg-coral-700 transition">
            <i data-lucide="trash-2" class="w-4 h-4"></i> Supprimer le projet
          </button>
        </div>
      </section>`;
  }

  function renderHistory(p) {
    const list = p.transactions.filter((t) => state.txFilter === 'all' || t.type === state.txFilter);
    return `
      <section class="bg-card border border-border rounded-2xl p-5">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-serif text-lg font-semibold">Historique des transactions</h3>
          <select id="tx-filter" class="border border-border bg-card rounded-2xl px-3 py-2 text-sm">
            <option value="all" ${state.txFilter === 'all' ? 'selected' : ''}>Toutes</option>
            <option value="versement" ${state.txFilter === 'versement' ? 'selected' : ''}>Versements</option>
            <option value="contestation" ${state.txFilter === 'contestation' ? 'selected' : ''}>Contestations</option>
          </select>
        </div>
        <ul class="divide-y divide-border">
          ${list.length ? list.map((t) => historyRow(t)).join('') : '<li class="py-6 text-center text-sm text-muted">Aucune transaction à afficher.</li>'}
        </ul>
      </section>`;
  }

  function historyRow(t) {
    const isVersement = t.type === 'versement';
    return `
      <li class="py-3 flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <i data-lucide="${isVersement ? 'arrow-down-circle' : 'flag'}" class="w-5 h-5 shrink-0 ${isVersement ? 'text-teal-700' : 'text-coral-700'}"></i>
          <div class="min-w-0">
            <p class="text-sm font-medium">${isVersement ? 'Versement' : 'Contestation'} · ${esc(fmtDate(t.occurredAt))}</p>
            ${t.note ? `<p class="text-xs text-muted truncate">${esc(t.note)}</p>` : ''}
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="font-semibold text-sm ${isVersement ? 'text-teal-700' : 'text-muted'}">${isVersement ? money(t.amount) : ''}</span>
          ${state.mode === 'maman' && isVersement ? `<button data-contest="${t.id}" class="text-xs text-mama-700 border border-mama-200 rounded-full px-3 py-1 hover:bg-mama-50 transition">Contester</button>` : ''}
          ${state.mode === 'victor' ? `<button data-delete-tx="${t.id}" class="w-8 h-8 rounded-full border border-border flex items-center justify-center text-muted hover:text-coral-700 hover:border-coral-600 transition"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
        </div>
      </li>`;
  }

  // ---------- Detail events ----------

  function bindDetailEvents(schedule) {
    document.getElementById('back-btn').onclick = () => {
      state.view = 'dashboard';
      state.currentProject = null;
      state.contestTarget = null;
      refreshDashboard();
    };

    document.querySelectorAll('[data-mode]').forEach((btn) => {
      btn.onclick = () => switchMode(btn.dataset.mode);
    });

    document.getElementById('tx-filter').onchange = (e) => { state.txFilter = e.target.value; renderDetail(); };

    if (state.mode === 'maman') bindMamanEvents();
    if (state.mode === 'victor') bindVictorEvents(schedule);

    document.querySelectorAll('[data-contest]').forEach((btn) => {
      btn.onclick = () => {
        const tx = state.currentProject.transactions.find((t) => t.id === Number(btn.dataset.contest));
        state.contestTarget = tx;
        renderDetail();
      };
    });

    document.querySelectorAll('[data-delete-tx]').forEach((btn) => {
      btn.onclick = () => {
        const txId = btn.dataset.deleteTx;
        confirmClick(`tx-${txId}`, btn, '', '', async () => {
          try {
            await api(`/projects/${state.currentProjectId}/transactions/${txId}`, {
              method: 'DELETE',
              body: JSON.stringify({ code: codeFor('victor') })
            });
            toast('Transaction supprimée.');
            await refreshCurrentProject();
            renderDetail();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
        btn.innerHTML = '<i data-lucide="alert-triangle" class="w-4 h-4"></i>';
        icons();
      };
    });
  }

  function bindMamanEvents() {
    const form = document.getElementById('contest-form');
    if (!form) return;
    document.getElementById('cancel-contest').onclick = () => { state.contestTarget = null; renderDetail(); };
    const submitBtn = document.getElementById('submit-contest');
    form.onsubmit = withBusy(submitBtn, async (e) => {
      e.preventDefault();
      const motif = new FormData(form).get('motif');
      await api(`/projects/${state.currentProjectId}/contest`, {
        method: 'POST',
        body: JSON.stringify({ motif, code: codeFor('maman') })
      });
      toast('Contestation signalée.');
      state.contestTarget = null;
      await refreshCurrentProject();
      renderDetail();
    });
  }

  function bindVictorEvents(schedule) {
    const addForm = document.getElementById('add-tx-form');
    const addSubmit = document.getElementById('add-tx-submit');
    addForm.onsubmit = withBusy(addSubmit, async (e) => {
      e.preventDefault();
      const data = new FormData(addForm);
      await api(`/projects/${state.currentProjectId}/transactions`, {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(data.get('amount')),
          note: data.get('note') || null,
          code: codeFor('victor')
        })
      });
      toast('Versement ajouté.');
      await refreshCurrentProject();
      renderDetail();
    });

    const settleBtn = document.getElementById('settle-btn');
    if (settleBtn && schedule.kind === 'ok') {
      settleBtn.onclick = withBusy(settleBtn, async () => {
        await api(`/projects/${state.currentProjectId}/settle`, {
          method: 'POST',
          body: JSON.stringify({ code: codeFor('victor') })
        });
        toast('Échéance réglée.');
        await refreshCurrentProject();
        renderDetail();
      });
    }

    const pauseBtn = document.getElementById('pause-btn');
    pauseBtn.onclick = withBusy(pauseBtn, async () => {
      await api(`/projects/${state.currentProjectId}/pause`, {
        method: 'POST',
        body: JSON.stringify({ code: codeFor('victor') })
      });
      toast(state.currentProject.paused ? 'Suivi repris.' : 'Suivi mis en pause.');
      await refreshCurrentProject();
      renderDetail();
    });

    const archiveBtn = document.getElementById('archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = withBusy(archiveBtn, async () => {
        await api(`/projects/${state.currentProjectId}/archive`, {
          method: 'POST',
          body: JSON.stringify({ code: codeFor('victor') })
        });
        toast(state.currentProject.archived ? 'Projet désarchivé.' : 'Projet archivé.');
        await refreshCurrentProject();
        renderDetail();
      });
    }

    const noteForm = document.getElementById('note-form');
    const saveNoteBtn = document.getElementById('save-note-btn');
    noteForm.onsubmit = withBusy(saveNoteBtn, async (e) => {
      e.preventDefault();
      const note = new FormData(noteForm).get('note');
      await api(`/projects/${state.currentProjectId}/note`, {
        method: 'PUT',
        body: JSON.stringify({ note, code: codeFor('victor') })
      });
      toast('Note mise à jour.');
      await refreshCurrentProject();
      renderDetail();
    });

    const deleteBtn = document.getElementById('delete-project-btn');
    deleteBtn.onclick = () => {
      confirmClick('delete-project', deleteBtn, 'Supprimer le projet', 'Confirmer la suppression ?', async () => {
        try {
          await api(`/projects/${state.currentProjectId}`, {
            method: 'DELETE',
            body: JSON.stringify({ code: codeFor('victor') })
          });
          toast('Projet supprimé.');
          state.view = 'dashboard';
          state.currentProject = null;
          await refreshDashboard();
        } catch (err) {
          toast(err.message, 'error');
          deleteBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i> Supprimer le projet';
          icons();
        }
      });
      deleteBtn.innerHTML = '<i data-lucide="alert-triangle" class="w-4 h-4"></i> Confirmer la suppression ?';
      icons();
    };
  }

  // ---------- Global render ----------

  function render() {
    if (state.view === 'dashboard') renderDashboard();
    else renderDetail();
  }

  // ---------- Header events (dark mode, new project) ----------

  function bindHeaderEvents() {
    const darkBtn = document.getElementById('dark-toggle');
    darkBtn.onclick = () => {
      state.darkMode = !state.darkMode;
      document.documentElement.classList.toggle('dark', state.darkMode);
      darkBtn.innerHTML = `<i data-lucide="${state.darkMode ? 'sun' : 'moon'}" class="w-5 h-5"></i>`;
      icons();
    };

    const openCreate = () => {
      if (state.view !== 'dashboard') {
        state.view = 'dashboard';
        state.currentProject = null;
      }
      state.createPanelOpen = true;
      render();
    };
    document.getElementById('new-project-btn').onclick = openCreate;
    document.getElementById('new-project-btn-mobile').onclick = openCreate;
  }

  // ---------- Init ----------

  async function init() {
    bindHeaderEvents();
    try {
      await refreshDashboard();
    } catch (err) {
      app.innerHTML = `<div class="text-center py-16 text-coral-700">Impossible de charger les projets : ${esc(err.message)}</div>`;
    }
  }

  init();
})();
