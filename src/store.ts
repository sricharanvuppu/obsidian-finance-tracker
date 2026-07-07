import { App, normalizePath } from "obsidian";
import { FinanceData, Transaction, Loan, Repayment } from "./types";

function monthOf(date: string): string {
  return (date || "").slice(0, 7); // YYYY-MM
}

/**
 * Storage layout (all relative to the base folder, default "_finance"):
 *   config.json                       -> version, accounts, categories, budgets, recurring
 *   loans.json                        -> array of loans
 *   transactions/YYYY/YYYY-MM.json    -> array of transactions for that month
 *
 * All data is loaded into memory on start; writes are targeted to the affected
 * month file (or config/loans), so syncing (e.g. Remotely Save) rarely conflicts.
 * On first run it auto-migrates from the old single-file format and keeps a .bak.
 */
export class FinanceStore {
  private app: App;
  baseDir = "";
  private legacyPath = "";
  data: FinanceData = { version: 2, transactions: [], loans: [] };
  lastWrite = 0;

  constructor(app: App, dataFilePath: string) {
    this.app = app;
    this.setPath(dataFilePath);
  }

  setPath(dataFilePath: string) {
    this.legacyPath = normalizePath(dataFilePath);
    const slash = this.legacyPath.lastIndexOf("/");
    this.baseDir = slash > 0 ? this.legacyPath.slice(0, slash) : "";
  }

  private p(rel: string): string {
    return normalizePath((this.baseDir ? this.baseDir + "/" : "") + rel);
  }
  private get configPath() { return this.p("config.json"); }
  private get loansPath() { return this.p("loans.json"); }
  private get txnDir() { return this.p("transactions"); }
  private monthPath(ym: string): string { return this.p(`transactions/${ym.slice(0, 4)}/${ym}.json`); }

  // ── low-level helpers ─────────────────────────────────────────────
  private get adapter() { return this.app.vault.adapter; }

