/**
 * ST-AutoPulse Server Plugin
 * Manages timers and queues for character auto-messaging.
 * Runs in Node.js - persists even when the browser is closed.
 *
 * Данные хранятся отдельно для каждого пользователя SillyTavern:
 *   plugins/autopulse/users/<handle>/data.json
 *   plugins/autopulse/users/<handle>/queue.json
 *   plugins/autopulse/users/<handle>/jealousy-configs/<charId>.json
 */

const path = require('path');
const fs = require('fs');

const PLUGIN_DIR = path.join(__dirname);
const USERS_DIR = path.join(PLUGIN_DIR, 'users');
const DEFAULT_HANDLE = 'default-user';

// Допустимые идентификаторы. Всё, что попадает в путь к файлу или в ключ объекта,
// проходит через эти проверки.
const HANDLE_RE = /^[a-z0-9_-]{1,64}$/i;
const ID_RE = /^(?!(?:__proto__|constructor|prototype)$)[\w-]{1,64}$/;
const CHAR_ID_RE = /^\d{1,9}$/;

/** @type {Map<string, NodeJS.Timeout>} Active timers, key = `${handle}:${timerId}` */
const activeTimers = new Map();

/** @type {Map<string, Set<import('express').Response>>} Connected SSE clients per user */
const sseClients = new Map();

/** @type {Map<string, Array<object>>} Pending events for polling clients per user */
const pendingEvents = new Map();

function createEventId() {
    return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function timerKey(handle, id) {
    return `${handle}:${id}`;
}

/**
 * Handle of the ST user making the request. Plugin routes are mounted after
 * ST's login middleware, so req.user is set; in single-user mode it is default-user.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getHandle(req) {
    const handle = req.user?.profile?.handle ?? DEFAULT_HANDLE;
    return HANDLE_RE.test(String(handle)) ? String(handle) : null;
}

function userDir(handle) {
    return path.join(USERS_DIR, handle);
}

function dataFile(handle) {
    return path.join(userDir(handle), 'data.json');
}

function queueFile(handle) {
    return path.join(userDir(handle), 'queue.json');
}

function jealousyDir(handle) {
    return path.join(userDir(handle), 'jealousy-configs');
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function listUserHandles() {
    if (!fs.existsSync(USERS_DIR)) return [];
    return fs.readdirSync(USERS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && HANDLE_RE.test(entry.name))
        .map(entry => entry.name);
}

/**
 * До версии с разделением по пользователям всё лежало прямо в папке плагина.
 * Переносим эти файлы к default-user, чтобы настройки не потерялись.
 */
function migrateLegacyData() {
    const legacy = ['data.json', 'queue.json', 'jealousy-configs'];
    const found = legacy.filter(name => fs.existsSync(path.join(PLUGIN_DIR, name)));
    if (found.length === 0) return;

    const target = userDir(DEFAULT_HANDLE);
    ensureDir(target);
    for (const name of found) {
        const from = path.join(PLUGIN_DIR, name);
        const to = path.join(target, name);
        if (fs.existsSync(to)) {
            console.warn(`[AutoPulse] Миграция: ${to} уже существует, старый ${name} оставлен на месте.`);
            continue;
        }
        fs.renameSync(from, to);
        console.log(`[AutoPulse] Миграция: ${name} перенесён в users/${DEFAULT_HANDLE}/`);
    }
}

// ─── Data Persistence ────────────────────────────────────────────────

function readJson(file, fallback) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
    } catch (e) {
        console.error(`[AutoPulse] Ошибка чтения ${file}:`, e.message);
    }
    return fallback;
}

function writeJson(file, value) {
    try {
        ensureDir(path.dirname(file));
        fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
    } catch (e) {
        console.error(`[AutoPulse] Ошибка записи ${file}:`, e.message);
    }
}

