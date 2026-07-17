process.on('uncaughtException', err => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('./db');
const engine = require('./engine');
const memory = require('./memory');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { callLLM } = require('./llm');

const app = express();
app.use(cors());
app.use(express.json()); // Parses incoming JSON requests

// Serve static uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Serve static React frontend
const clientDistPath = path.join(__dirname, '../client/dist');
app.use(express.static(clientDistPath));

// Configure Multer for local image uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'public/uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});
const upload = multer({ storage: storage });

// Initialize the Database schemas
db.initDb();

// Setup Server and WebSockets
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const wsClients = new Set();

wss.on('connection', (ws) => {
    console.log('[WS] Frontend client connected.');
    wsClients.add(ws);

    ws.on('close', () => {
        console.log('[WS] Frontend client disconnected.');
        wsClients.delete(ws);
    });
});

// 0. Upload a file (image or any file)
app.post('/api/upload', upload.any(), (req, res) => {
    try {
        const file = req.files?.[0];
        if (!file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }
        const protocol = req.protocol;
        const host = req.get('host');
        const fileUrl = `${protocol}://${host}/uploads/${file.filename}`;
        res.json({ success: true, url: fileUrl });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// REST API ROUTES
// ─────────────────────────────────────────────────────────────

// 1. Get all characters (Contacts list)
app.get('/api/characters', (req, res) => {
    try {
        const characters = db.getCharacters();
        // Attach unread_count so the frontend can initialise badges correctly on load/refresh
        const enriched = characters.map(c => ({
            ...c,
            unread_count: db.getUnreadCount(c.id)
        }));
        res.json(enriched);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Add or Update Character
app.post('/api/characters', (req, res) => {
    try {
        const data = req.body;
        if (!data.id || !data.name) return res.status(400).json({ error: 'Отсутствует ID или имя' });

        db.updateCharacter(data.id, data);
        // Restart their engine timer by mimicking a user interaction / simple restart
        engine.stopTimer(data.id);
        engine.handleUserMessage(data.id, wsClients);

        res.json({ success: true, character: db.getCharacter(data.id) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2.5 Fetch available models from a given API endpoint (proxy to avoid CORS + key exposure in browser)
app.get('/api/models', async (req, res) => {
    try {
        const { endpoint, key } = req.query;
        if (!endpoint || !key) return res.status(400).json({ error: 'Отсутствует endpoint или ключ' });

        let baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
        if (baseUrl.endsWith('/chat/completions')) baseUrl = baseUrl.slice(0, -'/chat/completions'.length);
        const modelsUrl = `${baseUrl}/models`;

        const response = await fetch(modelsUrl, {
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
        });
        if (!response.ok) {
            const text = await response.text();
            return res.status(response.status).json({ error: `API ${response.status}: ${text.slice(0, 200)}` });
        }
        const data = await response.json();
        const models = (data.data || data.models || []).map(m => m.id || m.name || m).filter(Boolean).sort();
        res.json({ models });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Get messages for a character (supports ?limit=N and ?before=msgId for pagination)
app.get('/api/messages/:characterId', (req, res) => {
    try {
        const charId = req.params.characterId;
        const limit = parseInt(req.query.limit) || 100;
        const before = req.query.before;  // message ID cursor for older messages

        let messages;
        if (before) {
            messages = db.getMessagesBefore(charId, before, limit);
        } else {
            messages = db.getMessages(charId, limit);
            // Mark messages as read when user opens this chat (not when paging back)
            db.markMessagesRead(charId);
        }
        res.json(messages);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3.5 SillyTavern Context Interception (ST-ChatPulse Bridge)
app.post('/api/integrations/st/context', (req, res) => {
    try {
        const payload = req.body;
        if (!payload.st_character_id) return res.status(400).json({ error: 'Отсутствует st_character_id' });

        engine.updateSTContext(payload.st_character_id, {
            name: payload.st_character_name,
            userName: payload.st_user_name,
            persona: payload.st_persona,
            scenario: payload.st_scenario,
            history: payload.chat_history,
            lastSynced: Date.now()
        });

        // Auto-create character if they don't exist in ChatPulse DB
        const existingChar = db.getCharacter(payload.st_character_id);
        if (!existingChar) {
            console.log(`[ST-Sync] Auto-creating missing character in ChatPulse DB: ${payload.st_character_name}`);
            db.updateCharacter(payload.st_character_id, {
                id: payload.st_character_id,
                name: payload.st_character_name || 'ST Character',
                avatar: payload.st_avatar || `https://api.dicebear.com/7.x/pixel-art/svg?seed=${payload.st_character_id}`
            });
            wsClients.forEach(ws => {
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'refresh_contacts' }));
            });
        }

        res.json({ success: true, message: 'Контекст синхронизирован из SillyTavern' });
    } catch (e) {
        console.error('[ST-ChatPulse API] Error syncing context:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 3.6 SillyTavern Long-Term Memory Sync (ST-ChatPulse Bridge)
app.post('/api/integrations/st/sync_memory', (req, res) => {
    try {
        const payload = req.body;
        if (!payload.st_character_id || !payload.memory_summary) {
            return res.status(400).json({ error: 'Отсутствует st_character_id или memory_summary' });
        }

        // Auto-create character if they don't exist
        const existingChar = db.getCharacter(payload.st_character_id);
        if (!existingChar) {
            console.log(`[ST-Sync] Auto-creating missing character for memory push: ${payload.st_character_name}`);
            db.updateCharacter(payload.st_character_id, {
                id: payload.st_character_id,
                name: payload.st_character_name || 'ST Character',
                avatar: payload.st_avatar || `https://api.dicebear.com/7.x/pixel-art/svg?seed=${payload.st_character_id}`
            });
            wsClients.forEach(ws => {
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'refresh_contacts' }));
            });
        }

        // Push memory
        const memoryData = {
            time: new Date().toLocaleString(),
            location: 'SillyTavern',
            people: payload.st_character_name || 'ST Character',
            event: 'ST Context Summary',
            relationships: 'Bond building in SillyTavern',
            items: '',
            importance: 8,
            embedding: null
        };

        const memId = db.addMemory(payload.st_character_id, memoryData);

        // Let's actually append the summary text into the `event` or `relationships` field
        // Since it's a summary of the context, let's put it as the 'event'
        db.updateMemory(memId, {
            event: payload.memory_summary
        });

        console.log(`[ST-Sync] Received and saved memory summary for ${payload.st_character_id}`);
        res.json({ success: true, memory_id: memId });
    } catch (e) {
        console.error('[ST-ChatPulse API] Error syncing memory:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 4. Send a message to a character (User initiates)
app.post('/api/messages', (req, res) => {
    try {
        const { characterId, content } = req.body;
        if (!characterId || !content) return res.status(400).json({ error: 'Отсутствует characterId или содержимое' });

        const charObj = db.getCharacter(characterId);

        // If character has blocked the user, save message but return blocked flag
        if (!charObj || charObj.is_blocked) {
            const { id: msgId, timestamp: msgTs } = db.addMessage(characterId, 'user', content);
            const savedMessage = { id: msgId, character_id: characterId, role: 'user', content, timestamp: msgTs, isBlocked: true };
            engine.broadcastNewMessage?.(wsClients, savedMessage);
            return res.json({ success: true, blocked: true, message: savedMessage });
        }

        // Add user message to DB
        const { id: msgId, timestamp: msgTs } = db.addMessage(characterId, 'user', content);
        const savedMessage = { id: msgId, character_id: characterId, role: 'user', content, timestamp: msgTs };

        // Mark previous character messages as read
        db.markMessagesRead(characterId);

        // Push user message to UI via WS (before triggering AI reply for correct ordering)
        engine.broadcastNewMessage?.(wsClients, savedMessage);

        // Tell the engine to handle the user message: it will trigger an immediate reply
        engine.handleUserMessage(characterId, wsClients);

        // Check if other characters get jealous that user is talking to this character
        engine.triggerJealousyCheck(characterId, wsClients);

        // Asynchronously trigger memory extraction using the small AI
        const recentMessages = db.getMessages(characterId, 10);
        memory.extractMemoryFromContext(charObj, recentMessages).catch(e => console.error('[Memory] Background extraction error:', e));

        res.json({ success: true, message: savedMessage });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.5 Send a transfer to a character (Unblock mechanic)
app.post('/api/transfer', (req, res) => {
    try {
        const { characterId, amount, note } = req.body;
        if (!characterId) return res.status(400).json({ error: 'Отсутствует characterId' });

        const char = db.getCharacter(characterId);
        if (!char) return res.status(404).json({ error: 'Персонаж не найден' });

        // Create traceable transfer record in DB (deducts user wallet)
        const transferNote = note || 'Transfer';
        let tid;
        try {
            tid = db.createTransfer({
                charId: characterId,
                senderId: 'user',
                recipientId: characterId,
                amount: parseFloat(amount) || 0.01,
                note: transferNote,
                messageId: null
            });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }

        // Add user transfer message to DB
        const transferText = `[TRANSFER]${tid}|${amount || 0.01}|${transferNote}`;
        const { id: msgId, timestamp: msgTs } = db.addMessage(characterId, 'user', transferText);
        const savedMessage = { id: msgId, character_id: characterId, role: 'user', content: transferText, timestamp: msgTs };

        // Broadcast wallet update for user
        engine.broadcastWalletSync(wsClients, characterId);

        // Unblock them and reset pressure
        db.updateCharacter(characterId, {
            is_blocked: 0,
            pressure_level: 0
        });

        // Tell the engine to process the unblock reaction
        engine.handleUserMessage(characterId, wsClients);

        // Push user message to UI via WS
        engine.broadcastNewMessage?.(wsClients, savedMessage);

        res.json({ success: true, unblocked: true, message: savedMessage });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.55 Generate Character via LLM
app.post('/api/characters/generate', async (req, res) => {
    try {
        const { query, api_endpoint, api_key, model_name } = req.body;
        if (!query || !api_endpoint || !api_key || !model_name) {
            return res.status(400).json({ error: 'Отсутствуют необходимые API ключи или описание запроса.' });
        }

        const systemPrompt = `Ты — профессиональный генератор RPG-персонажей. Создай детальную личность персонажа и описание мира на основе описания пользователя. Персонаж предназначен для реалистичной симуляции общения в мессенджере. Верни ТОЛЬКО сырой JSON-объект без форматирования markdown. Не включай блоки \`\`\`json.
КРИТИЧЕСКИЕ ПРАВИЛА JSON:
1. Все переносы строк внутри строковых значений должны быть экранированы как \\n (не выводи буквенные переносы строк внутри строк).
2. НЕ добавляй комментарии (например, // или /* */).
3. НЕ ставь завершающие запятые.
4. Держи ВСЕ текстовые поля максимально краткими (макс. 2-3 предложения на поле), чтобы генерация не обрывалась.

JSON ОБЯЗАТЕЛЬНО должен содержать СЛЕДУЮЩИЕ ключи:
- "name" (string, имя персонажа)
- "persona" (string, очень подробный психологический профиль от первого лица и речевые привычки)
- "world_info" (string, детальная предыстория сеттинга и отношения к пользователю)
- "affinity" (number 0-100, начальный уровень отношений, целое число)
- "sys_pressure" (number 0 или 1, 1 если персонаж склонен к тревоге/стрессу)
- "sys_jealousy" (number 0 или 1, 1 если персонаж собственник/ревнив)
- "interval_min" (number, рекомендуемый минимум минут между активными сообщениями, целое число)
- "interval_max" (number, рекомендуемый максимум минут, целое число)
`;

        const generatedText = await callLLM({
            endpoint: api_endpoint,
            key: api_key,
            model: model_name,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: query }],
            maxTokens: 1500,
            temperature: 0.7
        });

        console.log(`[Generator Raw Output]`, generatedText);

        // Aggressively strip markdown formatting
        let cleanText = generatedText.replace(/```json/gi, '').replace(/```/g, '').trim();

        const startIdx = cleanText.indexOf('{');
        const endIdx = cleanText.lastIndexOf('}');
        if (startIdx !== -1 && endIdx !== -1) {
            const jsonText = cleanText.slice(startIdx, endIdx + 1);
            let parsed;
            try {
                parsed = JSON.parse(jsonText);
            } catch (err) {
                console.error('JSON.parse failed on this string:\n', jsonText);
                throw new Error('LLM JSON Syntax Error: ' + err.message);
            }

            // Set defaults and formatting
            parsed.avatar = `https://api.dicebear.com/7.x/notionists/svg?seed=${encodeURIComponent(parsed.name || 'AI')}&backgroundColor=f0f0f0`;
            parsed.api_endpoint = api_endpoint;
            parsed.api_key = api_key;
            parsed.model_name = model_name;
            parsed.sys_timer = 1;
            parsed.sys_proactive = 1;

            return res.json({ success: true, character: parsed });
        } else {
            console.error('Failed to find JSON brackets in cleanText:', cleanText);
            throw new Error('LLM did not return a valid JSON object. Check Server Logs.');
        }
    } catch (e) {
        console.error('Generation Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 4.6 Clear messages for a character (Legacy Soft Clear)
app.delete('/api/messages/:characterId', (req, res) => {
    try {
        db.clearMessages(req.params.characterId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.7 DEEP WIPE: Clear all messages, sql memories, moments, diaries, and vectors
app.delete('/api/data/:characterId', async (req, res) => {
    try {
        const id = req.params.characterId;

        // ⚡ Stop the engine timer FIRST to minimize race-condition window
        engine.stopTimer(id);

        // Clear all data
        db.clearMessages(id);
        db.clearMemories(id);
        db.clearMoments(id);
        db.clearDiaries(id);
        db.clearFriends(id);
        db.clearCharRelationships(id); // Also wipe inter-char social bonds
        await memory.wipeIndex(id);

        // Reset core emotional stats, wallet, AND diary lock state
        db.updateCharacter(id, {
            affinity: 50,
            pressure_level: 0,
            is_blocked: 0,
            is_diary_unlocked: 0,
            wallet: 200,
            diary_password: null
        });
        // Immediately assign a fresh diary password
        const newPw = String(Math.floor(1000 + Math.random() * 9000));
        db.setDiaryPassword(id, newPw);

        // Add wipe notice (engine's anti-wipe check looks for this message)
        db.addMessage(id, 'system', '[System] Вся история чата, долговременная память, векторы, моменты и дневник были полностью очищены. Этот персонаж теперь чистый лист.');

        // Restart the character's engine timer so they resume proactive messaging
        engine.handleUserMessage(id, wsClients);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.8 EXPORT: Export character data (settings, messages, memories, moments)
app.get('/api/data/:characterId/export', (req, res) => {
    try {
        const data = db.exportCharacterData(req.params.characterId);
        if (!data) return res.status(404).json({ error: 'Персонаж не найден' });

        // Return as a downloadable JSON file
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.characterId}_export.json"`);
        res.send(JSON.stringify(data, null, 2));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Get Memories for Character
app.get('/api/memories/:characterId', (req, res) => {
    try {
        const mems = db.getMemories(req.params.characterId);
        res.json(mems);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5.5 Trigger Manual Memory Extraction
app.post('/api/memories/:characterId/extract', async (req, res) => {
    try {
        const charObj = db.getCharacter(req.params.characterId);
        if (!charObj) return res.status(404).json({ error: 'Персонаж не найден' });

        if (!charObj.memory_api_endpoint || !charObj.memory_api_key || !charObj.memory_model_name) {
            return res.status(400).json({ error: 'Учётные данные Memory AI (Малая Модель) не настроены для этого персонажа. Пожалуйста, настройте их в настройках.' });
        }

        const recentMessages = db.getMessages(req.params.characterId, 15);
        if (recentMessages.length === 0) {
            return res.status(400).json({ error: 'Нет недавних сообщений для извлечения памяти.' });
        }

        const extracted = await memory.extractMemoryFromContext(charObj, recentMessages);

        if (extracted) {
            res.json({ success: true, message: 'Память успешно извлечена!', data: extracted });
        } else {
            res.json({ success: true, message: 'ИИ проанализировал чат, но не нашёл новых значимых воспоминаний для извлечения.' });
        }
    } catch (e) {
        console.error('Manual extraction failed:', e);
        res.status(500).json({ error: e.message });
    }
});

// 6. Delete a Memory manually
app.delete('/api/memories/:id', (req, res) => {
    try {
        db.deleteMemory(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. Get All Moments
app.get('/api/moments', (req, res) => {
    try {
        const allMoments = db.getMoments();
        const characters = db.getCharacters();
        const blockedCharIds = characters.filter(c => c.is_blocked).map(c => c.id);
        // Allow user-posted moments (character_id = 'user')
        const visibleMoments = allMoments.filter(m => m.character_id === 'user' || !blockedCharIds.includes(m.character_id));

        // Enrich each moment with likes and comments
        const enriched = visibleMoments.map(m => ({
            ...m,
            likers: db.getLikesForMoment(m.id).map(l => l.liker_id),
            comments: db.getComments(m.id)
        }));
        res.json(enriched);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// User posts a Moment
app.post('/api/moments', (req, res) => {
    try {
        const { content, image_url } = req.body;
        if (!content) return res.status(400).json({ error: 'Требуется содержимое' });
        const id = db.addMoment('user', content, image_url || null);
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7.5 Delete a Moment (user only)
app.delete('/api/moments/:id', (req, res) => {
    try {
        db.deleteMoment(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8. Get Moments for a specific character
app.get('/api/moments/:characterId', (req, res) => {
    try {
        const char = db.getCharacter(req.params.characterId);
        if (char && char.is_blocked) return res.json([]);
        const moments = db.getCharacterMoments(req.params.characterId);
        res.json(moments);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8.5 Toggle Like on a Moment
app.post('/api/moments/:id/like', (req, res) => {
    try {
        const { liker_id } = req.body;  // 'user' or character id
        const liked = db.toggleLike(req.params.id, liker_id || 'user');
        const likers = db.getLikesForMoment(req.params.id).map(l => l.liker_id);
        res.json({ success: true, liked, likers });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8.6 Add a Comment on a Moment
app.post('/api/moments/:id/comment', (req, res) => {
    try {
        const { author_id, content } = req.body;
        if (!content) return res.status(400).json({ error: 'Требуется содержимое' });
        const commentId = db.addComment(req.params.id, author_id || 'user', content);
        res.json({ success: true, id: commentId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 9. Get Diaries for a Character
app.get('/api/diaries/:characterId', (req, res) => {
    try {
        const char = db.getCharacter(req.params.characterId);
        const diaries = db.getDiaries(req.params.characterId);
        res.json({
            isUnlocked: char ? char.is_diary_unlocked === 1 : false,
            entries: diaries
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 10. Unlock Diaries for a Character (Password-lock mechanic)
app.post('/api/diaries/:characterId/unlock', (req, res) => {
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ success: false, reason: 'Пароль не указан.' });
        const result = db.verifyAndUnlockDiary(req.params.characterId, password);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(403).json({ success: false, reason: result.reason });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 10.5 Hide a range of messages for a character (context hide mechanic)
// Body: { startIdx: 0, endIdx: 10 } — 0-based indices from oldest message
app.post('/api/messages/:characterId/hide', (req, res) => {
    try {
        const { startIdx, endIdx } = req.body;
        if (startIdx === undefined || endIdx === undefined) {
            return res.status(400).json({ error: 'Отсутствует startIdx или endIdx' });
        }
        const count = db.hideMessagesByRange(req.params.characterId, Number(startIdx), Number(endIdx));
        res.json({ success: true, hidden: count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 10.6 Unhide all messages for a character
app.post('/api/messages/:characterId/unhide', (req, res) => {
    try {
        const count = db.unhideMessages(req.params.characterId);
        res.json({ success: true, unhidden: count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 11. User Profile
app.get('/api/user', (req, res) => {
    try {
        const profile = db.getUserProfile();
        res.json(profile);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/user', (req, res) => {
    try {
        db.updateUserProfile(req.body);
        // If group proactive settings changed, restart all group timers immediately
        const proactiveKeys = ['group_proactive_enabled', 'group_interval_min', 'group_interval_max'];
        if (proactiveKeys.some(k => k in req.body)) {
            engine.startGroupProactiveTimers(wsClients);
        }
        res.json({ success: true, profile: db.getUserProfile() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 11.5 Theme Generation Helper
app.get('/api/theme-guide', (req, res) => {
    try {
        const guideText = `ChatPulse — Руководство по генерации темы

Ты — эксперт UI/UX-дизайнер. Создай кастомную тему для приложения ChatPulse.
ChatPulse использует строгую систему CSS-переменных на уровне :root.
Сгенерируй JSON-объект со следующими ключами и HEX-значениями цветов, формирующими целостную красивую тему:

{
  "--bg-main": "Основной цвет фона приложения (например, #F8F0F5)",
  "--bg-sidebar": "Фон левой навигационной панели (например, #2A2D3E)",
  "--bg-sidebar-hover": "Состояние наведения для иконок боковой панели (например, rgba(255,255,255,0.1))",
  "--bg-contacts": "Фон среднего столбца со списком контактов (например, #F0F4FA)",
  "--bg-chat-area": "Фон правой области чата (например, #F8F0F5)",
  "--bg-input": "Фон поля ввода сообщения (например, #FFFFFF)",
  "--text-primary": "Основной цвет текста для чтения (например, #333333)",
  "--text-secondary": "Приглушённый текст / временные метки (например, #999999)",
  "--bubble-user-bg": "Фон моих сообщений (например, #B8D4F0)",
  "--bubble-user-text": "Цвет текста моих сообщений (например, #333333)",
  "--bubble-ai-bg": "Фон сообщений ИИ (например, #FFF0F5)",
  "--bubble-ai-text": "Цвет текста сообщений ИИ (например, #333333)",
  "--accent-color": "Основной брендовый цвет для активных элементов/кнопок (например, #7B9FE0)",
  "--accent-hover": "Состояние наведения для основных кнопок (например, #9BB5E8)",
  "--border-color": "Тонкие границы между панелями (например, #E0E0E0)"
}

Выведи только сырой валидный JSON-объект без форматирования markdown и пояснений. Мне нужно загрузить это напрямую в приложение.`;

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="chatpulse-theme-prompt.txt"');
        res.send(guideText);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 11.6 AI Theme Generation
app.post('/api/theme/generate', async (req, res) => {
    try {
        const { query, api_endpoint, api_key, model_name } = req.body;
        if (!query || !api_endpoint || !api_key || !model_name) {
            return res.status(400).json({ error: 'Отсутствуют необходимые API ключи или описание темы.' });
        }

        const systemPrompt = `Ты — эксперт UI/UX-дизайнер. Создай кастомную тему для чат-приложения на основе запроса пользователя.
Верни ТОЛЬКО сырой JSON-объект без форматирования markdown. Не включай блоки \`\`\`json.
JSON ОБЯЗАТЕЛЬНО должен содержать ТОЧНО следующие ключи с валидными 6-значными HEX-кодами цветов (например, #F8F0F5):
- "--bg-main" (Основной цвет фона приложения)
- "--bg-sidebar" (Фон левой навигационной панели)
- "--bg-contacts" (Фон среднего столбца со списком контактов)
- "--bg-chat-area" (Фон правой области чата)
- "--bg-input" (Фон поля ввода сообщения)
- "--text-primary" (Основной цвет текста)
- "--text-secondary" (Приглушённый текст / временные метки)
- "--bubble-user-bg" (Фон моих сообщений)
- "--bubble-user-text" (Цвет текста моих сообщений)
- "--bubble-ai-bg" (Фон сообщений ИИ)
- "--bubble-ai-text" (Цвет текста сообщений ИИ)
- "--accent-color" (Брендовый цвет для активных элементов/кнопок)
- "--accent-hover" (Состояние наведения для кнопок)
- "--border-color" (Тонкие границы между панелями)
`;

        const generatedText = await callLLM({
            endpoint: api_endpoint,
            key: api_key,
            model: model_name,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: query }],
            maxTokens: 800,
            temperature: 0.7
        });

        console.log(`[Theme Generator Raw Output]`, generatedText);

        // Aggressively strip markdown formatting
        let cleanText = generatedText.replace(/```json/gi, '').replace(/```/g, '').trim();

        const startIdx = cleanText.indexOf('{');
        const endIdx = cleanText.lastIndexOf('}');
        if (startIdx !== -1 && endIdx !== -1) {
            const jsonText = cleanText.slice(startIdx, endIdx + 1);
            try {
                const parsed = JSON.parse(jsonText);
                return res.json({ success: true, theme_config: parsed });
            } catch (err) {
                console.error('JSON.parse failed on this theme string:\n', jsonText);
                throw new Error('LLM JSON Syntax Error: ' + err.message);
            }
        } else {
            console.error('Failed to find JSON brackets in cleanText:', cleanText);
            throw new Error('LLM did not return a valid JSON object. Check Server Logs.');
        }
    } catch (e) {
        console.error('Theme Generation Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 12. Delete Character
app.delete('/api/characters/:id', (req, res) => {
    try {
        engine.stopTimer(req.params.id);
        db.deleteCharacter(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 13. Friendships
app.get('/api/characters/:id/friends', (req, res) => {
    try {
        const friends = db.getFriends(req.params.id);
        res.json(friends);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/characters/:id/friends', async (req, res) => {
    try {
        const { target_id } = req.body;
        if (!target_id) return res.status(400).json({ error: 'Требуется target_id' });

        const added = db.addFriend(req.params.id, target_id);
        if (added) {
            const sourceChar = db.getCharacter(req.params.id);
            const targetChar = db.getCharacter(target_id);
            if (sourceChar && targetChar) {
                db.addMessage(req.params.id, 'user', `[CONTACT_CARD:${targetChar.id}:${targetChar.name}:${targetChar.avatar}]`);
                db.addMessage(target_id, 'user', `[CONTACT_CARD:${sourceChar.id}:${sourceChar.name}:${sourceChar.avatar}]`);

                // Generate initial impressions for both characters via LLM (fire-and-forget)
                const generateImpression = async (fromChar, toChar) => {
                    const tryGenerate = async (withSystem) => {
                        const fromPersona = (fromChar.persona || '').substring(0, 200);
                        const toPersona = (toChar.persona || '').substring(0, 200);
                        const userPrompt = `You are ${fromChar.name}. Your personality: ${fromPersona} \nYou were just introduced to someone named "${toChar.name}".Their description: ${toPersona}.\nRespond with ONLY a valid JSON object, no markdown, no extra text: \n{ "affinity": <integer 1 - 100 >, "impression": "<one sentence>" } `;
                        const messages = withSystem
                            ? [{ role: 'system', content: 'You are a JSON-only response bot. Output only a raw JSON object.' }, { role: 'user', content: userPrompt }]
                            : [{ role: 'user', content: userPrompt }];
                        const result = await callLLM({
                            endpoint: fromChar.api_endpoint,
                            key: fromChar.api_key,
                            model: fromChar.model_name,
                            messages,
                            maxTokens: 200,
                            temperature: 0.3
                        });
                        if (!result || !result.trim()) {
                            console.warn(`[Social] LLM returned empty for ${fromChar.name}→${toChar.name} (withSystem = ${withSystem})`);
                            return null;
                        }
                        console.log(`[Social] Raw LLM output for ${fromChar.name}→${toChar.name}: ${result.substring(0, 300)} `);
                        const cleaned = (result || '').replace(/```[a - z] *\n ? /gi, '').replace(/```/g, '').trim();
                        const m = cleaned.match(/\{[\s\S]*\}/);
                        if (m) {
                            try {
                                const parsed = JSON.parse(m[0]);
                                if (parsed.impression) {
                                    return { affinity: Math.max(1, Math.min(100, parseInt(parsed.affinity) || 50)), impression: String(parsed.impression).substring(0, 200) };
                                }
                            } catch (e) { /* JSON.parse failed */ }
                        }
                        // Simple regex extraction
                        const aNum = cleaned.match(/affinity\D*(\d+)/i);
                        const iText = cleaned.match(/impression\D{0,5}["'](.+?)["']/is) || cleaned.match(/impression\D{0,5}(.+)/is);
                        if (aNum && iText) {
                            const imp = iText[1].replace(/["'}\]]+\s*$/, '').trim();
                            if (imp.length > 2) return { affinity: Math.max(1, Math.min(100, parseInt(aNum[1]) || 50)), impression: imp.substring(0, 200) };
                        }
                        // Fallback: affinity found but no impression — use default
                        if (aNum) {
                            const aVal = Math.max(1, Math.min(100, parseInt(aNum[1]) || 50));
                            const defaultImp = aVal >= 70 ? 'Выглядит интересно, хотелось бы узнать побольше.'
                                : aVal >= 40 ? 'Пока без особых чувств.' : 'Не уверен(а) насчёт этого человека.';
                            return { affinity: aVal, impression: defaultImp };
                        }
                        return null;
                    };

                    try {
                        // Attempt 1: with system role (GPT-4/Grok)
                        let result = await tryGenerate(true);
                        if (!result) {
                            console.warn(`[Social] Attempt 1 failed for ${fromChar.name}→${toChar.name}, retrying without system role(Gemini fallback)`);
                            // Attempt 2: without system role (Gemini native API)
                            result = await tryGenerate(false);
                        }

                        if (result) {
                            db.initCharRelationship(fromChar.id, toChar.id, result.affinity, result.impression, 'recommend');
                            console.log(`[Social] ${fromChar.name}→${toChar.name}: affinity = ${result.affinity}, "${result.impression}"`);
                        } else {
                            console.warn(`[Social] Both attempts failed for ${fromChar.name}→${toChar.name}, storing empty impression`);
                            db.initCharRelationship(fromChar.id, toChar.id, 50, '', 'recommend');
                        }
                    } catch (err) {
                        console.error(`[Social] Impression error ${fromChar.name}→${toChar.name}: `, err.message);
                        db.initCharRelationship(fromChar.id, toChar.id, 50, '', 'recommend');
                    }
                };

                // Generate both impressions in parallel (don't block the response)
                Promise.all([
                    generateImpression(sourceChar, targetChar),
                    generateImpression(targetChar, sourceChar)
                ]).catch(e => console.error('[Social] Impression generation error:', e));
            }
        }
        res.json({ success: true, added });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 13.5 Get character relationships (inter-char affinity)
app.get('/api/characters/:id/relationships', (req, res) => {
    try {
        const relationships = db.getCharRelationships(req.params.id);
        // Enrich with character names and avatars — skip if target no longer exists
        const enriched = relationships
            .filter(r => db.getCharacter(r.targetId) !== undefined)
            .map(r => {
                const targetChar = db.getCharacter(r.targetId);
                return {
                    ...r,
                    targetName: targetChar?.name || 'Unknown',
                    targetAvatar: targetChar?.avatar || ''
                };
            });
        res.json(enriched);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 13.6 Regenerate impression for a specific relationship pair
app.post('/api/characters/:id/relationships/regenerate', async (req, res) => {
    try {
        const { target_id } = req.body;
        if (!target_id) return res.status(400).json({ error: 'Требуется target_id' });
        const fromChar = db.getCharacter(req.params.id);
        const toChar = db.getCharacter(target_id);
        if (!fromChar || !toChar) return res.status(404).json({ error: 'Персонаж не найден' });

        const fromPersona = (fromChar.persona || '').substring(0, 200);
        const toPersona = (toChar.persona || '').substring(0, 200);
        const userPrompt = `You are ${fromChar.name}. Your personality: ${fromPersona} \nYou just met someone named "${toChar.name}".Their description: ${toPersona}.\nRespond with ONLY a valid JSON object, no markdown, no extra text: \n{ "affinity": <integer 1 - 100 >, "impression": "<one sentence first impression>" } `;

        const tryCall = async (withSystem) => {
            const messages = withSystem
                ? [{ role: 'system', content: 'You are a JSON-only response bot. Output only a raw JSON object.' }, { role: 'user', content: userPrompt }]
                : [{ role: 'user', content: userPrompt }];
            let result;
            try {
                result = await callLLM({
                    endpoint: fromChar.api_endpoint,
                    key: fromChar.api_key,
                    model: fromChar.model_name,
                    messages,
                    maxTokens: 200,
                    temperature: 0.3
                });
            } catch (llmErr) {
                console.warn(`[Social / Regen] LLM call error for ${fromChar.name}→${toChar.name} (withSystem = ${withSystem}): ${llmErr.message}`);
                return null;
            }
            if (!result || !result.trim()) {
                console.warn(`[Social / Regen] LLM returned empty for ${fromChar.name}→${toChar.name} (withSystem = ${withSystem})`);
                return null;
            }
            console.log(`[Social / Regen] Raw LLM output for ${fromChar.name}→${toChar.name}: ${result.substring(0, 400)} `);
            try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'data', 'debug_regen.txt'), `[${new Date().toISOString()}] ${fromChar.name}→${toChar.name} (withSystem = ${withSystem}): \n${result} \n-- -\n`, { flag: 'a' }); } catch (e) { }
            const cleaned = (result || '').replace(/```[a - z] *\n ? /gi, '').replace(/```/g, '').trim();

            // Strategy 1: standard JSON.parse on the largest {...} block
            const m = cleaned.match(/\{[\s\S]*\}/);
            if (m) {
                try {
                    const parsed = JSON.parse(m[0]);
                    if (parsed.impression) {
                        return { affinity: Math.max(1, Math.min(100, parseInt(parsed.affinity) || 50)), impression: String(parsed.impression).substring(0, 200), _raw: cleaned };
                    }
                } catch (e) {
                    console.log('[Social/Regen] JSON.parse failed:', e.message, 'Input:', m[0].substring(0, 150));
                }
            }

            // Strategy 2: simple number + text extraction
            const aNum = cleaned.match(/affinity\D*(\d+)/i);
            const iText = cleaned.match(/impression\D{0,5}["'](.+?)["']/is) || cleaned.match(/impression\D{0,5}(.+)/is);
            console.log('[Social/Regen] Strategy 2:', 'aNum=', aNum?.[1], 'iText=', iText?.[1]?.substring(0, 80));
            if (aNum && iText) {
                const imp = iText[1].replace(/["'}\]]+\s*$/, '').trim();
                if (imp.length > 2) {
                    return { affinity: Math.max(1, Math.min(100, parseInt(aNum[1]) || 50)), impression: imp.substring(0, 200), _raw: cleaned };
                }
            }

            // Strategy 3: if affinity number found, use any remaining text as impression
            if (aNum) {
                const leftover = cleaned.replace(/[{}]/g, '').replace(/affinity\D*\d+/i, '').replace(/impression/i, '').replace(/["':,]/g, ' ').trim();
                console.log('[Social/Regen] Strategy 3 leftover:', leftover.substring(0, 100));
                if (leftover.length > 3) {
                    return { affinity: Math.max(1, Math.min(100, parseInt(aNum[1]) || 50)), impression: leftover.substring(0, 200), _raw: cleaned };
                }
            }
            // Strategy 4: affinity found but absolutely no impression text — generate a default one
            if (aNum) {
                const aVal = Math.max(1, Math.min(100, parseInt(aNum[1]) || 50));
                const defaultImp = aVal >= 70 ? 'Выглядит интересно, хотелось бы узнать побольше.'
                    : aVal >= 40 ? 'Пока без особых чувств.'
                        : 'Не уверен(а) насчёт этого человека.';
                console.log(`[Social / Regen] Strategy 4: using default impression for affinity = ${aVal}`);
                return { affinity: aVal, impression: defaultImp, _raw: cleaned };
            }

            console.warn('[Social/Regen] All strategies failed. Cleaned:', cleaned.substring(0, 300));
            return null;
        };

        let out = await tryCall(true);
        if (!out) {
            console.warn(`[Social / Regen] Attempt 1 failed for ${fromChar.name}→${toChar.name}, retrying without system role`);
            out = await tryCall(false);
        }
        if (!out) return res.status(500).json({ error: `Обе попытки не вернули валидный JSON. Проверьте конфигурацию вашего Gemini API.` });

        db.initCharRelationship(fromChar.id, toChar.id, out.affinity, out.impression, 'recommend');
        res.json({ success: true, affinity: out.affinity, impression: out.impression });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 14.1 List all groups
app.get('/api/groups', (req, res) => {
    try {
        res.json(db.getGroups());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 14.2 Create a group
app.post('/api/groups', (req, res) => {
    try {
        const { name, member_ids } = req.body;
        if (!name || !member_ids || member_ids.length === 0) {
            return res.status(400).json({ error: 'Требуются name и member_ids' });
        }
        const id = 'group_' + Date.now();
        // Generate a group avatar mosaic from members
        const firstMember = db.getCharacter(member_ids[0]);
        const avatar = firstMember?.avatar || 'https://api.dicebear.com/7.x/shapes/svg?seed=' + id;
        db.createGroup(id, name, member_ids, avatar);
        res.json({ success: true, group: db.getGroup(id) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 14.3 Get group messages
app.get('/api/groups/:id/messages', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        res.json(db.getGroupMessages(req.params.id, limit));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 14.5 Hide/Unhide group messages (context hide mechanic)
app.post('/api/groups/:id/messages/hide', (req, res) => {
    try {
        const { start, end } = req.body;
        const hidden = db.hideGroupMessagesByRange(req.params.id, start, end);
        res.json({ success: true, hidden });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/groups/:id/messages/unhide', (req, res) => {
    try {
        const unhidden = db.unhideGroupMessages(req.params.id);
        res.json({ success: true, unhidden });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 14.6 Add member to group
app.post('/api/groups/:id/members', (req, res) => {
    try {
        const { member_id } = req.body;
        if (!member_id) return res.status(400).json({ error: 'Требуется member_id' });
        db.addGroupMember(req.params.id, member_id);
        res.json({ success: true, group: db.getGroup(req.params.id) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 14.7 Kick member from group
app.delete('/api/groups/:id/members/:memberId', (req, res) => {
    try {
        db.removeGroupMember(req.params.id, req.params.memberId);
        res.json({ success: true, group: db.getGroup(req.params.id) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 14.8 Dissolve (delete) group
app.delete('/api/groups/:id', (req, res) => {
    try {
        db.deleteGroup(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 14.9 Clear group messages
app.delete('/api/groups/:id/messages', (req, res) => {
    try {
        db.clearGroupMessages(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Group Chat Debounce System ─────────────────────────────────────────
// When user sends multiple messages quickly, we wait until they stop, then fire ONE AI reply chain.
const groupDebounceTimers = {}; // { groupId: timeoutHandle }
const groupReplyLock = {};     // { groupId: true } — prevent overlapping chains
const pausedGroups = new Set(); // groups where AI replies are paused by user
const noChainGroups = new Set(); // groups where AI→AI secondary @-mention chains are blocked

// 14.10 Set AI pause for a group
app.post('/api/groups/:id/ai-pause', (req, res) => {
    const id = req.params.id;
    // Allow explicitly setting state from request body, otherwise fallback to toggle
    const wantsPause = req.body && req.body.paused !== undefined ? req.body.paused : !pausedGroups.has(id);

    if (!wantsPause) {
        pausedGroups.delete(id);
        // Restart proactive timer if it was running
        engine.scheduleGroupProactive(id, wsClients);
        res.json({ paused: false });
    } else {
        pausedGroups.add(id);
        engine.stopGroupProactiveTimer(id);
        // Clear any pending debounce/chaining locks instantly
        if (groupDebounceTimers[id]) { clearTimeout(groupDebounceTimers[id]); delete groupDebounceTimers[id]; }
        delete groupReplyLock[id];
        res.json({ paused: true });
    }
});

app.get('/api/groups/:id/ai-pause', (req, res) => {
    res.json({ paused: pausedGroups.has(req.params.id) });
});

// 14.11 Toggle AI→AI secondary @-mention chain for a group
app.post('/api/groups/:id/no-chain', (req, res) => {
    const id = req.params.id;
    if (noChainGroups.has(id)) {
        noChainGroups.delete(id);
        res.json({ noChain: false });
    } else {
        noChainGroups.add(id);
        res.json({ noChain: true });
    }
});

app.get('/api/groups/:id/no-chain', (req, res) => {
    res.json({ noChain: noChainGroups.has(req.params.id) });
});

function triggerGroupAIChain(groupId, wsClients, mentionedIds = [], isAtAll = false) {
    if (pausedGroups.has(groupId)) return; // AI replies paused by user
    if (groupReplyLock[groupId]) return; // already running
    groupReplyLock[groupId] = true;

    const group = db.getGroup(groupId);
    if (!group) { delete groupReplyLock[groupId]; return; }

    const charMembers = group.members.filter(m => m.member_id !== 'user');
    // Fisher-Yates shuffle
    const shuffled = [...charMembers];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        // Ensure explicitly mentioned chars are moved to the front so they reply first
    }
    // Re-order: mentioned chars first, rest after
    const mentionedFirst = [
        ...shuffled.filter(m => mentionedIds.includes(m.member_id) || isAtAll),
        ...shuffled.filter(m => !mentionedIds.includes(m.member_id) && !isAtAll)
    ];

    (async () => {
        const pendingSecondaryChains = []; // collect @mention triggers to fire AFTER lock release
        try {
            for (const member of mentionedFirst) {
                const char = db.getCharacter(member.member_id);
                if (!char || char.is_blocked) continue;
                const isMentioned = mentionedIds.includes(char.id) || isAtAll;
                // Mentioned chars bypass skip rate; others use the configured rate
                if (!isMentioned) {
                    const skipProfile = db.getUserProfile();
                    const skipRate = (skipProfile?.group_skip_rate ?? 10) / 100;
                    if (Math.random() < skipRate) continue;
                }

                // Broadcast "typing" indicator
                const typingPayload = JSON.stringify({ type: 'group_typing', data: { group_id: groupId, sender_id: char.id, name: char.name } });
                wsClients.forEach(c => { if (c.readyState === 1) c.send(typingPayload); });

                // Random delay 2-5 seconds before this character speaks
                const delay = Math.floor(2000 + Math.random() * 3000);
                await new Promise(resolve => setTimeout(resolve, delay));

                try {
                    // Re-fetch messages RIGHT NOW so this char sees all prior replies
                    const userProfile = db.getUserProfile();
                    const groupMsgLimit = userProfile?.group_msg_limit ?? 20;
                    const recentGroupMsgs = db.getVisibleGroupMessages(groupId, groupMsgLimit);
                    const userName = userProfile?.name || 'User';

                    const history = recentGroupMsgs.map(m => {
                        const senderName = m.sender_id === 'user' ? userName : (db.getCharacter(m.sender_id)?.name || m.sender_name || 'Unknown');
                        return { role: m.sender_id === char.id ? 'assistant' : 'user', content: `[${senderName}]: ${m.content} ` };
                    });

                    // Build relationship-aware member descriptions
                    const otherMembers = group.members.filter(m => m.member_id !== char.id);
                    const knownMembers = [];
                    const unknownMembers = [];

                    for (const m of otherMembers) {
                        if (m.member_id === 'user') {
                            const userRel = db.getCharRelationship(char.id, 'user');
                            knownMembers.push(`- ${userName} (уровень отношений: ${userRel?.affinity ?? char.affinity ?? 50})`);
                            continue;
                        }
                        const otherChar = db.getCharacter(m.member_id);
                        if (!otherChar) continue;
                        const rel = db.getCharRelationship(char.id, otherChar.id);
                        if (rel && rel.isAcquainted) {
                            knownMembers.push(`- ${otherChar.name} (уровень отношений: ${rel.affinity}, впечатление: «${rel.impression}»)`);
                        } else {
                            unknownMembers.push(`- ${otherChar.name} (ты не знаешь этого человека, только имя)`);
                        }
                    }

                    let relationSection = '';
                    if (knownMembers.length > 0) {
                        relationSection += `\nЗнакомые тебе люди:\n${knownMembers.join('\n')} `;
                    }
                    if (unknownMembers.length > 0) {
                        relationSection += `\nНезнакомые тебе люди:\n${unknownMembers.join('\n')} `;
                    }

                    // List char's own recent messages to prevent repetition
                    const charOwnRecent = recentGroupMsgs
                        .filter(m => m.sender_id === char.id)
                        .slice(-3)
                        .map(m => `"${m.content}"`)
                        .join(', ');
                    const noRepeatNote = charOwnRecent
                        ? `\nВАЖНО: Ты недавно говорил: ${charOwnRecent}. НЕ повторяй и не перефразируй это. Скажи что-то новое.`
                        : '';
                    const mentionNote = isMentioned
                        ? `\n[УПОМИНАНИЕ]: Кто-то только что @упомянул тебя напрямую! Ты ОБЯЗАН ответить на это сообщение — не игнорируй его.`
                        : '';

                    const systemPrompt = `Ты — ${char.name}, ты общаешься в групповом чате под названием «${group.name}».
(Внимание: это групповой чат, а не личная переписка.)

Персонаж: ${char.persona || 'Без конкретного персонажа.'}
${relationSection}
${noRepeatNote}${mentionNote}

Инструкции:
1. Оставайся в роли. Будь неформальным и разговорчивым.
2. Ты общаешься в группе. Пиши коротко (1-2 предложения).
3. Реагируй естественно на разговор. Не выдумывай ответы насильно.
4. НЕ добавляй префикс со своим именем или скобки. Просто говори естественно.
5. Выводи ТОЛЬКО текст своего ответа. Никогда не повторяй то, что только что сказал.
6. Если твои чувства к кому-то в группе изменились, добавь в конце: [CHAR_AFFINITY:id_персонажа:+5] или [CHAR_AFFINITY:id_персонажа:-10].
7. Ты МОЖЕШЬ использовать @Имя, чтобы напрямую обратиться к конкретному человеку в группе (например, «@${userName} ...», «@${charMembers.map(m => db.getCharacter(m.member_id)?.name).filter(Boolean).join('", "@')}»). Когда хочешь привлечь чьё-то внимание, упомяни их через @Имя.`;

                    const reply = await callLLM({
                        endpoint: char.api_endpoint,
                        key: char.api_key,
                        model: char.model_name,
                        messages: [{ role: 'system', content: systemPrompt }, ...history],
                        maxTokens: char.max_tokens || 500
                    });


                    if (reply && reply.trim()) {
                        let cleanReply = reply.trim();

                        // ── Parse [CHAR_AFFINITY:targetId:delta] — inter-char affinity changes ──
                        const charAffinityRegex = /\[CHAR_AFFINITY:([^:]+):([+-]?\d+)\]/gi;
                        let affinityMatch;
                        while ((affinityMatch = charAffinityRegex.exec(cleanReply)) !== null) {
                            const targetId = affinityMatch[1].trim();
                            const delta = parseInt(affinityMatch[2], 10);
                            if (targetId && !isNaN(delta)) {
                                const groupSource = `group:${groupId}`;
                                const existing = db.getCharRelationship(char.id, targetId);
                                const existingGroupRow = existing?.sources?.find(s => s.source === groupSource);
                                const currentGroupAffinity = existingGroupRow?.affinity || 50;
                                const newAffinity = Math.max(0, Math.min(100, currentGroupAffinity + delta));
                                db.updateCharRelationship(char.id, targetId, groupSource, { affinity: newAffinity });
                                console.log(`[Social] ${char.name} → ${targetId}: group affinity delta ${delta}, now ${newAffinity}`);
                            }
                        }

                        // ── Parse [MOMENT:content] — char posts to their Moments feed ──
                        const momentMatch = cleanReply.match(/\[MOMENT:\s*([\s\S]*?)\s*\]/i);
                        if (momentMatch?.[1]) {
                            db.addMoment(char.id, momentMatch[1].trim());
                            console.log(`[GroupChat] ${char.name} posted a Moment from group chat.`);
                        }

                        // ── Parse [DIARY:content] — char writes a diary entry ──
                        const diaryMatch = cleanReply.match(/\[DIARY:\s*([\s\S]*?)\s*\]/i);
                        if (diaryMatch?.[1]) {
                            db.addDiary(char.id, diaryMatch[1].trim(), 'neutral');
                            console.log(`[GroupChat] ${char.name} wrote a Diary entry from group chat.`);
                        }

                        // ── Parse [AFFINITY:±N] — char's affinity toward user changes ──
                        const affinityUserMatch = cleanReply.match(/\[AFFINITY:\s*([+-]?\d+)\s*\]/i);
                        if (affinityUserMatch?.[1]) {
                            const delta = parseInt(affinityUserMatch[1], 10);
                            const freshChar = db.getCharacter(char.id);
                            if (freshChar) {
                                const newAff = Math.max(0, Math.min(100, freshChar.affinity + delta));
                                db.updateCharacter(char.id, { affinity: newAff });
                                console.log(`[GroupChat] ${char.name} affinity → user: Δ${delta}, now ${newAff}`);
                            }
                        }

                        // ── Strip ALL action tags before saving/broadcasting ──
                        const globalStripRegex = /\[(?:CHAR_AFFINITY|AFFINITY|MOMENT|DIARY|UNLOCK_DIARY|PRESSURE|TIMER|TRANSFER|DIARY_PASSWORD|Red Packet)[^\]]*\]/gi;
                        cleanReply = cleanReply.replace(globalStripRegex, '').trim();

                        if (cleanReply.length > 0) {
                            const replyId = db.addGroupMessage(groupId, char.id, cleanReply, char.name, char.avatar);
                            const replyMsg = { id: replyId, group_id: groupId, sender_id: char.id, content: cleanReply, timestamp: Date.now(), sender_name: char.name, sender_avatar: char.avatar };
                            const payload = JSON.stringify({ type: 'group_message', data: replyMsg });
                            wsClients.forEach(c => { if (c.readyState === 1) c.send(payload); });

                            // Detect @mentions in char's own reply and schedule secondary chain
                            const charMentionMatches = [...cleanReply.matchAll(/(?:^|\s)@([^\s@]+)/g)].map(m => m[1].toLowerCase());
                            if (charMentionMatches.length > 0) {
                                const allGroupChars = group.members.filter(m => m.member_id !== 'user' && m.member_id !== char.id);
                                const secondaryIds = allGroupChars
                                    .filter(m => { const c = db.getCharacter(m.member_id); return c && charMentionMatches.includes(c.name.toLowerCase()); })
                                    .map(m => m.member_id);
                                if (secondaryIds.length > 0) {
                                    if (noChainGroups.has(groupId)) {
                                        console.log(`[GroupChat] ${char.name} mentioned ${secondaryIds.join(',')} — secondary chain BLOCKED (no-chain mode ON)`);
                                    } else {
                                        console.log(`[GroupChat] ${char.name} mentioned ${secondaryIds.join(',')} — queuing secondary reply after current chain`);
                                        pendingSecondaryChains.push(secondaryIds);
                                    }
                                }
                            }

                            // Trigger memory extraction in background (tagged with groupId for cleanup)
                            memory.extractMemoryFromContext(char, history.map(h => ({ role: h.role, content: h.content })), groupId)
                                .catch(err => console.error(`[GroupChat] Memory extraction err for ${char.name}:`, err.message));
                        }
                    }

                    // Clear typing indicator
                    const stopPayload = JSON.stringify({ type: 'group_typing_stop', data: { group_id: groupId, sender_id: char.id } });
                    wsClients.forEach(c => { if (c.readyState === 1) c.send(stopPayload); });
                } catch (err) {
                    console.error(`[GroupChat] ${char.name} failed to reply:`, err.message);
                    const stopPayload = JSON.stringify({ type: 'group_typing_stop', data: { group_id: groupId, sender_id: char.id } });
                    wsClients.forEach(c => { if (c.readyState === 1) c.send(stopPayload); });
                }
            }
        } finally {
            delete groupReplyLock[groupId];
            // Now fire any queued secondary chains (lock is released)
            for (const secondaryIds of pendingSecondaryChains) {
                setTimeout(() => triggerGroupAIChain(groupId, wsClients, secondaryIds, false), 2000);
            }
        }
    })();
}

// 14.4 Send message to group (user sends)
app.post('/api/groups/:id/messages', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: 'Требуется содержимое' });
        const group = db.getGroup(req.params.id);
        if (!group) return res.status(404).json({ error: 'Группа не найдена' });

        // Save user message
        const userProfile = db.getUserProfile?.() || { name: 'User', avatar: '' };
        const msgId = db.addGroupMessage(req.params.id, 'user', content, userProfile.name, userProfile.avatar);
        const savedMsg = { id: msgId, group_id: req.params.id, sender_id: 'user', content, timestamp: Date.now(), sender_name: userProfile.name, sender_avatar: userProfile.avatar };

        // Broadcast to all WS clients
        const wsPayload = JSON.stringify({ type: 'group_message', data: savedMsg });
        wsClients.forEach(c => { if (c.readyState === 1) c.send(wsPayload); });

        // Parse @mentions from message content (user only can do @all)
        const allRef = /(?:^|\s)@(?:all|全体成员)(?:\s|$)/i.test(content);
        const isAtAll = allRef; // only user (sender) can use @all
        const mentionedNames = [...content.matchAll(/(?:^|\s)@([^\s@]+)/g)].map(m => m[1].toLowerCase());
        const charMembers = group.members.filter(m => m.member_id !== 'user');
        const mentionedIds = charMembers
            .filter(m => { const c = db.getCharacter(m.member_id); return c && mentionedNames.includes(c.name.toLowerCase()); })
            .map(m => m.member_id);

        // Debounce: reset timer each time user sends a message — AI chain fires 1.5s after LAST message
        const groupId = req.params.id;
        if (groupDebounceTimers[groupId]) {
            clearTimeout(groupDebounceTimers[groupId]);
        }
        // Mentions are time-sensitive: fire slightly faster than normal debounce
        const debounceDelay = (mentionedIds.length > 0 || isAtAll) ? 1500 : 5000;
        groupDebounceTimers[groupId] = setTimeout(() => {
            delete groupDebounceTimers[groupId];
            triggerGroupAIChain(groupId, wsClients, mentionedIds, isAtAll);
        }, debounceDelay);

        res.json({ success: true, message: savedMsg });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// (duplicate route removed — DELETE /api/groups/:id is already defined at 14.8 above)

// ─── Private Transfer APIs ────────────────────────────────────────────────
// 14.9 Get transfer info
app.get('/api/transfers/:tid', (req, res) => {
    try {
        const t = db.getTransfer(parseInt(req.params.tid));
        if (!t) return res.status(404).json({ error: 'Перевод не найден' });
        res.json(t);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 14.10 Claim a private transfer  (recipient clicks "Claim")
app.post('/api/transfers/:tid/claim', (req, res) => {
    try {
        const { claimer_id = 'user' } = req.body;
        const result = db.claimTransfer(parseInt(req.params.tid), claimer_id);
        if (result.success) {
            engine.broadcastWalletSync(wsClients, req.params.tid ? db.getTransfer(parseInt(req.params.tid))?.char_id : null);
            res.json({ success: true, amount: result.amount, wallet: db.getWallet(claimer_id) });

            // If char claimed user's transfer, trigger a short reaction message
            if (claimer_id !== 'user') {
                const t = db.getTransfer(parseInt(req.params.tid));
                if (t) {
                    setTimeout(async () => {
                        try {
                            const char = db.getCharacter(claimer_id);
                            if (!char) return;
                            const userProfile = db.getUserProfile();
                            const reactionPrompt = `Ты — ${char.name}. Персонаж: ${char.persona || 'не задан'}\n${userProfile?.name || 'User'} перевёл(а) тебе ¥${result.amount.toFixed(2)} с пометкой: «${t.note || 'нет пометки'}». В соответствии со своим характером, отреагируй на этот перевод 1-2 фразами естественно (благодарность, удивление, теплота и т.д.). Без префикса с именем, просто говори.`;
                            const reply = await callLLM({ endpoint: char.api_endpoint, key: char.api_key, model: char.model_name, messages: [{ role: 'system', content: reactionPrompt }, { role: 'user', content: 'Ответь.' }], maxTokens: 80 });
                            if (reply?.trim()) {
                                const clean = reply.trim().replace(/\[(?:AFFINITY|PRESSURE|TIMER|MOMENT|DIARY)[^\]]*\]/gi, '').trim();
                                if (clean) {
                                    const { id: rid, timestamp: rts } = db.addMessage(char.id, 'character', clean);
                                    const claimMsg = { id: rid, character_id: char.id, role: 'character', content: clean, timestamp: rts };
                                    wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: claimMsg })); });
                                }
                            }
                        } catch (e) { console.error('[Transfer] char reaction error:', e.message); }
                    }, 2000 + Math.random() * 5000);
                }
            }
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 14.11 Refund a private transfer
app.post('/api/transfers/:tid/refund', async (req, res) => {
    try {
        const { refunder_id = 'user' } = req.body;
        const tid = parseInt(req.params.tid);
        const t = db.getTransfer(tid);
        if (!t) return res.status(404).json({ error: 'Перевод не найден' });

        const result = db.refundTransfer(tid, refunder_id);
        if (!result.success) return res.status(400).json({ success: false, error: result.error });

        engine.broadcastWalletSync(wsClients, t.char_id);
        res.json({ success: true, amount: result.amount, wallet: db.getWallet(t.sender_id) });

        // Trigger char reaction to refund
        const charId = t.char_id;
        const char = db.getCharacter(charId);
        if (!char) return;

        setTimeout(async () => {
            try {
                const userProfile = db.getUserProfile();
                let reactionPrompt;
                if (refunder_id === 'user') {
                    // User refunded char's transfer back to char
                    reactionPrompt = `Ты — ${char.name}. Персонаж: ${char.persona || 'не задан'}\nРанее ты отправил(а) ${userProfile?.name || 'User'} перевод ¥${result.amount.toFixed(2)} с пометкой «${t.note || 'нет пометки'}», но он(а) вернул(а) его тебе. В соответствии со своим характером, отреагируй 1-2 фразами естественно (разочарование, понимание, неловкость, показное безразличие и т.д.). Без префикса с именем, просто говори.`;
                } else {
                    // Char refunded user's transfer back to user
                    reactionPrompt = `Ты — ${char.name}. Персонаж: ${char.persona || 'не задан'}\n${userProfile?.name || 'User'} перевёл(а) тебе ¥${result.amount.toFixed(2)} с пометкой «${t.note || 'нет пометки'}», и ты решил(а) вернуть эти деньги. Объясни причину возврата 1-2 фразами (гордость, нежелание быть обязанным, странное чувство и т.д.). Без префикса с именем, просто говори.`;
                }
                const reply = await callLLM({ endpoint: char.api_endpoint, key: char.api_key, model: char.model_name, messages: [{ role: 'system', content: reactionPrompt }, { role: 'user', content: 'Ответь.' }], maxTokens: 80 });
                if (reply?.trim()) {
                    const clean = reply.trim().replace(/\[(?:AFFINITY|PRESSURE|TIMER|MOMENT|DIARY)[^\]]*\]/gi, '').trim();
                    if (clean) {
                        const { id: rid, timestamp: rts } = db.addMessage(char.id, 'character', clean);
                        const reactionMsg = { id: rid, character_id: char.id, role: 'character', content: clean, timestamp: rts };
                        wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: reactionMsg })); });
                    }
                }
            } catch (e) { console.error('[Transfer] refund reaction error:', e.message); }
        }, 1500 + Math.random() * 3000);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 14.12 User sends a transfer to a character
app.post('/api/characters/:id/transfer', async (req, res) => {
    try {
        const { amount, note = '' } = req.body;
        const charId = req.params.id;
        const amountF = parseFloat(amount);
        if (!amountF || amountF <= 0) return res.status(400).json({ error: 'Некорректная сумма' });

        const tid = db.createTransfer({ charId, senderId: 'user', recipientId: charId, amount: amountF, note });
        engine.broadcastWalletSync(wsClients, charId);

        const userProfile = db.getUserProfile();
        const transferText = `[TRANSFER]${tid}|${amountF}|${note}`;
        const { id: msgId, timestamp: msgTs } = db.addMessage(charId, 'user', transferText);
        const transferMsg = { id: msgId, character_id: charId, role: 'user', content: transferText, timestamp: msgTs };
        wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: transferMsg })); });

        // Schedule LLM-based claim/refund decision (5-12 seconds)
        setTimeout(async () => {
            try {
                const char = db.getCharacter(charId);
                if (!char) return;
                const affinity = char.affinity ?? 50;

                // Ask LLM: would this character accept or refund this transfer?
                const decidePrompt = `Ты — ${char.name}. Персонаж: ${char.persona || 'не задан'}\nТекущий уровень отношений с ${userProfile?.name || 'User'}: ${affinity}/100\n${userProfile?.name || 'User'} отправил(а) тебе перевод ¥${amountF.toFixed(2)} с пометкой: «${note || 'нет пометки'}».\nОсновываясь на своём характере и текущем уровне отношений, ты решаешь: 【принять】 эти деньги или 【вернуть】?\nВ первой строке напиши только одно слово: принять или вернуть\nЗатем со второй строки напиши 1-2 фразы своей реакции. Без префикса с именем, просто говори.`;

                const reply = await callLLM({ endpoint: char.api_endpoint, key: char.api_key, model: char.model_name, messages: [{ role: 'system', content: decidePrompt }, { role: 'user', content: 'Реши.' }], maxTokens: 100 });
                if (!reply?.trim()) {
                    throw new Error("LLM returned empty or null response");
                }

                const lines = reply.trim().split('\n').filter(l => l.trim());
                const decision = lines[0]?.trim() || '';
                const reaction = lines.slice(1).join(' ').trim();
                const willRefund = decision.toLowerCase().includes('верн') || decision.toLowerCase().includes('refund');

                if (willRefund) {
                    // Char refuses: refund back to user
                    db.refundTransfer(tid, charId);
                } else {
                    // Char accepts the transfer
                    db.claimTransfer(tid, charId);
                }
                engine.broadcastWalletSync(wsClients, charId);

                // Broadcast reaction
                const clean = reaction.replace(/\[(?:AFFINITY|PRESSURE|TIMER|MOMENT|DIARY)[^\]]*\]/gi, '').trim();
                if (clean) {
                    const { id: rid, timestamp: rts } = db.addMessage(char.id, 'character', clean);
                    const replyMsg = { id: rid, character_id: char.id, role: 'character', content: clean, timestamp: rts };
                    wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: replyMsg })); });
                }
            } catch (e) {
                console.error('[Transfer] char decide error or timeout:', e.message);
                // Fallback: Default to refunding if the API call takes too long or errors out
                // Prevent the transfer from getting stuck forever.
                const fallbackResult = db.refundTransfer(tid, charId);

                // If the refund was successful (meaning it was still pending)
                if (fallbackResult && fallbackResult.success) {
                    const char = db.getCharacter(charId);
                    if (char) {
                        const clean = "(Система автоматически вернула ваш перевод — сеть перегружена или возникла неполадка)";
                        const { id: rid, timestamp: rts } = db.addMessage(char.id, 'character', clean);
                        const fallbackMsg = { id: rid, character_id: char.id, role: 'character', content: clean, timestamp: rts };
                        wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: fallbackMsg })); });
                    }
                }
            }
        }, 5000 + Math.random() * 7000);

        res.json({ success: true, transfer_id: tid, wallet: db.getWallet('user') });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Red Packet APIs ─────────────────────────────────────────────────────
// 15.1 Get wallet balance
app.get('/api/wallet/:id', (req, res) => {
    try {
        res.json({ wallet: db.getWallet(req.params.id) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 15.2 Create a red packet (sent by user or char)
app.post('/api/groups/:id/redpackets', (req, res) => {
    try {
        const { sender_id = 'user', type, count, per_amount, total_amount, note } = req.body;
        if (!type || !count || (!per_amount && !total_amount)) {
            return res.status(400).json({ error: 'Отсутствуют обязательные поля' });
        }
        const groupId = req.params.id;
        const group = db.getGroup(groupId);
        if (!group) return res.status(404).json({ error: 'Группа не найдена' });

        const total = type === 'fixed'
            ? +(parseFloat(per_amount) * parseInt(count)).toFixed(2)
            : +parseFloat(total_amount).toFixed(2);



        const packetId = db.createRedPacket({
            groupId,
            senderId: sender_id,
            type,
            totalAmount: total,
            perAmount: type === 'fixed' ? +parseFloat(per_amount).toFixed(2) : null,
            count: parseInt(count),
            note: note || ''
        });

        // Save message & broadcast
        const userProfile = db.getUserProfile();
        const senderName = sender_id === 'user'
            ? (userProfile?.name || 'User')
            : (db.getCharacter(sender_id)?.name || 'Unknown');
        const senderAvatar = sender_id === 'user'
            ? (userProfile?.avatar || '')
            : (db.getCharacter(sender_id)?.avatar || '');

        const content = `[REDPACKET:${packetId}]`;
        const msgId = db.addGroupMessage(groupId, sender_id, content, senderName, senderAvatar);
        const savedMsg = { id: msgId, group_id: groupId, sender_id, content, timestamp: Date.now(), sender_name: senderName, sender_avatar: senderAvatar };
        wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'group_message', data: savedMsg })); });

        // Trigger AI auto-claim for char members (5–30 second delay to simulate hand speed)
        scheduleAIRedPacketClaims(groupId, packetId, sender_id, wsClients);

        res.json({ success: true, packet_id: packetId, message: savedMsg });
    } catch (e) {
        console.error('[RedPacket] Create error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 15.3 Get red packet details + claims
app.get('/api/groups/:id/redpackets/:pid', (req, res) => {
    try {
        const pkt = db.getRedPacket(parseInt(req.params.pid));
        if (!pkt) return res.status(404).json({ error: 'Красный конверт не найден' });
        // Enrich claims with names
        const enrichedClaims = pkt.claims.map(c => {
            const name = c.claimer_id === 'user'
                ? (db.getUserProfile()?.name || 'User')
                : (db.getCharacter(c.claimer_id)?.name || c.claimer_id);
            const avatar = c.claimer_id === 'user'
                ? (db.getUserProfile()?.avatar || '')
                : (db.getCharacter(c.claimer_id)?.avatar || '');
            return { ...c, name, avatar };
        });
        res.json({ ...pkt, claims: enrichedClaims });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 15.4 Claim a red packet
app.post('/api/groups/:id/redpackets/:pid/claim', (req, res) => {
    try {
        const { claimer_id = 'user' } = req.body;
        const result = db.claimRedPacket(parseInt(req.params.pid), claimer_id);
        if (result.success) {
            res.json({ success: true, amount: result.amount, wallet: db.getWallet(claimer_id) });
        } else {
            res.status(400).json({ success: false, error: result.error });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── AI Auto Red Packet Claim ────────────────────────────────────────────
async function scheduleAIRedPacketClaims(groupId, packetId, senderCharId, wsClients) {
    const group = db.getGroup(groupId);
    if (!group) return;
    const charMembers = group.members.filter(m => m.member_id !== 'user');

    for (const member of charMembers) {
        const delayMs = Math.floor(5000 + Math.random() * 25000); // 5–30 seconds
        setTimeout(async () => {
            try {
                const char = db.getCharacter(member.member_id);
                if (!char || char.is_blocked) return;

                const result = db.claimRedPacket(packetId, char.id);
                if (!result.success) return; // already claimed or exhausted

                const pkt = db.getRedPacket(packetId);
                const senderName = senderCharId === 'user'
                    ? (db.getUserProfile()?.name || 'User')
                    : (db.getCharacter(senderCharId)?.name || 'кто-то');

                // Ask AI to react in group chat
                const userProfile = db.getUserProfile();
                const recentMsgs = db.getVisibleGroupMessages(groupId, 6);
                const historyForPrompt = recentMsgs.map(m => {
                    const sName = m.sender_id === 'user'
                        ? (userProfile?.name || 'User')
                        : (m.sender_name || db.getCharacter(m.sender_id)?.name || '?');
                    return { role: m.sender_id === char.id ? 'assistant' : 'user', content: `[${sName}]: ${m.content}` };
                });

                const isLucky = pkt?.type === 'lucky';
                const totalClaimed = pkt?.count - pkt?.remaining_count;
                const reactionPrompt = `Ты — ${char.name}. Персонаж: ${char.persona || 'не задан'}
Ты только что открыл(а) ${isLucky ? 'счастливый' : 'обычный'} красный конверт от ${senderName} в группе «${group.name}» на сумму ¥${result.amount.toFixed(2)}.
${isLucky ? `(Всего ${pkt?.count} конвертов, ты ${totalClaimed}-й открывший, ${pkt?.remaining_count > 0 ? `осталось ${pkt?.remaining_count}` : 'все разобраны'})` : ''}
В соответствии со своим характером, отреагируй 1-2 фразами в групповом чате естественно (радость, разочарование, хвастовство, скромность и т.д.). Без префикса с именем, просто говори.`;

                const reply = await callLLM({
                    endpoint: char.api_endpoint,
                    key: char.api_key,
                    model: char.model_name,
                    messages: [{ role: 'system', content: reactionPrompt }, ...historyForPrompt],
                    maxTokens: 80
                });

                if (reply && reply.trim()) {
                    const clean = reply.trim().replace(/\[(?:CHAR_AFFINITY|AFFINITY|MOMENT|DIARY|UNLOCK_DIARY|PRESSURE|TIMER|TRANSFER|DIARY_PASSWORD)[^\]]*\]/gi, '').trim();
                    if (clean) {
                        const replyId = db.addGroupMessage(groupId, char.id, clean, char.name, char.avatar);
                        const replyMsg = { id: replyId, group_id: groupId, sender_id: char.id, content: clean, timestamp: Date.now(), sender_name: char.name, sender_avatar: char.avatar };
                        wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'group_message', data: replyMsg })); });
                    }
                }
            } catch (err) {
                console.error(`[RedPacket] AI auto-claim error for ${member.member_id}:`, err.message);
            }
        }, delayMs);
    }
}


// ─────────────────────────────────────────────────────────────
// Catch-all for React Router frontend
app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Start listening
console.log('[Express] Attempting to listen on port 8000...');
const PORT = process.env.PORT || 8001;
server.listen(PORT, () => {
    console.log(`[Express] ChatPulse Server running on http://localhost:${PORT}`);
});

// Start Background Engine
engine.setGroupChainCallback(triggerGroupAIChain);
engine.startEngine(wsClients);
engine.startGroupProactiveTimers(wsClients);
