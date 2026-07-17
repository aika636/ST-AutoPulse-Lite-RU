import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

function TransferModal({ contact, onClose, onConfirm }) {
    const { lang } = useLanguage();
    const [amount, setAmount] = useState('0.01');
    const [note, setNote] = useState('');

    const handleConfirm = () => {
        const value = parseFloat(amount);
        if (isNaN(value) || value <= 0) {
            alert('Введите корректную сумму.');
            return;
        }
        onConfirm(value, note.trim() || 'Перевод');
    };

    return (
        <div className="modal-overlay">
            <div className="modal-content" style={{ maxWidth: '320px', padding: '0' }}>
                <div style={{ padding: '15px 20px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: '16px', fontWeight: '500' }}>Перевод для {contact?.name}</div>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><span style={{ fontSize: '18px', color: '#999' }}>✕</span></button>
                </div>
                <div style={{ padding: '30px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ fontSize: '14px', color: '#666', marginBottom: '10px' }}>Сумма (¥)</div>
                    <div style={{ display: 'flex', alignItems: 'center', fontSize: '36px', fontWeight: 'bold' }}>
                        <span style={{ marginRight: '5px', fontSize: '28px' }}>¥</span>
                        <input
                            type="number"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            style={{ width: '120px', fontSize: '36px', border: 'none', borderBottom: '1px solid var(--accent-color)', textAlign: 'center', outline: 'none' }}
                            step="0.01"
                            min="0.01"
                            autoFocus
                        />
                    </div>
                    <input
                        type="text"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Добавить заметку (необязательно)"
                        style={{ marginTop: '20px', width: '100%', maxWidth: '200px', padding: '8px', border: 'none', borderBottom: '1px solid #ddd', textAlign: 'center', outline: 'none', fontSize: '14px', backgroundColor: 'transparent' }}
                    />
                </div>
                <div style={{ padding: '15px 20px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'center' }}>
                    <button
                        onClick={handleConfirm}
                        style={{ backgroundColor: 'var(--accent-color)', color: '#fff', border: 'none', padding: '10px 40px', borderRadius: '4px', fontSize: '16px', cursor: 'pointer', width: '100%' }}
                    >
                        Перевести
                    </button>
                </div>
            </div>
        </div>
    );
}

export default TransferModal;
