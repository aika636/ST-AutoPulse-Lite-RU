import React, { useState, useEffect } from 'react';
import { Trash2, RefreshCw, Wand2, X } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

function MemoTable({ contact, apiUrl, onClose }) {
    const { t, lang } = useLanguage();
    const [memories, setMemories] = useState([]);
    const [loading, setLoading] = useState(false);
    const [isExtracting, setIsExtracting] = useState(false);

    const fetchMemories = React.useCallback(() => {
        if (!contact) return;
        setLoading(true);
        fetch(`${apiUrl}/memories/${contact.id}`)
            .then(res => res.json())
            .then(data => {
                if (!Array.isArray(data)) {
                    console.error('API Error:', data);
                    data = [];
                }
                setMemories(data);
                setLoading(false);
            })
            .catch(err => {
                console.error('Failed to load memories:', err);
                setLoading(false);
            });
    }, [contact, apiUrl]);

    useEffect(() => {
        fetchMemories();
    }, [fetchMemories]);

    const handleDelete = async (id) => {
        try {
            await fetch(`${apiUrl}/memories/${id}`, { method: 'DELETE' });
            setMemories(prev => prev.filter(m => m.id !== id));
        } catch (e) {
            console.error('Failed to delete memory:', e);
        }
    };

    const handleExtract = async () => {
        if (!contact) return;
        setIsExtracting(true);
        try {
            const res = await fetch(`${apiUrl}/memories/${contact.id}/extract`, { method: 'POST' });
            const data = await res.json();

            if (!res.ok) {
                alert(`Ошибка извлечения:\n${data.error}`);
            } else {
                alert(`Извлечение завершено:\n${data.message}`);
                fetchMemories(); // Refresh the list if successful
            }
        } catch (e) {
            console.error('Failed to extract memories:', e);
            alert('Не удалось подключиться к серверу для извлечения.');
        } finally {
            setIsExtracting(false);
        }
    };

    if (!contact) return null;

    console.log('MemoTable rendering:', { contact: contact?.name, memoriesLength: memories.length, loading });

    return (
        <div className="drawer-container memory-drawer">
            <div className="memory-header">
                <h3>{contact.name} — Воспоминания</h3>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button
                        onClick={handleExtract}
                        disabled={isExtracting}
                        style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '4px 8px', backgroundColor: isExtracting ? '#ccc' : 'var(--accent-color)', color: '#fff', border: 'none', borderRadius: '4px', cursor: isExtracting ? 'not-allowed' : 'pointer', fontSize: '13px' }}
                    >
                        <Wand2 size={14} /> {isExtracting ? 'Извлечение...' : 'Извлечь'}
                    </button>
                    <button className="icon-btn" onClick={fetchMemories} title="Обновить">
                        <RefreshCw size={16} />
                    </button>
                    <button className="icon-btn" onClick={onClose} title={t('Cancel')}>
                        <X size={16} />
                    </button>
                </div>
            </div>

            <div className="memory-content">
                {loading || isExtracting ? (
                    <p className="loading-text">{isExtracting ? 'Анализ контекста...' : 'Загрузка воспоминаний...'}</p>
                ) : memories.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
                        <p>{t('No memories yet')}</p>
                        <p style={{ fontSize: '12px', marginTop: '10px' }}>Обычно ИИ извлекает их в фоне, но вы можете запустить извлечение вручную.</p>
                    </div>
                ) : (
                    <div className="memory-list">
                        {memories.map(mem => (
                            <div key={mem.id} className="memory-card">
                                <div className="memory-card-header">
                                    <span className="memory-time">{new Date(mem.created_at).toLocaleString()}</span>
                                    <button className="icon-btn danger" onClick={() => handleDelete(mem.id)}>
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                                <div className="memory-card-body">
                                    <strong>Событие:</strong> {mem.event}
                                </div>
                                {(mem.time || mem.location || mem.people) && (
                                    <div className="memory-card-footer">
                                        {mem.time && <span>🕒 {mem.time}</span>}
                                        {mem.location && <span>📍 {mem.location}</span>}
                                        {mem.people && <span>👥 {mem.people}</span>}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export default MemoTable;