function loadData(handle) {
    const data = readJson(dataFile(handle), {});
    // Объекты без прототипа: ключи вида __proto__ не трогают Object.prototype.
    return {
        ...data,
        timers: Object.assign(Object.create(null), data.timers || {}),
        scheduledTasks: Object.assign(Object.create(null), data.scheduledTasks || {}),
    };
}

function saveData(handle, data) {
    writeJson(dataFile(handle), data);
}

function loadQueue(handle) {
    const queue = readJson(queueFile(handle), []);
    return Array.isArray(queue) ? queue : [];
}

function saveQueue(handle, queue) {
    writeJson(queueFile(handle), queue);
}

function acknowledgeQueueEvents(handle, eventIds) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
        return 0;
    }

    const ids = new Set(eventIds.map(String));
    const queue = loadQueue(handle);
    const nextQueue = queue.filter(event => !ids.has(String(event.id)));
    const removed = queue.length - nextQueue.length;

    if (removed > 0) {
        saveQueue(handle, nextQueue);
    }

    return removed;
}

// ─── SSE Broadcasting ────────────────────────────────────────────────

/**
 * Send an event to the user's connected SSE clients, or queue it if none connected.
 * @param {string} handle
 * @param {string} eventType
 * @param {object} data
 */
function broadcastOrQueue(handle, eventType, data) {
    const event = {
        id: createEventId(),
        type: eventType,
        data: data,
        timestamp: Date.now(),
    };

    const clients = sseClients.get(handle);
    if (clients && clients.size > 0) {
        const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const client of clients) {
            try {
                client.write(message);
            } catch (e) {
                clients.delete(client);
            }
        }
        console.log(`[AutoPulse] [${handle}] Отправлено "${eventType}" ${clients.size} клиенту(ам)`);
    } else {
        // No SSE clients connected, keep for polling
        if (!pendingEvents.has(handle)) pendingEvents.set(handle, []);
        pendingEvents.get(handle).push(event);
        console.log(`[AutoPulse] [${handle}] Событие добавлено в очередь ожидания (размер: ${pendingEvents.get(handle).length})`);
    }

    // Always persist to offline queue as backup
    const queue = loadQueue(handle);
    queue.push(event);
    saveQueue(handle, queue);
}

// ─── Timer Management ────────────────────────────────────────────────

const DEFAULT_PRESSURE_MULTIPLIERS = [1.0, 0.7, 0.5, 0.3, 0.2];

function updateTimerState(handle, id, patch) {
    const data = loadData(handle);
    if (!data.timers[id]) return;
    data.timers[id] = {
        ...data.timers[id],
        ...patch,
        updatedAt: Date.now(),
    };
    saveData(handle, data);
}

/**
 * Start a timer with the given configuration.
 * @param {string} handle ST user handle
 * @param {string} id Timer ID
 * @param {object} config Timer configuration
 */
