// ── Globals ─────────────────────────────────────────────────────────────────
const vscode = acquireVsCodeApi();
let state = {
  specs: [],
  activeSpec: null,
  activeStage: 'requirements',
  contents: {},
  generating: false,
  models: [],
  selectedModelId: null,
  selectedModelName: null,
  progress: null,
  hasCustomPrompts: false,
  editMode: false,
  requirementsFormat: 'given-when-then',
};
let streamBuffer = { requirements: '', design: '', tasks: '', verify: '' };
let streamFramePending = { requirements: false, design: false, tasks: false, verify: false };
let pendingDelete = null;
const STAGES = ['requirements', 'design', 'tasks', 'verify'];

// ── Marked setup ────────────────────────────────────────────────────────────
if (typeof marked !== 'undefined') {
  marked.setOptions({
    gfm: true,
    breaks: false,
    highlight: (code, lang) => {
      if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      if (typeof hljs !== 'undefined') return hljs.highlightAuto(code).value;
      return code;
    }
  });
}

if (typeof mermaid !== 'undefined') {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'dark'
  });
}

// ── VSCode message handling ─────────────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':         handleInit(msg); break;
    case 'triggerNewSpec': openNewModal(); break;
    case 'specCreated':  handleSpecCreated(msg); break;
    case 'specOpened':   handleSpecOpened(msg); break;
    case 'specDeleted':  handleSpecDeleted(msg.specName); break;
    case 'streamStart':  handleStreamStart(msg); break;
    case 'streamChunk':  handleStreamChunk(msg); break;
    case 'streamDone':   handleStreamDone(msg); break;
    case 'inquiryDone':  handleInquiryDone(msg); break;
    case 'chatEntry':    break; // No longer rendered in panel (use Copilot chat instead)
    case 'taskOutput':   break; // Output goes to VS Code output channel
    case 'saved':        showToast('Saved ✓'); break;
    case 'error':        showError(msg.message); break;
    case 'modelChanged': handleModelChanged(msg); break;
    case 'modelsLoaded': handleModelsLoaded(msg); break;
    case 'progressUpdated': handleProgressUpdated(msg.progress); break;
    case 'usingCustomPrompt': showToast(`Using custom prompt for ${msg.stage}`); break;
    case 'promptsScaffolded': state.hasCustomPrompts = true; updateBreadcrumb(); break;
    case 'specRenamed': handleSpecRenamed(msg); break;
    case 'requirementsFormatChanged': state.requirementsFormat = msg.format || 'given-when-then'; showToast(msg.format === 'ears' ? 'Requirements format: EARS' : 'Requirements format: Given/When/Then'); break;
  }
});

// ── Init ────────────────────────────────────────────────────────────────────
function handleInit(msg) {
  state.specs = msg.specs || [];
  state.models = msg.models || [];
  state.selectedModelId = msg.selectedModelId || null;
  state.activeSpec = msg.activeSpec;
  state.activeStage = msg.activeStage || 'requirements';
  state.contents = msg.contents || {};
  state.requirementsFormat = msg.requirementsFormat || 'given-when-then';

  // Resolve selected model name
  const found = state.models.find(m => m.id === state.selectedModelId);
  state.selectedModelName = found?.name || (state.models[0]?.name ?? null);
  if (!state.selectedModelId && state.models[0]) {
    state.selectedModelId = state.models[0].id;
  }

  renderSidebar();
  renderModelChip();
  if (state.activeSpec) {
    renderAllStages();
    setActiveStage(state.activeStage);
    showMainContent();
  } else {
    showWelcome();
  }
}

function handleModelChanged(msg) {
  state.selectedModelId = msg.modelId;
  state.selectedModelName = msg.modelName;
  renderModelChip();
}

function handleModelsLoaded(msg) {
  state.models = msg.models || [];
  state.selectedModelId = msg.selectedModelId || state.selectedModelId;
  const found = state.models.find(m => m.id === state.selectedModelId);
  state.selectedModelName = found?.name || state.models[0]?.name || null;
  if (!state.selectedModelId && state.models[0]) state.selectedModelId = state.models[0].id;
  renderModelChip();
}

