/**
 * ST-AutoPulse Lite - Чисто фронтендная версия
 * Не требует серверного плагина, все таймеры работают в браузере.
 * После закрытия страницы таймеры останавливаются.
 */

const MODULE_NAME = 'ST-AutoPulse-Lite';
const PLUGIN_ID = 'autopulse-lite';

// ─── Настройки по умолчанию ───────────────────────────────────────────

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    intervalMinutes: 30,
    prompt: '',
    notifyDesktop: true,
    // Система давления
    pressureEnabled: false,
    pressureMaxLevel: 4,
    pressureReturnEnabled: true,
    // Система ревности
    jealousyEnabled: false,
    jealousyChance: 50,
    jealousyDelayMin: 30,
    jealousyDelayMax: 120,
    jealousyCharacters: [],
    jealousyPrompt: '',
});

const DEFAULT_PROMPT = 'Прошло некоторое время. Основываясь на текущем контексте диалога, характере персонажа и его предыстории, отправь от имени персонажа естественное сообщение пользователю. Это сообщение должно быть таким, будто персонаж вспомнил о пользователе — это может быть приветствие, рассказ о чём-то из жизни, выражение заботы или продолжение предыдущей темы. Сохраняй тон и стиль персонажа.';

// ─── Промпты системы давления ────────────────────────────────────────

const PRESSURE_MULTIPLIERS = [1.0, 0.7, 0.5, 0.3, 0.2];

const PRESSURE_PROMPTS = [
    '', // Уровень 0: нормально
    '（[Эмоциональный фон: ты начинаешь скучать по собеседнику, прошло немного времени без ответа.]）\n',
    '（[Эмоциональный фон: ты уже долго не получаешь ответа, начинаешь беспокоиться и хочешь узнать, всё ли в порядке.]）\n',
    '（[Эмоциональный фон: ты ждёшь очень долго, тебя охватывает тревога, ты не можешь удержаться и хочешь снова написать.]）\n',
    '（[Эмоциональный фон: ты почти не в силах выдержать это долгое ожидание, эмоции на пределе, ты отчаянно хочешь получить хоть какой-то ответ.]）\n',
];

const RETURN_PROMPTS = [
    '', // Уровень 0: без особой реакции
    '（[Эмоциональный фон: собеседник наконец ответил! Ты чувствуешь радость и облегчение, на душе стало спокойнее.]）\n',
    '（[Эмоциональный фон: собеседник наконец ответил, ты вздыхаешь с облегчением, но немного обижен — лёгкий капризный тон.]）\n',
    '（[Эмоциональный фон: собеседник наконец ответил! Ты и рад, и немного сердит — чувствуешь, что тебя проигнорировали, хочешь больше внимания и утешения.]）\n',
    '（[Эмоциональный фон: собеседник наконец ответил, но ты очень обижен тем, что тебя так долго игнорировали. Смешанные чувства — хочется простить, но невозможно сдержать недовольство.]）\n',
];

const JEALOUSY_PROMPT = '[OOC инструкция: временно прерви текущий формат РП. Тебе нужно отправить короткое мгновенное сообщение (как в Telegram/WhatsApp/SMS) — не художественный текст, не РП. Запрещены: описание действий, внутренние монологи, описание обстановки, действия в скобках. Выводи только слова персонажа, 1-2 предложения, разговорным языком, как настоящий человек пишет сообщение. Ситуация: ты замечаешь, что собеседник общается с кем-то другим, и чувствуешь ревность.]\n';

// ─── Состояние ───────────────────────────────────────────────────────

let isGenerating = false;
let nextTriggerTime = null;
let countdownInterval = null;
let autoTimerInterval = null;

// Состояние системы давления
let pressureLevel = 0;
let lastUserMessageTime = Date.now();
let pendingReturnReaction = false;
let returnReactionLevel = 0;

// Состояние системы ревности
let previousCharacterId = null;
let jealousyTimeout = null;

// ─── Вспомогательные функции ─────────────────────────────────────────

function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = ctx.extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = DEFAULT_SETTINGS[key];
        }
    }
    return settings;
}

function saveSettings() {
    const ctx = SillyTavern.getContext();
    ctx.saveSettingsDebounced();
}

// ─── Управление таймером ─────────────────────────────────────────────

