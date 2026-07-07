import { ItemView, WorkspaceLeaf, Notice, normalizePath } from "obsidian";
import {
  Chart,
  ArcElement,
  LineElement,
  BarElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  PieController,
  LineController,
  BarController,
} from "chart.js";
import { Transaction, TxnType } from "./types";
import {
  DateRange,
  RangePreset,
  computeRange,
  formatCurrency,
  inRange,
  monthKey,
  monthLabel,
  sumByType,
  transactionsToCSV,
  toISO,
  computeBalances,
  cashTotal,
  netWorth,
  totalReceivable,
  totalPayable,
  loanOutstanding,
  loanInterestTotal,
  interestEarnedInRange,
  interestPaidInRange,
  lendingNetCashInRange,
  accountName,
  dateTimeKey,
} from "./util";
import { AddTransactionModal } from "./AddTransactionModal";
import { RecurringModal } from "./RecurringModal";
import { BudgetModal } from "./BudgetModal";
import { AccountModal } from "./AccountModal";
import { LoanModal } from "./LoanModal";
import type FinanceTrackerPlugin from "./main";

Chart.register(
  ArcElement,
  LineElement,
  BarElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  PieController,
  LineController,
  BarController
);

export const VIEW_TYPE_FINANCE = "finance-tracker-dashboard";

const PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac",
  "#86bcb6", "#d37295", "#fabfd2", "#8cd17d", "#b6992d",
];

export class FinanceDashboardView extends ItemView {
  private plugin: FinanceTrackerPlugin;

  private mode: "dashboard" | "yearly" | "budget" | "lending" = "dashboard";
  private preset: RangePreset = "this-month";
  private custom: DateRange | null = null;
  private typeFilter: "all" | TxnType = "all";
  private categoryFilter = "all";
  private accountFilter = "all";
  private search = "";
  private sortKey: keyof Transaction = "date";
  private sortDir: "asc" | "desc" = "desc";
  private budgetMonth: string = monthKey(toISO(new Date()));

