import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

// ------------------------------------------------------------------ toast
type ToastAction = { label: string; run: () => void | Promise<void> };
type Toast = { id: number; text: string; tone: 'ok' | 'error'; action?: ToastAction };
type Push = (text: string, opt?: 'ok' | 'error' | ToastAction) => void;
const ToastCtx = createContext<Push>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push: Push = (text, opt) => {
    const id = Date.now() + Math.random();
    const tone = opt === 'error' ? 'error' : 'ok';
    const action = typeof opt === 'object' ? opt : undefined;
    setToasts((t) => [...t, { id, text, tone, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' || action ? 6000 : 3000);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
            {t.action && <button className="toast-action" onClick={() => { setToasts((x) => x.filter((y) => y.id !== t.id)); t.action!.run(); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Wrap an async action: shows errors as toasts, returns a busy flag. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast(success);
      return r;
    } catch (e) {
      toast((e as Error).message, 'error');
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

// ------------------------------------------------------------------ sheet
export function Sheet({ title, onClose, children, wide, footer, compact }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Keep focus on a field the content focused itself (e.g. a chat box); otherwise focus the dialog.
    requestAnimationFrame(() => { if (!ref.current?.contains(document.activeElement)) ref.current?.focus(); });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className={`overlay ${compact ? 'centered' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${wide ? 'wide' : ''} ${compact ? 'compact' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} ref={ref}>
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Confirm({ title, body, confirmLabel = 'Confirm', danger, onConfirm, onClose }: { title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
    </>}>
      <div className="prose">{body}</div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ small bits
export const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' } as const;
export function PriorityDot({ p }: { p: string }) {
  return <span className={`prio prio-${p}`} title={`${PRIORITY_LABEL[p as keyof typeof PRIORITY_LABEL]} priority`} aria-label={`${p} priority`} />;
}

export function SpaceTag({ space, name }: { space: 'me' | 'us' | 'you'; name?: string }) {
  return <span className={`space-tag space-${space}`}>{space === 'us' ? 'US' : space === 'me' ? 'ME' : name ?? 'YOU'}</span>;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <p className="empty-title">{title}</p>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Loading() {
  return <div className="loading" aria-label="Loading"><span /><span /><span /></div>;
}

export function ErrorNote({ error }: { error: Error | null }) {
  if (!error) return null;
  return <div className="note error">{error.message}</div>;
}