function startTimer() {
    stopTimer();

    const settings = getSettings();
    if (!settings.enabled) return;

    let intervalMs = settings.intervalMinutes * 60 * 1000;

    // Применяем множитель давления
    if (settings.pressureEnabled) {
        const multiplier = PRESSURE_MULTIPLIERS[Math.min(pressureLevel, PRESSURE_MULTIPLIERS.length - 1)] || 1.0;
        intervalMs = Math.max(60000, Math.round(intervalMs * multiplier)); // Минимум 1 минута
    }

    autoTimerInterval = setInterval(() => {
        console.log(`[AutoPulse Lite] Таймер сработал! (Давление: ${pressureLevel})`);
        handleTrigger(settings.prompt, `Запланированное сообщение (база ${settings.intervalMinutes} мин, давление ${pressureLevel})`);
    }, intervalMs);

    nextTriggerTime = Date.now() + intervalMs;
    startCountdown();

    console.log(`[AutoPulse Lite] Таймер запущен, база: ${settings.intervalMinutes} мин, давление: ${pressureLevel}, фактически: ${Math.round(intervalMs / 60000)} мин`);
}

function stopTimer() {
    if (autoTimerInterval) {
        clearInterval(autoTimerInterval);
        autoTimerInterval = null;
    }
    nextTriggerTime = null;
    stopCountdown();
}

function resetTimer() {
    const settings = getSettings();
    if (settings.enabled) {
        startTimer();
    }
}

// ─── Генерация сообщений ─────────────────────────────────────────────

/**
 * Обработка события срабатывания: генерация сообщения от персонажа.
 * @param {string} customPrompt Пользовательский промпт
 * @param {string} source Описание источника срабатывания
 */
async function handleTrigger(customPrompt, source = 'Автоматическое сообщение') {
    if (isGenerating) {
        console.log('[AutoPulse Lite] Уже генерируется, пропуск');
        return;
    }

    const ctx = SillyTavern.getContext();

    // Проверяем наличие активного чата
    if (!ctx.characterId && !ctx.groupId) {
        console.log('[AutoPulse Lite] Нет активного чата, пропуск');
        return;
    }

    // Проверяем наличие сообщений в чате
    if (!ctx.chat || ctx.chat.length === 0) {
        console.log('[AutoPulse Lite] Чат пустой, пропуск');
        return;
    }

    const settings = getSettings();
    let prompt = customPrompt || settings.prompt || DEFAULT_PROMPT;

    // Добавляем эмоциональный контекст давления в промпт если система давления включена
    if (settings.pressureEnabled && pressureLevel > 0) {
        const pressurePrompt = PRESSURE_PROMPTS[Math.min(pressureLevel, PRESSURE_PROMPTS.length - 1)] || '';
        prompt = pressurePrompt + prompt;
        console.log(`[AutoPulse Lite] Уровень давления ${pressureLevel}, добавляем эмоциональный контекст`);
    }

    isGenerating = true;
    console.log(`[AutoPulse Lite] Генерация сообщения (источник: ${source}, давление: ${pressureLevel})...`);

    try {
        const result = await ctx.generateQuietPrompt({
            quietPrompt: prompt,
            quietImage: null,
            skipWIAN: false,
        });

        if (!result || result.trim().length === 0) {
            console.warn('[AutoPulse Lite] Сгенерирован пустой ответ, пропуск');
            return;
        }

        const messageText = result.trim();
        const message = {
            name: ctx.name2,
            is_user: false,
            mes: messageText,
            force_avatar: ctx.getThumbnailUrl('avatar', ctx.characters[ctx.characterId]?.avatar),
            extra: {
                autopulse: true,
                autopulse_source: source,
                autopulse_timestamp: Date.now(),
                autopulse_pressure: pressureLevel,
            },
        };

        ctx.chat.push(message);
        const messageId = ctx.chat.length - 1;
        ctx.addOneMessage(message, { insertAfter: messageId - 1 });

        await ctx.saveChat();

        console.log(`[AutoPulse Lite] Сообщение сгенерировано и добавлено в чат: "${messageText.substring(0, 50)}..."`);

        toastr.info(`${ctx.name2} написал(а) сообщение`, 'AutoPulse Lite', { timeOut: 3000 });

        if (settings.notifyDesktop) {
            sendDesktopNotification(ctx.name2, messageText);
        }

        // Повышаем давление если система включена
        if (settings.pressureEnabled) {
            const maxLevel = settings.pressureMaxLevel || 4;
            if (pressureLevel < maxLevel) {
                pressureLevel++;
                console.log(`[AutoPulse Lite] Давление повышено до уровня ${pressureLevel}`);
                updatePressureDisplay();
            }
        }

        resetTimer();

    } catch (e) {
        console.error('[AutoPulse Lite] Не удалось сгенерировать сообщение:', e);
        toastr.error(`Ошибка генерации сообщения: ${e.message}`, 'AutoPulse Lite');
    } finally {
        isGenerating = false;
    }
}

