/* app.js — main PWA application logic for OfflineGDZ */

let db;
let currentTab = 'library';
let currentScreen = null; // null = tab view, 'textbook', 'solution'
let currentTextbookId = null;
let currentTaskId = null;
let solutionContext = []; // taskId list for prev/next
let searchTimeout = null;
const naturalCollator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
const content = () => $('#content');
const esc = (s) => {
    const el = document.createElement('span');
    el.textContent = s || '';
    return el.innerHTML;
};

function compareNullableNumbers(a, b) {
    const aNum = Number(a);
    const bNum = Number(b);
    const aMissing = Number.isNaN(aNum);
    const bMissing = Number.isNaN(bNum);

    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return aNum - bNum;
}

function compareNaturalLabels(a, b) {
    const left = (a || '').toString().trim();
    const right = (b || '').toString().trim();

    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;

    return naturalCollator.compare(left, right);
}

const BUNDLED_ASSETS = [
    'data/biology-gdz-import.json',
    'data/chemistry-8-gabrielyan-euroki.json',
    'data/geography-euroki-import.json',
    'data/geometry-reshak-import.json'
];
const BOOTSTRAP_KEY = 'gdz_bootstrapped_v1';
const GRADE_KEY = 'gdz_selected_grade';
const SUPPORTED_GRADES = [7, 8];
const OFFLINE_CACHE_NAME = 'offlinegdz-v7';

function getSelectedGrade() {
    const grade = Number(localStorage.getItem(GRADE_KEY));
    return SUPPORTED_GRADES.includes(grade) ? grade : null;
}

function setSelectedGrade(grade) {
    if (SUPPORTED_GRADES.includes(grade)) {
        localStorage.setItem(GRADE_KEY, String(grade));
    }
}

function clearSelectedGrade() {
    localStorage.removeItem(GRADE_KEY);
    currentScreen = null;
    currentTextbookId = null;
    currentTaskId = null;
    solutionContext = [];
}

function extractSupportedGrades(value) {
    const text = (value || '').toString().toLowerCase();
    if (!text) return null;

    const rangeMatch = text.match(/(\d+)\s*[-–—]\s*(\d+)\s*класс/);
    if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
            const grades = [];
            for (let grade = start; grade <= end; grade += 1) {
                grades.push(grade);
            }
            return grades;
        }
    }

    const singleMatch = text.match(/(\d+)\s*класс/);
    if (singleMatch) {
        const grade = Number(singleMatch[1]);
        if (Number.isFinite(grade)) return [grade];
    }

    return null;
}

function textbookGradeLabel(item) {
    return [
        item?.seriesTitle,
        item?.textbookSeriesTitle,
        item?.title,
        item?.textbookTitle
    ].find(Boolean) || '';
}

function matchesSelectedGrade(item, selectedGrade = getSelectedGrade()) {
    if (!selectedGrade) return true;
    const supportedGrades = extractSupportedGrades(textbookGradeLabel(item));
    return !supportedGrades || supportedGrades.includes(selectedGrade);
}

function filterBySelectedGrade(items, selectedGrade = getSelectedGrade()) {
    return items.filter(item => matchesSelectedGrade(item, selectedGrade));
}

function gradeSubtitle() {
    const grade = getSelectedGrade();
    return grade ? `${grade} класс` : '';
}

function renderGradePicker() {
    setTopBar('ГДЗ Офлайн', 'Выберите свой класс', false);
    $('#bottomNav').classList.add('hidden');
    $('#topActions').innerHTML = '';

    content().innerHTML = `
    <div class="gradient-header">
        <h2>🎓 Мой класс</h2>
        <p>Выберите класс, чтобы видеть только свои учебники</p>
    </div>
    <div class="grade-select-grid">
        <button class="card grade-select-card" data-grade="7">
            <div class="grade-select-badge">7</div>
            <h3>7 класс</h3>
            <p>Показывать только учебники для 7 класса</p>
        </button>
        <button class="card grade-select-card" data-grade="8">
            <div class="grade-select-badge">8</div>
            <h3>8 класс</h3>
            <p>Показывать только учебники для 8 класса</p>
        </button>
    </div>`;

    $$('[data-grade]', content()).forEach(el => {
        el.addEventListener('click', () => {
            const grade = Number(el.dataset.grade);
            setSelectedGrade(grade);
            switchTab(currentTab || 'library');
        });
    });
}

// === Init ===
async function init() {
    db = new GdzDatabase();
    await db.open();

    // Tab clicks
    $$('.nav-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            currentScreen = null;
            switchTab(btn.dataset.tab);
        });
    });

    // Back button
    $('#backBtn').addEventListener('click', goBack);

    // Image overlay — close on bg click and close button
    const overlay = $('#imageOverlay');
    const overlayImg = $('#overlayImage');
    $('#closeOverlay').addEventListener('click', () => overlay.classList.add('hidden'));
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.add('hidden');
    });
    // Double-tap to zoom image in overlay
    let overlayScale = 1;
    overlayImg.addEventListener('dblclick', () => {
        overlayScale = overlayScale > 1 ? 1 : 2.5;
        overlayImg.style.transform = `scale(${overlayScale})`;
    });
    // Reset zoom when overlay closes
    const resetOverlay = () => { overlayScale = 1; overlayImg.style.transform = ''; };
    $('#closeOverlay').addEventListener('click', resetOverlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) resetOverlay(); });

    // Register SW
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // Hardware/browser back button support
    window.addEventListener('popstate', () => {
        if (currentScreen) {
            goBack();
        }
    });

    switchTab('library');

    // Auto-bootstrap bundled data on first launch
    if (!localStorage.getItem(BOOTSTRAP_KEY)) {
        await bootstrapBundledData();
    }
}