function renderModelChip() {
  // Inject model chip into topbar if it doesn't already exist
  let chip = document.getElementById('model-chip');
  const actions = document.getElementById('topbar-actions');
  if (!actions) return;

  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'model-chip';
    chip.className = 'model-chip';
    chip.title = 'Click to change model';
    chip.addEventListener('click', openModelPicker);
    // Insert before other actions
    actions.parentElement.insertBefore(chip, actions);
  }

  if (state.selectedModelName) {
    chip.className = 'model-chip';
    chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
    <span class="model-chip-name">${esc(state.selectedModelName)}</span>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;
  } else {
    chip.className = 'model-chip model-chip-none';
    chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <span class="model-chip-name">${state.models.length === 0 ? 'No model — Open settings' : 'No model — click to select'}</span>`;
  }
  const noModelCard = document.getElementById('no-model-card');
  const btnOpenSettings = document.getElementById('btn-open-settings');
  if (noModelCard) noModelCard.style.display = state.models.length === 0 ? 'block' : 'none';
  if (btnOpenSettings) {
    btnOpenSettings.onclick = () => { vscode.postMessage({ command: 'openSettings' }); };
  }
}

function openModelPicker() {
  if (state.models.length === 0) {
    vscode.postMessage({ command: 'openSettings' });
    return;
  }

  // Build inline dropdown
  const existing = document.getElementById('model-dropdown');
  if (existing) { existing.remove(); return; }

  const chip = document.getElementById('model-chip');
  const rect = chip.getBoundingClientRect();

  const dropdown = document.createElement('div');
  dropdown.id = 'model-dropdown';
  dropdown.style.cssText = `position:fixed;top:${rect.bottom+4}px;left:${rect.left}px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 8px 24px rgba(0,0,0,.4);z-index:200;min-width:260px;overflow:hidden`;

  dropdown.innerHTML = `
    <div style="padding:8px 12px 6px;font-size:11px;color:var(--text-muted);font-weight:500;border-bottom:1px solid var(--border)">SELECT MODEL</div>
    ${state.models.map(m => `
      <div class="model-option ${m.id === state.selectedModelId ? 'selected' : ''}" data-id="${esc(m.id)}" data-name="${esc(m.name)}"
        style="padding:8px 12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;transition:background .1s">
        <div>
          <div style="color:var(--text)">${esc(m.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(m.vendor)} · ${esc(m.family)}</div>
        </div>
        ${m.id === state.selectedModelId ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
      </div>
    `).join('')}
  `;

  dropdown.querySelectorAll('.model-option').forEach(opt => {
    opt.addEventListener('mouseover', () => opt.style.background = 'var(--surface2)');
    opt.addEventListener('mouseout', () => opt.style.background = '');
    opt.addEventListener('click', () => {
      const id = opt.dataset.id;
      vscode.postMessage({ command: 'selectModel', modelId: id });
      dropdown.remove();
    });
  });

  document.body.appendChild(dropdown);
  setTimeout(() => document.addEventListener('click', function handler(e) {
    if (!dropdown.contains(e.target)) { dropdown.remove(); document.removeEventListener('click', handler); }
  }), 10);
}

// ── Spec events ─────────────────────────────────────────────────────────────
function handleSpecCreated(msg) {
  state.activeSpec = msg.specName;
  state.activeStage = 'requirements';
  state.contents = {};
  state.progress = null;
  state.hasCustomPrompts = msg.hasCustomPrompts || false;
  streamBuffer = { requirements: '', design: '', tasks: '', verify: '' };
  addOrUpdateSpecInList({ name: msg.specName, hasRequirements: false, hasDesign: false, hasTasks: false, hasVerify: false, progress: null });
  renderSidebar();
  showMainContent();
  setActiveStage('requirements');
  updateBreadcrumb();
}

function handleSpecOpened(msg) {
  state.activeSpec = msg.specName;
  state.activeStage = msg.activeStage;
  state.contents = msg.contents || {};
  state.progress = msg.progress || null;
  state.hasCustomPrompts = msg.hasCustomPrompts || false;
  state.requirementsFormat = msg.requirementsFormat || 'given-when-then';
  streamBuffer = { requirements: '', design: '', tasks: '', verify: '' };
  renderAllStages();
  showMainContent();
  setActiveStage(state.activeStage);
  renderSidebar();
  updateBreadcrumb();
  if (state.progress && state.activeStage === 'tasks') renderProgress(state.progress);
}

function handleProgressUpdated(progress) {
  state.progress = progress;
  renderProgress(progress);
  // Update sidebar dot for this spec
  const spec = state.specs.find(s => s.name === state.activeSpec);
  if (spec) { spec.progress = progress; renderSidebar(); }
}

function handleSpecDeleted(specName) {
  state.specs = state.specs.filter(s => s.name !== specName);
  if (state.activeSpec === specName) {
    state.activeSpec = null;
    state.contents = {};
    showWelcome();
  }
  renderSidebar();
}

// ── Stream ───────────────────────────────────────────────────────────────────
let isRefineStream = false;
function handleStreamStart(msg) {
  state.generating = true;
  isRefineStream = !!msg.isRefine;
  streamBuffer[msg.stage] = '';
  streamFramePending[msg.stage] = false;
  const el = document.getElementById('md-' + msg.stage);
  if (el) { el.innerHTML = ''; el.classList.add('stream-cursor'); }
  setActiveStage(msg.stage);
  updateTopbarActions();
}

function handleStreamChunk(msg) {
  streamBuffer[msg.stage] += msg.chunk;
  scheduleStreamRender(msg.stage);
}

function handleInquiryDone(msg) {
  state.generating = false;
  streamBuffer[msg.stage] = '';
  // Restore the original document content (streamStart cleared it)
  const el = document.getElementById('md-' + msg.stage);
  if (el) {
    el.classList.remove('stream-cursor');
    const original = state.contents[msg.stage] || '';
    if (msg.stage === 'tasks') {
      el.innerHTML = renderInteractiveTasks(original);
      wireTaskCheckboxes();
    } else {
      renderMarkdownInto(el, original);
    }
  }
  showToast('AI response received');
  updateTopbarActions();
}

function handleStreamDone(msg) {
  state.generating = false;
  state.contents[msg.stage] = msg.content;
  streamBuffer[msg.stage] = '';
  const el = document.getElementById('md-' + msg.stage);
  if (el) {
    el.classList.remove('stream-cursor');
    if (msg.stage === 'tasks') {
      el.innerHTML = renderInteractiveTasks(msg.content);
      wireTaskCheckboxes();
    } else {
      renderMarkdownInto(el, msg.content);
    }
    if (msg.stage === 'verify') renderHealthScore(msg.content);
  }
  if (isRefineStream) {
    showToast('Document refined');
    isRefineStream = false;
  }
  setActiveStage(msg.stage);
  updateSpecStages(state.activeSpec, msg.stage);
  renderSidebar();
  updateTopbarActions();
}

// ── Render helpers ────────────────────────────────────────────────────────────
function renderMarkdown(md) {
  if (typeof marked === 'undefined') return md || '';
  return marked.parse(md || '');
}

function renderStreamingPreview(md) {
  return `<pre class="streaming-preview">${esc(md || '')}</pre>`;
}

function renderMarkdownInto(el, md) {
  if (!el) return;
  el.innerHTML = renderMarkdown(md);
  renderMermaidDiagrams(el);
}

function scheduleStreamRender(stage) {
  if (streamFramePending[stage]) return;
  streamFramePending[stage] = true;
  requestAnimationFrame(() => {
    streamFramePending[stage] = false;
    const el = document.getElementById('md-' + stage);
    if (!el) return;
    el.innerHTML = renderStreamingPreview(streamBuffer[stage]);
    const area = el.closest('.md-area');
    if (area) area.scrollTop = area.scrollHeight;
  });
}

function renderMermaidDiagrams(container) {
  if (typeof mermaid === 'undefined' || !container) return;
  const codeBlocks = container.querySelectorAll('pre > code.language-mermaid, pre > code.lang-mermaid');
  if (!codeBlocks.length) return;

  const nodes = [];
  codeBlocks.forEach((code, idx) => {
    const pre = code.parentElement;
    if (!pre) return;
    const src = code.textContent || '';
    const host = document.createElement('div');
    host.className = 'mermaid';
    host.id = `mermaid-${Date.now()}-${idx}`;
    host.textContent = src;
    pre.replaceWith(host);
    nodes.push(host);
  });

  if (nodes.length) {
    mermaid.run({ nodes }).catch(() => {});
  }
}

function renderAllStages() {
  ['requirements', 'design'].forEach(stage => {
    const el = document.getElementById('md-' + stage);
    renderMarkdownInto(el, state.contents[stage] || '');
  });
  const tasksEl = document.getElementById('md-tasks');
  if (tasksEl) {
    if (state.contents.tasks) {
      tasksEl.innerHTML = renderInteractiveTasks(state.contents.tasks);
      wireTaskCheckboxes();
    } else {
      tasksEl.innerHTML = '';
    }
  }
  if (state.progress) renderProgress(state.progress);

  const verifyEl = document.getElementById('md-verify');
  if (verifyEl) {
    renderMarkdownInto(verifyEl, state.contents.verify || '');
    if (state.contents.verify) renderHealthScore(state.contents.verify);
  }
}

function renderSidebar() {
  const list = document.getElementById('specs-list');
  const countEl = document.getElementById('specs-count');
  if (!list) return;
  const filtered = searchFilter
    ? state.specs.filter(s => s.name.toLowerCase().includes(searchFilter))
    : state.specs;
  if (countEl) countEl.textContent = `${filtered.length} spec${filtered.length !== 1 ? 's' : ''}`;
  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:16px 8px;color:var(--text-muted);font-size:12px;text-align:center">' +
      (state.specs.length === 0 ? 'No specs yet' : 'No matching specs') + '</div>';
    return;
  }
  list.innerHTML = filtered.map(spec => {
    const active = spec.name === state.activeSpec;
    const pct = spec.progress && spec.progress.total > 0
      ? Math.round((spec.progress.done / spec.progress.total) * 100) : 0;
    const showProgress = spec.hasTasks && spec.progress;
    return `<div class="spec-item ${active ? 'active' : ''}" data-name="${esc(spec.name)}">
      <div style="flex:1;min-width:0">
        <span class="spec-item-name">${esc(spec.name)}</span>
        ${showProgress ? `<div class="progress-bar-wrap" style="margin-top:3px"><div class="progress-bar-fill" style="width:${pct}%"></div></div>` : ''}
      </div>
      <span class="spec-item-dots">
        <span class="stage-dot ${spec.hasRequirements ? 'done' : ''}" title="Requirements"></span>
        <span class="stage-dot ${spec.hasDesign ? 'done' : ''}" title="Design"></span>
        <span class="stage-dot ${spec.hasTasks ? 'done' : ''}" title="Tasks"></span>
        <span class="stage-dot ${spec.hasVerify ? 'verify' : ''}" title="Verify"></span>
      </span>
      <button class="spec-item-del" data-del="${esc(spec.name)}" title="Delete spec">✕</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.spec-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.del || e.target.classList.contains('rename-input')) return;
      const name = el.dataset.name;
      if (name && name !== state.activeSpec) {
        vscode.postMessage({ command: 'openSpec', specName: name });
      }
    });
    // Double-click to rename (Deliverable G)
    el.querySelector('.spec-item-name')?.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const nameSpan = e.target;
      const oldName = el.dataset.name;
      const input = document.createElement('input');
      input.className = 'rename-input';
      input.value = oldName;
      nameSpan.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const newName = input.value.trim();
        if (newName && newName !== oldName) {
          vscode.postMessage({ command: 'renameSpec', oldName, newName });
        } else {
          renderSidebar();
        }
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.value = oldName; input.blur(); }
      });
    });
  });
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDeleteModal(btn.dataset.del);
    });
  });
}