/**
 * Обработка реакции на возвращение пользователя после долгого отсутствия.
 * Срабатывает один раз когда пользователь отвечает при давлении > 0.
 */
async function handleReturnReaction() {
    if (!pendingReturnReaction) return;
    if (isGenerating) {
        setTimeout(handleReturnReaction, 1000);
        return;
    }

    const ctx = SillyTavern.getContext();
    const settings = getSettings();

    if (!settings.pressureEnabled || !settings.pressureReturnEnabled) {
        pendingReturnReaction = false;
        return;
    }

    if (!ctx.characterId && !ctx.groupId) return;
    if (!ctx.chat || ctx.chat.length === 0) return;

    const returnPrompt = RETURN_PROMPTS[Math.min(returnReactionLevel, RETURN_PROMPTS.length - 1)] || '';
    if (!returnPrompt) {
        pendingReturnReaction = false;
        return;
    }

    const basePrompt = settings.prompt || DEFAULT_PROMPT;
    const prompt = returnPrompt + basePrompt;

    pendingReturnReaction = false;
    console.log(`[AutoPulse Lite] Генерация реакции на возвращение (уровень давления был ${returnReactionLevel})`);

    isGenerating = true;
    try {
        const result = await ctx.generateQuietPrompt({
            quietPrompt: prompt,
            quietImage: null,
            skipWIAN: false,
        });

        if (!result || result.trim().length === 0) return;

        const messageText = result.trim();
        const message = {
            name: ctx.name2,
            is_user: false,
            mes: messageText,
            force_avatar: ctx.getThumbnailUrl('avatar', ctx.characters[ctx.characterId]?.avatar),
            extra: {
                autopulse: true,
                autopulse_source: `Реакция на возвращение (уровень давления ${returnReactionLevel})`,
                autopulse_timestamp: Date.now(),
            },
        };

        ctx.chat.push(message);
        const messageId = ctx.chat.length - 1;
        ctx.addOneMessage(message, { insertAfter: messageId - 1 });
        await ctx.saveChat();

        console.log(`[AutoPulse Lite] Реакция на возвращение отправлена: "${messageText.substring(0, 50)}..."`);
        toastr.info(`${ctx.name2} реагирует на твоё возвращение`, 'AutoPulse Lite', { timeOut: 3000 });

    } catch (e) {
        console.error('[AutoPulse Lite] Не удалось сгенерировать реакцию на возвращение:', e);
    } finally {
        isGenerating = false;
    }
}

// ─── Всплывающее окно ревности ───────────────────────────────────────

/**
 * Попытка запустить сообщение ревности от предыдущего персонажа.
 * Вызывается когда пользователь переключается на другой чат.
 * @param {string} prevCharId ID персонажа которого покинули
 */
function tryTriggerJealousy(prevCharId) {
    const settings = getSettings();
    if (!settings.jealousyEnabled || !prevCharId) return;

    const allowedChars = settings.jealousyCharacters || [];
    if (allowedChars.length === 0) {
        console.log('[AutoPulse Lite] Ревность: персонажи не выбраны, пропуск');
        return;
    }
    if (!allowedChars.includes(String(prevCharId))) {
        console.log(`[AutoPulse Lite] Ревность: персонаж ${prevCharId} не в списке, пропуск`);
        return;
    }

    if (jealousyTimeout) {
        clearTimeout(jealousyTimeout);
        jealousyTimeout = null;
    }

    const chance = (settings.jealousyChance || 50) / 100;
    if (Math.random() > chance) {
        console.log('[AutoPulse Lite] Ревность: проверка вероятности не прошла, пропуск');
        return;
    }

    const minDelay = (settings.jealousyDelayMin || 30) * 1000;
    const maxDelay = (settings.jealousyDelayMax || 120) * 1000;
    const delay = minDelay + Math.random() * (maxDelay - minDelay);

    console.log(`[AutoPulse Lite] Ревность сработала для персонажа ${prevCharId}, срабатывание через ${Math.round(delay / 1000)} сек`);

    jealousyTimeout = setTimeout(async () => {
        await generateJealousyMessage(prevCharId);
    }, delay);
}

/**
 * Генерация и отображение сообщения ревности от указанного персонажа.
 * @param {string} characterId ID ревнующего персонажа
 */
