import { FinanceSettings, Transaction, TxnType, Frequency, Account, Loan } from "./types";

export function formatCurrency(amount: number, settings: FinanceSettings): string {
  try {
    return new Intl.NumberFormat(settings.locale || "en-IN", {
      style: "currency",
      currency: settings.currency || "INR",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${settings.currency} ${amount.toFixed(2)}`;
  }
}

export function todayISO(): string {
  const d = new Date();
  return toISO(d);
}

/** Current time as HH:mm (24-hour) in IST (Asia/Kolkata), regardless of device timezone. */
export function nowTimeIST(): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
}

/** Combined date+time key for chronological sorting (falls back to 00:00 when no time). */
export function dateTimeKey(t: { date: string; time?: string }): string {
  return (t.date || "") + "T" + (t.time || "00:00");
}

export function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseISO(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s || "").trim());
  if (!m) return null;
  const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

export function monthKey(iso: string): string {
  return (iso || "").slice(0, 7); // YYYY-MM
}

export function monthLabel(key: string): string {
  const d = parseISO(key + "-01");
  if (!d) return key;
  return d.toLocaleString("default", { month: "short", year: "numeric" });
}

export interface DateRange {
  from: string; // inclusive YYYY-MM-DD
  to: string; // inclusive YYYY-MM-DD
}

export type RangePreset = "this-month" | "last-month" | "this-year" | "last-year" | "all" | "custom";

export function computeRange(preset: RangePreset, all: Transaction[], custom?: DateRange): DateRange {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case "this-month":
      return { from: toISO(new Date(y, m, 1)), to: toISO(new Date(y, m + 1, 0)) };
    case "last-month":
      return { from: toISO(new Date(y, m - 1, 1)), to: toISO(new Date(y, m, 0)) };
    case "this-year":
      return { from: toISO(new Date(y, 0, 1)), to: toISO(new Date(y, 11, 31)) };
    case "last-year":
      return { from: toISO(new Date(y - 1, 0, 1)), to: toISO(new Date(y - 1, 11, 31)) };
    case "custom":
      return custom ?? { from: toISO(new Date(y, m, 1)), to: toISO(new Date(y, m + 1, 0)) };
    case "all":
    default: {
      if (all.length === 0) return { from: toISO(new Date(y, 0, 1)), to: todayISO() };
      const dates = all.map((t) => t.date).sort();
      return { from: dates[0], to: dates[dates.length - 1] };
    }
  }
}

export function inRange(iso: string, range: DateRange): boolean {
  return iso >= range.from && iso <= range.to;
}

export function sumByType(txns: Transaction[], type: TxnType): number {
  return txns.filter((t) => t.type === type).reduce((s, t) => s + (t.amount || 0), 0);
}

// ── Account balances ───────────────────────────────────────────────
export interface AccountBalance {
  account: Account;
  balance: number;
}

/**
 * Computes the current balance of each account:
 *   initialBalance + income - expense - investment - transfersOut + transfersIn
 *   + loan cash movements (lending out reduces cash, repayments received add it, etc.)
 * Considers ALL transactions/loans (balances are point-in-time, not range-filtered).
 */
export function computeBalances(
  accounts: Account[],
  txns: Transaction[],
  loans: Loan[] = []
): AccountBalance[] {
  const map = new Map<string, number>();
  for (const a of accounts) map.set(a.id, a.initialBalance || 0);

  for (const t of txns) {
    const amt = t.amount || 0;
    if (t.type === "transfer") {
      if (t.account && map.has(t.account)) map.set(t.account, map.get(t.account)! - amt);
      if (t.toAccount && map.has(t.toAccount)) map.set(t.toAccount, map.get(t.toAccount)! + amt);
      continue;
    }
    if (!t.account || !map.has(t.account)) continue;
    if (t.type === "income") map.set(t.account, map.get(t.account)! + amt);
    else map.set(t.account, map.get(t.account)! - amt); // expense or investment
  }

  // Loan cash movements
  for (const loan of loans) {
    // lent: principal leaves cash (-); borrowed: principal enters cash (+)
    const openSign = loan.direction === "lent" ? -1 : 1;
    if (loan.account && map.has(loan.account)) {
      map.set(loan.account, map.get(loan.account)! + openSign * (loan.principal || 0));
    }
    // lent: repayments bring cash in (+); borrowed: repayments send cash out (-)
    const rSign = loan.direction === "lent" ? 1 : -1;
    for (const rp of loan.repayments || []) {
      const acc = rp.account || loan.account;
      const cash = (rp.principal || 0) + (rp.interest || 0);
      if (acc && map.has(acc)) map.set(acc, map.get(acc)! + rSign * cash);
    }
  }

  return accounts.map((a) => ({ account: a, balance: map.get(a.id) ?? a.initialBalance ?? 0 }));
}

export function cashTotal(accounts: Account[], txns: Transaction[], loans: Loan[] = []): number {
  return computeBalances(accounts, txns, loans).reduce((s, b) => s + b.balance, 0);
}

// ── Lending helpers ────────────────────────────────────────────────
/** Outstanding principal on a loan (principal not yet repaid). */
export function loanOutstanding(loan: Loan): number {
  const repaid = (loan.repayments || []).reduce((s, r) => s + (r.principal || 0), 0);
  return Math.max(0, (loan.principal || 0) - repaid);
}

export function loanInterestTotal(loan: Loan): number {
  return (loan.repayments || []).reduce((s, r) => s + (r.interest || 0), 0);
}

/** Total still owed TO you across lent loans. */
export function totalReceivable(loans: Loan[]): number {
  return loans.filter((l) => l.direction === "lent").reduce((s, l) => s + loanOutstanding(l), 0);
}

/** Total you still owe across borrowed loans. */
export function totalPayable(loans: Loan[]): number {
  return loans.filter((l) => l.direction === "borrowed").reduce((s, l) => s + loanOutstanding(l), 0);
}

/** Net worth = liquid cash + receivables - payables. */
export function netWorth(accounts: Account[], txns: Transaction[], loans: Loan[]): number {
  return cashTotal(accounts, txns, loans) + totalReceivable(loans) - totalPayable(loans);
}

/** Interest earned (lent) within a date range, from repayment dates. */
export function interestEarnedInRange(loans: Loan[], range: DateRange): number {
  return loans
    .filter((l) => l.direction === "lent")
    .reduce(
      (s, l) =>
        s + (l.repayments || []).filter((r) => inRange(r.date, range)).reduce((a, r) => a + (r.interest || 0), 0),
      0
    );
}

/** Interest paid (borrowed) within a date range. */
export function interestPaidInRange(loans: Loan[], range: DateRange): number {
  return loans
    .filter((l) => l.direction === "borrowed")
    .reduce(
      (s, l) =>
        s + (l.repayments || []).filter((r) => inRange(r.date, range)).reduce((a, r) => a + (r.interest || 0), 0),
      0
    );
}

/**
 * Net change in liquid cash from lending activity within a date range:
 *   - lent out (loan.date in range): -principal
 *   - repayment received (lent): +(principal+interest)
 *   - borrowed received (loan.date in range): +principal
 *   - repayment paid (borrowed): -(principal+interest)
 */
export function lendingNetCashInRange(loans: Loan[], range: DateRange): number {
  let net = 0;
  for (const loan of loans) {
    if (inRange(loan.date, range)) {
      net += (loan.direction === "lent" ? -1 : 1) * (loan.principal || 0);
    }
    const rSign = loan.direction === "lent" ? 1 : -1;
    for (const rp of loan.repayments || []) {
      if (inRange(rp.date, range)) net += rSign * ((rp.principal || 0) + (rp.interest || 0));
    }
  }
  return net;
}

export function accountName(accounts: Account[], id?: string): string {
  if (!id) return "";
  return accounts.find((a) => a.id === id)?.name ?? "(deleted)";
}

// ── Recurrence ─────────────────────────────────────────────────────

/** Advance a date by one period of the given frequency. Clamps month-day overflow. */
export function advanceDate(d: Date, freq: Frequency): Date {
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  if (freq === "weekly") {
    return new Date(y, m, day + 7);
  }
  if (freq === "yearly") {
    return clampDay(y + 1, m, day);
  }
  // monthly
  return clampDay(y, m + 1, day);
}

function clampDay(year: number, month: number, day: number): Date {
  // Normalize month overflow (month can be 12 -> next year handled by Date)
  const normYear = year + Math.floor(month / 12);
  const normMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(normYear, normMonth + 1, 0).getDate();
  return new Date(normYear, normMonth, Math.min(day, lastDay));
}

/**
 * Returns the list of ISO dates a recurring rule should be posted for,
 * strictly after lastPosted (if set) and on/after startDate, up to and including `upto`.
 */
export function dueOccurrences(
  startDate: string,
  lastPosted: string | null,
  freq: Frequency,
  upto: Date
): string[] {
  const start = parseISO(startDate);
  if (!start) return [];
  const last = lastPosted ? parseISO(lastPosted) : null;
  const out: string[] = [];
  let d = start;
  // safety cap to avoid runaway loops
  let guard = 0;
  while (d.getTime() <= upto.getTime() && guard < 5000) {
    guard++;
    if (!last || d.getTime() > last.getTime()) {
      out.push(toISO(d));
    }
    d = advanceDate(d, freq);
  }
  return out;
}

// ── CSV ────────────────────────────────────────────────────────────
function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

export function transactionsToCSV(txns: Transaction[], accounts: Account[] = []): string {
  const header = ["date", "time", "type", "category", "sub-category", "amount", "account", "to-account", "note"];
  const lines = [header.join(",")];
  for (const t of txns) {
    lines.push(
      [
        t.date,
        t.time || "",
        t.type,
        csvEscape(t.category || ""),
        csvEscape(t.subcategory || ""),
        String(t.amount),
        csvEscape(accountName(accounts, t.account)),
        csvEscape(t.type === "transfer" ? accountName(accounts, t.toAccount) : ""),
        csvEscape(t.note || ""),
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}
