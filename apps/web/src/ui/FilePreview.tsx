/**
 * In-app viewing of uploaded files. The file opens in a viewer on the page; downloading is a separate, explicit action
 * inside it. The bytes come through the typed client as a blob, so the viewer works under the API's strict CSP and
 * frame-ancestors rules, and the server decides which types are safe to render (PDF, images, plain text).
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Icon, LinkButton, Skeleton } from '@yaneshtyagi/design-system';
import { api, problemOf } from '../api/client';

const downloadUrl = (fileId: string) => `/api/v1/files/${fileId}`;

type View =
  | { state: 'loading' }
  | { state: 'ready'; kind: 'pdf' | 'image'; url: string }
  | { state: 'ready'; kind: 'text'; text: string }
  | { state: 'error'; message: string };

/** A file's name that opens it in the viewer. */
export function FileLink({ fileId, filename, children }: { fileId: string; filename: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="file-link" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Icon name="eye" size={16} /><span>{children ?? filename}</span>
      </button>
      {open && <FilePreview fileId={fileId} filename={filename} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Modal viewer: Esc, the close button or the backdrop closes it; focus returns to the trigger. */
export function FilePreview({ fileId, filename, onClose }: { fileId: string; filename: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<View>({ state: 'loading' });

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let url: string | null = null;
    let live = true;
    (async () => {
      const r = await api.GET('/api/v1/files/{id}', { params: { path: { id: fileId }, query: { disposition: 'inline' } }, parseAs: 'blob' });
      if (!live) return;
      if (!r.response.ok || !r.data) return setView({ state: 'error', message: problemOf(r.error).message });
      const blob = r.data as Blob;
      const type = r.response.headers.get('content-type') ?? blob.type;
      if (type.startsWith('text/plain')) return setView({ state: 'ready', kind: 'text', text: await blob.text() });
      url = URL.createObjectURL(new Blob([blob], { type }));
      setView({ state: 'ready', kind: type === 'application/pdf' ? 'pdf' : 'image', url });
    })();
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [fileId]);

  return (
    <dialog ref={ref} className="file-preview" aria-label={`Preview of ${filename}`} onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) ref.current?.close(); }}>
      <div className="file-preview__bar">
        <h2 className="file-preview__title" title={filename}>{filename}</h2>
        <LinkButton href={downloadUrl(fileId)} download={filename} variant="secondary" size="sm" icon="download">Download</LinkButton>
        <Button variant="ghost" size="sm" iconOnly aria-label="Close preview" icon="x" onClick={() => ref.current?.close()} />
      </div>
      <div className="file-preview__body">
        {view.state === 'loading' && <div aria-busy="true" className="file-preview__pad"><span className="bv-sr-only">Loading preview…</span><Skeleton height={320} /></div>}
        {view.state === 'error' && (
          <div className="file-preview__pad file-preview__empty" role="status">
            <Icon name="file-text" size={24} />
            <p>{view.message}</p>
            <LinkButton href={downloadUrl(fileId)} download={filename} variant="primary" icon="download">Download {filename}</LinkButton>
          </div>
        )}
        {view.state === 'ready' && view.kind === 'pdf' && <iframe className="file-preview__frame" src={view.url} title={filename} />}
        {view.state === 'ready' && view.kind === 'image' && <img className="file-preview__image" src={view.url} alt={filename} />}
        {view.state === 'ready' && view.kind === 'text' && <pre className="file-preview__text" tabIndex={0}>{view.text}</pre>}
      </div>
    </dialog>
  );
}
