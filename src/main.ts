import { Plugin, WorkspaceLeaf, Notice, normalizePath } from "obsidian";
import { DEFAULT_SETTINGS, FinanceSettings } from "./types";
import { FinanceStore } from "./store";
import { AddTransactionModal } from "./AddTransactionModal";
import { RecurringModal } from "./RecurringModal";
import { AccountModal } from "./AccountModal";
import { LoanModal } from "./LoanModal";
import { ImportModal } from "./ImportModal";
import { HoldingsModal } from "./HoldingsModal";
import { FinanceDashboardView, VIEW_TYPE_FINANCE } from "./DashboardView";
import { FinanceSettingTab } from "./settings";
import { dueOccurrences } from "./util";

export default class FinanceTrackerPlugin extends Plugin {
  settings!: FinanceSettings;
  store!: FinanceStore;

  async onload() {
    await this.loadSettings();

    this.store = new FinanceStore(this.app, this.settings.dataFilePath);
    await this.store.load();

    // Ensure shared config (accounts/categories/budgets/recurring) lives in the
    // synced data file so it travels across devices. Migrates from plugin
    // settings on first run with this version.
    await this.reconcileConfig();

    // Daily full-snapshot backup (recoverable safety net).
    await this.store.backup();

    // Auto-post any due recurring transactions since last open.
    await this.materializeRecurring();

    this.registerView(VIEW_TYPE_FINANCE, (leaf) => new FinanceDashboardView(leaf, this));

    // Ribbon: one click adds a transaction
    this.addRibbonIcon("indian-rupee", "Add transaction", () => {
      new AddTransactionModal(this.app, this, () => this.refreshDashboards()).open();
    });

    // Ribbon: open dashboard
    this.addRibbonIcon("pie-chart", "Finance dashboard", () => {
      this.activateView();
    });

    this.addCommand({
      id: "add-transaction",
      name: "Add transaction",
      callback: () => {
        new AddTransactionModal(this.app, this, () => this.refreshDashboards()).open();
      },
    });

    this.addCommand({
      id: "open-dashboard",
      name: "Open dashboard",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "manage-recurring",
      name: "Manage recurring transactions",
      callback: () => {
        new RecurringModal(this.app, this, () => this.refreshDashboards()).open();
      },
    });

    this.addCommand({
      id: "manage-accounts",
      name: "Manage accounts",
      callback: () => {
        new AccountModal(this.app, this, () => this.refreshDashboards()).open();
      },
    });

    this.addCommand({
      id: "manage-lending",
      name: "Manage lending & borrowing",
      callback: () => {
        new LoanModal(this.app, this, () => this.refreshDashboards()).open();
      },
    });

    this.addCommand({
      id: "import-csv",
      name: "Import transactions from CSV",
      callback: () => {
        new ImportModal(this.app, this, () => this.refreshDashboards()).open();
      },
    });

    this.addCommand({
      id: "manage-holdings",
      name: "Manage investment holdings",
      callback: () => {
        new HoldingsModal(this.app, this, () => this.refreshDashboards()).open();
      },
    });

    this.addSettingTab(new FinanceSettingTab(this.app, this));

    // Live-refresh when any data file under the base folder changes on disk
    // (e.g. after a sync on another device, or an external edit).
    const onFileChange = (file: { path: string }) => {
      const base = normalizePath(this.store.baseDir);
      if (file.path.includes("/backups/")) return; // ignore our snapshot churn
      if (file.path === base || file.path.startsWith(base + "/")) {
        this.reloadIfChanged();
      }
    };
    this.registerEvent(this.app.vault.on("modify", onFileChange));
    this.registerEvent(this.app.vault.on("create", onFileChange));
    this.registerEvent(this.app.vault.on("delete", onFileChange));
    this.registerEvent(this.app.vault.on("rename", onFileChange));
  }

  onunload() {
    // Views are cleaned up by Obsidian; charts are destroyed in view.onClose().
  }

  /** Persists only the device-local "last used" prefs (cheap, no config write). */
  async saveLastUsed() {
    await this.saveData({
      dataFilePath: this.settings.dataFilePath,
      currency: this.settings.currency,
      locale: this.settings.locale,
      lastUsed: this.settings.lastUsed,
    });
  }