async function bootstrapBundledData() {
    showToast('Загрузка данных...');
    let totalImported = 0;
    for (const asset of BUNDLED_ASSETS) {
        try {
            const resp = await fetch(asset);
            if (!resp.ok) continue;
            const text = await resp.text();
            const normalized = normalizeJson(text);
            const payload = JSON.parse(normalized);
            const result = await db.importPayload(payload);
            totalImported += result.importedTasks;
        } catch (e) {
            console.warn('Bootstrap failed for', asset, e);
        }
    }
    localStorage.setItem(BOOTSTRAP_KEY, Date.now().toString());
    if (totalImported > 0) {
        showToast(`Загружено ${totalImported} заданий`);
        if (currentTab === 'library' && !currentScreen) renderLibrary();
    }
}

function switchTab(tab) {
    currentTab = tab;
    currentScreen = null;
    $$('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('#bottomNav').classList.remove('hidden');
    $('#backBtn').classList.add('hidden');
    $('#topActions').innerHTML = '';
    $('#topSubtitle').textContent = '';

    if (!getSelectedGrade()) {
        renderGradePicker();
        return;
    }

    switch (tab) {
        case 'library': renderLibrary(); break;
        case 'search': renderSearch(); break;
        case 'favorites': renderFavorites(); break;
        case 'history': renderHistory(); break;
        case 'more': renderMore(); break;
    }
}

function goBack() {
    if (currentScreen === 'solution') {
        if (currentTextbookId) {
            currentScreen = 'textbook';
            renderTextbookContent(currentTextbookId);
        } else {
            currentScreen = null;
            switchTab(currentTab);
        }
    } else if (currentScreen === 'textbook') {
        currentScreen = null;
        switchTab(currentTab);
    } else {
        switchTab(currentTab);
    }
}

function setTopBar(title, subtitle, showBack) {
    $('#topTitle').textContent = title;
    $('#topSubtitle').textContent = subtitle || '';
    $('#backBtn').classList.toggle('hidden', !showBack);
}

function showToast(msg) {
    const existing = $('.toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

// === Library Tab ===
async function renderLibrary() {
    const selectedGrade = getSelectedGrade();
    if (!selectedGrade) {
        renderGradePicker();
        return;
    }

    setTopBar('ГДЗ Офлайн', gradeSubtitle(), false);
    const subjects = await db.getSubjects();
    const textbooks = filterBySelectedGrade(await db.getTextbooks(), selectedGrade);
    const tasks = await db._all('tasks');

    const tbBySubject = {};
    for (const tb of textbooks) {
        (tbBySubject[tb.subjectId] = tbBySubject[tb.subjectId] || []).push(tb);
    }
    const taskCountByTb = {};
    for (const t of tasks) {
        taskCountByTb[t.textbookId] = (taskCountByTb[t.textbookId] || 0) + 1;
    }

    const visibleSubjects = subjects.filter(subject => (tbBySubject[subject.id] || []).length > 0);
    const sorted = visibleSubjects.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name));

    let html = `<div class="gradient-header"><h2>📚 Библиотека</h2><p>Все загруженные предметы и учебники</p></div>`;

    if (sorted.length === 0) {
        html += emptyCardHtml('📥', 'База пуста', 'Перейди во вкладку «Ещё» и импортируй JSON-файл с данными');
    } else {
        html += `<div class="section-title">Предметы</div>`;
        for (const subject of sorted) {
            const books = (tbBySubject[subject.id] || []).sort((a, b) => (a.partOrder || 0) - (b.partOrder || 0));
            const firstBook = books[0];
            if (!firstBook) continue;
            const totalTasks = books.reduce((sum, b) => sum + (taskCountByTb[b.id] || 0), 0);
            const icon = subjectIcon(subject.name);
            const color = subjectColor(subject.name);
            const meta = [firstBook.authors, firstBook.year, totalTasks > 0 ? `${totalTasks} заданий` : null].filter(Boolean).join(' • ');

            html += `
            <div class="card subject-card" data-book-id="${firstBook.id}">
                <div class="card-body">
                    <div class="subject-header">
                        <div class="subject-icon" style="background:${color}20;color:${color}">${icon}</div>
                        <div class="subject-info">
                            <h3>${esc(subject.name)}</h3>
                            <div class="book-title">${esc(firstBook.title)}</div>
                            ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
                        </div>
                    </div>
                    <button class="btn-tonal" data-book-id="${firstBook.id}">Открыть учебник</button>
                </div>
            </div>`;
        }
    }

    content().innerHTML = html;

    // Click handlers
    $$('.subject-card, .btn-tonal[data-book-id]', content()).forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const bookId = parseInt(el.dataset.bookId || el.closest('[data-book-id]')?.dataset.bookId);
            if (bookId) openTextbook(bookId);
        });
    });
}

async function openTextbook(textbookId) {
    currentScreen = 'textbook';
    currentTextbookId = textbookId;
    history.pushState({ screen: 'textbook', id: textbookId }, '');
    await renderTextbookContent(textbookId);
}

