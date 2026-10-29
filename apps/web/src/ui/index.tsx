/**
 * Earlio's thin layer over @yaneshtyagi/design-system: status vocabulary, page chrome, feedback and
 * formatting helpers, so pages compose design-system parts the same way everywhere.
 */
import { forwardRef, type ElementType, type ReactNode, type AnchorHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert, Badge, Card, CardBody, CardHeader, EmptyState, Icon, Money, PageHeader, Skeleton, Timeline, cx, formatDate, formatDateTime,
  type BadgeTone, type ButtonSize, type ButtonVariant, type Crumb, type IconName, type TimelineTone,
} from '@yaneshtyagi/design-system';

// ------------------------------------------------------------------ router glue
/** The design system renders links through this so navigation stays client-side. */
export const RouterLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function RouterLink({ href, children, ...rest }, ref) {
  return <Link ref={ref} to={href} {...rest}>{children}</Link>;
});
export const routerLink = RouterLink as ElementType;

// ------------------------------------------------------------------ status vocabulary
const TONES: Record<BadgeTone, string[]> = {
  success: ['Funded', 'Settled', 'Credited', 'Matched', 'Distributed', 'Reconciled', 'Paid', 'Approved', 'PartiallyApproved', 'Recovered', 'Resolved', 'ResolvedForBuyer', 'ResolvedForSupplier',
    'Withdrawn', 'Realised', 'Reported', 'active', 'Active', 'applied', 'approved', 'partial', 'Selected', 'Sent', 'Delivered', 'clear', 'Clear', 'verified', 'Verified', 'attached', 'on'],
  danger: ['Rejected', 'NotEligible', 'Defaulted', 'Reversed', 'Failed', 'Returned', 'Declined', 'declined', 'expired', 'Expired', 'Overdue', 'overdue', 'late', 'missing', 'confirmed', 'rejected', 'revoked', 'failed', 'BLOCKED'],
  warning: ['Disputed', 'Open', 'open', 'UnderReview', 'Escalated', 'Filed', 'ClaimEligible', 'QueuedForValueDate', 'PartiallyReceived', 'Retry', 'draft', 'pending', 'Pending', 'hit', 'referred', 'in_review', 'exhausted'],
  info: ['Submitted', 'Accepted', 'OpenForFunding', 'OffersReceived', 'requested', 'Requested', 'Created', 'ConsentPending', 'BankConfirming', 'DisbursementInstructed', 'Reserved', 'Expected', 'Instructed', 'Queued'],
  neutral: ['Draft', 'Cancelled', 'Closed', 'retired', 'Archived', 'uninsured', 'Superseded', 'false_positive', 'off', 'none'],
  brand: [],
  discovery: [],
};
const TONE_OF = new Map<string, BadgeTone>(Object.entries(TONES).flatMap(([tone, names]) => names.map((n) => [n, tone as BadgeTone] as const)));

/** The tone for a record status. Unknown words stay neutral rather than inventing a meaning. */
export const toneFor = (status: string | null | undefined): BadgeTone => (status ? TONE_OF.get(status) ?? 'neutral' : 'neutral');

/** A status as a badge: the word comes from the record, the colour from the shared vocabulary. */
export function StatusChip({ status, children, tone }: { status?: string | null; children?: ReactNode; tone?: BadgeTone }) {
  return <Badge tone={tone ?? toneFor(status)}>{children ?? status ?? '—'}</Badge>;
}

// ------------------------------------------------------------------ formatting
export const label = (s: string) => s.replace(/_/g, ' ');
/** 22 Oct 2026, 11:42 — the house format for a timestamp. */
export const dt = (s: string | null | undefined) => (s ? formatDateTime(s, { withYear: true }) : '—');
/** 22 Oct 2026 — for a date-only value ("2026-10-22") or a timestamp. */
export const dd = (s: string | null | undefined) => (s ? formatDate(s) : '—');

