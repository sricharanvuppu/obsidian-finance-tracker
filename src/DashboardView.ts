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
import { Transaction, TxnType, EVENT_STATUS_LABELS } from "./types";
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
import { EventModal } from "./EventModal";
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

/** Inline Chart.js plugin that draws each slice's percentage on pie charts. */
const percentLabelPlugin = {
  id: "ftPercentLabels",
  afterDatasetsDraw(chart: any) {
    const ds = chart.data?.datasets?.[0];
    if (!ds) return;
    const data: number[] = ds.data || [];
    const total = data.reduce((s, v) => s + (Number(v) || 0), 0);
    if (!total) return;
    const meta = chart.getDatasetMeta(0);
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = "bold 11px var(--font-interface, sans-serif)";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    meta.data.forEach((arc: any, i: number) => {
      const v = Number(data[i]) || 0;
      const pct = (v / total) * 100;
      if (pct < 5) return; // skip tiny slices to avoid clutter
      const pos = arc.tooltipPosition();
      ctx.fillText(pct.toFixed(0) + "%", pos.x, pos.y);
    });
    ctx.restore();
  },
};

export class FinanceDashboardView extends ItemView {
  private plugin: FinanceTrackerPlugin;

  private mode: "dashboard" | "yearly" | "budget" | "lending" | "insights" | "events" = "dashboard";
  private preset: RangePreset = "this-month";
  private custom: DateRange | null = null;
  private typeFilter: "all" | TxnType = "all";
  private categoryFilter = "all";
  private accountFilter = "all";
  private eventFilter = "all";
  private search = "";
  private sortKey: keyof Transaction = "date";
  private sortDir: "asc" | "desc" = "desc";
  private budgetMonth: string = monthKey(toISO(new Date()));