async function renderTextbookContent(textbookId) {
    const tb = await db.getTextbook(textbookId);
    if (!tb) { showToast('Учебник не найден'); return; }
    if (!matchesSelectedGrade(tb)) {
        currentScreen = null;
        currentTextbookId = null;
        showToast('Этот учебник скрыт для выбранного класса');
        switchTab('library');
        return;
    }

    const subjects = await db.getSubjects();
    const subject = subjects.find(s => s.id === tb.subjectId);
    const subtitle = [tb.partTitle, tb.authors, tb.year].filter(Boolean).join(' • ');

    setTopBar(tb.seriesTitle || tb.title, subtitle, true);
    $('#bottomNav').classList.add('hidden');

    const tasks = await db.getTasksByTextbook(textbookId);
    const primaryMode = tb.searchMode === 'paragraph' ? 'paragraph' : 'taskNumber';
    tasks.sort((a, b) => {
        const primaryCompare = compareNaturalLabels(a[primaryMode], b[primaryMode]);
        if (primaryCompare !== 0) return primaryCompare;

        const secondaryMode = primaryMode === 'paragraph' ? 'taskNumber' : 'paragraph';
        const secondaryCompare = compareNaturalLabels(a[secondaryMode], b[secondaryMode]);
        if (secondaryCompare !== 0) return secondaryCompare;

        const pageCompare = compareNullableNumbers(a.page, b.page);
        if (pageCompare !== 0) return pageCompare;

        return compareNullableNumbers(a.id, b.id);
    });

    solutionContext = tasks.map(t => t.id);

    let html = `<div class="results-count">${tasks.length} заданий</div>`;

    const displayed = tasks.slice(0, 50);
    const hasMore = tasks.length > 50;

    for (let i = 0; i < displayed.length; i++) {
        const task = displayed[i];
        const paraLabel = task.paragraph ? `§ ${task.paragraph.replace(/^§\s*/, '')}` : null;
        const numLabel = paraLabel || task.title || `Задание ${i + 1}`;
        const paraNum = task.paragraph ? task.paragraph.replace(/^§\s*/, '') : (i + 1).toString();

        html += `
        <div class="card para-card" data-task-id="${task.id}">
            <div class="card-body">
                <div class="para-num">${esc(paraNum.substring(0, 4))}</div>
                <div class="para-info">
                    <h4>${esc(numLabel)}</h4>
                    ${task.title && task.paragraph ? `<div class="para-title">${esc(task.title)}</div>` : ''}
                    <div class="para-preview">${esc(task.previewText)}</div>
                </div>
                <div class="para-arrow">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                </div>
            </div>
        </div>`;
    }

    if (hasMore) {
        html += `<button class="show-more-btn" id="showAllBtn">Показать все (ещё ${tasks.length - 50})</button>`;
    }

    content().innerHTML = html;

    // Use event delegation for task card clicks
    content().addEventListener('click', (e) => {
        const card = e.target.closest('.para-card');
        if (card) openSolution(parseInt(card.dataset.taskId));
    });

    const showAllBtn = $('#showAllBtn');
    if (showAllBtn) {
        showAllBtn.addEventListener('click', () => {
            let extra = '';
            for (let i = 50; i < tasks.length; i++) {
                const task = tasks[i];
                const paraLabel = task.paragraph ? `§ ${task.paragraph.replace(/^§\s*/, '')}` : null;
                const numLabel = paraLabel || task.title || `Задание ${i + 1}`;
                const paraNum = task.paragraph ? task.paragraph.replace(/^§\s*/, '') : (i + 1).toString();
                extra += `
                <div class="card para-card" data-task-id="${task.id}">
                    <div class="card-body">
                        <div class="para-num">${esc(paraNum.substring(0, 4))}</div>
                        <div class="para-info">
                            <h4>${esc(numLabel)}</h4>
                            ${task.title && task.paragraph ? `<div class="para-title">${esc(task.title)}</div>` : ''}
                            <div class="para-preview">${esc(task.previewText)}</div>
                        </div>
                        <div class="para-arrow">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </div>
                    </div>
                </div>`;
            }
            showAllBtn.remove();
            content().insertAdjacentHTML('beforeend', extra);
        });
    }
}