function renderProgress(progress) {
  if (!progress) return;
  const header = document.getElementById('tasks-progress-header');
  const bar = document.getElementById('progress-bar');
  const label = document.getElementById('progress-label');
  const pct = document.getElementById('progress-pct');
  if (!header || !bar || !label || !pct) return;
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  header.style.display = 'block';
  bar.style.width = percent + '%';
  label.textContent = `${progress.done} / ${progress.total} tasks complete`;
  pct.textContent = percent + '%';
}

function renderHealthScore(verifyContent) {
  const header = document.getElementById('verify-score-header');
  const badge = document.getElementById('health-badge');
  const verdict = document.getElementById('health-verdict');
  if (!header || !badge || !verdict) return;

  // Parse "## Spec Health Score: 84" or "## Spec Health Score: 84/100"
  const match = verifyContent.match(/Spec Health Score[:\s]+(\d+)/i);
  if (!match) return;

  const score = parseInt(match[1], 10);
  let cls = 'health-poor', emoji = '🔴';
  if (score >= 90) { cls = 'health-excellent'; emoji = '✅'; }
  else if (score >= 70) { cls = 'health-good'; emoji = '⚠️'; }
  else if (score >= 50) { cls = 'health-fair'; emoji = '🟡'; }

  // Extract verdict line (first sentence after the score heading)
  const verdictMatch = verifyContent.match(/Spec Health Score[^\n]*\n+([^\n]{10,120})/i);
  const verdictText = verdictMatch ? verdictMatch[1].replace(/^#+\s*/, '').trim() : '';

  header.style.display = 'flex';
  badge.className = `health-badge ${cls}`;
  badge.textContent = `${emoji} ${score} / 100`;
  verdict.textContent = verdictText;
}

function renderInteractiveTasks(markdown) {
  // Convert markdown but make checkboxes interactive with data-task-id
  const lines = markdown.split('\n');
  let taskIndex = 0;
  const processedLines = lines.map(line => {
    const m = /^(\s*)-\s+\[([ xX])\]\s+(.+?)(\s+\([SMLX]+\))?$/.exec(line);
    if (!m) return line;
    const label = m[3].trim();
    const indent = m[1].length;
    const checked = m[2].toLowerCase() === 'x';
    const size = m[4] || '';
    // Generate same stableId logic as backend
    const id = `${label.slice(0,32).replace(/\s+/g,'_').toLowerCase()}_${taskIndex++}`;

    // Use persisted state if available
    const isChecked = state.progress?.items[id] ?? checked;
    const checkedStr = isChecked ? 'x' : ' ';
    return `${m[1]}- [${checkedStr}] ${m[3]}${size} <span style="display:none" data-task-id="${esc(id)}"></span>`;
  });
  return renderMarkdown(processedLines.join('\n'));
}

function wireTaskCheckboxes() {
  const el = document.getElementById('md-tasks');
  if (!el) return;
  el.querySelectorAll('input[type=checkbox]').forEach((cb, i) => {
    cb.addEventListener('change', () => {
      // Find the hidden span with data-task-id nearby
      const li = cb.closest('li');
      const idSpan = li?.querySelector('[data-task-id]');
      if (idSpan) {
        vscode.postMessage({ command: 'toggleTask', taskId: idSpan.dataset.taskId });
      }
      // Optimistic UI
      cb.closest('li')?.classList.toggle('done', cb.checked);
    });
  });
}

function updateTopbarActions() {
  const container = document.getElementById('topbar-actions');
  if (!container || !state.activeSpec) { if(container) container.innerHTML=''; return; }
  const stage = state.activeStage;
  const hasContent = !!state.contents[stage];
  const hasReq = !!state.contents.requirements;
  const hasDes = !!state.contents.design;
  const hasTasks = !!state.contents.tasks;
  const hasVerify = !!state.contents.verify;
  const gen = state.generating;
  let html = '';

  if (gen) {
    html = `<div style="display:flex;align-items:center;gap:8px;color:var(--text-muted);font-size:12px">
      <div class="spinner accent"></div>Generating…
      <button class="btn-action" style="margin-left:4px" id="btn-cancel">Cancel</button>
    </div>`;
    container.innerHTML = html;
    container.querySelector('#btn-cancel')?.addEventListener('click', () => vscode.postMessage({ command: 'cancelGeneration' }));
    return;
  }

  // Primary actions
  if (stage === 'requirements' && hasReq) {
    html += `<button class="btn-action primary" id="btn-gen-design">Generate Design →</button>`;
  }
  if (stage === 'design') {
    if (!hasDes && hasReq) html += `<button class="btn-action primary" id="btn-gen-design">Generate Design</button>`;
    if (hasDes) html += `<button class="btn-action primary" id="btn-gen-tasks">Generate Tasks →</button>`;
  }
  if (stage === 'tasks') {
    if (!hasTasks && hasDes) html += `<button class="btn-action primary" id="btn-gen-tasks">Generate Tasks</button>`;
    if (hasTasks) {
      html += `<button class="btn-action run" id="btn-run-tasks">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Run all
      </button>`;
      html += `<button class="btn-action primary" id="btn-gen-verify" style="background:var(--yellow);border-color:var(--yellow);color:#1e1e2e">Verify →</button>`;
    }
  }
  if (stage === 'verify') {
    if (!hasVerify && hasTasks) html += `<button class="btn-action primary" id="btn-gen-verify">Run Verification</button>`;
    if (hasVerify) html += `<button class="btn-action" id="btn-gen-verify">Re-verify</button>`;
  }

  // Secondary actions are grouped in a "More" menu to avoid crowding.
  html += `<button class="btn-action" id="btn-actions-menu" title="More actions">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
    More
  </button>`;

  container.innerHTML = html;

  // Wire up buttons
  container.querySelector('#btn-gen-design')?.addEventListener('click', () => vscode.postMessage({ command: 'generateDesign' }));
  container.querySelector('#btn-gen-tasks')?.addEventListener('click', () => vscode.postMessage({ command: 'generateTasks' }));
  container.querySelector('#btn-run-tasks')?.addEventListener('click', () => vscode.postMessage({ command: 'runAllTasks' }));
  container.querySelector('#btn-gen-verify')?.addEventListener('click', () => {
    setActiveStage('verify');
    vscode.postMessage({ command: 'generateVerify' });
  });
  container.querySelector('#btn-actions-menu')?.addEventListener('click', () => openActionsMenu(stage, hasContent));
}

function updateBreadcrumb() {
  const el = document.getElementById('bc-spec');
  if (el) {
    el.innerHTML = esc(state.activeSpec || '—') +
      (state.hasCustomPrompts ? '<span class="custom-prompts-dot" title="Custom prompts active"></span>' : '');
  }
  STAGES.forEach(s => {
    const pill = document.getElementById('pill-' + s);
    if (!pill) return;
    pill.classList.remove('active', 'done');
    if (s === state.activeStage) pill.classList.add('active');
    else if (state.contents[s]) pill.classList.add('done');
  });
}

function setActiveStage(stage) {
  // Exit edit mode when switching stages
  if (state.editMode) exitEditMode();
  closeRefineInline();
  state.activeStage = stage;
  STAGES.forEach(s => {
    document.getElementById('view-' + s)?.classList.toggle('visible', s === stage);
  });
  updateBreadcrumb();
  updateTopbarActions();
  vscode.postMessage({ command: 'setStage', stage });
  // Update refine placeholder
  const ri = document.getElementById('refine-input');
  if (ri) ri.placeholder = `Describe the change to ${stage}… (Enter to apply)`;
  // Persist state
  saveWebviewState();
}

function updateSpecStages(specName, completedStage) {
  const spec = state.specs.find(s => s.name === specName);
  if (!spec) return;
  if (completedStage === 'requirements') spec.hasRequirements = true;
  if (completedStage === 'design') spec.hasDesign = true;
  if (completedStage === 'tasks') spec.hasTasks = true;
  if (completedStage === 'verify') spec.hasVerify = true;
}

function addOrUpdateSpecInList(spec) {
  const idx = state.specs.findIndex(s => s.name === spec.name);
  if (idx >= 0) state.specs[idx] = { ...state.specs[idx], ...spec };
  else state.specs.unshift(spec);
}

function showWelcome() {
  document.getElementById('welcome')?.classList.remove('hidden');
  STAGES.forEach(s => document.getElementById('view-' + s)?.classList.remove('visible'));
  document.getElementById('bc-spec').textContent = '—';
  document.getElementById('topbar-actions').innerHTML = '';
}

function showMainContent() {
  document.getElementById('welcome')?.classList.add('hidden');
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
}

function showError(msg) {
  state.generating = false;
  STAGES.forEach(s => document.getElementById('md-' + s)?.classList.remove('stream-cursor'));
  showToast('Error: ' + msg);
  updateTopbarActions();
  console.error('nSpec:', msg);
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Edit mode (Deliverable A) ─────────────────────────────────────────────────
function toggleEditMode() {
  if (state.editMode) exitEditMode();
  else enterEditMode();
}

function enterEditMode() {
  const stage = state.activeStage;
  const area = document.getElementById('area-' + stage);
  const textarea = document.getElementById('edit-' + stage);
  if (!area || !textarea) return;
  textarea.value = state.contents[stage] || '';
  area.classList.add('editing');
  state.editMode = true;
  textarea.style.height = 'auto';
  textarea.style.height = Math.max(textarea.scrollHeight, 200) + 'px';
  textarea.focus();
  updateTopbarActions();
}

function exitEditMode() {
  const stage = state.activeStage;
  const area = document.getElementById('area-' + stage);
  const textarea = document.getElementById('edit-' + stage);
  if (!area || !textarea) return;
  // Save content
  const newContent = textarea.value;
  if (newContent !== state.contents[stage]) {
    state.contents[stage] = newContent;
    vscode.postMessage({ command: 'saveContent', stage, content: newContent });
    // Re-render preview
    const mdEl = document.getElementById('md-' + stage);
    if (mdEl) {
      if (stage === 'tasks') {
        mdEl.innerHTML = renderInteractiveTasks(newContent);
        wireTaskCheckboxes();
      } else {
        renderMarkdownInto(mdEl, newContent);
      }
      if (stage === 'verify') renderHealthScore(newContent);
    }
  }
  area.classList.remove('editing');
  state.editMode = false;
  updateTopbarActions();
}

function saveEditWithoutExiting() {
  const stage = state.activeStage;
  const textarea = document.getElementById('edit-' + stage);
  if (!textarea || !state.editMode) return;
  const newContent = textarea.value;
  state.contents[stage] = newContent;
  vscode.postMessage({ command: 'saveContent', stage, content: newContent });
  showToast('Saved');
}

// ── Inline refine (Deliverable B) ─────────────────────────────────────────────
function openRefineInline() {
  const bar = document.getElementById('refine-inline');
  const input = document.getElementById('refine-input');
  if (!bar) return;
  bar.classList.add('visible');
  if (input) {
    input.placeholder = `Describe the change to ${state.activeStage}… (Enter to apply)`;
    input.focus();
  }
}

function closeRefineInline() {
  const bar = document.getElementById('refine-inline');
  if (bar) bar.classList.remove('visible');
}

function sendRefine() {
  const input = document.getElementById('refine-input');
  const val = input?.value?.trim();
  if (!val || state.generating || !state.activeSpec) return;
  vscode.postMessage({ command: 'refine', stage: state.activeStage, feedback: val });
  input.value = '';
  closeRefineInline();
}

document.getElementById('btn-refine-send')?.addEventListener('click', sendRefine);
document.getElementById('btn-refine-close')?.addEventListener('click', closeRefineInline);
document.getElementById('refine-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sendRefine(); }
  if (e.key === 'Escape') closeRefineInline();
});

// ── Cascade dropdown (Deliverable E) ──────────────────────────────────────────
function openActionsMenu(stage, hasContent) {
  const existing = document.getElementById('actions-dd');
  if (existing) { existing.remove(); return; }

  const btn = document.getElementById('btn-actions-menu');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();

  const dd = document.createElement('div');
  dd.id = 'actions-dd';
  dd.className = 'cascade-dropdown';
  dd.style.cssText = `top:${rect.bottom+4}px;right:${window.innerWidth - rect.right}px`;

  const editIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  const previewIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const items = [];
  if (hasContent) {
    items.push(`<div class="cascade-dropdown-item" data-action="toggle-edit">${state.editMode ? previewIcon + ' Preview mode' : editIcon + ' Edit mode'}</div>`);
    items.push('<div class="cascade-dropdown-item" data-action="refine">Refine current stage</div>');
  }
  items.push('<div class="cascade-dropdown-item" data-action="import">Import content</div>');
  if (stage !== 'verify') {
    items.push('<div class="cascade-dropdown-item" data-action="cascade">Cascade options</div>');
  }
  if (stage === 'requirements') {
    items.push(`<div class="cascade-dropdown-item" data-action="format-gwt">Requirements format: Given/When/Then${state.requirementsFormat === 'given-when-then' ? ' ✓' : ''}</div>`);
    items.push(`<div class="cascade-dropdown-item" data-action="format-ears">Requirements format: EARS${state.requirementsFormat === 'ears' ? ' ✓' : ''}</div>`);
  }
  dd.innerHTML = items.join('');

  dd.querySelectorAll('.cascade-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      dd.remove();
      if (action === 'toggle-edit') toggleEditMode();
      else if (action === 'refine') openRefineInline();
      else if (action === 'import') vscode.postMessage({ command: 'importFromFile' });
      else if (action === 'cascade') openCascadeDropdown(btn);
      else if (action === 'format-gwt') vscode.postMessage({ command: 'setRequirementsFormat', format: 'given-when-then' });
      else if (action === 'format-ears') vscode.postMessage({ command: 'setRequirementsFormat', format: 'ears' });
    });
  });

  document.body.appendChild(dd);
  setTimeout(() => document.addEventListener('click', function handler(e) {
    if (!dd.contains(e.target) && e.target !== btn) { dd.remove(); document.removeEventListener('click', handler); }
  }), 10);
}

