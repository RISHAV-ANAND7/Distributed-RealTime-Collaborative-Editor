import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Pencil, Check, X } from 'lucide-react';
import { Editor } from './Editor';
import { renameDocument } from '../lib/api';

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [title, setTitle] = useState<string>('Untitled document');
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `${title} · Confluence`;
  }, [title]);

  const startEditing = () => {
    setDraftTitle(title);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 50);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraftTitle('');
  };

  const commitEdit = async () => {
    const trimmed = draftTitle.trim();
    if (!trimmed || trimmed === title || !id) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      await renameDocument(id, trimmed);
      setTitle(trimmed);
    } catch {}
    setSaving(false);
    setEditing(false);
  };

  if (!id) {
    navigate('/');
    return null;
  }

  return (
    <div className="editor-page">
      <div className="editor-page-header">
        <Link to="/" className="back-btn">
          <ArrowLeft size={13} strokeWidth={2.5} /> Docs
        </Link>

        <div className="doc-title-area">
          {editing ? (
            <div className="doc-title-edit">
              <input
                ref={inputRef}
                className="doc-title-input"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit();
                  if (e.key === 'Escape') cancelEdit();
                }}
                maxLength={120}
                aria-label="Document title"
              />
              <button className="title-action-btn title-confirm" onClick={commitEdit} disabled={saving} title="Save">
                <Check size={14} />
              </button>
              <button className="title-action-btn title-cancel" onClick={cancelEdit} title="Cancel">
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="doc-title-display">
              <h1 className="doc-title-text">{title}</h1>
              <button className="title-edit-btn" onClick={startEditing} title="Rename document">
                <Pencil size={12} />
              </button>
            </div>
          )}
          <span className="doc-id-badge">#{id}</span>
        </div>
      </div>

      <Editor docId={id} onTitleResolved={setTitle} />
    </div>
  );
}