// === Solution Screen ===
async function openSolution(taskId) {
    currentScreen = 'solution';
    currentTaskId = taskId;
    history.pushState({ screen: 'solution', id: taskId }, '');
    const task = await db.getTask(taskId);
    if (!task) { showToast('Задание не найдено'); return; }

    const tb = await db.getTextbook(task.textbookId);
    if (!matchesSelectedGrade(tb)) {
        showToast('Это решение скрыто для выбранного класса');
        goBack();
        return;
    }
    const subjects = await db.getSubjects();
    const subject = subjects.find(s => s.id === tb?.subjectId);

    // Add to history
    await db.addHistory(taskId);

    const displayTitle = task.title
        || (task.paragraph ? `§ ${task.paragraph.replace(/^§\s*/, '')}` : null)
        || (task.taskNumber ? `№ ${task.taskNumber}` : null)
        || (task.page ? `Стр. ${task.page}` : null)
        || 'Решение';

    const subtitle = [tb?.seriesTitle || tb?.title, tb?.partTitle, subject?.name].filter(Boolean).join(' • ');

    setTopBar(displayTitle, subtitle, true);
    $('#bottomNav').classList.add('hidden');

    // Top actions: prev/next + favorite
    const ctxIdx = solutionContext.indexOf(taskId);
    const hasPrev = ctxIdx > 0;
    const hasNext = ctxIdx >= 0 && ctxIdx < solutionContext.length - 1;
    const isFav = await db.isFavorite(taskId);

    let actions = '<div class="solution-nav">';
    if (hasPrev) actions += `<button class="icon-btn" id="prevTask" title="Предыдущее"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>`;
    if (hasNext) actions += `<button class="icon-btn" id="nextTask" title="Следующее"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></button>`;
    actions += `<button class="icon-btn fav-btn${isFav ? ' danger' : ''}" id="favBtn" title="Избранное">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
        </svg>
    </button>`;
    actions += '</div>';
    $('#topActions').innerHTML = actions;

    // Parse solution
    const parsed = parseSolution(task.solutionText);
    const edition = parsed.editions[0];

    let html = `
    <div class="card solution-hero">
        <h2>${esc(displayTitle)}</h2>
        <div class="hero-meta">${esc(subtitle)}</div>
        <div class="hero-chips">
            ${task.paragraph ? `<span class="chip chip-secondary">§ ${esc(task.paragraph.replace(/^§\s*/, ''))}</span>` : ''}
            ${task.page ? `<span class="chip chip-primary">Стр. ${task.page}</span>` : ''}
            ${task.taskNumber ? `<span class="chip chip-primary">№ ${esc(task.taskNumber)}</span>` : ''}
        </div>
    </div>`;

    if (edition.headerInfo) {
        html += `<div style="background:rgba(21,101,192,0.06);border-radius:12px;padding:12px;font-size:13px;color:var(--primary);font-weight:500">${esc(edition.headerInfo)}</div>`;
    }

    // Edition tabs if multiple
    if (parsed.editions.length > 1) {
        html += `<div class="chips-row">`;
        parsed.editions.forEach((ed, i) => {
            html += `<button class="filter-chip edition-chip${i === 0 ? ' active' : ''}" data-edition="${i}">${esc(ed.name)}</button>`;
        });
        html += `</div>`;
    }

    html += renderEditionSections(edition);

    content().innerHTML = html;

    // Event handlers
    const prevBtn = $('#prevTask');
    if (prevBtn) prevBtn.addEventListener('click', () => openSolution(solutionContext[ctxIdx - 1]));
    const nextBtn = $('#nextTask');
    if (nextBtn) nextBtn.addEventListener('click', () => openSolution(solutionContext[ctxIdx + 1]));

    const favBtn = $('#favBtn');
    if (favBtn) favBtn.addEventListener('click', async () => {
        const nowFav = await db.toggleFavorite(taskId);
        favBtn.classList.toggle('danger', nowFav);
        favBtn.querySelector('svg').setAttribute('fill', nowFav ? 'currentColor' : 'none');
        showToast(nowFav ? 'Добавлено в избранное' : 'Удалено из избранного');
    });

    // Edition tabs
    $$('.edition-chip', content()).forEach(chip => {
        chip.addEventListener('click', () => {
            $$('.edition-chip', content()).forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            const idx = parseInt(chip.dataset.edition);
            const ed = parsed.editions[idx];
            const sectionsContainer = $('#solutionSections');
            if (sectionsContainer && ed) sectionsContainer.innerHTML = renderEditionSectionsInner(ed);
            bindImageClicks();
        });
    });

    bindImageClicks();
}

function renderEditionSections(edition) {
    return `<div id="solutionSections">${renderEditionSectionsInner(edition)}</div>`;
}

function renderEditionSectionsInner(edition) {
    let html = '';
    for (const section of edition.sections) {
        html += `<div class="solution-section">`;
        if (section.title) html += `<h3>${esc(section.title)}</h3>`;
        html += renderSectionContent(section);
        html += `</div>`;
    }
    return html;
}

function renderSectionContent(section) {
    const structured = buildQuestionStructure(section);
    if (!structured) {
        return renderBlocks(section.blocks);
    }

    let html = '';
    if (structured.introBlocks.length) {
        html += renderBlocks(structured.introBlocks);
    }

    for (const group of structured.groups) {
        html += `
        <div class="question-group">
            <div class="question-prompt">${renderInlineMarkdown(group.prompt.text)}</div>
            ${group.answerBlocks.length ? `<div class="question-answer">${renderBlocks(group.answerBlocks)}</div>` : ''}
        </div>`;
    }

    return html;
}

function buildQuestionStructure(section) {
    const blocks = Array.isArray(section?.blocks) ? section.blocks : [];
    if (!blocks.length) return null;

    const normalizedTitle = normalizeHeader(section?.title || '');
    const introBlocks = [];
    const groups = [];
    let currentGroup = null;

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        const isPrompt = block.type === 'numbered_item'
            || (normalizedTitle === 'Вопрос' && groups.length === 0 && introBlocks.length === 0 && isQuestionTextBlock(block));

        if (isPrompt) {
            const splitPrompt = splitQuestionPromptAndAnswer(block.text);
            currentGroup = {
                prompt: {
                    type: 'question_prompt',
                    text: splitPrompt?.prompt || block.text || ''
                },
                answerBlocks: splitPrompt?.answer ? [{ type: 'paragraph', text: splitPrompt.answer }] : []
            };
            groups.push(currentGroup);
            continue;
        }

        if (currentGroup) {
            currentGroup.answerBlocks.push(block);
        } else {
            introBlocks.push(block);
        }
    }

    return groups.length ? { introBlocks, groups } : null;
}