  private async ensureDir(dir: string): Promise<void> {
    if (!dir) return;
    const parts = dir.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? cur + "/" + part : part;
      if (!(await this.adapter.exists(cur))) {
        try { await this.adapter.mkdir(cur); } catch { /* race: already exists */ }
      }
    }
  }

  private async writeFile(path: string, content: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash > 0) await this.ensureDir(path.slice(0, slash));
    await this.adapter.write(path, content);
    this.lastWrite = Date.now();
  }

  private genId(): string {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  // ── load ──────────────────────────────────────────────────────────
  async load(): Promise<void> {
    try {
      if (await this.adapter.exists(this.configPath)) {
        await this.loadSplit();
      } else if (await this.adapter.exists(this.legacyPath)) {
        await this.loadLegacy();
        await this.migrateToSplit();
      } else {
        this.data = { version: 2, transactions: [], loans: [] };
        await this.writeAll();
      }
    } catch (e) {
      console.error("Finance Tracker: failed to load data", e);
      this.data = { version: 2, transactions: [], loans: [] };
    }
  }

  private async loadLegacy(): Promise<void> {
    const raw = await this.adapter.read(this.legacyPath);
    const parsed = JSON.parse(raw) as Partial<FinanceData>;
    this.data = {
      version: parsed.version ?? 1,
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      loans: Array.isArray(parsed.loans) ? parsed.loans : [],
      accounts: parsed.accounts,
      categories: parsed.categories,
      budgets: parsed.budgets,
      recurring: parsed.recurring,
    };
  }

  private async loadSplit(): Promise<void> {
    const cfg = JSON.parse(await this.adapter.read(this.configPath));
    const loans = (await this.adapter.exists(this.loansPath))
      ? JSON.parse(await this.adapter.read(this.loansPath))
      : [];

    const transactions: Transaction[] = [];
    if (await this.adapter.exists(this.txnDir)) {
      const years = await this.adapter.list(this.txnDir);
      for (const yearFolder of years.folders) {
        const monthFiles = await this.adapter.list(yearFolder);
        for (const mf of monthFiles.files) {
          if (!mf.endsWith(".json")) continue;
          try {
            const arr = JSON.parse(await this.adapter.read(mf));
            if (Array.isArray(arr)) transactions.push(...arr);
          } catch (e) {
            console.error("Finance Tracker: skipping unreadable month file", mf, e);
          }
        }
      }
    }

    this.data = {
      version: cfg.version ?? 2,
      transactions,
      loans: Array.isArray(loans) ? loans : Array.isArray(loans.loans) ? loans.loans : [],
      accounts: cfg.accounts,
      categories: cfg.categories,
      budgets: cfg.budgets,
      recurring: cfg.recurring,
    };
  }

  private async migrateToSplit(): Promise<void> {
    this.data.version = 2;
    await this.writeAll();
    // keep a backup of the old single file, then remove it
    try {
      const raw = await this.adapter.read(this.legacyPath);
      await this.adapter.write(this.legacyPath + ".bak", raw);
      await this.adapter.remove(this.legacyPath);
    } catch (e) {
      console.error("Finance Tracker: legacy backup/remove failed", e);
    }
  }

  // ── write ─────────────────────────────────────────────────────────
  async writeAll(): Promise<void> {
    await this.ensureDir(this.baseDir);
    await this.saveConfig();
    await this.saveLoans();
    const byMonth = new Map<string, Transaction[]>();
    for (const t of this.data.transactions) {
      const ym = monthOf(t.date);
      if (!ym) continue;
      if (!byMonth.has(ym)) byMonth.set(ym, []);
      byMonth.get(ym)!.push(t);
    }
    for (const [ym, arr] of byMonth) {
      await this.writeFile(this.monthPath(ym), JSON.stringify(arr, null, 2));
    }
  }

  async saveConfig(): Promise<void> {
    const cfg = {
      version: this.data.version ?? 2,
      accounts: this.data.accounts ?? [],
      categories: this.data.categories,
      budgets: this.data.budgets ?? {},
      recurring: this.data.recurring ?? [],
    };
    await this.writeFile(this.configPath, JSON.stringify(cfg, null, 2));
  }

  async saveLoans(): Promise<void> {
    await this.writeFile(this.loansPath, JSON.stringify(this.data.loans ?? [], null, 2));
  }

  /** Writes (or deletes if empty) the file for a single month. */
  private async saveMonth(ym: string): Promise<void> {
    if (!ym) return;
    const arr = this.data.transactions.filter((t) => monthOf(t.date) === ym);
    const path = this.monthPath(ym);
    if (arr.length === 0) {
      if (await this.adapter.exists(path)) {
        try { await this.adapter.remove(path); this.lastWrite = Date.now(); } catch { /* ignore */ }
      }
      return;
    }
    await this.writeFile(path, JSON.stringify(arr, null, 2));
  }

  // ── transactions CRUD ─────────────────────────────────────────────
  getAll(): Transaction[] {
    return this.data.transactions;
  }

  async add(txn: Omit<Transaction, "id">): Promise<Transaction> {
    const created: Transaction = { ...txn, id: this.genId() };
    this.data.transactions.push(created);
    await this.saveMonth(monthOf(created.date));
    return created;
  }

  async update(id: string, patch: Partial<Omit<Transaction, "id">>): Promise<void> {
    const idx = this.data.transactions.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const oldMonth = monthOf(this.data.transactions[idx].date);
    this.data.transactions[idx] = { ...this.data.transactions[idx], ...patch };
    const newMonth = monthOf(this.data.transactions[idx].date);
    await this.saveMonth(newMonth);
    if (newMonth !== oldMonth) await this.saveMonth(oldMonth);
  }

  async remove(id: string): Promise<void> {
    const t = this.data.transactions.find((x) => x.id === id);
    if (!t) return;
    const ym = monthOf(t.date);
    this.data.transactions = this.data.transactions.filter((x) => x.id !== id);
    await this.saveMonth(ym);
  }

  // ── loans ─────────────────────────────────────────────────────────
  getLoans(): Loan[] {
    if (!Array.isArray(this.data.loans)) this.data.loans = [];
    return this.data.loans;
  }

  async addLoan(loan: Omit<Loan, "id" | "repayments">): Promise<Loan> {
    const created: Loan = { ...loan, id: this.genId(), repayments: [] };
    this.getLoans().push(created);
    await this.saveLoans();
    return created;
  }

  async updateLoan(id: string, patch: Partial<Omit<Loan, "id" | "repayments">>): Promise<void> {
    const loan = this.getLoans().find((l) => l.id === id);
    if (loan) { Object.assign(loan, patch); await this.saveLoans(); }
  }

  async removeLoan(id: string): Promise<void> {
    this.data.loans = this.getLoans().filter((l) => l.id !== id);
    await this.saveLoans();
  }

  async addRepayment(loanId: string, rp: Omit<Repayment, "id">): Promise<void> {
    const loan = this.getLoans().find((l) => l.id === loanId);
    if (loan) { loan.repayments.push({ ...rp, id: this.genId() }); await this.saveLoans(); }
  }

  async removeRepayment(loanId: string, repaymentId: string): Promise<void> {
    const loan = this.getLoans().find((l) => l.id === loanId);
    if (loan) {
      loan.repayments = loan.repayments.filter((r) => r.id !== repaymentId);
      await this.saveLoans();
    }
  }
}
