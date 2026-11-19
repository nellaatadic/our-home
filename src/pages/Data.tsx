import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { day, money } from '../lib/format';
import { Loading } from '../components/ui';

/** Vertical bars with a faint grid and value labels. */
function Columns({ data, format, height = 150, highlightLast }: { data: { label: string; value: number }[]; format: (n: number) => string; height?: number; highlightLast?: boolean }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 100 / data.length;
  return (
    <svg className="chart" viewBox={`0 0 100 ${height / 3}`} preserveAspectRatio="none" role="img" aria-label={data.map((d) => `${d.label}: ${format(d.value)}`).join(', ')} style={{ height }}>
      {[0.25, 0.5, 0.75, 1].map((g) => <line key={g} x1="0" x2="100" y1={(height / 3) * (1 - g * 0.82)} y2={(height / 3) * (1 - g * 0.82)} className="grid" />)}
      {data.map((d, i) => {
        const h = (d.value / max) * (height / 3) * 0.82;
        return <rect key={d.label} x={i * w + w * 0.18} width={w * 0.64} y={height / 3 - h} height={Math.max(h, d.value ? 0.6 : 0)} rx="0.8" className={highlightLast && i === data.length - 1 ? 'bar now' : 'bar'} />;
      })}
    </svg>
  );
}

function ColumnLabels({ data, format }: { data: { label: string; value: number }[]; format: (n: number) => string }) {
  return (
    <div className="chart-labels" style={{ gridTemplateColumns: `repeat(${data.length}, 1fr)` }}>
      {data.map((d) => <span key={d.label}><b>{d.value ? format(d.value) : '–'}</b>{d.label}</span>)}
    </div>
  );
}

function HBars({ data, format }: { data: { name: string; value: number }[]; format: (n: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="hbars">
      {data.map((d) => (
        <li key={d.name}>
          <span className="clamp1">{d.name}</span>
          <span className="hbar"><i style={{ width: `${(d.value / max) * 100}%` }} /></span>
          <b>{format(d.value)}</b>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'warn' | 'ok' }) {
  return <div className={`stat-tile ${tone ?? ''}`}><b>{value}</b><span>{label}</span></div>;
}

export function DataPage() {
  const me = useMe();
  const { data } = useApi<any>('/data');
  if (!data) return <div className="page"><Loading /></div>;
  const cur = (n: number) => money(n, data.currency).replace(/\.00$/, '');
  const months = data.spending.months.map((m: any) => ({ label: day(`${m.month}-01`, { month: 'short' }), value: m.cents }));
  const partner = data.partner_name ?? 'Partner';
  const o = data.open;
  const weeks = data.calendar.weeks;
  const maxWeek = Math.max(1, ...weeks.map((w: any) => w.shared + w.mine + w.partner_busy));

  return (
    <div className="page data-page">
      <header className="page-head compact">
        <h1><BarChart3 size={22} /> Data</h1>
        <p className="muted small">Based only on what you can see: shared things and your own private ones.</p>
      </header>

      <div className="data-grid">
        <section className="tile span-2">
          <header className="tile-head"><h2>Spending</h2><span className="muted small">Last 6 months · {cur(data.spending.total_cents)}</span></header>
          {data.spending.total_cents ? <>
            <Columns data={months} format={cur} highlightLast />
            <ColumnLabels data={months} format={cur} />
            <div className="split">
              <div>
                <h3>By category</h3>
                <HBars data={data.spending.by_category.map((c: any) => ({ name: c.name, value: c.cents }))} format={cur} />
              </div>
              <div>
                <h3>Who paid</h3>
                <HBars data={data.spending.by_payer.map((c: any) => ({ name: c.name, value: c.cents }))} format={cur} />
                <h3>Shared balance</h3>
                <p className="balance">{data.spending.balance ? <><b>{data.spending.balance.owed_by}</b> owes <b>{data.spending.balance.owed_to}</b> {cur(data.spending.balance.cents)}</> : 'You’re even.'}</p>
              </div>
            </div>
          </> : <p className="muted small">No spending yet. Confirmed receipts and shared expenses appear here. <Link to="/lists/groceries">Scan a receipt</Link></p>}
        </section>

        <section className="tile">
          <header className="tile-head"><h2>Open topics</h2></header>
          <div className="stat-grid">
            <Stat label="open to-dos" value={o.todos.total} />
            <Stat label="overdue" value={o.todos.overdue + (o.overdue_items ?? 0)} tone={o.todos.overdue + (o.overdue_items ?? 0) ? 'warn' : undefined} />
            <Stat label="urgent items" value={o.urgent ?? 0} tone={o.urgent ? 'warn' : undefined} />
            <Stat label="flagged" value={o.flagged ?? 0} />
            <Stat label="being decided" value={o.deciding ?? 0} />
            <Stat label={`chats where ${partner} spoke last`} value={o.waiting_on_me} />
          </div>
          <h3>To-dos by person</h3>
          <HBars data={[
            { name: 'You', value: o.todos.mine }, { name: partner, value: o.todos.partner }, { name: 'Both', value: o.todos.both }, { name: 'Unassigned', value: o.todos.unassigned },
          ]} format={(n) => String(n)} />
        </section>

        <section className="tile">
          <header className="tile-head"><h2>Grocery habits</h2><span className="muted small">Last 90 days</span></header>
          {data.groceries.most_bought.length ? <>
            <div className="stat-grid two">
              <Stat label="days from list to bought (average)" value={data.groceries.avg_days_to_buy ?? '–'} />
              <Stat label="purchases counted" value={data.groceries.purchases_counted} />
            </div>
            <h3>Bought most often</h3>
            <HBars data={data.groceries.most_bought.map((g: any) => ({ name: g.title, value: g.n }))} format={(n) => `${n}×`} />
            {data.groceries.ran_out.length > 0 && <>
              <h3>Ran out most often</h3>
              <HBars data={data.groceries.ran_out.map((g: any) => ({ name: g.title, value: g.n }))} format={(n) => `${n}×`} />
            </>}
          </> : <p className="muted small">Tick items off your grocery list and the patterns show up here.</p>}
        </section>

        <section className="tile span-2">
          <header className="tile-head"><h2>Calendar load</h2><span className="muted small">Next 8 weeks</span></header>
          <div className="week-bars" role="img" aria-label={weeks.map((w: any) => `Week of ${w.week}: ${w.shared} shared, ${w.mine} private, ${w.partner_busy} ${partner} busy`).join('; ')}>
            {weeks.map((w: any) => (
              <div key={w.week} className="week-bar">
                <div className="stack-bar" style={{ height: 120 }}>
                  <i className="ev-us" style={{ height: `${(w.shared / maxWeek) * 100}%` }} title={`${w.shared} shared`} />
                  <i className="ev-me" style={{ height: `${(w.mine / maxWeek) * 100}%` }} title={`${w.mine} private`} />
                  <i className="busy" style={{ height: `${(w.partner_busy / maxWeek) * 100}%` }} title={`${w.partner_busy} ${partner} busy`} />
                </div>
                <b>{w.shared + w.mine + w.partner_busy}</b>
                <span>{day(w.week, { month: 'short', day: 'numeric' })}</span>
              </div>
            ))}
          </div>
          <p className="legend"><i className="ev-us" /> Shared <i className="ev-me" /> Your private {data.partner_shares_availability ? <><i className="busy" /> {partner} busy</> : <span className="muted small">· {partner}’s private time isn’t shared (each of you can turn this on in Settings)</span>}</p>
        </section>
      </div>
      <p className="muted tiny">Household currency: {data.currency}. {me.household.timezone} time.</p>
    </div>
  );
}