function isQuestionTextBlock(block) {
    return ['paragraph', 'emphasis', 'header', 'numbered_item'].includes(block?.type);
}

function splitQuestionPromptAndAnswer(text) {
    const raw = (text || '').trim();
    if (!raw) return null;

    const numberedMatch = raw.match(/^((?:\d+[.)]|[а-яa-z]\))\s*)(.+)$/i);
    const prefix = numberedMatch ? numberedMatch[1] : '';
    const body = numberedMatch ? numberedMatch[2].trim() : raw;

    const sentences = body.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(item => item.trim()).filter(Boolean) || [];
    if (sentences.length < 2) return null;

    let prompt = '';
    let best = null;

    for (let index = 0; index < sentences.length - 1; index += 1) {
        prompt = `${prompt}${prompt ? ' ' : ''}${sentences[index]}`.trim();
        const answer = sentences.slice(index + 1).join(' ').trim();
        if (!answer || answer.length < 35) continue;

        const promptLooksLikeQuestion = looksLikeQuestionPrompt(prompt);
        const answerLooksLikeQuestion = looksLikeQuestionPrompt(answer);
        if (promptLooksLikeQuestion && !answerLooksLikeQuestion) {
            best = {
                prompt: `${prefix}${prompt}`.trim(),
                answer
            };
            break;
        }
    }

    return best;
}

function looksLikeQuestionPrompt(text) {
    const sample = (text || '').trim();
    if (!sample) return false;
    if (sample.includes('?')) return true;

    return /\b(что|как|почему|зачем|какие?|какой|какова?|сколько|когда|где|кто|чем|объясните|сравните|охарактеризуйте|запишите|подготовьте|посмотрите|вспомните|сформулируйте|опишите|приведите|назовите|укажите|определите|рассмотрите|сделайте|вычислите|перечислите)\b/i.test(sample);
}

function renderBlocks(blocks) {
    let html = '';
    for (const block of blocks) {
        switch (block.type) {
            case 'image':
                const src = resolveImageUrl(block.source);
                html += `<div class="block-image"><img src="${src.replace(/"/g, '&quot;')}" alt="${esc(block.alt || 'Решение')}" loading="lazy" onerror="this.style.display='none';this.parentElement.classList.add('image-error')"></div>`;
                break;
            case 'table':
                html += renderTable(block.text);
                break;
            case 'header':
                html += `<div class="block-header">${renderInlineMarkdown(block.text)}</div>`;
                break;
            case 'emphasis':
                html += `<div class="block-emphasis">${renderInlineMarkdown(block.text)}</div>`;
                break;
            case 'bullet_item':
                html += `<div class="block-bullet">${renderInlineMarkdown(block.text)}</div>`;
                break;
            case 'numbered_item':
                html += `<div class="block-numbered">${renderInlineMarkdown(block.text)}</div>`;
                break;
            default:
                html += `<div class="block-paragraph">${renderInlineMarkdown(block.text)}</div>`;
        }
    }
    return html;
}

function renderTable(tableText) {
    if (!tableText) return '';
    const lines = tableText.split('\n').map(l => l.trim()).filter(Boolean);

    let rows;
    if (lines[0] && lines[0].startsWith('|')) {
        // Markdown table
        rows = lines
            .filter((line, i) => !(i === 1 && /^\|\s*:?-{3,}/.test(line)))
            .map(line => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
    } else {
        rows = lines.map(line => line.split('\t').map(c => c.trim()));
    }

    if (!rows.length) return '';
    let html = '<div class="block-table"><table>';
    rows.forEach((row, i) => {
        html += '<tr>';
        row.forEach(cell => {
            html += i === 0 ? `<th>${esc(cell)}</th>` : `<td>${esc(cell)}</td>`;
        });
        html += '</tr>';
    });
    html += '</table></div>';
    return html;
}

function bindImageClicks() {
    // Use event delegation to avoid duplicate listeners on edition switch
    const cont = content();
    if (cont._imgClickHandler) cont.removeEventListener('click', cont._imgClickHandler);
    cont._imgClickHandler = (e) => {
        const img = e.target.closest('.block-image img');
        if (img && !img.closest('.image-error')) {
            $('#overlayImage').src = img.src;
            $('#imageOverlay').classList.remove('hidden');
        }
    };
    cont.addEventListener('click', cont._imgClickHandler);
}

// === Search Tab ===
async function renderSearch() {
    const selectedGrade = getSelectedGrade();
    if (!selectedGrade) {
        renderGradePicker();
        return;
    }

    setTopBar('ГДЗ Офлайн', gradeSubtitle(), false);
    const textbooks = filterBySelectedGrade(await db.getTextbooks(), selectedGrade);
    const visibleSubjectIds = new Set(textbooks.map(tb => tb.subjectId));
    const subjects = (await db.getSubjects()).filter(subject => visibleSubjectIds.has(subject.id));

    let html = `
    <div class="search-input-wrap">
        <div class="search-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg></div>
        <input type="text" class="search-input" id="searchInput" placeholder="Номер, параграф, страница..." autocomplete="off">
        <button class="icon-btn search-clear hidden" id="searchClear"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    </div>`;

    if (subjects.length > 1) {
        html += `<div class="chips-row" id="subjectFilter">
            <button class="filter-chip active" data-subject="">Все</button>
            ${subjects.map(s => `<button class="filter-chip" data-subject="${s.id}">${esc(s.name)}</button>`).join('')}
        </div>`;
    }

    html += `<div id="searchResults"></div>`;

    content().innerHTML = html;

    const input = $('#searchInput');
    const clearBtn = $('#searchClear');
    let selectedSubject = null;

    input.addEventListener('input', () => {
        clearBtn.classList.toggle('hidden', !input.value);
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => doSearch(input.value, selectedSubject), 300);
    });

    clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.classList.add('hidden');
        $('#searchResults').innerHTML = emptyCardHtml('🔍', 'Начните поиск', 'Введите номер задания, параграф или страницу');
    });

    $$('.filter-chip', $('#subjectFilter'))?.forEach(chip => {
        chip.addEventListener('click', () => {
            $$('.filter-chip', $('#subjectFilter')).forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            selectedSubject = chip.dataset.subject ? parseInt(chip.dataset.subject) : null;
            if (input.value) doSearch(input.value, selectedSubject);
        });
    });

    $('#searchResults').innerHTML = emptyCardHtml('🔍', 'Начните поиск', 'Введите номер задания, параграф или страницу');
    input.focus();
}

