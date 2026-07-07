import { App, normalizePath, TFile } from "obsidian";
import { FinanceData, Transaction, Loan, Repayment } from "./types";

/**
 * Handles reading and writing the transactions JSON file in the vault.
 * Uses the vault adapter so the path is relative to the vault root.
 */
export class FinanceStore {
  private app: App;
  private path: string;
  data: FinanceData = { version: 1, transactions: [], loans: [] };

  constructor(app: App, path: string) {
    this.app = app;
    this.path = normalizePath(path);
  }

  setPath(path: string) {
    this.path = normalizePath(path);
  }

  private async ensureFolder(): Promise<void> {
    const slash = this.path.lastIndexOf("/");
    if (slash <= 0) return;
    const folder = this.path.substring(0, slash);
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.adapter.mkdir(folder);
    }
  }

  async load(): Promise<void> {
    try {
      if (await this.app.vault.adapter.exists(this.path)) {
        const raw = await this.app.vault.adapter.read(this.path);
        const parsed = JSON.parse(raw) as Partial<FinanceData>;
        this.data = {
          version: parsed.version ?? 1,
          transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
          loans: Array.isArray(parsed.loans) ? parsed.loans : [],
        };
      } else {
        this.data = { version: 1, transactions: [], loans: [] };
        await this.save();
      }
    } catch (e) {
      console.error("Finance Tracker: failed to load data", e);
      this.data = { version: 1, transactions: [], loans: [] };
    }
  }

  async save(): Promise<void> {
    await this.ensureFolder();
    const body = JSON.stringify(this.data, null, 2);
    // Prefer a TFile write when available (keeps Obsidian's index in sync).
    const file = this.app.vault.getAbstractFileByPath(this.path);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, body);
    } else {
      await this.app.vault.adapter.write(this.path, body);
    }
  }

  private genId(): string {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  getAll(): Transaction[] {
    return this.data.transactions;
  }

  async add(txn: Omit<Transaction, "id">): Promise<Transaction> {
    const created: Transaction = { ...txn, id: this.genId() };
    this.data.transactions.push(created);
    await this.save();
    return created;
  }

  async update(id: string, patch: Partial<Omit<Transaction, "id">>): Promise<void> {
    const idx = this.data.transactions.findIndex((t) => t.id === id);
    if (idx >= 0) {
      this.data.transactions[idx] = { ...this.data.transactions[idx], ...patch };
      await this.save();
    }
  }

  async remove(id: string): Promise<void> {
    this.data.transactions = this.data.transactions.filter((t) => t.id !== id);
    await this.save();
  }

  // ── Loans ──────────────────────────────────────────────────────
  getLoans(): Loan[] {
    if (!Array.isArray(this.data.loans)) this.data.loans = [];
    return this.data.loans;
  }

  async addLoan(loan: Omit<Loan, "id" | "repayments">): Promise<Loan> {
    const created: Loan = { ...loan, id: this.genId(), repayments: [] };
    this.getLoans().push(created);
    await this.save();
    return created;
  }

  async updateLoan(id: string, patch: Partial<Omit<Loan, "id" | "repayments">>): Promise<void> {
    const loan = this.getLoans().find((l) => l.id === id);
    if (loan) {
      Object.assign(loan, patch);
      await this.save();
    }
  }

  async removeLoan(id: string): Promise<void> {
    this.data.loans = this.getLoans().filter((l) => l.id !== id);
    await this.save();
  }

  async addRepayment(loanId: string, rp: Omit<Repayment, "id">): Promise<void> {
    const loan = this.getLoans().find((l) => l.id === loanId);
    if (loan) {
      loan.repayments.push({ ...rp, id: this.genId() });
      await this.save();
    }
  }

  async removeRepayment(loanId: string, repaymentId: string): Promise<void> {
    const loan = this.getLoans().find((l) => l.id === loanId);
    if (loan) {
      loan.repayments = loan.repayments.filter((r) => r.id !== repaymentId);
      await this.save();
    }
  }
}
