import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { DEFAULT_SETTINGS, FinanceSettings } from "./types";
import { FinanceStore } from "./store";
import { AddTransactionModal } from "./AddTransactionModal";
import { RecurringModal } from "./RecurringModal";
import { AccountModal } from "./AccountModal";
import { LoanModal } from "./LoanModal";
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

    this.addSettingTab(new FinanceSettingTab(this.app, this));
  }

  onunload() {
    // Views are cleaned up by Obsidian; charts are destroyed in view.onClose().
  }

  private refreshDashboards() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_FINANCE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof FinanceDashboardView) view.refresh();
    });
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

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    // ensure structures exist
    if (!this.settings.categories) this.settings.categories = DEFAULT_SETTINGS.categories;
    if (!Array.isArray(this.settings.recurring)) this.settings.recurring = [];
    if (!Array.isArray(this.settings.accounts)) this.settings.accounts = [];
    if (!this.settings.budgets || typeof this.settings.budgets !== "object") {
      this.settings.budgets = {};
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