async function doSearch(query, subjectId) {
    const resultsDiv = $('#searchResults');
    if (!resultsDiv) return;

    if (!query.trim()) {
        resultsDiv.innerHTML = emptyCardHtml('🔍', 'Начните поиск', 'Введите номер задания, параграф или страницу');
        return;
    }

    const results = filterBySelectedGrade(await db.searchTasks(query, subjectId));

    if (results.length === 0) {
        resultsDiv.innerHTML = emptyCardHtml('🔍', 'Ничего не найдено', 'Попробуйте другой запрос');
        return;
    }

    solutionContext = results.map(t => t.id);
    let html = `<div class="results-count">Найдено: ${results.length}</div>`;
    html += results.map(t => taskItemHtml(t)).join('');
    resultsDiv.innerHTML = html;
    bindTaskItems(resultsDiv);
}

// === Favorites Tab ===
async function renderFavorites() {
    const selectedGrade = getSelectedGrade();
    if (!selectedGrade) {
        renderGradePicker();
        return;
    }

    setTopBar('ГДЗ Офлайн', gradeSubtitle(), false);
    const favorites = filterBySelectedGrade(await db.getFavorites(), selectedGrade);

    let html = `<div class="gradient-header"><h2>❤️ Избранное</h2><p>${favorites.length} заданий</p></div>`;

    if (favorites.length === 0) {
        html += emptyCardHtml('❤️', 'Пока пусто', 'Нажмите ❤ на любом задании, чтобы добавить в избранное');
    } else {
        solutionContext = favorites.map(t => t.id);
        html += favorites.map(t => taskItemHtml(t)).join('');
    }

    content().innerHTML = html;
    bindTaskItems(content());
}

// === History Tab ===
async function renderHistory() {
    const selectedGrade = getSelectedGrade();
    if (!selectedGrade) {
        renderGradePicker();
        return;
    }

    setTopBar('ГДЗ Офлайн', gradeSubtitle(), false);
    const history = filterBySelectedGrade(await db.getHistory(), selectedGrade);

    let html = `<div class="gradient-header"><h2>🕐 История</h2><p>Последние просмотренные</p></div>`;

    if (history.length === 0) {
        html += emptyCardHtml('🕐', 'Пока пусто', 'Здесь появятся просмотренные задания');
    } else {
        solutionContext = history.map(t => t.id);
        html += history.map(t => {
            const date = t.viewedAt ? new Date(t.viewedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
            return taskItemHtml(t, date);
        }).join('');

        html += `<button class="btn-danger" id="clearHistoryBtn" style="margin-top:8px">Очистить историю</button>`;
    }

    content().innerHTML = html;
    bindTaskItems(content());

    const clearBtn = $('#clearHistoryBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            await db.clearHistory();
            renderHistory();
            showToast('История очищена');
        });
    }
}