function openCascadeDropdown(anchorEl) {
  const existing = document.getElementById('cascade-dd');
  if (existing) { existing.remove(); return; }

  const btn = anchorEl || document.getElementById('btn-cascade-open');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();

  const dd = document.createElement('div');
  dd.id = 'cascade-dd';
  dd.className = 'cascade-dropdown';
  dd.style.cssText = `top:${rect.bottom+4}px;right:${window.innerWidth - rect.right}px`;

  const stage = state.activeStage;
  let items = '';
  items += `<div class="cascade-dropdown-item" data-action="from-current">
    <div>From ${stage} → verify</div>
    <div class="cd-desc">Generate all downstream stages</div>
  </div>`;
  items += `<div class="cascade-dropdown-item" data-action="regen-current">
    <div>Regenerate ${stage}</div>
    <div class="cd-desc">Regenerate the current stage</div>
  </div>`;
  items += `<div class="cascade-dropdown-item" data-action="full-pipeline">
    <div>Full pipeline</div>
    <div class="cd-desc">Regenerate all stages from requirements</div>
  </div>`;
  dd.innerHTML = items;

  dd.querySelectorAll('.cascade-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      dd.remove();
      if (action === 'from-current') {
        vscode.postMessage({ command: 'cascadeFromStage', fromStage: stage });
      } else if (action === 'regen-current') {
        if (stage === 'requirements') vscode.postMessage({ command: 'generateRequirements' });
        else if (stage === 'design') vscode.postMessage({ command: 'generateDesign' });
        else if (stage === 'tasks') vscode.postMessage({ command: 'generateTasks' });
        else if (stage === 'verify') vscode.postMessage({ command: 'generateVerify' });
      } else if (action === 'full-pipeline') {
        vscode.postMessage({ command: 'cascadeFromStage', fromStage: 'design' });
      }
    });
  });

  document.body.appendChild(dd);
  setTimeout(() => document.addEventListener('click', function handler(e) {
    if (!dd.contains(e.target)) { dd.remove(); document.removeEventListener('click', handler); }
  }), 10);
}