  private pieChart: Chart | null = null;
  private trendChart: Chart | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: FinanceTrackerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_FINANCE;
  }
  getDisplayText() {
    return "Finance Tracker";
  }
  getIcon() {
    return "indian-rupee";
  }

  async onOpen() {
    this.render();
  }

  async onClose() {
    this.destroyCharts();
  }

  private destroyCharts() {
    this.pieChart?.destroy();
    this.trendChart?.destroy();
    this.pieChart = null;
    this.trendChart = null;
  }

  public refresh() {
    this.render();
  }

  private currentRange(): DateRange {
    return computeRange(this.preset, this.plugin.store.getAll(), this.custom ?? undefined);
  }

  private filtered(): Transaction[] {
    const range = this.currentRange();
    const q = this.search.trim().toLowerCase();
    return this.plugin.store
      .getAll()
      .filter((t) => inRange(t.date, range))
      .filter((t) => this.typeFilter === "all" || t.type === this.typeFilter)
      .filter((t) => this.categoryFilter === "all" || t.category === this.categoryFilter)
      .filter(
        (t) =>
          this.accountFilter === "all" ||
          t.account === this.accountFilter ||
          t.toAccount === this.accountFilter
      )
      .filter(
        (t) =>
          q === "" ||
          t.category.toLowerCase().includes(q) ||
          t.subcategory.toLowerCase().includes(q) ||
          (t.note || "").toLowerCase().includes(q)
      );
  }

  private render() {
    this.destroyCharts();
    const root = this.contentEl;
    root.empty();
    root.addClass("ft-dashboard");

    this.renderModeTabs(root);

    if (this.mode === "yearly") {
      this.renderYearly(root);
      return;
    }
    if (this.mode === "budget") {
      this.renderBudget(root);
      return;
    }
    if (this.mode === "lending") {
      this.renderLending(root);
      return;
    }

    this.renderToolbar(root);
    const txns = this.filtered();
    this.renderSummary(root, txns);

    const charts = root.createDiv("ft-charts");
    this.renderPie(charts, txns);
    this.renderTrend(charts);

    this.renderTable(root, txns);
  }

  private renderModeTabs(root: HTMLElement) {
    const tabs = root.createDiv("ft-mode-tabs");
    const modes: { key: typeof this.mode; label: string }[] = [
      { key: "dashboard", label: "Dashboard" },
      { key: "yearly", label: "Yearly" },
      { key: "budget", label: "Budget" },
      { key: "lending", label: "Lending" },
    ];
    modes.forEach((m) => {
      const b = tabs.createEl("button", {
        text: m.label,
        cls: "ft-mode-tab" + (this.mode === m.key ? " is-active" : ""),
      });
      b.onclick = () => {
        this.mode = m.key;
        this.render();
      };
    });

    const spacer = tabs.createDiv("ft-mode-spacer");
    spacer.style.flex = "1";

    const recurBtn = tabs.createEl("button", { text: "↻ Recurring", cls: "ft-chip" });
    recurBtn.setAttr("aria-label", "Manage recurring transactions");
    recurBtn.onclick = () =>
      new RecurringModal(this.app, this.plugin, () => this.refresh()).open();

    const acctBtn = tabs.createEl("button", { text: "🏦 Accounts", cls: "ft-chip" });
    acctBtn.setAttr("aria-label", "Manage accounts");
    acctBtn.onclick = () =>
      new AccountModal(this.app, this.plugin, () => this.refresh()).open();

    const loanBtn = tabs.createEl("button", { text: "💰 Loans", cls: "ft-chip" });
    loanBtn.setAttr("aria-label", "Manage lending & borrowing");
    loanBtn.onclick = () =>
      new LoanModal(this.app, this.plugin, () => this.refresh()).open();

    const exportBtn = tabs.createEl("button", { text: "⤓ Export CSV", cls: "ft-chip" });
    exportBtn.onclick = () => this.exportCSV();
  }

  private async exportCSV() {
    const txns = this.mode === "dashboard" ? this.filtered() : this.plugin.store.getAll();
    if (txns.length === 0) {
      new Notice("Nothing to export for the current view.");
      return;
    }
    const csv = transactionsToCSV(
      [...txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      this.plugin.settings.accounts
    );
    const stamp = toISO(new Date()).replace(/-/g, "") + "-" + Date.now().toString().slice(-4);
    const dir = "_finance/exports";
    const path = normalizePath(`${dir}/finance-export-${stamp}.csv`);
    try {
      if (!(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(path, csv);
      new Notice(`Exported ${txns.length} transactions to ${path}`);
    } catch (e) {
      console.error(e);
      new Notice("Export failed — see console.");
    }
  }

  // ── Yearly summary ───────────────────────────────────────────────
  private renderYearly(root: HTMLElement) {
    const all = this.plugin.store.getAll();
    if (all.length === 0) {
      root.createDiv({ cls: "ft-empty", text: "No transactions yet." });
      return;
    }
    const years = Array.from(new Set(all.map((t) => t.date.slice(0, 4)))).sort().reverse();

    const box = root.createDiv("ft-chart-box");
    box.createEl("h3", { text: "Yearly totals" });
    const table = box.createEl("table", { cls: "ft-table" });
    const hr = table.createEl("thead").createEl("tr");
    ["Year", "Income", "Expense", "Investment", "Savings", "Savings rate"].forEach((h) =>
      hr.createEl("th", { text: h })
    );
    const tbody = table.createEl("tbody");
    for (const y of years) {
      const ytx = all.filter((t) => t.date.slice(0, 4) === y);
      const income = sumByType(ytx, "income");
      const expense = sumByType(ytx, "expense");
      const invest = sumByType(ytx, "investment");
      const savings = income - expense;
      const rate = income > 0 ? (savings / income) * 100 : 0;
      const tr = tbody.createEl("tr");
      tr.createEl("td", { text: y });
      tr.createEl("td", { text: formatCurrency(income, this.plugin.settings) }).addClass("ft-type-income", "ft-amount");
      tr.createEl("td", { text: formatCurrency(expense, this.plugin.settings) }).addClass("ft-type-expense", "ft-amount");
      tr.createEl("td", { text: formatCurrency(invest, this.plugin.settings) }).addClass("ft-type-investment", "ft-amount");
      const sv = tr.createEl("td", { text: formatCurrency(savings, this.plugin.settings) });
      sv.addClass("ft-amount");
      if (savings < 0) sv.addClass("ft-type-expense");
      tr.createEl("td", { text: `${rate.toFixed(0)}%` }).addClass("ft-amount");
    }

    // Monthly breakdown for the most recent year
    const selYear = years[0];
    const mbox = root.createDiv("ft-chart-box");
    mbox.createEl("h3", { text: `Monthly breakdown — ${selYear}` });
    const mtable = mbox.createEl("table", { cls: "ft-table" });
    const mhr = mtable.createEl("thead").createEl("tr");
    ["Month", "Income", "Expense", "Investment", "Savings"].forEach((h) =>
      mhr.createEl("th", { text: h })
    );
    const mbody = mtable.createEl("tbody");
    for (let m = 0; m < 12; m++) {
      const mk = `${selYear}-${String(m + 1).padStart(2, "0")}`;
      const mtx = all.filter((t) => t.date.slice(0, 7) === mk);
      if (mtx.length === 0) continue;
      const income = sumByType(mtx, "income");
      const expense = sumByType(mtx, "expense");
      const invest = sumByType(mtx, "investment");
      const savings = income - expense;
      const tr = mbody.createEl("tr");
      tr.createEl("td", { text: monthLabel(mk) });
      tr.createEl("td", { text: formatCurrency(income, this.plugin.settings) }).addClass("ft-amount");
      tr.createEl("td", { text: formatCurrency(expense, this.plugin.settings) }).addClass("ft-amount");
      tr.createEl("td", { text: formatCurrency(invest, this.plugin.settings) }).addClass("ft-amount");
      const sv = tr.createEl("td", { text: formatCurrency(savings, this.plugin.settings) });
      sv.addClass("ft-amount");
      if (savings < 0) sv.addClass("ft-type-expense");
    }
  }

  // ── Budget vs actual ─────────────────────────────────────────────
  private renderBudget(root: HTMLElement) {
    const bar = root.createDiv("ft-toolbar");
    bar.createSpan({ text: "Month: " });
    const picker = bar.createEl("input");
    picker.type = "month";
    picker.value = this.budgetMonth;
    picker.onchange = () => {
      this.budgetMonth = picker.value || this.budgetMonth;
      this.render();
    };

    const setBtn = bar.createEl("button", { text: "⚙ Set budgets", cls: "mod-cta" });
    setBtn.onclick = () =>
      new BudgetModal(this.app, this.plugin, () => this.render()).open();

    const budgets = this.plugin.settings.budgets || {};
    const cats = Object.keys(budgets);
    const box = root.createDiv("ft-chart-box");

    if (cats.length === 0) {
      const empty = box.createDiv("ft-empty");
      empty.createDiv({ text: "No budgets set yet." });
      const btn = empty.createEl("button", { text: "Set budgets", cls: "mod-cta" });
      btn.style.marginTop = "10px";
      btn.onclick = () =>
        new BudgetModal(this.app, this.plugin, () => this.render()).open();
      return;
    }

    const monthTx = this.plugin.store
      .getAll()
      .filter((t) => t.type === "expense" && t.date.slice(0, 7) === this.budgetMonth);
    const actualByCat = new Map<string, number>();
    monthTx.forEach((t) =>
      actualByCat.set(t.category, (actualByCat.get(t.category) ?? 0) + t.amount)
    );

    let totalBudget = 0;
    let totalActual = 0;

    box.createEl("h3", { text: `Budget vs actual — ${monthLabel(this.budgetMonth)}` });

    for (const cat of cats.sort()) {
      const budget = budgets[cat];
      const actual = actualByCat.get(cat) ?? 0;
      totalBudget += budget;
      totalActual += actual;
      const pct = budget > 0 ? (actual / budget) * 100 : 0;
      const over = actual > budget;

      const row = box.createDiv("ft-budget-row");
      const head = row.createDiv("ft-budget-head");
      head.createSpan({ cls: "ft-budget-cat", text: cat });
      head.createSpan({
        cls: "ft-budget-nums" + (over ? " ft-over" : ""),
        text: `${formatCurrency(actual, this.plugin.settings)} / ${formatCurrency(
          budget,
          this.plugin.settings
        )} (${pct.toFixed(0)}%)`,
      });
      const track = row.createDiv("ft-budget-track");
      const fill = track.createDiv("ft-budget-fill");
      fill.style.width = Math.min(pct, 100) + "%";
      if (over) fill.addClass("ft-over");
      else if (pct >= 80) fill.addClass("ft-warn");
    }

    const remaining = totalBudget - totalActual;
    const foot = box.createDiv("ft-budget-total");
    foot.createSpan({
      text: `Total spent ${formatCurrency(totalActual, this.plugin.settings)} of ${formatCurrency(
        totalBudget,
        this.plugin.settings
      )} — ${
        remaining >= 0
          ? formatCurrency(remaining, this.plugin.settings) + " left"
          : formatCurrency(-remaining, this.plugin.settings) + " over"
      }`,
    });
  }

  // ── Toolbar: date range + filters ────────────────────────────────
  private renderToolbar(root: HTMLElement) {
    const bar = root.createDiv("ft-toolbar");

    const addBtn = bar.createEl("button", { text: "+ Add", cls: "mod-cta" });
    addBtn.onclick = () =>
      new AddTransactionModal(this.app, this.plugin, () => this.refresh()).open();

    const presets: { key: RangePreset; label: string }[] = [
      { key: "this-month", label: "This Month" },
      { key: "last-month", label: "Last Month" },
      { key: "this-year", label: "This Year" },
      { key: "last-year", label: "Last Year" },
      { key: "all", label: "All" },
      { key: "custom", label: "Custom" },
    ];
    const presetWrap = bar.createDiv("ft-presets");
    presets.forEach((p) => {
      const b = presetWrap.createEl("button", {
        text: p.label,
        cls: "ft-chip" + (this.preset === p.key ? " is-active" : ""),
      });
      b.onclick = () => {
        this.preset = p.key;
        if (p.key === "custom" && !this.custom) {
          const r = computeRange("this-month", this.plugin.store.getAll());
          this.custom = { ...r };
        }
        this.render();
      };
    });

    if (this.preset === "custom") {
      const cr = bar.createDiv("ft-custom-range");
      const from = cr.createEl("input");
      from.type = "date";
      from.value = this.custom?.from ?? "";
      from.onchange = () => {
        this.custom = { from: from.value, to: this.custom?.to ?? from.value };
        this.render();
      };
      cr.createSpan({ text: "→" });
      const to = cr.createEl("input");
      to.type = "date";
      to.value = this.custom?.to ?? "";
      to.onchange = () => {
        this.custom = { from: this.custom?.from ?? to.value, to: to.value };
        this.render();
      };
    }

    // secondary filters
    const filters = root.createDiv("ft-filters");

    const typeSel = filters.createEl("select");
    [
      { v: "all", t: "All types" },
      { v: "income", t: "Income" },
      { v: "expense", t: "Expense" },
      { v: "investment", t: "Investment" },
      { v: "transfer", t: "Transfer" },
    ].forEach((o) => {
      const opt = typeSel.createEl("option", { text: o.t, value: o.v });
      if (o.v === this.typeFilter) opt.selected = true;
    });
    typeSel.onchange = () => {
      this.typeFilter = typeSel.value as any;
      this.categoryFilter = "all";
      this.render();
    };

    const catSel = filters.createEl("select");
    catSel.createEl("option", { text: "All categories", value: "all" });
    const cats = new Set<string>();
    this.plugin.store.getAll().forEach((t) => {
      if (this.typeFilter === "all" || t.type === this.typeFilter) cats.add(t.category);
    });
    Array.from(cats).sort().forEach((c) => {
      const opt = catSel.createEl("option", { text: c, value: c });
      if (c === this.categoryFilter) opt.selected = true;
    });
    catSel.onchange = () => {
      this.categoryFilter = catSel.value;
      this.render();
    };

    // account filter
    const accounts = this.plugin.settings.accounts;
    if (accounts.length > 0) {
      const acctSel = filters.createEl("select");
      acctSel.createEl("option", { text: "All accounts", value: "all" });
      accounts.forEach((a) => {
        const opt = acctSel.createEl("option", { text: a.name, value: a.id });
        if (a.id === this.accountFilter) opt.selected = true;
      });
      acctSel.onchange = () => {
        this.accountFilter = acctSel.value;
        this.render();
      };
    }

    const searchInput = filters.createEl("input");
    searchInput.type = "search";
    searchInput.placeholder = "Search…";
    searchInput.value = this.search;
    searchInput.oninput = () => {
      this.search = searchInput.value;
      this.renderTableOnly();
    };
  }

  // ── Summary cards ────────────────────────────────────────────────
  private renderSummary(root: HTMLElement, txns: Transaction[]) {
    const income = sumByType(txns, "income");
    const expense = sumByType(txns, "expense");
    const investment = sumByType(txns, "investment");
    const savings = income - expense; // savings = income not consumed; investing is a use of savings
    const savingsRate = income > 0 ? (savings / income) * 100 : 0;
    const lendingCash = lendingNetCashInRange(this.plugin.store.getLoans(), this.currentRange());
    const netCash = income - expense - investment + lendingCash; // change in liquid cash this period

    const cards = root.createDiv("ft-cards");
    const card = (label: string, value: number, cls: string, extra?: string) => {
      const c = cards.createDiv("ft-card " + cls);
      c.createDiv({ cls: "ft-card-label", text: label });
      c.createDiv({ cls: "ft-card-value", text: formatCurrency(value, this.plugin.settings) });
      if (extra) c.createDiv({ cls: "ft-card-extra", text: extra });
    };
    card("Income", income, "ft-income");
    card("Expense", expense, "ft-expense");
    card("Investment", investment, "ft-investment");
    card("Savings", savings, savings >= 0 ? "ft-savings" : "ft-negative",
      `Savings rate ${savingsRate.toFixed(0)}%`);
    card("Net cash flow", netCash, netCash >= 0 ? "ft-netcash" : "ft-negative",
      lendingCash !== 0 ? "Incl. lending activity" : "Income − Expense − Investment");

    this.renderBalances(root);
  }

  // ── Account balances (uses ALL transactions, not range-filtered) ──
  private renderBalances(root: HTMLElement) {
    const accounts = this.plugin.settings.accounts;
    const loans = this.plugin.store.getLoans();
    const receivable = totalReceivable(loans);
    const payable = totalPayable(loans);
    if (accounts.length === 0 && receivable === 0 && payable === 0) return;

    const all = this.plugin.store.getAll();
    const balances = computeBalances(accounts, all, loans);
    const cash = balances.reduce((s, b) => s + b.balance, 0);
    const worth = cash + receivable - payable;

    const wrap = root.createDiv("ft-balances");
    const head = wrap.createDiv("ft-balances-head");
    head.createSpan({ cls: "ft-balances-title", text: "Balances & net worth" });
    const totalTxt =
      receivable > 0 || payable > 0
        ? `Cash ${formatCurrency(cash, this.plugin.settings)} · Net worth ${formatCurrency(worth, this.plugin.settings)}`
        : `Total: ${formatCurrency(cash, this.plugin.settings)}`;
    head.createSpan({ cls: "ft-balances-total", text: totalTxt });

    const cards = wrap.createDiv("ft-balance-cards");
    for (const b of balances) {
      const c = cards.createDiv("ft-balance-card");
      if (!b.account.active) c.addClass("ft-inactive");
      c.createDiv({ cls: "ft-balance-name", text: b.account.name });
      const v = c.createDiv({
        cls: "ft-balance-value",
        text: formatCurrency(b.balance, this.plugin.settings),
      });
      if (b.balance < 0) v.addClass("ft-neg");
    }
    if (receivable > 0) {
      const c = cards.createDiv("ft-balance-card ft-receivable");
      c.createDiv({ cls: "ft-balance-name", text: "Receivable (lent out)" });
      c.createDiv({ cls: "ft-balance-value", text: formatCurrency(receivable, this.plugin.settings) });
    }
    if (payable > 0) {
      const c = cards.createDiv("ft-balance-card ft-payable");
      c.createDiv({ cls: "ft-balance-name", text: "Owed (borrowed)" });
      const v = c.createDiv({ cls: "ft-balance-value ft-neg", text: formatCurrency(payable, this.plugin.settings) });
    }
  }

  // ── Lending tab ──────────────────────────────────────────────────
  private renderLending(root: HTMLElement) {
    const loans = this.plugin.store.getLoans();

    const bar = root.createDiv("ft-toolbar");
    const manage = bar.createEl("button", { text: "+ Add / manage loans", cls: "mod-cta" });
    manage.onclick = () => new LoanModal(this.app, this.plugin, () => this.refresh()).open();

    if (loans.length === 0) {
      root.createDiv({ cls: "ft-empty", text: "No loans yet. Use “Add / manage loans” to record money you lent or borrowed." });
      return;
    }

    const receivable = totalReceivable(loans);
    const payable = totalPayable(loans);
    const range = this.currentRange();
    const interestEarned = interestEarnedInRange(loans, range);
    const interestPaid = interestPaidInRange(loans, range);

    // summary cards
    const cards = root.createDiv("ft-cards");
    const card = (label: string, value: number, cls: string, extra?: string) => {
      const c = cards.createDiv("ft-card " + cls);
      c.createDiv({ cls: "ft-card-label", text: label });
      c.createDiv({ cls: "ft-card-value", text: formatCurrency(value, this.plugin.settings) });
      if (extra) c.createDiv({ cls: "ft-card-extra", text: extra });
    };
    card("Receivable", receivable, "ft-income", "Owed to you");
    card("Payable", payable, "ft-expense", "You owe");
    card("Interest earned", interestEarned, "ft-netcash", "In selected range");
    card("Interest paid", interestPaid, "ft-investment", "In selected range");

    // reminders: outstanding loans with due dates
    const today = toISO(new Date());
    const dueList = loans
      .filter((l) => loanOutstanding(l) > 0 && l.dueDate)
      .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));
    if (dueList.length > 0) {
      const rbox = root.createDiv("ft-chart-box");
      rbox.createEl("h3", { text: "Reminders" });
      for (const l of dueList) {
        const overdue = l.dueDate! < today;
        const row = rbox.createDiv("ft-reminder" + (overdue ? " ft-over" : ""));
        const label = l.direction === "lent" ? "Collect from" : "Pay";
        row.createSpan({
          text: `${overdue ? "⚠ " : "• "}${label} ${l.counterparty}: ${formatCurrency(
            loanOutstanding(l),
            this.plugin.settings
          )} by ${l.dueDate}`,
        });
      }
    }

    // loans table
    const box = root.createDiv("ft-chart-box");
    box.createEl("h3", { text: "Loans" });
    const table = box.createEl("table", { cls: "ft-table" });
    const hr = table.createEl("thead").createEl("tr");
    ["Person", "Direction", "Principal", "Outstanding", "Interest", "Rate", "Date", "Due", ""].forEach((h) =>
      hr.createEl("th", { text: h })
    );
    const tbody = table.createEl("tbody");
    for (const l of loans) {
      const outstanding = loanOutstanding(l);
      const tr = tbody.createEl("tr");
      if (outstanding <= 0) tr.addClass("ft-inactive");
      tr.createEl("td", { text: l.counterparty });
      tr.createEl("td", { text: l.direction === "lent" ? "→ lent" : "← borrowed" });
      tr.createEl("td", { text: formatCurrency(l.principal, this.plugin.settings) }).addClass("ft-amount");
      tr.createEl("td", { text: formatCurrency(outstanding, this.plugin.settings) }).addClass("ft-amount");
      tr.createEl("td", { text: formatCurrency(loanInterestTotal(l), this.plugin.settings) }).addClass("ft-amount");
      tr.createEl("td", { text: l.interestRate != null ? l.interestRate + "%" : "—" }).addClass("ft-amount");
      tr.createEl("td", { text: l.date });
      tr.createEl("td", { text: l.dueDate || "—" });
      const edit = tr.createEl("td").createEl("button", { text: "✎", cls: "ft-icon-btn" });
      edit.onclick = () => new LoanModal(this.app, this.plugin, () => this.refresh()).open();
    }
  }

  // ── Pie: expenses by category ────────────────────────────────────
  private renderPie(root: HTMLElement, txns: Transaction[]) {
    const box = root.createDiv("ft-chart-box");
    box.createEl("h3", { text: "Expenses by category" });
    const canvas = box.createEl("canvas");

    const byCat = new Map<string, number>();
    txns.filter((t) => t.type === "expense").forEach((t) => {
      byCat.set(t.category, (byCat.get(t.category) ?? 0) + t.amount);
    });
    const entries = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1]);

    if (entries.length === 0) {
      box.createDiv({ cls: "ft-empty", text: "No expenses in this range." });
      return;
    }

    this.pieChart = new Chart(canvas, {
      type: "pie",
      data: {
        labels: entries.map((e) => e[0]),
        datasets: [
          {
            data: entries.map((e) => e[1]),
            backgroundColor: entries.map((_, i) => PALETTE[i % PALETTE.length]),
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const val = ctx.parsed as number;
                const total = entries.reduce((s, e) => s + e[1], 0);
                const pct = total ? ((val / total) * 100).toFixed(1) : "0";
                return `${ctx.label}: ${formatCurrency(val, this.plugin.settings)} (${pct}%)`;
              },
            },
          },
        },
      },
    });
  }

  // ── Trend: income vs expense vs investment + savings over months ─
  private renderTrend(root: HTMLElement) {
    const box = root.createDiv("ft-chart-box");
    box.createEl("h3", { text: "Trend over time" });
    const canvas = box.createEl("canvas");

    // Build monthly buckets across the selected range using all matching txns
    // (ignore type/category filters here so the trend shows the full picture).
    const range = this.currentRange();
    const inScope = this.plugin.store
      .getAll()
      .filter((t) => inRange(t.date, range));

    if (inScope.length === 0) {
      box.createDiv({ cls: "ft-empty", text: "No data in this range." });
      return;
    }

    const months = Array.from(new Set(inScope.map((t) => monthKey(t.date)))).sort();
    const bucket = (type: TxnType) =>
      months.map((mk) =>
        inScope
          .filter((t) => t.type === type && monthKey(t.date) === mk)
          .reduce((s, t) => s + t.amount, 0)
      );
    const incomeArr = bucket("income");
    const expenseArr = bucket("expense");
    const investArr = bucket("investment");
    const savingsArr = months.map((_, i) => incomeArr[i] - expenseArr[i]);

    this.trendChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: months.map(monthLabel),
        datasets: [
          { type: "bar", label: "Income", data: incomeArr, backgroundColor: "#59a14f" },
          { type: "bar", label: "Expense", data: expenseArr, backgroundColor: "#e15759" },
          { type: "bar", label: "Investment", data: investArr, backgroundColor: "#4e79a7" },
          { type: "bar", label: "Savings", data: savingsArr, backgroundColor: "#edc948" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "top", labels: { boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx) =>
                `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y as number, this.plugin.settings)}`,
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: (v) => formatCurrency(Number(v), this.plugin.settings),
            },
          },
        },
      },
    });
  }

  // ── Transactions table ───────────────────────────────────────────
  private tableContainer: HTMLElement | null = null;
  private page = 0;
  private pageSize = 50;

  private renderTable(root: HTMLElement, txns: Transaction[]) {
    this.tableContainer = root.createDiv("ft-table-wrap");
    this.page = 0;
    this.drawTable(txns);
  }

  private renderTableOnly() {
    if (!this.tableContainer) return;
    this.page = 0;
    this.drawTable(this.filtered());
  }

  private drawTable(txns: Transaction[]) {
    const wrap = this.tableContainer!;
    wrap.empty();

    const sorted = [...txns].sort((a, b) => {
      const dir = this.sortDir === "asc" ? 1 : -1;
      // Sort the Date column chronologically using date + time.
      const ka = this.sortKey === "date" ? dateTimeKey(a) : a[this.sortKey] ?? "";
      const kb = this.sortKey === "date" ? dateTimeKey(b) : b[this.sortKey] ?? "";
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
      return 0;
    });

    const total = sorted.length;
    const pageSize = this.pageSize; // 0 == all
    const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
    if (this.page >= totalPages) this.page = totalPages - 1;
    if (this.page < 0) this.page = 0;
    const start = pageSize > 0 ? this.page * pageSize : 0;
    const end = pageSize > 0 ? Math.min(start + pageSize, total) : total;
    const pageRows = sorted.slice(start, end);

    // Header row: title + rows-per-page selector
    const header = wrap.createDiv("ft-table-header");
    header.createEl("h3", { text: `Transactions (${total})` });
    const rpp = header.createDiv("ft-rpp");
    rpp.createSpan({ text: "Rows: " });
    const sel = rpp.createEl("select");
    [
      { v: "25", t: "25" },
      { v: "50", t: "50" },
      { v: "100", t: "100" },
      { v: "0", t: "All" },
    ].forEach((o) => {
      const opt = sel.createEl("option", { text: o.t, value: o.v });
      if (parseInt(o.v) === this.pageSize) opt.selected = true;
    });
    sel.onchange = () => {
      this.pageSize = parseInt(sel.value);
      this.page = 0;
      this.drawTable(txns);
    };

    // Scrollable table region with sticky header
    const scroll = wrap.createDiv("ft-table-scroll");
    const table = scroll.createEl("table", { cls: "ft-table" });
    const thead = table.createEl("thead");
    const hr = thead.createEl("tr");
    const cols: { key: keyof Transaction; label: string }[] = [
      { key: "date", label: "Date / Time" },
      { key: "type", label: "Type" },
      { key: "category", label: "Category" },
      { key: "subcategory", label: "Sub-category" },
      { key: "amount", label: "Amount" },
      { key: "account", label: "Account" },
      { key: "note", label: "Note" },
    ];
    cols.forEach((c) => {
      const th = hr.createEl("th", { text: c.label });
      th.addClass("ft-col-" + c.key);
      if (this.sortKey === c.key) th.addClass(this.sortDir === "asc" ? "sort-asc" : "sort-desc");
      th.onclick = () => {
        if (this.sortKey === c.key) {
          this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
        } else {
          this.sortKey = c.key;
          this.sortDir = c.key === "amount" || c.key === "date" ? "desc" : "asc";
        }
        this.page = 0;
        this.drawTable(txns);
      };
    });
    hr.createEl("th", { text: "" });

    const tbody = table.createEl("tbody");
    for (const t of pageRows) {
      const tr = tbody.createEl("tr");
      tr.createEl("td", { text: t.time ? `${t.date} ${t.time}` : t.date }).addClass("ft-col-date");
      tr.createEl("td", { text: t.type }).addClass("ft-type-" + t.type);
      tr.createEl("td", { text: t.category });
      tr.createEl("td", { text: t.subcategory || "—" });
      const amt = tr.createEl("td", { text: formatCurrency(t.amount, this.plugin.settings) });
      amt.addClass("ft-amount", "ft-type-" + t.type);
      const accounts = this.plugin.settings.accounts;
      const acctText =
        t.type === "transfer"
          ? `${accountName(accounts, t.account)} → ${accountName(accounts, t.toAccount)}`
          : accountName(accounts, t.account) || "—";
      tr.createEl("td", { text: acctText });
      tr.createEl("td", { text: t.note || "" });
      const act = tr.createEl("td");
      const edit = act.createEl("button", { text: "✎", cls: "ft-icon-btn" });
      edit.setAttr("aria-label", "Edit");
      edit.onclick = () =>
        new AddTransactionModal(this.app, this.plugin, () => this.refresh(), t).open();
      const del = act.createEl("button", { text: "🗑", cls: "ft-icon-btn" });
      del.setAttr("aria-label", "Delete");
      del.onclick = async () => {
        await this.plugin.store.remove(t.id);
        this.refresh();
      };
    }

    // Pagination controls
    if (pageSize > 0 && total > pageSize) {
      const pager = wrap.createDiv("ft-pager");
      const prev = pager.createEl("button", { text: "‹ Prev", cls: "ft-chip" });
      prev.disabled = this.page === 0;
      prev.onclick = () => {
        this.page--;
        this.drawTable(txns);
      };
      pager.createSpan({
        cls: "ft-pager-info",
        text: `${start + 1}–${end} of ${total}  (page ${this.page + 1}/${totalPages})`,
      });
      const next = pager.createEl("button", { text: "Next ›", cls: "ft-chip" });
      next.disabled = this.page >= totalPages - 1;
      next.onclick = () => {
        this.page++;
        this.drawTable(txns);
      };
    }
  }
}