// === More Tab ===
async function renderMore() {
    const selectedGrade = getSelectedGrade();
    if (!selectedGrade) {
        renderGradePicker();
        return;
    }

    setTopBar('ГДЗ Офлайн', gradeSubtitle(), false);
    const subjects = await db.getSubjects();
    const textbooks = filterBySelectedGrade(await db.getTextbooks(), selectedGrade);
    const favorites = filterBySelectedGrade(await db.getFavorites(), selectedGrade);
    const visibleSubjectCount = new Set(textbooks.map(tb => tb.subjectId)).size;

    let html = `
    <div class="gradient-header"><h2>⚙️ Настройки</h2><p>Управление данными</p></div>

    <div class="card import-section">
        <h3>🎓 Мой класс</h3>
        <p>Сейчас выбран: ${selectedGrade} класс</p>
        <button class="btn-tonal" id="changeGradeBtn">Сменить класс</button>
    </div>

    <div class="stats-row">
        <div class="card stat-card"><div class="stat-value">${visibleSubjectCount}</div><div class="stat-label">Предметов</div></div>
        <div class="card stat-card"><div class="stat-value">${textbooks.length}</div><div class="stat-label">Учебников</div></div>
        <div class="card stat-card"><div class="stat-value">${favorites.length}</div><div class="stat-label">Избранных</div></div>
    </div>

    <div class="card import-section">
        <h3>📥 Импорт данных</h3>
        <p>Загрузите JSON-файл с данными ГДЗ (тот же формат, что и для Android-версии)</p>
        <input type="file" id="jsonFileInput" class="file-input" accept=".json,.txt,application/json,text/plain,*/*">
        <button class="btn-primary" id="importBtn">Выбрать JSON-файл</button>
    </div>`;

    if (textbooks.length > 0) {
        html += `<div class="card" style="padding:16px"><h3 style="font-size:15px;font-weight:600;margin-bottom:10px">📖 Управление учебниками</h3>`;
        for (const tb of textbooks) {
            const subject = subjects.find(s => s.id === tb.subjectId);
            const tasks = await db.getTasksByTextbook(tb.id);
            html += `
            <div class="textbook-manage-card" style="border-bottom:1px solid var(--outline)">
                <div class="textbook-manage-info">
                    <h4>${esc(tb.title)}</h4>
                    <p>${esc(subject?.name || '')} • ${tasks.length} заданий</p>
                </div>
                <button class="btn-small-danger" data-delete-tb="${tb.id}">Удалить</button>
            </div>`;
        }
        html += `</div>`;

        html += `<button class="btn-danger" id="clearAllBtn">🗑 Удалить все данные</button>`;
    }

    html += `
    <div class="card import-section">
        <h3>� Изображения для оффлайна</h3>
        <p>Скачайте все изображения решений, чтобы они работали без интернета</p>
        <div id="downloadProgress" class="download-progress hidden">
            <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
            <div class="progress-text" id="progressText">0 / 0</div>
        </div>
        <button class="btn-primary" id="downloadImagesBtn">Скачать изображения</button>
    </div>

    <div class="card import-section">
        <h3>🔄 Перезагрузить встроенные данные</h3>
        <p>Если данные не загрузились автоматически</p>
        <button class="btn-tonal" id="reloadBundledBtn">Загрузить заново</button>
    </div>

    <div class="card" style="padding:16px;text-align:center;margin-top:8px">
        <p style="font-size:12px;color:var(--on-surface-variant)">ГДЗ Офлайн PWA v1.1</p>
        <p style="font-size:11px;color:var(--on-surface-variant);opacity:0.7">Веб-версия для iPhone/iPad</p>
    </div>`;

    content().innerHTML = html;

    const changeGradeBtn = $('#changeGradeBtn');
    if (changeGradeBtn) {
        changeGradeBtn.addEventListener('click', () => {
            clearSelectedGrade();
            renderGradePicker();
        });
    }

    // Import handler
    const fileInput = $('#jsonFileInput');
    $('#importBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const normalized = normalizeJson(text);
            const payload = JSON.parse(normalized);
            const result = await db.importPayload(payload);
            showToast(`Импорт: +${result.addedSubjects} предм., +${result.addedTextbooks} учебн., ${result.importedTasks} заданий`);
            renderMore();
        } catch (err) {
            showToast('Ошибка импорта: ' + (err.message || 'Неверный формат'));
        }
        fileInput.value = '';
    });

    // Delete textbook handlers
    $$('[data-delete-tb]', content()).forEach(btn => {
        btn.addEventListener('click', () => {
            showConfirm('Удалить этот учебник и все его задания?', async () => {
                await db.deleteTextbook(parseInt(btn.dataset.deleteTb));
                showToast('Учебник удалён');
                renderMore();
            });
        });
    });

    // Clear all
    const clearAllBtn = $('#clearAllBtn');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', () => {
            showConfirm('Удалить ВСЕ данные? Это действие необратимо.', async () => {
                await db.clearAll();
                localStorage.removeItem(BOOTSTRAP_KEY);
                showToast('Все данные удалены');
                renderMore();
            });
        });
    }

    // Download images for offline
    const dlImgBtn = $('#downloadImagesBtn');
    if (dlImgBtn) {
        dlImgBtn.addEventListener('click', async () => {
            dlImgBtn.disabled = true;
            dlImgBtn.textContent = 'Подготовка...';
            try {
                await downloadAllImagesForOffline();
            } catch (e) {
                showToast('Ошибка загрузки: ' + (e.message || e));
            }
            dlImgBtn.disabled = false;
            dlImgBtn.textContent = 'Скачать изображения';
        });
    }

    // Reload bundled data
    const reloadBtn = $('#reloadBundledBtn');
    if (reloadBtn) {
        reloadBtn.addEventListener('click', async () => {
            localStorage.removeItem(BOOTSTRAP_KEY);
            await bootstrapBundledData();
            renderMore();
        });
    }
}

async function getAllImageUrls() {
    const tasks = await db._all('tasks');
    const IMAGE_RE = /!\[.*?\]\((.+?)\)/g;
    const urls = new Set();
    for (const task of tasks) {
        const text = task.solutionText || '';
        let m;
        while ((m = IMAGE_RE.exec(text)) !== null) {
            const resolved = resolveImageUrl(m[1].trim());
            if (resolved && !resolved.startsWith('http')) {
                urls.add(resolved);
            }
        }
    }
    return [...urls];
}