// ── Spec rename (Deliverable G) ───────────────────────────────────────────────
function handleSpecRenamed(msg) {
  if (state.activeSpec === msg.oldName) state.activeSpec = msg.newName;
  const spec = state.specs.find(s => s.name === msg.oldName);
  if (spec) spec.name = msg.newName;
  renderSidebar();
  updateBreadcrumb();
  showToast('Spec renamed');
}

// ── Sidebar search (Deliverable G) ────────────────────────────────────────────
let searchFilter = '';
document.getElementById('sidebar-search')?.addEventListener('input', e => {
  searchFilter = e.target.value.toLowerCase();
  renderSidebar();
});

// ── State persistence (Deliverable G) ─────────────────────────────────────────
function saveWebviewState() {
  vscode.setState({ activeSpec: state.activeSpec, activeStage: state.activeStage });
}

function restoreWebviewState() {
  const saved = vscode.getState();
  if (saved) {
    if (saved.activeSpec) state.activeSpec = saved.activeSpec;
    if (saved.activeStage) state.activeStage = saved.activeStage;
  }
}

// ── Keyboard shortcuts (Deliverable F) ────────────────────────────────────────
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!state.activeSpec) return;

  // Ctrl+1/2/3/4 switch stages
  if (ctrl && e.key >= '1' && e.key <= '4') {
    e.preventDefault();
    setActiveStage(STAGES[parseInt(e.key) - 1]);
    return;
  }
  // Ctrl+E toggle edit
  if (ctrl && e.key === 'e') {
    e.preventDefault();
    toggleEditMode();
    return;
  }
  // Ctrl+Enter generate next stage / cascade
  if (ctrl && e.key === 'Enter') {
    e.preventDefault();
    const s = state.activeStage;
    if (s === 'requirements' && state.contents.requirements) vscode.postMessage({ command: 'generateDesign' });
    else if (s === 'design' && state.contents.design) vscode.postMessage({ command: 'generateTasks' });
    else if (s === 'tasks' && state.contents.tasks) { setActiveStage('verify'); vscode.postMessage({ command: 'generateVerify' }); }
    return;
  }
  // Ctrl+R focus refine
  if (ctrl && e.key === 'r') {
    e.preventDefault();
    openRefineInline();
    return;
  }
  // Ctrl+S save edits
  if (ctrl && e.key === 's' && state.editMode) {
    e.preventDefault();
    saveEditWithoutExiting();
    return;
  }
  // Escape close modal / exit edit mode / close refine
  if (e.key === 'Escape') {
    if (state.editMode) { exitEditMode(); return; }
    const refineBar = document.getElementById('refine-inline');
    if (refineBar?.classList.contains('visible')) { closeRefineInline(); return; }
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
  }
});