  private refreshDashboards() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_FINANCE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof FinanceDashboardView) view.refresh();
    });
  }

  private reloadTimer: number | null = null;

  /**
   * Reloads all data from disk and refreshes dashboards. Debounced, and ignores
   * changes that happened right after our own write (so it doesn't loop).
   */
  private reloadIfChanged() {
    if (Date.now() - this.store.lastWrite < 1500) return; // our own recent write
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(async () => {
      if (Date.now() - this.store.lastWrite < 1500) return;
      try {
        await this.store.load();
        await this.reconcileConfig();
        this.refreshDashboards();
      } catch (e) {
        console.error("Finance Tracker: reloadIfChanged failed", e);
      }
    }, 500);
  }

  /**
   * Generates and posts any recurring transactions that have become due
   * (on or before today) since the rule was last posted. Returns the count added.
   */
  async materializeRecurring(): Promise<number> {
    const rules = this.settings.recurring || [];
    if (rules.length === 0) return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let added = 0;
    let settingsDirty = false;

    for (const rule of rules) {
      if (!rule.active) continue;
      const dates = dueOccurrences(rule.startDate, rule.lastPosted, rule.frequency, today);
      if (dates.length === 0) continue;
      for (const date of dates) {
        await this.store.add({
          date,
          type: rule.type,
          category: rule.category,
          subcategory: rule.subcategory,
          amount: Math.abs(rule.amount),
          note: rule.note ? rule.note + " (recurring)" : "(recurring)",
          account: rule.account,
          recurringId: rule.id,
        });
        added++;
      }
      rule.lastPosted = dates[dates.length - 1];
      settingsDirty = true;
    }

    if (settingsDirty) await this.saveSettings();
    if (added > 0) {
      new Notice(`Finance Tracker: posted ${added} recurring transaction(s).`);
      this.refreshDashboards();
    }
    return added;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_FINANCE);
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_FINANCE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    // ensure structures exist
    if (!this.settings.categories) this.settings.categories = DEFAULT_SETTINGS.categories;
    if (!Array.isArray(this.settings.recurring)) this.settings.recurring = [];
    if (!Array.isArray(this.settings.accounts)) this.settings.accounts = [];
    if (!Array.isArray(this.settings.events)) this.settings.events = [];
    if (!Array.isArray(this.settings.discretionary)) this.settings.discretionary = [];
    if (!Array.isArray(this.settings.favorites)) this.settings.favorites = [];
    if (!Array.isArray(this.settings.holdings)) this.settings.holdings = [];
    if (typeof this.settings.savingsGoal !== "number") this.settings.savingsGoal = 0;
    if (!this.settings.budgets || typeof this.settings.budgets !== "object") {
      this.settings.budgets = {};
    }
  }

  /**
   * Makes the synced data file the source of truth for accounts, categories,
   * budgets and recurring rules. On first run with this version it merges any
   * config that previously lived only in plugin settings into the data file
   * (union by id), so accounts are recovered no matter which device runs first.
   */
  async reconcileConfig() {
    const d = this.store.data;
    const migrated = (d.version ?? 1) >= 2;

    if (!migrated) {
      d.accounts = unionById(d.accounts ?? [], this.settings.accounts ?? []);
      d.recurring = unionById(d.recurring ?? [], this.settings.recurring ?? []);
      d.events = unionById(d.events ?? [], this.settings.events ?? []);
      d.budgets = { ...(this.settings.budgets ?? {}), ...(d.budgets ?? {}) };
      d.categories = d.categories ?? this.settings.categories ?? DEFAULT_SETTINGS.categories;
      d.savingsGoal = d.savingsGoal ?? this.settings.savingsGoal ?? 0;
      d.discretionary = d.discretionary ?? this.settings.discretionary ?? [];
      d.favorites = unionById(d.favorites ?? [], this.settings.favorites ?? []);
      d.holdings = unionById(d.holdings ?? [], this.settings.holdings ?? []);
      d.version = 2;
      await this.store.saveConfig();
    }

    // Data file is the source of truth from here on.
    this.settings.accounts = d.accounts ?? [];
    this.settings.categories = d.categories ?? DEFAULT_SETTINGS.categories;
    this.settings.budgets = d.budgets ?? {};
    this.settings.recurring = d.recurring ?? [];
    this.settings.events = d.events ?? [];
    this.settings.savingsGoal = d.savingsGoal ?? 0;
    this.settings.discretionary = d.discretionary ?? [];
    this.settings.favorites = d.favorites ?? [];
    this.settings.holdings = d.holdings ?? [];
  }

  async saveSettings() {
    // Only device-local display prefs stay in plugin settings — NOT the shared
    // config, so stale copies can't resurrect deleted accounts across devices.
    await this.saveData({
      dataFilePath: this.settings.dataFilePath,
      currency: this.settings.currency,
      locale: this.settings.locale,
      lastUsed: this.settings.lastUsed,
    });
    // Shared config is persisted into the synced data file.
    if (this.store) {
      this.store.data.accounts = this.settings.accounts;
      this.store.data.categories = this.settings.categories;
      this.store.data.budgets = this.settings.budgets;
      this.store.data.recurring = this.settings.recurring;
      this.store.data.events = this.settings.events;
      this.store.data.savingsGoal = this.settings.savingsGoal;
      this.store.data.discretionary = this.settings.discretionary;
      this.store.data.favorites = this.settings.favorites;
      this.store.data.holdings = this.settings.holdings;
      if ((this.store.data.version ?? 1) < 2) this.store.data.version = 2;
      await this.store.saveConfig();
    }
  }
}

/** Merge two lists of objects by their `id`, keeping the first list's items on conflict. */
function unionById<T extends { id: string }>(base: T[], extra: T[]): T[] {
  const seen = new Set(base.map((x) => x.id));
  const result = [...base];
  for (const item of extra) {
    if (!seen.has(item.id)) {
      result.push(item);
      seen.add(item.id);
    }
  }
  return result;
}
