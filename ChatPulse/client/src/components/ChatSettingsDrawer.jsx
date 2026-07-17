import React, { useState, useEffect } from 'react';
import { X, Trash2, Settings, RefreshCw } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

function ChatSettingsDrawer({ contact, apiUrl, onClose, onClearHistory }) {
    const { t, lang } = useLanguage();
    const [relationships, setRelationships] = useState([]);
    const [regenLoading, setRegenLoading] = useState(null);
    const [regenError, setRegenError] = useState(null);

    useEffect(() => {
        if (!contact) return;
        fetch(`${apiUrl}/characters/${contact.id}/relationships`)
            .then(r => r.json())
            .then(data => setRelationships(Array.isArray(data) ? data : []))
            .catch(() => { });
    }, [contact, apiUrl]);

    const handleRegenerate = async (targetId) => {
        setRegenLoading(targetId);
        setRegenError(null);
        try {
            const r = await fetch(`${apiUrl}/characters/${contact.id}/relationships/regenerate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_id: targetId })
            });
            const d = await r.json();
            if (!r.ok) {
                setRegenError(d.error || 'Ошибка генерации');
            } else {
                setRelationships(prev => prev.map(rel =>
                    rel.targetId === targetId ? { ...rel, affinity: d.affinity ?? rel.affinity, impression: d.impression ?? rel.impression } : rel
                ));
            }
        } catch (e) {
            console.error(e);
            setRegenError(e.message || 'Ошибка сети');
        }
        setRegenLoading(null);
    };

    if (!contact) return null;

    const handleClearHistory = async () => {
        if (!window.confirm(`Вы уверены, что хотите полностью удалить всю историю с ${contact.name}?\n\nЭто удалит чаты, воспоминания, дневники, моменты, векторные индексы и сбросит привязанность.\n\nЭто действие необратимо.`)) return;
        try {
            const res = await fetch(`${apiUrl}/data/${contact.id}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                if (onClearHistory) onClearHistory();
            }
        } catch (e) {
            console.error('Failed to wipe character data:', e);
        }
    };

    return (
        <div className="memory-drawer" style={{ width: '320px', backgroundColor: '#f7f7f7' }}>
            <div className="memory-header">
                <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Settings size={18} /> {t('Chat Settings')}
                </h3>
                <button className="icon-btn" onClick={onClose}>
                    <X size={20} />
                </button>
            </div>
            <div className="memory-content" style={{ padding: '0' }}>
                {/* Contact Banner */}
                <div style={{ backgroundColor: '#fff', padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', borderBottom: '1px solid #eee' }}>
                    <img src={contact.avatar} alt={contact.name} style={{ width: '60px', height: '60px', borderRadius: '50%', marginBottom: '10px' }} />
                    <div style={{ fontSize: '18px', fontWeight: '500' }}>{contact.name}</div>
                    <div style={{ fontSize: '13px', color: '#999', marginTop: '5px', textAlign: 'center', padding: '0 10px' }}>
                        {contact.persona ? contact.persona.substring(0, 50) + '...' : 'Персона не задана.'}
                    </div>
                </div>

                {/* AI Stats */}
                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ fontSize: '12px', color: '#999', marginBottom: '15px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Скрытая статистика ИИ
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '14px' }}>
                        <span>Привязанность</span>
                        <span style={{ fontWeight: '500', color: contact.affinity >= 80 ? 'var(--accent-color)' : contact.affinity < 30 ? 'var(--danger)' : '#333' }}>
                            {contact.affinity} / 100
                        </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '14px' }}>
                        <span>Кошелёк</span>
                        <span style={{ fontWeight: '500', color: '#e67e22' }}>
                            💰 ¥{(contact.wallet ?? 0).toFixed(2)}
                        </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '14px' }}>
                        <span>Давление</span>
                        <span style={{ fontWeight: '500', color: contact.pressure_level > 2 ? 'var(--danger)' : '#333' }}>
                            {contact.pressure_level}
                        </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px' }}>
                        <span>Status</span>
                        <span style={{ fontWeight: '500', color: contact.is_blocked ? 'var(--danger)' : 'var(--accent-color)' }}>
                            {contact.is_blocked ? 'Заблокировал(а)' : 'Активен'}
                        </span>
                    </div>
                </div>

                {/* Inter-character Relationships (char-to-char impressions) */}
                <div style={{ marginTop: '10px', backgroundColor: '#fff', padding: '15px', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div style={{ fontSize: '12px', color: '#999', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        {`${contact.name}: впечатления о других`}
                    </div>
                    {relationships.length === 0 ? (
                        <div style={{ fontSize: '13px', color: '#bbb', fontStyle: 'italic' }}>
                            Пока нет отношений.
                        </div>
                    ) : (
                        relationships.map(rel => (
                            <div key={rel.targetId} style={{ marginBottom: '12px', padding: '10px', background: '#f8f9fa', borderRadius: '8px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                                    <img src={rel.targetAvatar || `https://api.dicebear.com/7.x/notionists/svg?seed=${rel.targetName}`} alt=""
                                        style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
                                    <div style={{ flex: 1 }}>
                                        <span style={{ fontWeight: '500', fontSize: '13px' }}>{rel.targetName}</span>
                                        <span style={{ fontSize: '11px', color: '#999', marginLeft: '6px' }}>
                                            ❤️ {rel.affinity ?? '?'}
                                        </span>
                                    </div>
                                    <button onClick={() => handleRegenerate(rel.targetId)} disabled={regenLoading === rel.targetId}
                                        title="Перегенерировать впечатление этого персонажа через ИИ"
                                        style={{ background: 'none', border: '1px solid #ddd', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', fontSize: '11px', color: 'var(--accent-color)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                        <RefreshCw size={10} /> {regenLoading === rel.targetId ? '...' : 'Обновить'}
                                    </button>
                                </div>
                                {rel.impression && (
                                    <div style={{ fontSize: '12px', color: '#666', lineHeight: '1.4', fontStyle: 'italic' }}>
                                        "{rel.impression}"
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                    {regenError && (
                        <div style={{ marginTop: '8px', padding: '6px 10px', background: '#fff1f1', border: '1px solid #ffc0c0', borderRadius: '6px', fontSize: '12px', color: '#c0392b' }}>
                            ⚠️ {regenError}
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div style={{ marginTop: '10px', backgroundColor: '#fff', borderTop: '1px solid #eee', borderBottom: '1px solid #eee' }}>
                    <div
                        style={{ padding: '15px', display: 'flex', justifyContent: 'center', color: 'var(--danger)', cursor: 'pointer', alignItems: 'center', gap: '8px', fontWeight: '500' }}
                        onClick={handleClearHistory}
                    >
                        <Trash2 size={18} /> {t('Deep Wipe')}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ChatSettingsDrawer;