// ── Stage pills ───────────────────────────────────────────────────────────────
document.querySelectorAll('.stage-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    if (!state.activeSpec) return;
    setActiveStage(pill.dataset.stage);
  });
});

// ── New spec wizard (D1 + D2) ─────────────────────────────────────────────────
// Delegate from #app so "New Spec" / "Create your first spec" work even if direct
// listeners failed (script timing, DOM not ready, or Cursor/webview quirks).
document.getElementById('app')?.addEventListener('click', (e) => {
  const t = e.target && e.target.closest && e.target.closest('#btn-new-spec, #btn-welcome-new');
  if (t) { e.preventDefault(); openNewModal(); }
});

function openNewModal() {
  document.getElementById('modal-new')?.classList.remove('hidden');
  updateStep1ForType();
  document.getElementById('new-spec-name')?.focus();
}

function closeNewModal() {
  document.getElementById('modal-new')?.classList.add('hidden');
  const nameEl = document.getElementById('new-spec-name');
  if (nameEl) nameEl.value = '';
  const promptEl = document.getElementById('new-spec-prompt');
  if (promptEl) promptEl.value = '';
  const jiraEl = document.getElementById('new-spec-jira');
  if (jiraEl && 'value' in jiraEl) jiraEl.value = '';
  const tmplEl = document.getElementById('new-spec-template');
  if (tmplEl) tmplEl.value = '';
  const featRadio = document.querySelector('input[name="spec-type"][value="feature"]');
  if (featRadio) featRadio.checked = true;
}