/** An amount with its currency: the symbol for rupees, the code for every other currency. */
export function Amt({ v, c, direction, strong }: { v: string | number | null | undefined; c: string; direction?: 'credit' | 'debit'; strong?: boolean }) {
  if (v === null || v === undefined || v === '') return <>—</>;
  const m = <Money amount={v} currency={c} currencyDisplay={c === 'INR' ? 'symbol' : 'code'} direction={direction} />;
  return strong ? <strong>{m}</strong> : m;
}

// ------------------------------------------------------------------ page chrome
/**
 * A page: its one h1 with optional description and actions, then content. It renders a fragment so the
 * children become direct regions of the shell's content area, which spaces them.
 */
export function Page({ title, description, meta, actions, breadcrumbs, children }: { title: ReactNode; description?: ReactNode; meta?: ReactNode; actions?: ReactNode; breadcrumbs?: Crumb[]; children?: ReactNode }) {
  return (
    <>
      <PageHeader title={title} description={description} meta={meta} actions={actions} breadcrumbs={breadcrumbs} linkComponent={routerLink} />
      {children}
    </>
  );
}

/** A region of a page. Cards are never nested: use Section inside one. */
export function Panel({ title, sub, actions, level = 2, children, footer }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; level?: 2 | 3 | 4; children?: ReactNode; footer?: ReactNode }) {
  return (
    <Card as="section">
      {title ? <CardHeader title={title} sub={sub} actions={actions} level={level} /> : null}
      <CardBody>
        <div className="stack-3">{children}</div>
      </CardBody>
      {footer}
    </Card>
  );
}

/** A titled part of a Panel. */
export function Section({ title, children, level = 3 }: { title?: ReactNode; children?: ReactNode; level?: 3 | 4 }) {
  const H = `h${level}` as 'h3' | 'h4';
  return (
    <div className="subsection">
      {title ? <H className="bv-heading-xs">{title}</H> : null}
      {children}
    </div>
  );
}

export const Hint = ({ children }: { children: ReactNode }) => <p className="hint">{children}</p>;

// ------------------------------------------------------------------ feedback
export type Msg = { ok?: boolean; kind?: 'ok' | 'err'; text: string } | null | undefined;
/** Success is announced politely, a problem assertively; the words come from the server's plain-language reasons. */
export function Notice({ msg }: { msg: Msg }) {
  if (!msg) return null;
  const ok = msg.ok ?? msg.kind === 'ok';
  return <Alert tone={ok ? 'success' : 'danger'} title={msg.text} />;
}
export function ErrorNote({ children }: { children?: ReactNode }) {
  return children ? <Alert tone="danger" title={children} /> : null;
}

/** Shown while a page's first data loads: skeleton blocks shaped like the content, never a lone spinner. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div aria-busy="true" className="stack-3">
      <span className="bv-sr-only">{label}</span>
      <Skeleton width="40%" height={28} />
      <Skeleton height={120} />
    </div>
  );
}

/** A link that looks like a button, navigating inside the app (the design system's LinkButton reloads the page). */
export function NavButton({ to, variant = 'secondary', size = 'md', icon, children }: { to: string; variant?: ButtonVariant; size?: ButtonSize; icon?: IconName; children: ReactNode }) {
  return (
    <Link to={to} className={cx('bv-btn', `bv-btn--${variant}`, size !== 'md' && `bv-btn--${size}`)}>
      {icon ? <Icon name={icon} size={size === 'lg' ? 20 : 16} /> : null}
      <span className="bv-btn__label">{children}</span>
    </Link>
  );
}

/** What a table shows when it has no rows. */
export const noRows = (title: string, text?: ReactNode) => <EmptyState title={title}>{text}</EmptyState>;

export interface TimelineItem { id: string; title: ReactNode; meta?: ReactNode; at: string; tone?: TimelineTone }
/** A record's trail of events, in the order given (the design system expects newest first). */
export function TimelineList({ events, 'aria-label': ariaLabel }: { events: TimelineItem[]; 'aria-label': string }) {
  if (!events.length) return null;
  return <Timeline aria-label={ariaLabel} events={events.map((e) => ({ id: e.id, title: e.title, meta: e.meta, time: dt(e.at), isoTime: e.at, tone: e.tone }))} />;
}
