/* db.js — IndexedDB storage layer for OfflineGDZ PWA */
const DB_NAME = 'offlinegdz';
const DB_VERSION = 1;

class GdzDatabase {
    constructor() {
        this._db = null;
    }

    open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('subjects')) {
                    const s = db.createObjectStore('subjects', { keyPath: 'id', autoIncrement: true });
                    s.createIndex('name', 'name', { unique: true });
                }
                if (!db.objectStoreNames.contains('textbooks')) {
                    const t = db.createObjectStore('textbooks', { keyPath: 'id', autoIncrement: true });
                    t.createIndex('subjectId', 'subjectId');
                    t.createIndex('seriesTitle', 'seriesTitle');
                }
                if (!db.objectStoreNames.contains('tasks')) {
                    const tk = db.createObjectStore('tasks', { keyPath: 'id', autoIncrement: true });
                    tk.createIndex('textbookId', 'textbookId');
                    tk.createIndex('taskNumber', 'taskNumber');
                    tk.createIndex('paragraph', 'paragraph');
                    tk.createIndex('page', 'page');
                    tk.createIndex('textbook_taskNumber', ['textbookId', 'taskNumber']);
                    tk.createIndex('textbook_paragraph', ['textbookId', 'paragraph']);
                    tk.createIndex('textbook_page', ['textbookId', 'page']);
                }
                if (!db.objectStoreNames.contains('favorites')) {
                    const f = db.createObjectStore('favorites', { keyPath: 'id', autoIncrement: true });
                    f.createIndex('taskId', 'taskId', { unique: true });
                    f.createIndex('addedAt', 'addedAt');
                }
                if (!db.objectStoreNames.contains('history')) {
                    const h = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
                    h.createIndex('taskId', 'taskId', { unique: true });
                    h.createIndex('viewedAt', 'viewedAt');
                }
            };
            req.onsuccess = (e) => { this._db = e.target.result; resolve(this); };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    _tx(stores, mode) {
        const tx = this._db.transaction(stores, mode);
        return stores.length === 1 ? tx.objectStore(stores[0]) : stores.map(s => tx.objectStore(s));
    }

    _req(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    _all(store) {
        return this._req(this._tx([store], 'readonly').getAll());
    }

    // === Subjects ===
    async getSubjects() {
        return this._all('subjects');
    }

    async getSubjectByName(name) {
        return this._req(this._tx(['subjects'], 'readonly').index('name').get(name));
    }

    // === Textbooks ===
    async getTextbooks() {
        return this._all('textbooks');
    }

    async getTextbooksBySubject(subjectId) {
        return this._req(this._tx(['textbooks'], 'readonly').index('subjectId').getAll(subjectId));
    }

    async getTextbook(id) {
        return this._req(this._tx(['textbooks'], 'readonly').get(id));
    }

    // === Tasks ===
    async getTasksByTextbook(textbookId) {
        return this._req(this._tx(['tasks'], 'readonly').index('textbookId').getAll(textbookId));
    }

    async getTask(id) {
        return this._req(this._tx(['tasks'], 'readonly').get(id));
    }

    async searchTasks(query, subjectId) {
        const tasks = await this._all('tasks');
        const textbooks = await this._all('textbooks');
        const subjects = await this._all('subjects');
        const tbMap = Object.fromEntries(textbooks.map(t => [t.id, t]));
        const sjMap = Object.fromEntries(subjects.map(s => [s.id, s]));
        const q = query.toLowerCase().trim();
        const pageNum = parseInt(q, 10);

        return tasks.filter(task => {
            const tb = tbMap[task.textbookId];
            if (!tb) return false;
            if (subjectId && tb.subjectId !== subjectId) return false;
            if (task.taskNumber && task.taskNumber.toLowerCase().includes(q)) return true;
            if (task.paragraph && task.paragraph.toLowerCase().includes(q)) return true;
            if (!isNaN(pageNum) && task.page === pageNum) return true;
            if (task.title && task.title.toLowerCase().includes(q)) return true;
            if (q.length >= 3 && task.previewText && task.previewText.toLowerCase().includes(q)) return true;
            return false;
        }).slice(0, 200).map(task => {
            const tb = tbMap[task.textbookId];
            const sj = sjMap[tb?.subjectId];
            return { ...task, textbookTitle: tb?.title, subjectName: sj?.name, seriesTitle: tb?.seriesTitle, partTitle: tb?.partTitle, partOrder: tb?.partOrder };
        });
    }

    // === Favorites ===
    async getFavorites() {
        const favs = await this._all('favorites');
        favs.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        const result = [];
        for (const fav of favs) {
            const task = await this.getTask(fav.taskId);
            if (task) {
                const tb = await this.getTextbook(task.textbookId);
                const subjects = await this.getSubjects();
                const sj = subjects.find(s => s.id === tb?.subjectId);
                result.push({ ...task, textbookTitle: tb?.title, subjectName: sj?.name, seriesTitle: tb?.seriesTitle, partTitle: tb?.partTitle, partOrder: tb?.partOrder, favoriteId: fav.id });
            }
        }
        return result;
    }

    async isFavorite(taskId) {
        const result = await this._req(this._tx(['favorites'], 'readonly').index('taskId').get(taskId));
        return !!result;
    }

    toggleFavorite(taskId) {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(['favorites'], 'readwrite');
            const store = tx.objectStore('favorites');
            const getReq = store.index('taskId').get(taskId);
            getReq.onsuccess = () => {
                const existing = getReq.result;
                if (existing) {
                    const delReq = store.delete(existing.id);
                    delReq.onsuccess = () => resolve(false);
                    delReq.onerror = () => reject(delReq.error);
                } else {
                    const addReq = store.add({ taskId, addedAt: Date.now() });
                    addReq.onsuccess = () => resolve(true);
                    addReq.onerror = () => reject(addReq.error);
                }
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }

    // === History ===
    async getHistory() {
        const items = await this._all('history');
        items.sort((a, b) => (b.viewedAt || 0) - (a.viewedAt || 0));
        const result = [];
        for (const item of items.slice(0, 100)) {
            const task = await this.getTask(item.taskId);
            if (task) {
                const tb = await this.getTextbook(task.textbookId);
                const subjects = await this.getSubjects();
                const sj = subjects.find(s => s.id === tb?.subjectId);
                result.push({ ...task, textbookTitle: tb?.title, subjectName: sj?.name, seriesTitle: tb?.seriesTitle, partTitle: tb?.partTitle, partOrder: tb?.partOrder, viewedAt: item.viewedAt });
            }
        }
        return result;
    }

    addHistory(taskId) {
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(['history'], 'readwrite');
            const store = tx.objectStore('history');
            const getReq = store.index('taskId').get(taskId);
            getReq.onsuccess = () => {
                const existing = getReq.result;
                if (existing) {
                    existing.viewedAt = Date.now();
                    const putReq = store.put(existing);
                    putReq.onsuccess = () => resolve();
                    putReq.onerror = () => reject(putReq.error);
                } else {
                    const addReq = store.add({ taskId, viewedAt: Date.now() });
                    addReq.onsuccess = () => resolve();
                    addReq.onerror = () => reject(addReq.error);
                }
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }

    async clearHistory() {
        const store = this._tx(['history'], 'readwrite');
        await this._req(store.clear());
    }

    // === Import ===
    async importPayload(payload) {
        let addedSubjects = 0, addedTextbooks = 0, importedTasks = 0;

        for (const subject of payload.subjects) {
            const normalizedName = subject.name.trim();
            let subjectId;
            const existing = await this.getSubjectByName(normalizedName);
            if (existing) {
                subjectId = existing.id;
                if (existing.sortOrder !== (subject.sort_order || 0)) {
                    const store = this._tx(['subjects'], 'readwrite');
                    existing.sortOrder = subject.sort_order || 0;
                    await this._req(store.put(existing));
                }
            } else {
                const store = this._tx(['subjects'], 'readwrite');
                subjectId = await this._req(store.add({
                    name: normalizedName,
                    sortOrder: subject.sort_order || 0
                }));
                addedSubjects++;
            }

            for (const book of subject.textbooks) {
                const title = book.title?.trim() || '';
                const seriesTitle = book.series_title?.trim() || title;
                const partTitle = book.part_title?.trim() || null;
                const partOrder = book.part_order || 0;
                const searchMode = book.search_mode || 'number';

                // Check if textbook already exists
                const existingBooks = await this.getTextbooksBySubject(subjectId);
                const match = existingBooks.find(b =>
                    b.title === title || (b.seriesTitle === seriesTitle && b.partTitle === partTitle)
                );

                let textbookId;
                if (match) {
                    textbookId = match.id;
                    const store = this._tx(['textbooks'], 'readwrite');
                    match.title = title;
                    match.seriesTitle = seriesTitle;
                    match.partTitle = partTitle;
                    match.partOrder = partOrder;
                    match.authors = book.authors?.trim() || null;
                    match.year = book.year || null;
                    match.searchMode = searchMode;
                    await this._req(store.put(match));

                    // Delete existing tasks for re-import
                    const existingTasks = await this.getTasksByTextbook(textbookId);
                    const taskStore = this._tx(['tasks'], 'readwrite');
                    for (const t of existingTasks) {
                        await this._req(taskStore.delete(t.id));
                    }
                } else {
                    const store = this._tx(['textbooks'], 'readwrite');
                    textbookId = await this._req(store.add({
                        subjectId,
                        title,
                        seriesTitle,
                        partTitle,
                        partOrder,
                        authors: book.authors?.trim() || null,
                        year: book.year || null,
                        searchMode
                    }));
                    addedTextbooks++;
                }

                // Insert tasks
                if (book.tasks && book.tasks.length > 0) {
                    const taskStore = this._tx(['tasks'], 'readwrite');
                    for (const task of book.tasks) {
                        const previewText = buildPreviewText(task.solution_text || '', 120);
                        await this._req(taskStore.add({
                            textbookId,
                            taskNumber: task.task_number || null,
                            paragraph: task.paragraph || null,
                            page: task.page || null,
                            title: task.title || null,
                            solutionText: task.solution_text || '',
                            previewText,
                            createdAt: Date.now()
                        }));
                        importedTasks++;
                    }
                }
            }
        }

        return { addedSubjects, addedTextbooks, importedTasks };
    }

    // === Clear all data ===
    async clearAll() {
        for (const store of ['tasks', 'textbooks', 'subjects', 'favorites', 'history']) {
            const s = this._tx([store], 'readwrite');
            await this._req(s.clear());
        }
    }

    async deleteTextbook(textbookId) {
        // Get textbook info before deleting
        const tb = await this.getTextbook(textbookId);
        // Delete tasks and cleanup favorites/history
        const tasks = await this.getTasksByTextbook(textbookId);
        for (const t of tasks) {
            const taskStore = this._tx(['tasks'], 'readwrite');
            await this._req(taskStore.delete(t.id));
            // Clean up orphaned favorites and history
            try {
                const favStore = this._tx(['favorites'], 'readwrite');
                const fav = await this._req(favStore.index('taskId').get(t.id));
                if (fav) {
                    const favStore2 = this._tx(['favorites'], 'readwrite');
                    await this._req(favStore2.delete(fav.id));
                }
            } catch(e) {}
            try {
                const histStore = this._tx(['history'], 'readwrite');
                const hist = await this._req(histStore.index('taskId').get(t.id));
                if (hist) {
                    const histStore2 = this._tx(['history'], 'readwrite');
                    await this._req(histStore2.delete(hist.id));
                }
            } catch(e) {}
        }
        // Delete textbook
        const tbStore = this._tx(['textbooks'], 'readwrite');
        await this._req(tbStore.delete(textbookId));

        // Clean up subject if no more textbooks
        if (tb) {
            const remaining = await this.getTextbooksBySubject(tb.subjectId);
            if (remaining.length === 0) {
                const sjStore = this._tx(['subjects'], 'readwrite');
                await this._req(sjStore.delete(tb.subjectId));
            }
        }
    }
}

function buildPreviewText(solutionText, maxLength) {
    const text = solutionText
        .replace(/!\[.*?\]\(.*?\)/g, '')  // remove markdown images
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return 'Есть решение на изображении';
    return text.length > maxLength ? text.substring(0, maxLength).trimEnd() + '…' : text;
}