async function generateJealousyMessage(characterId) {
    if (isGenerating) {
        console.log('[AutoPulse Lite] Уже генерируется, пропуск ревности');
        toastr.warning('Идёт генерация, попробуй чуть позже', 'AutoPulse Lite');
        return;
    }

    const ctx = SillyTavern.getContext();
    const character = ctx.characters[characterId];
    if (!character) {
        console.warn('[AutoPulse Lite] Персонаж не найден для ревности:', characterId);
        return;
    }

    const settings = getSettings();
    const prompt = settings.jealousyPrompt?.trim() || JEALOUSY_PROMPT;
    console.log('[AutoPulse Lite] Используем промпт ревности:', prompt.substring(0, 60) + '...');

    console.log(`[AutoPulse Lite] Генерация сообщения ревности от ${character.name} (id: ${characterId})...`);

    isGenerating = true;
    try {
        const result = await ctx.generateQuietPrompt({
            quietPrompt: prompt,
            quietImage: null,
            skipWIAN: false,
            responseLength: 150,
            removeReasoning: true,
            trimToSentence: true,
            forceChId: characterId,
        });

        console.log('[AutoPulse Lite] Сырой результат ревности:', result);

        if (!result || result.trim().length === 0) {
            console.warn('[AutoPulse Lite] Сообщение ревности пустое, пропуск');
            toastr.warning('Сообщение ревности оказалось пустым', 'AutoPulse Lite');
            return;
        }

        let cleaned = result
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
            .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
            .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
            .replace(/<chain_of_thought>[\s\S]*?<\/chain_of_thought>/gi, '')
            .replace(/<内心[\s\S]*?>[\s\S]*?<\/内心[\s\S]*?>/gi, '')
            .replace(/\[thinking\][\s\S]*?\[\/thinking\]/gi, '')
            .trim();

        cleaned = cleaned.replace(/\*[^*]+\*/g, '').trim();

        const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length > 2) {
            cleaned = lines.slice(-2).join('\n');
        }

        cleaned = cleaned.replace(/^["「『"]([\s\S]+)["」』"]$/, '$1').trim();

        if (!cleaned) {
            console.warn('[AutoPulse Lite] Сообщение ревности пустое после очистки');
            toastr.warning('Сообщение ревности пустое после очистки', 'AutoPulse Lite');
            return;
        }

        const messageText = cleaned;

        try {
            const avatarUrl = ctx.getThumbnailUrl('avatar', character.avatar);
            console.log('[AutoPulse Lite] Показываем всплывающее окно ревности:', character.name, avatarUrl);
            showJealousyPopup(character.name, avatarUrl, messageText);
        } catch (popupErr) {
            console.error('[AutoPulse Lite] Ошибка создания всплывающего окна:', popupErr);
        }

        toastr.info(`${character.name} кажется немного ревнует...`, 'AutoPulse Lite 💢', { timeOut: 5000 });

        if (settings.notifyDesktop) {
            sendDesktopNotification(character.name, messageText);
        }

        console.log(`[AutoPulse Lite] Сообщение ревности отправлено: "${messageText.substring(0, 80)}"`);

    } catch (e) {
        console.error('[AutoPulse Lite] Не удалось сгенерировать сообщение ревности:', e);
        toastr.error(`Ошибка генерации сообщения ревности: ${e.message}`, 'AutoPulse Lite');
    } finally {
        isGenerating = false;
    }
}

