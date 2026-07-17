import React, { createContext, useState, useContext, useEffect } from 'react';

const LanguageContext = createContext();

const translations = {
    // Common
    'Save': { en: 'Save', zh: '保存', ru: 'Сохранить' },
    'Cancel': { en: 'Cancel', zh: '取消', ru: 'Отмена' },
    'Edit': { en: 'Edit', zh: '编辑', ru: 'Редактировать' },
    'Delete': { en: 'Delete', zh: '删除', ru: 'Удалить' },
    'Send': { en: 'Send', zh: '发送', ru: 'Отправить' },
    'Loading': { en: 'Loading...', zh: '加载中...', ru: 'Загрузка...' },

    // Tabs
    'Chats': { en: 'Chats', zh: '聊天', ru: 'Чаты' },
    'Contacts': { en: 'Contacts', zh: '联系人', ru: 'Контакты' },
    'Moments': { en: 'Moments', zh: '朋友圈', ru: 'Моменты' },
    'Settings': { en: 'Settings', zh: '设置', ru: 'Настройки' },

    // Settings Panel
    'Export Data': { en: 'Export Data', zh: '导出数据', ru: 'Экспорт данных' },
    'Deep Wipe': { en: 'Deep Wipe', zh: '深度清理', ru: 'Глубокая очистка' },
    'Characters': { en: 'Characters', zh: '角色', ru: 'Персонажи' },
    'Add Character': { en: 'Add Character', zh: '添加角色', ru: 'Добавить персонажа' },
    'User Profile': { en: 'User Profile', zh: '用户档案', ru: 'Профиль пользователя' },
    'Name': { en: 'Name', zh: '名称', ru: 'Имя' },
    'Avatar URL': { en: 'Avatar URL', zh: '头像 URL', ru: 'URL аватара' },
    'Bio': { en: 'Bio', zh: '个性签名', ru: 'О себе' },
    'Theme': { en: 'Theme', zh: '主题', ru: 'Тема' },

    // Add / Edit Character Form
    'Persona': { en: 'Persona', zh: '角色设定 (Persona)', ru: 'Персона' },
    'World Info / Scenario': { en: 'World Info / Scenario', zh: '世界设定 / 场景', ru: 'Мир / Сценарий' },
    'API Endpoint': { en: 'API Endpoint (e.g. https://api.openai.com/v1)', zh: 'API Endpoint (如: https://api.openai.com/v1)', ru: 'API Endpoint (напр. https://api.openai.com/v1)' },
    'Memory API Endpoint': { en: 'Memory API Endpoint', zh: '记忆提取 API Endpoint (可选)', ru: 'API Endpoint памяти' },
    'API Key': { en: 'API Key', zh: 'API Key', ru: 'API Ключ' },
    'Memory API Key': { en: 'Memory API Key', zh: '记忆提取 API Key (可选)', ru: 'API Ключ памяти' },
    'Model Name': { en: 'Model Name (e.g. gpt-4o)', zh: '聊天模型名称 (例如: gpt-4o)', ru: 'Модель (напр. gpt-4o)' },
    'Memory Model Name': { en: 'Memory Model Name', zh: '记忆模型 (建议: o1-mini等推理模型)', ru: 'Модель памяти' },
    'Fetch Models': { en: 'Fetch List', zh: '拉取列表', ru: 'Загрузить список' },
    'System Guidelines': { en: 'System Guidelines (Mandatory logic for background events)', zh: '系统准则 (后台事件运行的强制逻辑)', ru: 'Системные правила (обязательная логика для фоновых событий)' },
    'Advanced Config': { en: 'Advanced Engine Configuration', zh: '高级引擎配置', ru: 'Расширенная конфигурация движка' },
    'Max Output Tokens': { en: 'Max Output Tokens', zh: '最大输出 Token 限制', ru: 'Макс. токенов на вывод' },

    // Systems Toggles
    'Disable Background Engine': { en: '🚨 Disable Entire Background Engine (Sleep Mode)', zh: '🚨 禁用该角色的所有后台活动 (休眠模式)', ru: '🚨 Отключить фоновый движок (Режим сна)' },
    'Toggle Proactive Messages': { en: 'Enable Proactive Messaging (Random initiated messages)', zh: '开启主动发消息 (随机发起话题)', ru: 'Включить проактивные сообщения (случайные инициативы)' },
    'Toggle Timer Actions': { en: 'Enable Self-Scheduled Timers ([TIMER] tags)', zh: '允许角色自定义等待时间 (使用 [TIMER] 标签)', ru: 'Разрешить таймеры (теги [TIMER])' },
    'Toggle Pressure System': { en: 'Enable Pressure System (Panic mode if ignored)', zh: '开启情绪压力系统 (被无视时会感到焦虑)', ru: 'Включить систему давления (паника при игнорировании)' },
    'Toggle Jealousy System': { en: 'Enable Jealousy System (Interruption when talking to others)', zh: '开启吃醋系统 (同别人聊天时有概率打断)', ru: 'Включить систему ревности (перебивание при разговоре с другими)' },

    // Chat & Drawers
    'Chat Settings': { en: 'Chat Settings', zh: '聊天设置', ru: 'Настройки чата' },
    'Memories': { en: 'Memories', zh: '潜意识记忆', ru: 'Воспоминания' },
    'Secret Diary': { en: 'Secret Diary', zh: '私密日记本', ru: 'Секретный дневник' },
    'Send Transfer': { en: 'Send Transfer', zh: '发送转账/红包', ru: 'Отправить перевод' },
    'Hide Old Messages': { en: 'Hide Old Messages', zh: '隐藏旧消息', ru: 'Скрыть старые сообщения' },
    'No moments yet': { en: 'No moments yet. Your friends are quiet today.', zh: '还没有任何动态哦。', ru: 'Пока нет публикаций. Ваши друзья сегодня молчат.' },
    'Share something new': { en: 'Share something new...', zh: '说点什么...', ru: 'Поделиться...' },
    'Post': { en: 'Post', zh: '发布', ru: 'Опубликовать' },
    'Type a message': { en: 'Type a message...', zh: '输入消息...', ru: 'Введите сообщение...' },
    'Connecting': { en: 'Connecting...', zh: '连接中...', ru: 'Подключение...' },
    'Thinking': { en: 'Thinking...', zh: '对方正在输入...', ru: 'Думает...' },
    'Typing': { en: 'typing...', zh: '正在输入...', ru: 'печатает...' },

    // Diary & Memory specific
    'Unlock Diary': { en: 'Unlock Secret Diary', zh: '解锁私密日记', ru: 'Открыть дневник' },
    'Diary Locked': { en: 'Diary is Locked 🔒', zh: '日记已锁定 🔒', ru: 'Дневник закрыт 🔒' },
    'Password': { en: 'Password', zh: '密码', ru: 'Пароль' },
    'Unlock': { en: 'Unlock', zh: '解锁', ru: 'Разблокировать' },
    'No entries yet': { en: 'No entries yet...', zh: '暂无记录...', ru: 'Пока нет записей...' },
    'No memories yet': { en: 'No memories yet...', zh: '暂无记忆...', ru: 'Пока нет воспоминаний...' },
    'Significance': { en: 'Significance', zh: '重要程度', ru: 'Значимость' },
    'Impact': { en: 'Impact', zh: '影响', ru: 'Влияние' },

    // Comments & Likes
    'Like': { en: 'Like', zh: '赞', ru: 'Нравится' },
    'Unlike': { en: 'Unlike', zh: '取消赞', ru: 'Убрать лайк' },
    'Comment': { en: 'Comment', zh: '评论', ru: 'Комментировать' },
    'Reply': { en: 'Reply...', zh: '回复...', ru: 'Ответить...' },

    // Form Errors
    'Required fields missing': { en: 'Please fill in Name, Persona, API Endpoint, API Key, and Model.', zh: '请填写名称、角色设定、API Endpoint、API Key 和模型名称。', ru: 'Заполните Имя, Персону, API Endpoint, API Key и Модель.' },
    'Failed to add character': { en: 'Failed to add character', zh: '添加角色失败', ru: 'Ошибка добавления персонажа' },
    'Failed to clear history': { en: 'Failed to clear history', zh: '清除历史记录失败', ru: 'Ошибка очистки истории' },
    'History cleared': { en: 'History cleared', zh: '历史记录已清除', ru: 'История очищена' },
    'Are you sure clear history': { en: 'Are you sure you want to clear this chat history?', zh: '确定要清除此聊天记录吗？', ru: 'Вы уверены, что хотите очистить историю чата?' }
};

export const LanguageProvider = ({ children }) => {
    const [lang, setLang] = useState(() => {
        return localStorage.getItem('chatpulse_lang') || 'ru';
    });

    useEffect(() => {
        localStorage.setItem('chatpulse_lang', lang);
    }, [lang]);

    const toggleLanguage = () => {
        setLang(prev => (prev === 'ru' ? 'en' : prev === 'en' ? 'zh' : 'ru'));
    };

    const t = (key) => {
        if (!translations[key]) return key;
        return translations[key][lang] || key;
    };

    return (
        <LanguageContext.Provider value={{ lang, toggleLanguage, t }}>
            {children}
        </LanguageContext.Provider>
    );
};

export const useLanguage = () => useContext(LanguageContext);