function getSelectedSpecType() {
  return document.querySelector('input[name="spec-type"]:checked')?.value || 'feature';
}

function updateStep1ForType() {
  const specType = getSelectedSpecType();
  const label   = document.getElementById('prompt-label');
  const area    = document.getElementById('new-spec-prompt');
  const nextBtn = document.getElementById('btn-wiz-next-1');
  const jiraField = document.getElementById('jira-field');
  const tmplField = document.getElementById('template-field');

  if (specType === 'bugfix') {
    if (label)   label.textContent = 'Bug report';
    if (area)    area.placeholder = 'Describe the bug: symptoms, reproduction steps, expected vs actual behavior…';
    if (nextBtn) nextBtn.textContent = 'Analyze Root Cause →';
    if (jiraField) jiraField.style.display = 'none';
    if (tmplField) tmplField.style.display = 'none';
  } else if (specType === 'design-first') {
    if (label)   label.textContent = 'Design description';
    if (area)    area.placeholder = 'Describe the technical design, architecture, or approach…';
    if (nextBtn) nextBtn.textContent = 'Generate Design →';
    if (jiraField) jiraField.style.display = 'block';
    if (tmplField) tmplField.style.display = 'block';
  } else {
    if (label)   label.textContent = 'Description';
    if (area)    area.placeholder = 'Describe the feature, its purpose, key behaviors, and any constraints…';
    if (nextBtn) nextBtn.textContent = 'Generate →';
    if (jiraField) jiraField.style.display = 'block';
    if (tmplField) tmplField.style.display = 'block';
  }
}