function escapeHtml(unsafe) {
    return (unsafe || '').toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Показать всплывающее уведомление для сообщений ревности.
 * @param {string} name Имя персонажа
 * @param {string} avatarUrl URL аватара персонажа
 * @param {string} message Текст сообщения ревности
 */
function showJealousyPopup(name, avatarUrl, message) {
    let container = document.getElementById('autopulse_jealousy_container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'autopulse_jealousy_container';
        document.body.appendChild(container);
    }

    // Максимум 3 всплывающих окна
    while (container.children.length >= 3) {
        container.removeChild(container.firstChild);
    }

    const popup = document.createElement('div');
    popup.className = 'autopulse-jealousy-popup';
    popup.innerHTML = `
        <div class="autopulse-jealousy-header">
            <img class="autopulse-jealousy-avatar" src="${avatarUrl || '/favicon.ico'}" alt="${escapeHtml(name)}" />
            <span class="autopulse-jealousy-name">${escapeHtml(name)} 💢</span>
            <span class="autopulse-jealousy-close fa-solid fa-xmark"></span>
        </div>
        <div class="autopulse-jealousy-body">${escapeHtml(message).substring(0, 200)}${message.length > 200 ? '...' : ''}</div>
    `;

    popup.querySelector('.autopulse-jealousy-close').addEventListener('click', () => {
        popup.classList.add('autopulse-jealousy-exit');
        setTimeout(() => popup.remove(), 300);
    });

    // Автоматически скрыть через 15 секунд
    setTimeout(() => {
        if (popup.parentNode) {
            popup.classList.add('autopulse-jealousy-exit');
            setTimeout(() => popup.remove(), 300);
        }
    }, 15000);

    container.appendChild(popup);
}

// ─── Уведомления рабочего стола ──────────────────────────────────────

function sendDesktopNotification(characterName, message) {
    if (!('Notification' in window)) return;

    if (Notification.permission === 'granted') {
        try {
            new Notification(`${characterName} написал(а) тебе сообщение`, {
                body: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
                icon: '/favicon.ico',
                tag: 'autopulse-lite',
            });
        } catch (e) {
            console.warn('[AutoPulse Lite] Не удалось показать уведомление (мобильный браузер?):', e);
        }
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(perm => {
            if (perm === 'granted') {
                sendDesktopNotification(characterName, message);
            }
        });
    }
}

// ─── Отображение обратного отсчёта ───────────────────────────────────

function startCountdown() {
    stopCountdown();
    updateCountdownDisplay();
    countdownInterval = setInterval(updateCountdownDisplay, 1000);
    $('#autopulse_timer_info').show();
}

function stopCountdown() {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    $('#autopulse_timer_info').hide();
}

function updateCountdownDisplay() {
    if (!nextTriggerTime) {
        $('#autopulse_next_trigger').text('Остановлен');
        return;
    }

    const remaining = nextTriggerTime - Date.now();
    if (remaining <= 0) {
        $('#autopulse_next_trigger').text('Вот-вот сработает...');
        return;
    }

    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    $('#autopulse_next_trigger').text(
        `Следующий запуск через: ${minutes} мин ${String(seconds).padStart(2, '0')} сек`
    );
}

// ─── Статус интерфейса ────────────────────────────────────────────────

function updateStatusUI() {
    const dot = $('#autopulse_status_dot');
    const text = $('#autopulse_status_text');
    const settings = getSettings();

    dot.removeClass('connected disconnected active');

    if (settings.enabled) {
        dot.addClass('active');
        text.text('Фронтенд-таймер работает (останавливается при закрытии страницы)');
    } else {
        dot.addClass('disconnected');
        text.text('Отключено');
    }
}

// ─── Обработчики событий интерфейса ──────────────────────────────────

function onEnabledChange() {
    const settings = getSettings();
    settings.enabled = $('#autopulse_enabled').prop('checked');
    saveSettings();
    if (settings.enabled) {
        startTimer();
    } else {
        stopTimer();
    }
    updateStatusUI();
}

function onIntervalChange(value) {
    const settings = getSettings();
    const v = Math.max(1, Math.min(180, Number(value) || 30));
    settings.intervalMinutes = v;
    $('#autopulse_interval_range').val(v);
    $('#autopulse_interval_input').val(v);
    saveSettings();
    if (settings.enabled) {
        startTimer();
    }
}

function onPromptChange() {
    const settings = getSettings();
    settings.prompt = $('#autopulse_prompt').val().trim();
    saveSettings();
}

function onNotifyChange() {
    const settings = getSettings();
    settings.notifyDesktop = $('#autopulse_notify').prop('checked');
    saveSettings();

    if (settings.notifyDesktop && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function onTriggerNow() {
    const settings = getSettings();
    handleTrigger(settings.prompt, 'Ручной запуск');
}

// ─── Обработчики системы давления ────────────────────────────────────

function onPressureEnabledChange() {
    const settings = getSettings();
    settings.pressureEnabled = $('#autopulse_pressure_enabled').prop('checked');
    saveSettings();
    if (!settings.pressureEnabled) {
        pressureLevel = 0;
        updatePressureDisplay();
        if (settings.enabled) resetTimer();
    }
}

function onPressureMaxLevelChange(value) {
    const settings = getSettings();
    const v = Math.max(1, Math.min(5, Number(value) || 4));
    settings.pressureMaxLevel = v;
    $('#autopulse_pressure_max').val(v);
    $('#autopulse_pressure_max_display').text(v);
    saveSettings();
    if (pressureLevel > v) {
        pressureLevel = v;
        updatePressureDisplay();
    }
}

function onPressureReturnChange() {
    const settings = getSettings();
    settings.pressureReturnEnabled = $('#autopulse_pressure_return').prop('checked');
    saveSettings();
}

function updatePressureDisplay() {
    const display = $('#autopulse_pressure_display');
    const settings = getSettings();
    const max = settings.pressureMaxLevel || 4;

    let emoji = '😊';
    if (pressureLevel >= max) emoji = '💢';
    else if (pressureLevel >= max - 1) emoji = '😠';
    else if (pressureLevel >= 2) emoji = '😰';
    else if (pressureLevel >= 1) emoji = '🥺';

    display.text(`${emoji} Уровень ${pressureLevel}`);

    if (pressureLevel === 0) display.css('color', '');
    else if (pressureLevel === 1) display.css('color', '#ffb74d');
    else if (pressureLevel === 2) display.css('color', '#ff9800');
    else if (pressureLevel === 3) display.css('color', '#f44336');
    else display.css('color', '#d32f2f');
}

// ─── Обработчики системы ревности ────────────────────────────────────

function onJealousyEnabledChange() {
    const settings = getSettings();
    settings.jealousyEnabled = $('#autopulse_jealousy_enabled').prop('checked');
    saveSettings();
}

function onJealousyChanceChange(value) {
    const settings = getSettings();
    const v = Math.max(0, Math.min(100, Number(value) || 50));
    settings.jealousyChance = v;
    $('#autopulse_jealousy_chance').val(v);
    $('#autopulse_jealousy_chance_display').text(`${v}%`);
    saveSettings();
}

function onJealousyDelayMinChange(value) {
    const settings = getSettings();
    const v = Math.max(1, Math.min(300, Number(value) || 30));
    settings.jealousyDelayMin = v;
    $('#autopulse_jealousy_delay_min').val(v);
    $('#autopulse_jealousy_delay_min_display').text(`${v} сек`);
    if (settings.jealousyDelayMin > settings.jealousyDelayMax) {
        settings.jealousyDelayMax = settings.jealousyDelayMin;
        $('#autopulse_jealousy_delay_max').val(v);
        $('#autopulse_jealousy_delay_max_display').text(`${v} сек`);
    }
    saveSettings();
}

function onJealousyDelayMaxChange(value) {
    const settings = getSettings();
    let v = Math.max(1, Math.min(600, Number(value) || 120));
    if (v < settings.jealousyDelayMin) {
        v = settings.jealousyDelayMin;
    }
    settings.jealousyDelayMax = v;
    $('#autopulse_jealousy_delay_max').val(v);
    $('#autopulse_jealousy_delay_max_display').text(`${v} сек`);
    saveSettings();
}

function onJealousyPromptChange() {
    const settings = getSettings();
    settings.jealousyPrompt = $('#autopulse_jealousy_prompt').val().trim();
    saveSettings();
}

function updateJealousyCharPicker() {
    const settings = getSettings();
    const container = $('#autopulse_jealousy_chars');
    container.empty();

    const ctx = SillyTavern.getContext();
    const chars = ctx.characters || [];

    if (chars.length === 0) {
        container.html('<span class="autopulse-hint">Персонажи не найдены. Сначала добавь персонажей.</span>');
        return;
    }

    const selectedChars = settings.jealousyCharacters || [];

    chars.forEach((char, index) => {
        const isSelected = selectedChars.includes(String(index));
        const avatarUrl = ctx.getThumbnailUrl('avatar', char.avatar) || '/favicon.ico';

        const chip = $(`
            <div class="autopulse-char-chip ${isSelected ? 'selected' : ''}" data-id="${index}" title="${escapeHtml(char.name)}">
                <img class="autopulse-char-chip-avatar" src="${avatarUrl}" />
                <span class="autopulse-char-chip-name">${escapeHtml(char.name)}</span>
            </div>
        `);

        chip.on('click', function () {
            const id = $(this).data('id').toString();
            const currSettings = getSettings();
            currSettings.jealousyCharacters = currSettings.jealousyCharacters || [];

            const idx = currSettings.jealousyCharacters.indexOf(id);
            if (idx > -1) {
                currSettings.jealousyCharacters.splice(idx, 1);
                $(this).removeClass('selected');
            } else {
                currSettings.jealousyCharacters.push(id);
                $(this).addClass('selected');
            }
            saveSettings();
        });

        container.append(chip);
    });
}

// ─── Слэш-команды ────────────────────────────────────────────────────

function registerSlashCommands() {
    const ctx = SillyTavern.getContext();

    ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
        name: 'autopulse',
        callback: async (namedArgs, unnamedArgs) => {
            const subcommand = String(unnamedArgs || '').trim().toLowerCase();
            const settings = getSettings();

            switch (subcommand) {
                case 'on':
                    settings.enabled = true;
                    $('#autopulse_enabled').prop('checked', true);
                    saveSettings();
                    startTimer();
                    updateStatusUI();
                    return '✅ AutoPulse Lite включён';

                case 'off':
                    settings.enabled = false;
                    $('#autopulse_enabled').prop('checked', false);
                    saveSettings();
                    stopTimer();
                    updateStatusUI();
                    return '⏹ AutoPulse Lite отключён';

                case 'trigger':
                    await handleTrigger(settings.prompt, 'Запуск через слэш-команду');
                    return '⚡ Запущена генерация сообщения персонажа';

                case 'status':
                    return `📊 Статус AutoPulse Lite:\n` +
                        `- Включён: ${settings.enabled ? 'Да' : 'Нет'}\n` +
                        `- Интервал: ${settings.intervalMinutes} мин\n` +
                        `- Режим: только фронтенд (останавливается при закрытии страницы)\n` +
                        `- Таймер: ${autoTimerInterval ? 'Работает' : 'Остановлен'}`;

                default: {
                    const num = parseInt(subcommand);
                    if (!isNaN(num) && num >= 1 && num <= 180) {
                        settings.intervalMinutes = num;
                        onIntervalChange(num);
                        return `⏱ Интервал установлен: ${num} мин`;
                    }
                    return 'Использование: /autopulse [on|off|trigger|status|<минуты>]';
                }
            }
        },
        helpString: `
            <div>
                Управление функцией автоматических сообщений AutoPulse Lite (только фронтенд).
            </div>
            <div>
                <strong>Использование:</strong>
                <ul>
                    <li><code>/autopulse on</code> — включить автосообщения</li>
                    <li><code>/autopulse off</code> — отключить автосообщения</li>
                    <li><code>/autopulse trigger</code> — запустить немедленно</li>
                    <li><code>/autopulse status</code> — показать статус</li>
                    <li><code>/autopulse 30</code> — установить интервал 30 минут</li>
                </ul>
            </div>
        `,
        unnamedArgumentList: [
            ctx.SlashCommandArgument.fromProps({
                description: 'on/off/trigger/status или количество минут',
                typeList: [ctx.ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumList: ['on', 'off', 'trigger', 'status'],
            }),
        ],
    }));

    console.log('[AutoPulse Lite] Слэш-команды зарегистрированы');
}

// ─── Инициализация ───────────────────────────────────────────────────

function loadSettingsUI() {
    const settings = getSettings();

    $('#autopulse_enabled').prop('checked', settings.enabled);
    $('#autopulse_interval_range').val(settings.intervalMinutes);
    $('#autopulse_interval_input').val(settings.intervalMinutes);
    $('#autopulse_prompt').val(settings.prompt);
    $('#autopulse_notify').prop('checked', settings.notifyDesktop);

    // Настройки давления
    $('#autopulse_pressure_enabled').prop('checked', settings.pressureEnabled);
    $('#autopulse_pressure_max').val(settings.pressureMaxLevel || 4);
    $('#autopulse_pressure_max_display').text(settings.pressureMaxLevel || 4);
    $('#autopulse_pressure_return').prop('checked', settings.pressureReturnEnabled !== false);
    updatePressureDisplay();

    // Настройки ревности
    $('#autopulse_jealousy_enabled').prop('checked', settings.jealousyEnabled);
    $('#autopulse_jealousy_chance').val(settings.jealousyChance || 50);
    $('#autopulse_jealousy_chance_display').text(`${settings.jealousyChance || 50}%`);
    $('#autopulse_jealousy_delay_min').val(settings.jealousyDelayMin || 30);
    $('#autopulse_jealousy_delay_min_display').text(`${settings.jealousyDelayMin || 30} сек`);
    $('#autopulse_jealousy_delay_max').val(settings.jealousyDelayMax || 120);
    $('#autopulse_jealousy_delay_max_display').text(`${settings.jealousyDelayMax || 120} сек`);
    $('#autopulse_jealousy_prompt').val(settings.jealousyPrompt || JEALOUSY_PROMPT);
    updateJealousyCharPicker();
}

async function initExtension() {
    const ctx = SillyTavern.getContext();

    const settingsHtml = await $.get(new URL('./settings.html', import.meta.url).href);
    $('#extensions_settings').append(settingsHtml);

    // Привязка событий — основные
    $('#autopulse_enabled').on('change', onEnabledChange);
    $('#autopulse_interval_range').on('input', function () { onIntervalChange(this.value); });
    $('#autopulse_interval_input').on('change', function () { onIntervalChange(this.value); });
    $('#autopulse_prompt').on('change', onPromptChange);
    $('#autopulse_notify').on('change', onNotifyChange);
    $('#autopulse_trigger_now').on('click', onTriggerNow);

    // Привязка событий — давление
    $('#autopulse_pressure_enabled').on('change', onPressureEnabledChange);
    $('#autopulse_pressure_max').on('input', function () { onPressureMaxLevelChange(this.value); });
    $('#autopulse_pressure_return').on('change', onPressureReturnChange);

    // Привязка событий — ревность
    $('#autopulse_jealousy_enabled').on('change', onJealousyEnabledChange);
    $('#autopulse_jealousy_chance').on('input', function () { onJealousyChanceChange(this.value); });
    $('#autopulse_jealousy_delay_min').on('input', function () { onJealousyDelayMinChange(this.value); });
    $('#autopulse_jealousy_delay_max').on('input', function () { onJealousyDelayMaxChange(this.value); });
    $('#autopulse_jealousy_prompt').on('change', onJealousyPromptChange);

    // Привязка тестовых кнопок
    $('#autopulse_test_pressure_up').on('click', () => {
        const settings = getSettings();
        if (!settings.pressureEnabled) {
            toastr.warning('Сначала включи систему эмоционального давления', 'AutoPulse Lite');
            return;
        }
        const maxLevel = settings.pressureMaxLevel || 4;
        if (pressureLevel < maxLevel) {
            pressureLevel++;
            updatePressureDisplay();
            toastr.success(`Давление повышено до ${pressureLevel}`, 'Инструменты тестирования');
        } else {
            toastr.info('Уже максимальный уровень давления', 'Инструменты тестирования');
        }
    });

    $('#autopulse_test_pressure_trigger').on('click', () => {
        const settings = getSettings();
        handleTrigger(settings.prompt, `Тестовый запуск (давление ${pressureLevel})`);
    });

    $('#autopulse_test_return').on('click', () => {
        const settings = getSettings();
        if (!settings.pressureEnabled || !settings.pressureReturnEnabled) {
            toastr.warning('Сначала включи систему давления и реакцию на возвращение', 'AutoPulse Lite');
            return;
        }
        if (pressureLevel === 0) {
            toastr.info('Давление пока не накоплено', 'Инструменты тестирования');
            return;
        }
        returnReactionLevel = pressureLevel;
        pendingReturnReaction = true;
        pressureLevel = 0;
        updatePressureDisplay();
        toastr.success('Готово — отправь сообщение, чтобы увидеть реакцию', 'Инструменты тестирования');
    });

    $('#autopulse_test_jealousy').on('click', () => {
        const charId = ctx.characterId;
        if (!charId) {
            toastr.warning('Сначала открой чат с каким-нибудь персонажем', 'AutoPulse Lite');
            return;
        }
        toastr.info('Генерируем сообщение ревности (вероятность и задержка игнорируются)...', 'Инструменты тестирования');
        generateJealousyMessage(charId);
    });

    ctx.eventSource.on(ctx.eventTypes.CHARACTER_EDITED, updateJealousyCharPicker);
    ctx.eventSource.on(ctx.eventTypes.CHARACTERS_LOADED, updateJealousyCharPicker);

    loadSettingsUI();
    updateStatusUI();

    registerSlashCommands();

    const settings = getSettings();
    if (settings.enabled) {
        startTimer();
    }

    ctx.eventSource.on(ctx.eventTypes.MESSAGE_SENT, () => {
        const settings = getSettings();

        if (settings.pressureEnabled && pressureLevel > 0) {
            console.log(`[AutoPulse Lite] Пользователь ответил при уровне давления ${pressureLevel}, планируем реакцию на возвращение`);
            returnReactionLevel = pressureLevel;
            pendingReturnReaction = true;
            pressureLevel = 0;
            updatePressureDisplay();

            setTimeout(() => {
                handleReturnReaction();
            }, 3000);
        } else if (settings.pressureEnabled) {
            pressureLevel = 0;
            updatePressureDisplay();
        }

        lastUserMessageTime = Date.now();

        if (settings.enabled) {
            resetTimer();
        }
    });

    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
        const currentCharacterId = ctx.characterId;

        if (getSettings().enabled) {
            resetTimer();
        }

        if (previousCharacterId !== null && previousCharacterId !== currentCharacterId) {
            tryTriggerJealousy(previousCharacterId);
        }

        if (currentCharacterId !== undefined) {
            previousCharacterId = currentCharacterId;
        } else {
            previousCharacterId = null;
        }
    });

    if (ctx.characterId) {
        previousCharacterId = ctx.characterId;
    }

    console.log('[AutoPulse Lite] Расширение инициализировано! (только фронтенд)');
}

// ─── Точка входа ─────────────────────────────────────────────────────

jQuery(async () => {
    const ctx = SillyTavern.getContext();

    ctx.eventSource.on(ctx.eventTypes.APP_READY, async () => {
        await initExtension();
    });
});