  private charts: Chart[] = [];

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
    this.charts.forEach((c) => c.destroy());
    this.charts = [];
  }

  public refresh() {
    this.render();
  }

  private currentRange(): DateRange {
    return computeRange(this.preset, this.plugin.store.getAll(), this.custom ?? undefined);
  }

  /** IDs of events flagged as capital (excluded from monthly/overspending analysis). */
  private capitalEventIds(): Set<string> {
    return new Set((this.plugin.settings.events || []).filter((e) => e.capital).map((e) => e.id));
  }

  /** Drops transactions tagged to a capital event (for monthly/behavioral views). */
  private nonCapital(txns: Transaction[]): Transaction[] {
    const cap = this.capitalEventIds();
    if (cap.size === 0) return txns;
    return txns.filter((t) => !(t.event && cap.has(t.event)));
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
          this.eventFilter === "all" ||
          (this.eventFilter === "none" ? !t.event : t.event === this.eventFilter)
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
    if (this.mode === "insights") {
      this.renderInsights(root);
      return;
    }
    if (this.mode === "events") {
      this.renderEvents(root);
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
      { key: "insights", label: "Insights" },
      { key: "yearly", label: "Yearly" },
      { key: "budget", label: "Budget" },
      { key: "lending", label: "Lending" },
      { key: "events", label: "Events" },
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

    const eventBtn = tabs.createEl("button", { text: "🎉 Events", cls: "ft-chip" });
    eventBtn.setAttr("aria-label", "Manage life events");
    eventBtn.onclick = () =>
      new EventModal(this.app, this.plugin, () => this.refresh()).open();

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

    const monthTx = this.nonCapital(this.plugin.store.getAll())
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

    // event filter
    const events = this.plugin.settings.events || [];
    if (events.length > 0) {
      const evSel = filters.createEl("select");
      evSel.createEl("option", { text: "All events", value: "all" });
      evSel.createEl("option", { text: "— No event —", value: "none" });
      events.forEach((e) => {
        const opt = evSel.createEl("option", { text: e.name, value: e.id });
        if (e.id === this.eventFilter) opt.selected = true;
      });
      if (this.eventFilter !== "all") evSel.value = this.eventFilter;
      evSel.onchange = () => {
        this.eventFilter = evSel.value;
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
    const mtx = this.nonCapital(txns); // exclude capital-event spend from monthly analysis
    const income = sumByType(mtx, "income");
    const expense = sumByType(mtx, "expense");
    const investment = sumByType(mtx, "investment");
    const lendingCash = lendingNetCashInRange(this.plugin.store.getLoans(), this.currentRange());
    // Net cash flow is a true liquid-cash metric, so it counts EVERYTHING that
    // moved cash — including capital events (they go out of your income too).
    const netCash =
      sumByType(txns, "income") -
      sumByType(txns, "expense") -
      sumByType(txns, "investment") +
      lendingCash;

    const cap = this.capitalEventIds();
    const capitalSpend = txns
      .filter((t) => t.event && cap.has(t.event) && (t.type === "expense" || t.type === "investment"))
      .reduce((s, t) => s + t.amount, 0);

    const cards = root.createDiv("ft-cards");
    const card = (label: string, value: number, cls: string, extra?: string, tooltip?: string) => {
      const c = cards.createDiv("ft-card " + cls);
      if (tooltip) { c.setAttr("aria-label", tooltip); c.setAttr("title", tooltip); }
      c.createDiv({ cls: "ft-card-label", text: label });
      c.createDiv({ cls: "ft-card-value", text: formatCurrency(value, this.plugin.settings) });
      if (extra) c.createDiv({ cls: "ft-card-extra", text: extra });
    };
    card("Income", income, "ft-income", undefined,
      "Income received in this range (excludes capital-event income and loan repayments).");
    card("Expense", expense, "ft-expense", "Everyday spending only",
      "Counts only regular monthly expenses. Excludes capital events (weddings, home, etc.), investments, and money lent out — those are tracked separately.");
    card("Investment", investment, "ft-investment", undefined,
      "Money moved into investments this range (excludes capital-event spend).");
    card("Net cash flow", netCash, netCash >= 0 ? "ft-netcash" : "ft-negative",
      capitalSpend > 0 ? "Incl. capital events & lending" : (lendingCash !== 0 ? "Incl. lending activity" : "Income − Expense − Investment"),
      "Actual change in liquid cash: all income minus all expenses, investments, capital events, and net lending. This is the true cash movement (matches your account balances).");
    if (capitalSpend > 0) {
      card("Capital events", capitalSpend, "ft-capital", "Excluded from monthly analysis",
        "One-off life events (wedding, home, baby). Not counted in Expense/Savings, but they do reduce your account balances and net worth.");
    }

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
    this.nonCapital(txns).filter((t) => t.type === "expense").forEach((t) => {
      byCat.set(t.category, (byCat.get(t.category) ?? 0) + t.amount);
    });
    const entries = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1]);

    if (entries.length === 0) {
      box.createDiv({ cls: "ft-empty", text: "No expenses in this range." });
      return;
    }

    this.makePie(canvas, entries);
  }

  /** Builds a pie chart with percentages on slices and in the legend. */
  private makePie(canvas: HTMLCanvasElement, entries: [string, number][]) {
    const total = entries.reduce((s, e) => s + e[1], 0);
    const chart = new Chart(canvas, {
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
          legend: {
            position: "right",
            labels: {
              boxWidth: 12,
              generateLabels: (c: any) => {
                const ds = c.data.datasets[0];
                return (c.data.labels || []).map((l: string, i: number) => {
                  const v = Number(ds.data[i]) || 0;
                  const pct = total ? ((v / total) * 100).toFixed(0) : "0";
                  return {
                    text: `${l} — ${pct}%`,
                    fillStyle: (ds.backgroundColor as string[])[i],
                    strokeStyle: "rgba(0,0,0,0)",
                    index: i,
                  };
                });
              },
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx: any) => {
                const val = ctx.parsed as number;
                const pct = total ? ((val / total) * 100).toFixed(1) : "0";
                return `${ctx.label}: ${formatCurrency(val, this.plugin.settings)} (${pct}%)`;
              },
            },
          },
        },
      },
      plugins: [percentLabelPlugin],
    });
    this.charts.push(chart);
  }

  // ── Trend: income vs expense vs investment + savings over months ─
  private renderTrend(root: HTMLElement) {
    const box = root.createDiv("ft-chart-box");
    box.createEl("h3", { text: "Trend over time" });
    const canvas = box.createEl("canvas");

    // Build monthly buckets across the selected range using all matching txns
    // (ignore type/category filters here so the trend shows the full picture).
    const range = this.currentRange();
    const inScope = this.nonCapital(
      this.plugin.store.getAll().filter((t) => inRange(t.date, range))
    );

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

    this.charts.push(new Chart(canvas, {
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
    }));
  }

  // ── Events tab: track big one-off life events ───────────────────
  private renderEvents(root: HTMLElement) {
    const bar = root.createDiv("ft-toolbar");
    const manage = bar.createEl("button", { text: "+ Add / manage events", cls: "mod-cta" });
    manage.onclick = () => new EventModal(this.app, this.plugin, () => this.refresh()).open();

    const events = this.plugin.settings.events || [];
    if (events.length === 0) {
      root.createDiv({ cls: "ft-empty", text: "No life events yet. Use “Add / manage events” to track a wedding, home purchase, etc." });
      return;
    }

    const all = this.plugin.store.getAll();
    const spentOf = (evId: string) =>
      all
        .filter((t) => t.event === evId && (t.type === "expense" || t.type === "investment"))
        .reduce((s, t) => s + t.amount, 0);

    // ── Overview charts across all events ──
    const overview = root.createDiv("ft-charts");

    // Budget vs actual across events (events that have a target)
    const budgeted = events.filter((ev) => (ev.target ?? 0) > 0);
    if (budgeted.length) {
      this.makeBars(
        overview.createDiv("ft-chart-box"),
        "Budget vs actual (by event)",
        budgeted.map((ev) => ev.name),
        [
          { label: "Spent", data: budgeted.map((ev) => spentOf(ev.id)), backgroundColor: "#e15759" },
          { label: "Target", data: budgeted.map((ev) => ev.target ?? 0), backgroundColor: "#4e79a7" },
        ],
        { horizontal: true }
      );
    }

    // Event spend over time (stacked bars per event across months)
    const evAll = all.filter((t) => t.event && (t.type === "expense" || t.type === "investment"));
    const evMonths = Array.from(new Set(evAll.map((t) => monthKey(t.date)))).sort();
    const spendingEvents = events.filter((ev) => spentOf(ev.id) > 0);
    if (evMonths.length && spendingEvents.length) {
      const datasets = spendingEvents.map((ev, i) => ({
        label: ev.name,
        data: evMonths.map((mk) =>
          evAll
            .filter((t) => t.event === ev.id && monthKey(t.date) === mk)
            .reduce((s, t) => s + t.amount, 0)
        ),
        backgroundColor: PALETTE[i % PALETTE.length],
      }));
      this.makeBars(
        overview.createDiv("ft-chart-box"),
        "Event spend over time",
        evMonths.map(monthLabel),
        datasets,
        { stacked: true }
      );
    }

    const grid = root.createDiv("ft-charts");

    for (const ev of events) {
      const evTxns = all.filter((t) => t.event === ev.id);
      const spent = evTxns
        .filter((t) => t.type === "expense" || t.type === "investment")
        .reduce((s, t) => s + t.amount, 0);
      const target = ev.target ?? 0;
      const pct = target > 0 ? (spent / target) * 100 : 0;
      const over = target > 0 && spent > target;

      const box = grid.createDiv("ft-chart-box");
      const head = box.createDiv("ft-event-head");
      head.createEl("h3", { text: `${ev.name}` });
      head.createSpan({ cls: "ft-event-status ft-status-" + ev.status, text: EVENT_STATUS_LABELS[ev.status] });

      const meta: string[] = [];
      if (ev.startDate) meta.push(ev.startDate + (ev.endDate ? " → " + ev.endDate : ""));
      if (!ev.capital) meta.push("counts in monthly");
      box.createDiv({ cls: "setting-item-description", text: meta.join(" · ") });

      box.createDiv({
        cls: "ft-event-figures",
        text:
          `Spent ${formatCurrency(spent, this.plugin.settings)}` +
          (target > 0
            ? ` of ${formatCurrency(target, this.plugin.settings)} · ${
                over
                  ? formatCurrency(spent - target, this.plugin.settings) + " over"
                  : formatCurrency(target - spent, this.plugin.settings) + " left"
              } (${pct.toFixed(0)}%)`
            : ""),
      });

      if (target > 0) {
        const track = box.createDiv("ft-budget-track");
        const fill = track.createDiv("ft-budget-fill");
        fill.style.width = Math.min(pct, 100) + "%";
        if (over) fill.addClass("ft-over");
        else if (pct >= 80) fill.addClass("ft-warn");
      }

      // per-event charts: category pie + spend over time
      const byCat = new Map<string, number>();
      evTxns.filter((t) => t.type === "expense" || t.type === "investment").forEach((t) => {
        byCat.set(t.category, (byCat.get(t.category) ?? 0) + t.amount);
      });
      const cats = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1]);
      if (cats.length) {
        const charts = box.createDiv("ft-charts");

        const pieBox = charts.createDiv("ft-chart-box");
        pieBox.createEl("h3", { text: "Category breakdown" });
        this.makePie(pieBox.createEl("canvas"), cats);

        const evSpendTxns = evTxns.filter((t) => t.type === "expense" || t.type === "investment");
        const evMonthsE = Array.from(new Set(evSpendTxns.map((t) => monthKey(t.date)))).sort();
        this.makeBars(
          charts.createDiv("ft-chart-box"),
          "Spend over time",
          evMonthsE.map(monthLabel),
          [
            {
              label: "Spent",
              data: evMonthsE.map((mk) =>
                evSpendTxns.filter((t) => monthKey(t.date) === mk).reduce((s, t) => s + t.amount, 0)
              ),
              backgroundColor: "#e15759",
            },
          ]
        );
      } else {
        box.createDiv({ cls: "ft-empty", text: "No transactions tagged to this event yet." });
      }

      // editable list of this event's transactions
      if (evTxns.length) {
        box.createEl("h4", { text: "Transactions", cls: "ft-event-txn-title" });
        const tt = box.createEl("table", { cls: "ft-table" });
        const thr = tt.createEl("thead").createEl("tr");
        ["Date", "Category", "Amount", ""].forEach((h) => {
          const th = thr.createEl("th", { text: h });
          if (h === "Amount") th.addClass("ft-col-amount");
        });
        const tbb = tt.createEl("tbody");
        const sorted = [...evTxns].sort((a, b) => (a.date < b.date ? 1 : -1));
        for (const t of sorted) {
          const tr = tbb.createEl("tr");
          tr.createEl("td", { text: t.time ? `${t.date} ${t.time}` : t.date }).addClass("ft-col-date");
          tr.createEl("td", { text: `${t.category}${t.subcategory ? " › " + t.subcategory : ""}` });
          tr.createEl("td", { text: formatCurrency(t.amount, this.plugin.settings) }).addClass("ft-amount", "ft-type-" + t.type);
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
      }
    }
  }

  // ── Insights tab: a collection of meaningful charts ─────────────
  private renderInsights(root: HTMLElement) {
    // range selector
    const bar = root.createDiv("ft-toolbar");
    const presets: { key: RangePreset; label: string }[] = [
      { key: "this-month", label: "This Month" },
      { key: "last-month", label: "Last Month" },
      { key: "this-year", label: "This Year" },
      { key: "last-year", label: "Last Year" },
      { key: "all", label: "All" },
    ];
    const wrap = bar.createDiv("ft-presets");
    presets.forEach((p) => {
      const b = wrap.createEl("button", {
        text: p.label,
        cls: "ft-chip" + (this.preset === p.key ? " is-active" : ""),
      });
      b.onclick = () => {
        this.preset = p.key;
        this.render();
      };
    });

    const range = this.currentRange();
    const inScope = this.nonCapital(
      this.plugin.store.getAll().filter((t) => inRange(t.date, range))
    );
    if (inScope.length === 0) {
      root.createDiv({ cls: "ft-empty", text: "No data in this range." });
      return;
    }

    // ── Spending-health alert cards ──
    this.renderSpendingAlerts(root, inScope);

    const months = Array.from(new Set(inScope.map((t) => monthKey(t.date)))).sort();
    const labels = months.map(monthLabel);
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
    let running = 0;
    const cumulativeArr = savingsArr.map((s) => (running += s));

    const grid = root.createDiv("ft-charts");

    // 1. Expenses by category (pie with %)
    const expByCat = this.groupByCategory(inScope, "expense");
    if (expByCat.length) {
      const box = grid.createDiv("ft-chart-box");
      box.createEl("h3", { text: "Expenses by category" });
      this.makePie(box.createEl("canvas"), expByCat);
    }

    // 2. Income by source (pie with %)
    const incByCat = this.groupByCategory(inScope, "income");
    if (incByCat.length) {
      const box = grid.createDiv("ft-chart-box");
      box.createEl("h3", { text: "Income by source" });
      this.makePie(box.createEl("canvas"), incByCat);
    }

    // 3. Monthly cash flow (grouped bars)
    this.makeBars(grid.createDiv("ft-chart-box"), "Monthly income vs expense", labels, [
      { label: "Income", data: incomeArr, backgroundColor: "#59a14f" },
      { label: "Expense", data: expenseArr, backgroundColor: "#e15759" },
    ]);

    // 4. Monthly expense % of income (line, % + 100% reference)
    const monthlyExpensePct = months.map((_, i) =>
      incomeArr[i] > 0 ? Math.round((expenseArr[i] / incomeArr[i]) * 100) : 0
    );
    this.makeLine(
      grid.createDiv("ft-chart-box"),
      "Monthly expense % (of income)",
      labels,
      [
        { label: "Expense %", data: monthlyExpensePct, borderColor: "#e15759", backgroundColor: "#e15759", tension: 0.3, pointRadius: 3 },
        { label: "100% (all income spent)", data: months.map(() => 100), borderColor: "#bab0ac", borderDash: [6, 6], pointRadius: 0, fill: false },
      ],
      { percent: true }
    );

    // 5. Spending by category over time (stacked bars)
    const topCats = expByCat.slice(0, 6).map((e) => e[0]);
    const catColors: Record<string, string> = {};
    topCats.forEach((c, i) => (catColors[c] = PALETTE[i % PALETTE.length]));
    const stackedDatasets = topCats.map((cat) => ({
      label: cat,
      data: months.map((mk) =>
        inScope
          .filter((t) => t.type === "expense" && t.category === cat && monthKey(t.date) === mk)
          .reduce((s, t) => s + t.amount, 0)
      ),
      backgroundColor: catColors[cat],
    }));
    // "Other" bucket for remaining categories
    const otherData = months.map((mk) =>
      inScope
        .filter((t) => t.type === "expense" && !topCats.includes(t.category) && monthKey(t.date) === mk)
        .reduce((s, t) => s + t.amount, 0)
    );
    if (otherData.some((v) => v > 0)) {
      stackedDatasets.push({ label: "Other", data: otherData, backgroundColor: "#bab0ac" });
    }
    this.makeBars(
      grid.createDiv("ft-chart-box"),
      "Spending by category over time",
      labels,
      stackedDatasets,
      { stacked: true }
    );

    // 6. Cumulative net (income − expense) over time
    this.makeLine(grid.createDiv("ft-chart-box"), "Cumulative net (income − expense)", labels, [
      { label: "Cumulative net", data: cumulativeArr, borderColor: "#4e79a7", backgroundColor: "#4e79a7", tension: 0.3, pointRadius: 3, fill: false },
    ]);

    // 7. Top spending categories (horizontal bar, share of total)
    if (expByCat.length) {
      const totalExp = expByCat.reduce((s, e) => s + e[1], 0);
      const top = expByCat.slice(0, 8);
      this.makeBars(
        grid.createDiv("ft-chart-box"),
        "Top spending categories",
        top.map((e) => `${e[0]} (${((e[1] / totalExp) * 100).toFixed(0)}%)`),
        [{ label: "Spent", data: top.map((e) => e[1]), backgroundColor: top.map((_, i) => PALETTE[i % PALETTE.length]) }],
        { horizontal: true }
      );
    }

    // 9. Category change vs previous month (what's driving the increase)
    if (months.length >= 2) {
      const cur = months[months.length - 1];
      const prev = months[months.length - 2];
      const expFor = (mk: string) => {
        const m = new Map<string, number>();
        inScope.filter((t) => t.type === "expense" && monthKey(t.date) === mk).forEach((t) => m.set(t.category, (m.get(t.category) ?? 0) + t.amount));
        return m;
      };
      const cm = expFor(cur), pm = expFor(prev);
      const cats = new Set<string>([...cm.keys(), ...pm.keys()]);
      const deltas = Array.from(cats)
        .map((c) => [c, (cm.get(c) ?? 0) - (pm.get(c) ?? 0)] as [string, number])
        .filter((d) => Math.abs(d[1]) > 0)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 8);
      if (deltas.length) {
        this.makeBars(
          grid.createDiv("ft-chart-box"),
          `Category change: ${monthLabel(cur)} vs ${monthLabel(prev)}`,
          deltas.map((d) => d[0]),
          [{ label: "Change", data: deltas.map((d) => d[1]), backgroundColor: deltas.map((d) => (d[1] > 0 ? "#e15759" : "#59a14f")) }],
          { horizontal: true }
        );
      }
    }

    // 10. Biggest expenses (top 10 table)
    const biggest = inScope
      .filter((t) => t.type === "expense")
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);
    if (biggest.length) {
      const box = grid.createDiv("ft-chart-box");
      box.createEl("h3", { text: "Biggest expenses" });
      const table = box.createEl("table", { cls: "ft-table" });
      const hr = table.createEl("thead").createEl("tr");
      ["Date", "Category", "Amount"].forEach((h) => hr.createEl("th", { text: h }));
      const tb = table.createEl("tbody");
      for (const t of biggest) {
        const tr = tb.createEl("tr");
        tr.createEl("td", { text: t.date });
        tr.createEl("td", { text: `${t.category}${t.subcategory ? " › " + t.subcategory : ""}` });
        tr.createEl("td", { text: formatCurrency(t.amount, this.plugin.settings) }).addClass("ft-amount", "ft-type-expense");
      }
    }
  }

  /** Alert cards that make overspending obvious for the selected range. */
  private renderSpendingAlerts(root: HTMLElement, inScope: Transaction[]) {
    const income = sumByType(inScope, "income");
    const expense = sumByType(inScope, "expense");
    const ratio = income > 0 ? (expense / income) * 100 : 0;
    const expByCat = this.groupByCategory(inScope, "expense");
    const topCat = expByCat[0];
    const topShare = expByCat.length ? (topCat[1] / expense) * 100 : 0;

    // over-budget for the most recent month in scope
    const months = Array.from(new Set(inScope.map((t) => monthKey(t.date)))).sort();
    const lastMonth = months[months.length - 1];
    const budgets = this.plugin.settings.budgets || {};
    let overCount = 0, overAmount = 0;
    for (const cat of Object.keys(budgets)) {
      const actual = inScope
        .filter((t) => t.type === "expense" && t.category === cat && monthKey(t.date) === lastMonth)
        .reduce((s, t) => s + t.amount, 0);
      if (actual > budgets[cat]) { overCount++; overAmount += actual - budgets[cat]; }
    }

    // this month vs average month expense
    const monthlyExp = months.map((mk) =>
      inScope.filter((t) => t.type === "expense" && monthKey(t.date) === mk).reduce((s, t) => s + t.amount, 0)
    );
    const avgExp = monthlyExp.length ? monthlyExp.reduce((s, v) => s + v, 0) / monthlyExp.length : 0;
    const lastExp = monthlyExp[monthlyExp.length - 1] ?? 0;
    const vsAvg = avgExp > 0 ? ((lastExp - avgExp) / avgExp) * 100 : 0;

    const cards = root.createDiv("ft-cards");
    const card = (label: string, value: string, cls: string, extra?: string) => {
      const c = cards.createDiv("ft-card " + cls);
      c.createDiv({ cls: "ft-card-label", text: label });
      c.createDiv({ cls: "ft-card-value", text: value });
      if (extra) c.createDiv({ cls: "ft-card-extra", text: extra });
    };

    const ratioCls = ratio >= 100 ? "ft-negative" : ratio >= 85 ? "ft-expense" : "ft-savings";
    card("Expense-to-income", `${ratio.toFixed(0)}%`, ratioCls,
      ratio >= 100 ? "Spending more than you earn!" : ratio >= 85 ? "Running tight" : "Healthy");

    card("Over budget", overCount > 0 ? `${overCount} categories` : "On track",
      overCount > 0 ? "ft-negative" : "ft-savings",
      overCount > 0 ? `${formatCurrency(overAmount, this.plugin.settings)} over (${monthLabel(lastMonth)})` : monthLabel(lastMonth));

    if (topCat) {
      card("Top category", topCat[0], "ft-investment",
        `${topShare.toFixed(0)}% of spend · ${formatCurrency(topCat[1], this.plugin.settings)}`);
    }

    card(`${monthLabel(lastMonth)} vs avg`, `${vsAvg >= 0 ? "+" : ""}${vsAvg.toFixed(0)}%`,
      vsAvg > 15 ? "ft-negative" : vsAvg < -5 ? "ft-savings" : "ft-netcash",
      vsAvg > 15 ? "Spending spiked" : "vs your average month");
  }

  private groupByCategory(txns: Transaction[], type: TxnType): [string, number][] {
    const m = new Map<string, number>();
    txns.filter((t) => t.type === type).forEach((t) => {
      m.set(t.category, (m.get(t.category) ?? 0) + t.amount);
    });
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }

  private makeBars(
    box: HTMLElement,
    title: string,
    labels: string[],
    datasets: any[],
    opts?: { stacked?: boolean; percent?: boolean; horizontal?: boolean }
  ) {
    box.createEl("h3", { text: title });
    const canvas = box.createEl("canvas");
    const fmt = (v: number) =>
      opts?.percent ? v.toFixed(0) + "%" : formatCurrency(v, this.plugin.settings);
    this.charts.push(
      new Chart(canvas, {
        type: "bar",
        data: { labels, datasets },
        options: {
          indexAxis: opts?.horizontal ? "y" : "x",
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: datasets.length > 1, position: "top", labels: { boxWidth: 12 } },
            tooltip: {
              callbacks: {
                label: (ctx: any) =>
                  `${ctx.dataset.label}: ${fmt(Number(opts?.horizontal ? ctx.parsed.x : ctx.parsed.y))}`,
              },
            },
          },
          scales: {
            x: {
              stacked: !!opts?.stacked,
              beginAtZero: true,
              ticks: {
                callback: (v: any) => (opts?.horizontal ? fmt(Number(v)) : v),
              },
            },
            y: {
              stacked: !!opts?.stacked,
              beginAtZero: true,
              ticks: {
                callback: (v: any) => (opts?.horizontal ? v : fmt(Number(v))),
              },
            },
          },
        },
      })
    );
  }

  private makeLine(
    box: HTMLElement,
    title: string,
    labels: string[],
    datasets: any[],
    opts?: { percent?: boolean }
  ) {
    box.createEl("h3", { text: title });
    const canvas = box.createEl("canvas");
    this.charts.push(
      new Chart(canvas, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { position: "top", labels: { boxWidth: 12 } },
            tooltip: {
              callbacks: {
                label: (ctx: any) =>
                  `${ctx.dataset.label}: ${
                    opts?.percent
                      ? (ctx.parsed.y as number).toFixed(0) + "%"
                      : formatCurrency(ctx.parsed.y as number, this.plugin.settings)
                  }`,
              },
            },
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: (v: any) =>
                  opts?.percent ? v + "%" : formatCurrency(Number(v), this.plugin.settings),
              },
            },
          },
        },
      })
    );
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