function getWizardFormData() {
  return {
    specName:    document.getElementById('new-spec-name')?.value?.trim()   || '',
    specType:    getSelectedSpecType(),
    template:    document.getElementById('new-spec-template')?.value       || '',
    description: document.getElementById('new-spec-prompt')?.value?.trim() || '',
    jiraUrl:     document.getElementById('new-spec-jira')?.value?.trim()   || '',
  };
}

// Jira URL → auto-infer Feature type
document.getElementById('new-spec-jira')?.addEventListener('input', (e) => {
  const val = e.target?.value?.trim() || '';
  const looksLikeJiraRef =
    (val && val.includes('atlassian.net')) || /^[A-Z][A-Z0-9]+-\d+$/i.test(val);
  if (looksLikeJiraRef) {
    const radio = document.querySelector('input[name="spec-type"][value="feature"]');
    if (radio && !radio.checked) { radio.checked = true; updateStep1ForType(); }
  }
});

// Spec type change
document.querySelectorAll('input[name="spec-type"]').forEach(r => {
  r.addEventListener('change', updateStep1ForType);
});

// Step 1 primary action: Clarify → OR direct generate (bugfix/design-first)
document.getElementById('btn-wiz-next-1')?.addEventListener('click', () => {
  const d = getWizardFormData();
  if (!d.specName) { document.getElementById('new-spec-name')?.focus(); showToast('Please enter a spec name.'); return; }
  if (!d.description && !d.jiraUrl) { document.getElementById('new-spec-prompt')?.focus(); showToast('Enter a description or Jira URL.'); return; }
  closeNewModal();
  vscode.postMessage({ command: 'createSpec', specName: d.specName, prompt: d.description, specType: d.specType, template: d.template, jiraUrl: d.jiraUrl || undefined });
});

document.getElementById('btn-new-cancel')?.addEventListener('click', closeNewModal);

document.getElementById('new-spec-name')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-wiz-next-1')?.click(); }
});
document.getElementById('new-spec-prompt')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.metaKey) document.getElementById('btn-wiz-next-1')?.click();
});


// ── Delete modal ──────────────────────────────────────────────────────────────
function openDeleteModal(name) {
  pendingDelete = name;
  document.getElementById('modal-delete-msg').textContent = `Delete "${name}"? This cannot be undone.`;
  document.getElementById('modal-delete')?.classList.remove('hidden');
}
document.getElementById('btn-del-cancel')?.addEventListener('click', () => {
  pendingDelete = null;
  document.getElementById('modal-delete')?.classList.add('hidden');
});
document.getElementById('btn-del-ok')?.addEventListener('click', () => {
  if (pendingDelete) {
    vscode.postMessage({ command: 'deleteSpec', specName: pendingDelete });
    pendingDelete = null;
  }
  document.getElementById('modal-delete')?.classList.add('hidden');
});

// Close modals on overlay click (backdrop only); prevent overlay from capturing modal content clicks
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  const modal = overlay.querySelector('.modal');
  overlay.addEventListener('click', e => {
    if (e.target === overlay || (modal && !modal.contains(e.target))) overlay.classList.add('hidden');
  });
  if (modal) modal.addEventListener('click', e => e.stopPropagation());
});

// ── Boot ──────────────────────────────────────────────────────────────────────
restoreWebviewState();
vscode.postMessage({ command: 'ready' });
vscode.postMessage({ command: 'getModels' });