function startTimer(handle, id, config) {
    stopTimer(handle, id);

    if (!config.enabled) {
        console.log(`[AutoPulse] [${handle}] Таймер "${id}" отключён, запуск не выполнен.`);
        return;
    }

    const baseMinutes = config.intervalMinutes || 30;
    const multipliers = Array.isArray(config.pressureMultipliers) ? config.pressureMultipliers : DEFAULT_PRESSURE_MULTIPLIERS;
    const maxPressureLevel = Number(config.pressureMaxLevel) || 4;
    let pressureLevel = Number(config.pressureLevel) || 0;

    const scheduleNext = () => {
        const multiplier = Number(multipliers[Math.min(pressureLevel, multipliers.length - 1)]) || 1.0;
        const actualMinutes = Math.max(1, Math.round(baseMinutes * multiplier));
        const intervalMs = actualMinutes * 60 * 1000;
        const nextTriggerAt = Date.now() + intervalMs;

        updateTimerState(handle, id, {
            pressureLevel,
            pressureMaxLevel: maxPressureLevel,
            pressureMultipliers: multipliers,
            actualIntervalMinutes: actualMinutes,
            intervalMs,
            startedAt: Date.now(),
            nextTriggerAt,
        });

        const timer = setTimeout(() => {
            console.log(`[AutoPulse] [${handle}] Таймер "${id}" сработал! (давление: ${pressureLevel}, интервал: ${actualMinutes}мин)`);
            const firedPressureLevel = pressureLevel;

            broadcastOrQueue(handle, 'timer_trigger', {
                timerId: id,
                characterId: config.characterId ?? null,
                prompt: config.prompt || '',
                intervalMinutes: actualMinutes,
                pressureLevel: firedPressureLevel,
            });

            pressureLevel = Math.min(maxPressureLevel, pressureLevel + 1);
            updateTimerState(handle, id, {
                lastTriggeredAt: Date.now(),
                pressureLevel,
                actualIntervalMinutes: actualMinutes,
                intervalMs,
            });

            scheduleNext();
        }, intervalMs);

        activeTimers.set(timerKey(handle, id), timer);
        console.log(`[AutoPulse] [${handle}] Таймер "${id}" запланирован, база: ${baseMinutes}мин, давление: ${pressureLevel}, фактически: ${actualMinutes}мин`);
    };

    scheduleNext();
}

/**
 * Stop a specific timer.
 * @param {string} handle ST user handle
 * @param {string} id Timer ID
 */
function stopTimer(handle, id) {
    const key = timerKey(handle, id);
    if (activeTimers.has(key)) {
        clearTimeout(activeTimers.get(key));
        activeTimers.delete(key);
        console.log(`[AutoPulse] [${handle}] Таймер "${id}" остановлен.`);
    }
}

/**
 * Reset a timer (restart the countdown).
 * @param {string} handle ST user handle
 * @param {string} id Timer ID
 */
function resetTimer(handle, id) {
    const data = loadData(handle);
    if (data.timers[id]) {
        startTimer(handle, id, data.timers[id]);
    }
}

// ─── Scheduled Tasks ─────────────────────────────────────────────────

/** @type {NodeJS.Timeout|null} */
let scheduledTaskChecker = null;

function checkScheduledTasks(handle, now) {
    const data = loadData(handle);
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const currentDay = now.getDay(); // 0=Sun, 1=Mon, ...

    for (const [id, task] of Object.entries(data.scheduledTasks)) {
        if (!task.enabled) continue;

        let shouldFire = false;

        if (task.time === currentTime) {
            switch (task.repeatType) {
                case 'daily':
                    shouldFire = true;
                    break;
                case 'weekly':
                    shouldFire = (task.weekday === currentDay);
                    break;
                case 'once':
                    if (task.date) {
                        const taskDate = new Date(task.date);
                        shouldFire = (
                            taskDate.getFullYear() === now.getFullYear() &&
                            taskDate.getMonth() === now.getMonth() &&
                            taskDate.getDate() === now.getDate()
                        );
                    }
                    break;
            }
        }

        if (!shouldFire) continue;

        // Check if we already fired this minute (avoid duplicate fires)
        const lastFiredKey = `_lastFired_${id}`;
        const nowMinuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
        if (data[lastFiredKey] === nowMinuteKey) continue;

        data[lastFiredKey] = nowMinuteKey;
        // Disable one-time tasks after firing
        if (task.repeatType === 'once') {
            data.scheduledTasks[id].enabled = false;
        }
        saveData(handle, data);

        console.log(`[AutoPulse] [${handle}] Запланированная задача "${task.name}" (${id}) сработала!`);
        broadcastOrQueue(handle, 'scheduled_task_trigger', {
            taskId: id,
            taskName: task.name,
            characterId: task.characterId ?? null,
            prompt: task.prompt || '',
        });
    }
}

/**
 * Check scheduled tasks of every user every minute and fire if the time matches.
 */