async function downloadAllImagesForOffline() {
    const urls = await getAllImageUrls();
    if (urls.length === 0) {
        showToast('Нет изображений для загрузки');
        return;
    }

    const progressDiv = $('#downloadProgress');
    const progressFill = $('#progressFill');
    const progressText = $('#progressText');
    if (progressDiv) progressDiv.classList.remove('hidden');

    const cache = await caches.open(OFFLINE_CACHE_NAME);
    let done = 0, failed = 0, skipped = 0;
    const total = urls.length;

    // Check which are already cached
    const uncached = [];
    for (const url of urls) {
        const cached = await cache.match(url);
        if (cached) {
            skipped++;
        } else {
            uncached.push(url);
        }
    }

    if (uncached.length === 0) {
        showToast(`Все ${total} изображений уже скачаны!`);
        if (progressDiv) progressDiv.classList.add('hidden');
        return;
    }

    done = skipped;
    const updateProgress = () => {
        const pct = Math.round((done / total) * 100);
        if (progressFill) progressFill.style.width = pct + '%';
        if (progressText) progressText.textContent = `${done} / ${total}` + (failed > 0 ? ` (ошибок: ${failed})` : '');
    };
    updateProgress();

    // Download in batches of 6
    const BATCH = 6;
    for (let i = 0; i < uncached.length; i += BATCH) {
        const batch = uncached.slice(i, i + BATCH);
        await Promise.all(batch.map(async (url) => {
            try {
                const resp = await fetch(url);
                if (resp.ok) {
                    await cache.put(url, resp);
                } else {
                    failed++;
                }
            } catch {
                failed++;
            }
            done++;
            updateProgress();
        }));
    }

    showToast(`Готово! Скачано: ${done - skipped - failed}, ошибок: ${failed}`);
    if (progressDiv) setTimeout(() => progressDiv.classList.add('hidden'), 3000);
}

// === Helpers ===
function subjectIcon(name) {
    switch ((name || '').trim().toLowerCase()) {
        case 'биология': return '🧬';
        case 'география': return '🌍';
        case 'геометрия': return '📐';
        case 'химия': return '🧪';
        case 'алгебра': return '📊';
        case 'физика': return '⚡';
        case 'русский язык': return '📝';
        case 'английский язык': return '🇬🇧';
        default: return '📖';
    }
}

function subjectColor(name) {
    switch ((name || '').trim().toLowerCase()) {
        case 'биология': return '#4CAF50';
        case 'география': return '#FF9800';
        case 'геометрия': return '#9C27B0';
        case 'химия': return '#F44336';
        case 'алгебра': return '#1565C0';
        case 'физика': return '#FF5722';
        default: return '#1565C0';
    }
}

function emptyCardHtml(icon, title, subtitle) {
    return `<div class="card empty-card"><div style="font-size:48px;opacity:0.4;margin-bottom:8px">${icon}</div><h3>${esc(title)}</h3><p>${esc(subtitle)}</p></div>`;
}

function taskItemHtml(task, extraInfo) {
    const title = task.title
        || (task.paragraph ? `§ ${task.paragraph.replace(/^§\s*/, '')}` : null)
        || (task.taskNumber ? `№ ${task.taskNumber}` : null)
        || 'Задание';
    const meta = [task.seriesTitle || task.textbookTitle, task.partTitle].filter(Boolean).join(' • ');

    return `
    <div class="card task-item" data-task-id="${task.id}">
        <div class="card-body">
            <div class="task-item-header">
                <div class="task-chips">
                    <span class="chip chip-primary">${esc(task.subjectName || '')}</span>
                    ${task.partTitle ? `<span class="chip chip-secondary">${esc(task.partTitle)}</span>` : ''}
                </div>
            </div>
            <h4>${esc(title)}</h4>
            <div class="task-meta">${esc(meta)}</div>
            <div class="task-preview">${esc(task.previewText || '')}</div>
            ${extraInfo ? `<div class="history-date">${esc(extraInfo)}</div>` : ''}
        </div>
    </div>`;
}

function bindTaskItems(container) {
    $$('.task-item', container).forEach(el => {
        el.addEventListener('click', () => {
            const taskId = parseInt(el.dataset.taskId);
            if (taskId) openSolution(taskId);
        });
    });
}

function normalizeJson(raw) {
    let text = raw.trim();
    if (text.startsWith('\uFEFF')) text = text.substring(1);
    // Handle double-encoded JSON
    if (text.startsWith('"') && text.endsWith('"')) {
        try {
            const decoded = JSON.parse(text);
            if (typeof decoded === 'string') text = decoded.trim();
            if (text.startsWith('\uFEFF')) text = text.substring(1);
        } catch (e) { /* ignore */ }
    }
    return text;
}

function showConfirm(message, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
    <div class="dialog-box">
        <p>${esc(message)}</p>
        <div class="dialog-actions">
            <button class="dialog-cancel">Отмена</button>
            <button class="dialog-confirm">Удалить</button>
        </div>
    </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('.dialog-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.dialog-confirm').addEventListener('click', () => {
        overlay.remove();
        onConfirm();
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// === Start app ===
document.addEventListener('DOMContentLoaded', init);
