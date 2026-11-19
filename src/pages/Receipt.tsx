import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { money, parseMoney } from '../lib/format';
import { Field, Loading, SpaceTag, useAction, useToast } from '../components/ui';

interface Line {
  key: string; name: string; quantity: number | null; unit_price_cents: number | null; total_cents: number | null; category_id: string | null;
  action: 'stock' | 'skip'; complete_need_item_id: string | null; merge_into_stock_id: string | null; raw_text: string | null; needs_review: boolean; review_reason: string | null;
  matched_stock_title?: string | null;
}

export function ReceiptPage() {
  const { id } = useParams();
  const me = useMe();
  const nav = useNavigate();
  const toast = useToast();
  const { data } = useApi<any>(`/receipts/${id}`);
  const [lines, setLines] = useState<Line[]>([]);
  const [head, setHead] = useState({ merchant: '', purchase_date: '', total: '' });
  const [pasted, setPasted] = useState('');
  const [expense, setExpense] = useState(true);
  const { run, busy } = useAction();

  useEffect(() => {
    if (!data) return;
    setLines(data.lines.map((l: any, i: number) => ({
      key: l.id ?? String(i), name: l.name, quantity: l.quantity, unit_price_cents: l.unit_price_cents, total_cents: l.total_cents, category_id: l.category_id,
      action: 'stock', complete_need_item_id: l.matched_need_item_id, merge_into_stock_id: l.matched_need_item_id ? null : l.matched_stock_item_id, raw_text: l.raw_text,
      needs_review: l.needs_review, review_reason: l.review_reason, matched_stock_title: l.matched_stock_title,
    })));
    setHead({ merchant: data.receipt.merchant ?? '', purchase_date: data.receipt.purchase_date ?? '', total: data.receipt.total_cents != null ? (data.receipt.total_cents / 100).toFixed(2) : '' });
  }, [data]);

  if (!data) return <div className="page"><Loading /></div>;
  const r = data.receipt;
  const cur = r.currency ?? me.household.currency;
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch, needs_review: patch.name !== undefined ? !patch.name.trim() : l.needs_review } : l)));
  const unresolved = lines.filter((l) => l.action === 'stock' && (!l.name.trim() || l.needs_review)).length;
  const confirmed = r.status !== 'review';

  const reparse = () => run(async () => {
    const fd = new FormData();
    fd.set('text', pasted);
    const res = await api.post(`/spaces/${r.space}/receipts`, fd);
    await api.post(`/receipts/${r.id}/discard`);
    nav(`/receipts/${res.receipt.id}`, { replace: true });
  });

  const confirm = () => run(async () => {
    const res = await api.post(`/receipts/${r.id}/confirm`, {
      merchant: head.merchant || null, purchase_date: head.purchase_date || null, total_cents: parseMoney(head.total),
      lines: lines.map(({ key, needs_review, review_reason, matched_stock_title, ...l }) => l), create_expense: expense,
    });
    emitChange();
    toast(`${res.added} added to STOCK, ${res.completed} NEED item${res.completed === 1 ? '' : 's'} completed${res.merged ? `, ${res.merged} merged` : ''}`);
    nav('/lists/groceries?state=stock');
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Review receipt <SpaceTag space={r.space} /></h1>
          <p className="muted">{confirmed ? 'This receipt was confirmed.' : 'Check every line before anything is added to STOCK. Nothing is saved until you confirm.'}</p>
        </div>
      </header>
      {r.processor_note && <p className="note warn">{r.processor_note}</p>}
      <div className="receipt-layout">
        {r.attachment_url && (
          <div className="receipt-image card">
            {/\.pdf$|pdf/i.test(r.attachment_url) ? null : null}
            <a href={r.attachment_url} target="_blank" rel="noreferrer"><img src={r.attachment_url} alt="Receipt" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /></a>
            <a href={r.attachment_url} target="_blank" rel="noreferrer" className="small">Open original</a>
          </div>
        )}
        <div className="stack grow">
          <div className="grid-3">
            <Field label="Store"><input value={head.merchant} onChange={(e) => setHead({ ...head, merchant: e.target.value })} disabled={confirmed} /></Field>
            <Field label="Date"><input type="date" value={head.purchase_date} onChange={(e) => setHead({ ...head, purchase_date: e.target.value })} disabled={confirmed} /></Field>
            <Field label={`Total (${cur})`}><input inputMode="decimal" value={head.total} onChange={(e) => setHead({ ...head, total: e.target.value })} disabled={confirmed} /></Field>
          </div>
          {!lines.length && !confirmed && (
            <div className="card">
              <p>No products were recognised automatically. Paste the receipt text, or add lines by hand.</p>
              <textarea rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="MILK 1L   1.29" aria-label="Receipt text" />
              <div className="row gap-s end"><button className="btn" disabled={!pasted.trim() || busy} onClick={reparse}>Read pasted text</button></div>
            </div>
          )}
          <table className="receipt-table">
            <thead><tr><th>Add</th><th>Product</th><th>Qty</th><th>Price</th><th>Category</th><th>Matches</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key} className={l.action === 'skip' ? 'skipped' : l.needs_review ? 'review' : ''}>
                  <td><input type="checkbox" checked={l.action === 'stock'} onChange={(e) => set(i, { action: e.target.checked ? 'stock' : 'skip' })} disabled={confirmed} aria-label="Add to stock" /></td>
                  <td>
                    <input value={l.name} onChange={(e) => set(i, { name: e.target.value })} disabled={confirmed} aria-label="Product name" />
                    {l.raw_text && <div className="muted tiny">{l.raw_text}</div>}
                    {l.needs_review && <div className="warn tiny"><AlertTriangle size={12} /> {l.review_reason ?? 'Needs clarification'} {l.name.trim() && !confirmed && <button className="link-btn tiny" onClick={() => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, needs_review: false } : x)))}>Looks right</button>}</div>}
                  </td>
                  <td><input type="number" min={0} step="any" className="qty-input" value={l.quantity ?? ''} onChange={(e) => set(i, { quantity: e.target.value === '' ? null : Number(e.target.value) })} disabled={confirmed} aria-label="Quantity" /></td>
                  <td><input className="price-input" inputMode="decimal" defaultValue={l.total_cents != null ? (l.total_cents / 100).toFixed(2) : ''} onBlur={(e) => set(i, { total_cents: parseMoney(e.target.value) })} disabled={confirmed} aria-label="Price" /></td>
                  <td>
                    <select value={l.category_id ?? ''} onChange={(e) => set(i, { category_id: e.target.value || null })} disabled={confirmed} aria-label="Category">
                      <option value="">—</option>{data.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={l.complete_need_item_id ?? ''} onChange={(e) => set(i, { complete_need_item_id: e.target.value || null })} disabled={confirmed} aria-label="Completes NEED item">
                      <option value="">No NEED item</option>{data.open_need_items.map((n: any) => <option key={n.id} value={n.id}>✓ {n.title}</option>)}
                    </select>
                    {l.merge_into_stock_id && <label className="check tiny"><input type="checkbox" checked onChange={() => set(i, { merge_into_stock_id: null })} disabled={confirmed} /> add to existing “{l.matched_stock_title}”</label>}
                  </td>
                  <td>{!confirmed && <button className="icon-btn small" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line"><Trash2 size={14} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!confirmed && (
            <>
              <button className="btn small ghost" onClick={() => setLines((ls) => [...ls, { key: `n${Date.now()}`, name: '', quantity: 1, unit_price_cents: null, total_cents: null, category_id: null, action: 'stock', complete_need_item_id: null, merge_into_stock_id: null, raw_text: null, needs_review: true, review_reason: 'New line' }])}><Plus size={14} /> Add line</button>
              <label className="check"><input type="checkbox" checked={expense} onChange={(e) => setExpense(e.target.checked)} /> Also record this as an expense{r.space === 'us' ? ' (split equally)' : ''}</label>
              <div className="row gap-s end">
                <span className="muted small grow">{lines.filter((l) => l.action === 'stock').length} lines → STOCK · {money(lines.filter((l) => l.action === 'stock').reduce((s, l) => s + (l.total_cents ?? 0), 0), cur)}{unresolved ? ` · ${unresolved} need a name` : ''}</span>
                <button className="btn ghost" onClick={() => run(async () => { await api.post(`/receipts/${r.id}/discard`); nav(-1); })}>Discard</button>
                <button className="btn primary" disabled={busy || unresolved > 0} onClick={confirm}>Confirm and add to STOCK</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