function startScheduledTaskChecker() {
    if (scheduledTaskChecker) {
        clearInterval(scheduledTaskChecker);
    }

    scheduledTaskChecker = setInterval(() => {
        const now = new Date();
        for (const handle of listUserHandles()) {
            checkScheduledTasks(handle, now);
        }
    }, 60 * 1000);

    console.log('[AutoPulse] Проверка запланированных задач запущена (проверка каждые 60с)');
}

// ─── Restore timers on startup ───────────────────────────────────────

function restoreTimers() {
    let count = 0;
    for (const handle of listUserHandles()) {
        const data = loadData(handle);
        for (const [id, config] of Object.entries(data.timers)) {
            if (!ID_RE.test(id)) continue;
            startTimer(handle, id, config);
            count++;
        }
    }
    console.log(`[AutoPulse] Восстановлено ${count} таймер(ов) из сохранённых данных.`);
}

// ─── Validation helpers ──────────────────────────────────────────────

/**
 * Express middleware: resolves the user handle or rejects the request.
 */
function requireHandle(req, res, next) {
    const handle = getHandle(req);
    if (!handle) {
        return res.status(400).json({ success: false, error: 'Недопустимый пользователь' });
    }
    res.locals.handle = handle;
    next();
}

function optionalString(value, maxLength) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

/**
 * Keep only the known fields of a jealousy API config.
 * @param {object} body
 */
function sanitizeJealousyConfig(body) {
    const config = body && typeof body === 'object' ? body : {};
    const maxTokens = Number(config.maxTokens);
    const temperature = Number(config.temperature);
    return {
        apiEndpoint: optionalString(config.apiEndpoint, 2048),
        apiKey: optionalString(config.apiKey, 4096),
        modelName: optionalString(config.modelName, 256),
        maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.round(maxTokens) : 150,
        temperature: Number.isFinite(temperature) ? temperature : 0.9,
    };
}

// ─── Plugin Init / Exit ──────────────────────────────────────────────

/**
 * @param {import('express').Router} router
 */
