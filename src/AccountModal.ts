import { App, Modal, Notice, Setting } from "obsidian";
import { Account, AccountType, ACCOUNT_TYPE_LABELS } from "./types";
import { computeBalances, formatCurrency } from "./util";
import type FinanceTrackerPlugin from "./main";

export class AccountModal extends Modal {
  private plugin: FinanceTrackerPlugin;
  private onChanged: () => void;

  private editingId: string | null = null;
  private name = "";
  private initialBalance: number | null = null;
  private type: AccountType = "asset";

  private listEl!: HTMLElement;
  private formEl!: HTMLElement;

  constructor(app: App, plugin: FinanceTrackerPlugin, onChanged: () => void) {
    super(app);
    this.plugin = plugin;
    this.onChanged = onChanged;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ft-modal", "ft-account-modal");
    contentEl.createEl("h2", { text: "Accounts" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Define where money lives (cash, bank accounts, wallets). Balances update from income, expenses, investments and transfers.",
    });

    this.listEl = contentEl.createDiv("ft-account-list");
    this.formEl = contentEl.createDiv("ft-account-form");
    this.renderList();
    this.renderForm();
  }

  private renderList() {
    this.listEl.empty();
    const accounts = this.plugin.settings.accounts;
    if (accounts.length === 0) {
      this.listEl.createDiv({ cls: "ft-empty", text: "No accounts yet." });
      return;
    }
    const balances = computeBalances(accounts, this.plugin.store.getAll());
    const table = this.listEl.createEl("table", { cls: "ft-table" });
    const hr = table.createEl("thead").createEl("tr");
    ["", "Account", "Type", "Initial", "Current balance", ""].forEach((h) => {
      const th = hr.createEl("th", { text: h });
      if (["Initial", "Current balance"].includes(h)) th.addClass("ft-col-amount");
    });
    const tbody = table.createEl("tbody");
    for (const b of balances) {
      const a = b.account;
      const tr = tbody.createEl("tr");
      if (!a.active) tr.addClass("ft-inactive");

      const toggle = tr.createEl("td").createEl("input");
      toggle.type = "checkbox";
      toggle.checked = a.active;
      toggle.onchange = async () => {
        a.active = toggle.checked;
        await this.plugin.saveSettings();
      };

      tr.createEl("td", { text: a.name });
      tr.createEl("td", { text: ACCOUNT_TYPE_LABELS[a.type ?? "asset"].split(" ")[0] });
      tr.createEl("td", { text: formatCurrency(a.initialBalance, this.plugin.settings) }).addClass("ft-amount");
      const bal = tr.createEl("td", { text: formatCurrency(b.balance, this.plugin.settings) });
      bal.addClass("ft-amount");
      if (b.balance < 0) bal.addClass("ft-type-expense");

      const act = tr.createEl("td");
      const edit = act.createEl("button", { text: "✎", cls: "ft-icon-btn" });
      edit.onclick = () => {
        this.editingId = a.id;
        this.name = a.name;
        this.initialBalance = a.initialBalance;
        this.type = a.type ?? "asset";
        this.renderForm();
      };
      const del = act.createEl("button", { text: "🗑", cls: "ft-icon-btn" });
      del.onclick = async () => {
        const used = this.plugin.store
          .getAll()
          .some((t) => t.account === a.id || t.toAccount === a.id);
        if (used) {
          new Notice("This account is used by transactions. Deactivate it instead of deleting.");
          return;
        }
        this.plugin.settings.accounts = this.plugin.settings.accounts.filter((x) => x.id !== a.id);
        await this.plugin.saveSettings();
        this.renderList();
        this.onChanged();
      };
    }
  }

  private renderForm() {
    const el = this.formEl;
    el.empty();
    el.createEl("h3", { text: this.editingId ? "Edit account" : "Add account" });

    new Setting(el).setName("Name").addText((t) => {
      t.setValue(this.name);
      t.setPlaceholder("e.g. HDFC Savings, Cash, Wallet");
      t.onChange((v) => (this.name = v));
    });

    new Setting(el).setName("Type").addDropdown((dd) => {
      (Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[]).forEach((t) => dd.addOption(t, ACCOUNT_TYPE_LABELS[t]));
      dd.setValue(this.type);
      dd.onChange((v) => {
        this.type = v as AccountType;
        this.renderForm();
      });
    });

    const isDebt = this.type !== "asset";
    new Setting(el)
      .setName(isDebt ? "Amount currently owed" : "Initial balance")
      .setDesc(isDebt
        ? "How much you currently owe on this card/loan (0 if nothing)."
        : "Balance in this account before you start tracking.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.setAttr("step", "0.01");
        t.inputEl.setAttr("min", "0");
        if (this.initialBalance != null) t.setValue(String(Math.abs(this.initialBalance)));
        t.setPlaceholder("0");
        t.onChange((v) => (this.initialBalance = v === "" ? null : parseFloat(v)));
      });

    const actions = el.createDiv("ft-modal-actions");
    const save = actions.createEl("button", {
      text: this.editingId ? "Save" : "Add account",
      cls: "mod-cta",
    });
    save.onclick = () => this.save();
    if (this.editingId) {
      const nw = actions.createEl("button", { text: "New" });
      nw.onclick = () => {
        this.resetForm();
        this.renderForm();
      };
    }
  }

  private resetForm() {
    this.editingId = null;
    this.name = "";
    this.initialBalance = null;
    this.type = "asset";
  }

  private async save() {
    const name = this.name.trim();
    if (!name) {
      new Notice("Please enter an account name.");
      return;
    }
    const raw = this.initialBalance == null || isNaN(this.initialBalance) ? 0 : Math.abs(this.initialBalance);
    // Debt accounts store the opening balance as negative (amount owed).
    const initial = this.type === "asset" ? raw : -raw;
    if (this.editingId) {
      const a = this.plugin.settings.accounts.find((x) => x.id === this.editingId);
      if (a) {
        a.name = name;
        a.initialBalance = initial;
        a.type = this.type;
      }
    } else {
      this.plugin.settings.accounts.push({
        id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        name,
        initialBalance: initial,
        active: true,
        type: this.type,
      });
    }
    await this.plugin.saveSettings();
    this.resetForm();
    this.renderList();
    this.renderForm();
    this.onChanged();
    new Notice("Account saved.");
  }

  onClose() {
    this.contentEl.empty();
  }
}