async function init(router) {
    console.log('[AutoPulse] Инициализация серверного плагина...');

    ensureDir(USERS_DIR);
    migrateLegacyData();

    router.use(requireHandle);

    // Reject any id that could escape its directory or pollute objects.
    router.param('id', (req, res, next, id) => {
        if (!ID_RE.test(id)) {
            return res.status(400).json({ success: false, error: 'Недопустимый ID' });
        }
        next();
    });
    router.param('charId', (req, res, next, charId) => {
        if (!CHAR_ID_RE.test(charId)) {
            return res.status(400).json({ success: false, error: 'Недопустимый ID персонажа' });
        }
        next();
    });

    // ─── SSE Stream ──────────────────────────────────────────

    router.get('/stream', (req, res) => {
        const handle = res.locals.handle;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // Send initial heartbeat
        res.write(`event: connected\ndata: ${JSON.stringify({ message: 'AutoPulse SSE подключён' })}\n\n`);

        if (!sseClients.has(handle)) sseClients.set(handle, new Set());
        const clients = sseClients.get(handle);
        clients.add(res);
        console.log(`[AutoPulse] [${handle}] SSE клиент подключён (всего: ${clients.size})`);

        req.on('close', () => {
            clients.delete(res);
            console.log(`[AutoPulse] [${handle}] SSE клиент отключён (всего: ${clients.size})`);
        });
    });

    // ─── Timers ──────────────────────────────────────────────

    // GET /timers - list all timers
    router.get('/timers', (req, res) => {
        res.json(loadData(res.locals.handle).timers);
    });

    // POST /timers - create or update a timer
    router.post('/timers', (req, res) => {
        const handle = res.locals.handle;
        const { id, intervalMinutes, prompt, enabled } = req.body || {};
        if (!id) {
            return res.status(400).json({ error: 'Требуется ID таймера' });
        }
        if (!ID_RE.test(String(id))) {
            return res.status(400).json({ error: 'Недопустимый ID таймера' });
        }

        const data = loadData(handle);
        data.timers[id] = {
            intervalMinutes: Number(intervalMinutes) || 30,
            prompt: optionalString(prompt, 20000),
            enabled: enabled !== false,
            characterId: req.body.characterId ?? null,
            pressureLevel: Number(req.body.pressureLevel) || 0,
            pressureMaxLevel: Number(req.body.pressureMaxLevel) || 4,
            pressureMultipliers: Array.isArray(req.body.pressureMultipliers) ? req.body.pressureMultipliers.map(Number) : null,
            updatedAt: Date.now(),
        };
        saveData(handle, data);

        if (data.timers[id].enabled) {
            startTimer(handle, id, data.timers[id]);
        } else {
            stopTimer(handle, id);
        }

        res.json({ success: true, timer: loadData(handle).timers[id] });
    });

    // DELETE /timers/:id - delete a timer
    router.delete('/timers/:id', (req, res) => {
        const handle = res.locals.handle;
        const { id } = req.params;
        const data = loadData(handle);

        stopTimer(handle, id);

        if (data.timers[id]) {
            delete data.timers[id];
            saveData(handle, data);
        }

        res.json({ success: true });
    });

    // POST /timers/:id/reset - reset a timer's countdown
    router.post('/timers/:id/reset', (req, res) => {
        resetTimer(res.locals.handle, req.params.id);
        res.json({ success: true });
    });

    // ─── Scheduled Tasks ─────────────────────────────────────

    // GET /tasks - list all scheduled tasks
    router.get('/tasks', (req, res) => {
        res.json(loadData(res.locals.handle).scheduledTasks);
    });

    // POST /tasks - create or update a scheduled task
    router.post('/tasks', (req, res) => {
        const handle = res.locals.handle;
        const { id, name, time, repeatType, weekday, date, prompt, enabled } = req.body || {};
        if (!id) {
            return res.status(400).json({ error: 'Требуется ID задачи' });
        }
        if (!ID_RE.test(String(id))) {
            return res.status(400).json({ error: 'Недопустимый ID задачи' });
        }

        const data = loadData(handle);
        data.scheduledTasks[id] = {
            name: optionalString(name, 200) || 'Задача без имени',
            time: /^\d{2}:\d{2}$/.test(time) ? time : '09:00',
            repeatType: ['daily', 'weekly', 'once'].includes(repeatType) ? repeatType : 'daily',
            weekday: weekday !== undefined ? Number(weekday) : 1,
            date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
            prompt: optionalString(prompt, 20000),
            characterId: req.body.characterId ?? null,
            enabled: enabled !== false,
            updatedAt: Date.now(),
        };
        saveData(handle, data);

        res.json({ success: true, task: data.scheduledTasks[id] });
    });

    // DELETE /tasks/:id - delete a scheduled task
    router.delete('/tasks/:id', (req, res) => {
        const handle = res.locals.handle;
        const { id } = req.params;
        const data = loadData(handle);

        if (data.scheduledTasks[id]) {
            delete data.scheduledTasks[id];
            saveData(handle, data);
        }

        res.json({ success: true });
    });

    // ─── Queue ───────────────────────────────────────────────

    // GET /queue - get pending events (offline queue from disk)
    router.get('/queue', (req, res) => {
        res.json(loadQueue(res.locals.handle));
    });

    // DELETE /queue - clear the offline queue
    router.delete('/queue', (req, res) => {
        saveQueue(res.locals.handle, []);
        res.json({ success: true });
    });

    router.post('/queue/ack', (req, res) => {
        const removed = acknowledgeQueueEvents(res.locals.handle, req.body?.eventIds);
        res.json({ success: true, removed });
    });

    // ─── Polling Endpoint ────────────────────────────────────

    // GET /pending - get and clear pending events (for polling clients)
    router.get('/pending', (req, res) => {
        const queue = pendingEvents.get(res.locals.handle) || [];
        const events = queue.splice(0, queue.length);
        res.json({ events, serverTime: Date.now() });
    });

    // ─── Status ──────────────────────────────────────────────

    router.get('/status', (req, res) => {
        const handle = res.locals.handle;
        const data = loadData(handle);
        const prefix = `${handle}:`;
        res.json({
            activeTimers: Array.from(activeTimers.keys())
                .filter(key => key.startsWith(prefix))
                .map(key => key.slice(prefix.length)),
            sseClients: sseClients.get(handle)?.size || 0,
            queueSize: loadQueue(handle).length,
            timers: data.timers,
            scheduledTasks: data.scheduledTasks,
        });
    });

    // ─── Jealousy Per-Character Config ──────────────────────
    // Ключи API здесь принадлежат текущему пользователю ST и видны только ему.

    // GET /jealousy-configs - list all character configs of the current user
    router.get('/jealousy-configs', (req, res) => {
        const dir = jealousyDir(res.locals.handle);
        const configs = {};
        try {
            if (fs.existsSync(dir)) {
                for (const file of fs.readdirSync(dir)) {
                    const charId = path.basename(file, '.json');
                    if (!file.endsWith('.json') || !CHAR_ID_RE.test(charId)) continue;
                    try {
                        configs[charId] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
                    } catch (e) { /* skip malformed */ }
                }
            }
            res.json({ success: true, configs });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    // GET /jealousy-config/:charId - read one character's config
    router.get('/jealousy-config/:charId', (req, res) => {
        const filePath = path.join(jealousyDir(res.locals.handle), `${req.params.charId}.json`);
        if (!fs.existsSync(filePath)) {
            return res.json({ success: true, config: null });
        }
        try {
            const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            res.json({ success: true, config });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    // PUT /jealousy-config/:charId - save/update config
    router.put('/jealousy-config/:charId', (req, res) => {
        const handle = res.locals.handle;
        const filePath = path.join(jealousyDir(handle), `${req.params.charId}.json`);
        try {
            ensureDir(jealousyDir(handle));
            fs.writeFileSync(filePath, JSON.stringify(sanitizeJealousyConfig(req.body), null, 2), 'utf-8');
            console.log(`[AutoPulse] [${handle}] Конфигурация ревности сохранена для персонажа ${req.params.charId}`);
            res.json({ success: true });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    // DELETE /jealousy-config/:charId - remove config
    router.delete('/jealousy-config/:charId', (req, res) => {
        const handle = res.locals.handle;
        const filePath = path.join(jealousyDir(handle), `${req.params.charId}.json`);
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`[AutoPulse] [${handle}] Конфигурация ревности удалена для персонажа ${req.params.charId}`);
            }
            res.json({ success: true });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    // Restore saved timers and start task checker
    restoreTimers();
    startScheduledTaskChecker();

    console.log('[AutoPulse] Серверный плагин успешно инициализирован!');
}

async function exit() {
    console.log('[AutoPulse] Завершение работы...');

    // Clear all timers
    for (const timer of activeTimers.values()) {
        clearTimeout(timer);
    }
    activeTimers.clear();

    // Clear scheduled task checker
    if (scheduledTaskChecker) {
        clearInterval(scheduledTaskChecker);
        scheduledTaskChecker = null;
    }

    // Close all SSE connections
    for (const clients of sseClients.values()) {
        for (const client of clients) {
            try { client.end(); } catch (e) { /* ignore */ }
        }
    }
    sseClients.clear();

    console.log('[AutoPulse] Серверный плагин остановлен.');
}

module.exports = {
    init,
    exit,
    info: {
        id: 'autopulse',
        name: 'ST-AutoPulse',
        description: 'Управление таймерами для автоматической отправки сообщений персонажа. Таймеры продолжают работать, даже когда браузер закрыт.',
    },
};
