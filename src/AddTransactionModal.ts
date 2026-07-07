import { App, Modal, Notice, Setting } from "obsidian";
import { Account, CategoryMap, CategoryType, Transaction, TxnType, TYPE_LABELS } from "./types";
import { todayISO } from "./util";
import { PromptModal } from "./PromptModal";
import type FinanceTrackerPlugin from "./main";

export class AddTransactionModal extends Modal {
  private plugin: FinanceTrackerPlugin;
  private onSaved: () => void;
  private editing?: Transaction;

  private type: TxnType = "expense";
  private category = "";
  private subcategory = "";
  private amount: number | null = null;
  private date: string = todayISO();
  private note = "";
  private account = ""; // account id (source)
  private toAccount = ""; // account id (transfer destination)

  private dynamicEl!: HTMLElement;
  private catSelect: HTMLSelectElement | null = null;
  private subSelect: HTMLSelectElement | null = null;

  constructor(app: App, plugin: FinanceTrackerPlugin, onSaved: () => void, editing?: Transaction) {
    super(app);
    this.plugin = plugin;
    this.onSaved = onSaved;
    if (editing) {
      this.editing = editing;
      this.type = editing.type;
      this.category = editing.category;
      this.subcategory = editing.subcategory;
      this.amount = editing.amount;
      this.date = editing.date;
      this.note = editing.note;
      this.account = editing.account ?? "";
      this.toAccount = editing.toAccount ?? "";
    }
  }

  private activeAccounts(): Account[] {
    return this.plugin.settings.accounts.filter((a) => a.active || a.id === this.account || a.id === this.toAccount);
  }

  private catMap(): CategoryMap {
    if (this.type === "transfer") return {};
    return this.plugin.settings.categories[this.type as CategoryType] || {};
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ft-modal");
    contentEl.createEl("h2", { text: this.editing ? "Edit transaction" : "Add transaction" });

    // default account = first active account
    const accts = this.activeAccounts();
    if (!this.account && accts.length > 0) this.account = accts[0].id;

    // Type segmented control (includes Transfer)
    const typeRow = contentEl.createDiv("ft-type-row");
    (Object.keys(TYPE_LABELS) as TxnType[]).forEach((t) => {
      const btn = typeRow.createEl("button", {
        text: TYPE_LABELS[t],
        cls: "ft-type-btn" + (t === this.type ? " is-active" : ""),
      });
      btn.addClass("ft-type-" + t);
      btn.onclick = () => {
        this.type = t;
        if (t !== "transfer") {
          const cats = Object.keys(this.catMap());
          this.category = cats[0] ?? "";
          this.subcategory = (this.catMap()[this.category] ?? [])[0] ?? "";
        }
        typeRow.querySelectorAll(".ft-type-btn").forEach((b) => b.removeClass("is-active"));
        btn.addClass("is-active");
        this.renderDynamic();
      };
    });

    this.dynamicEl = contentEl.createDiv("ft-dynamic");

    // Amount
    new Setting(contentEl).setName("Amount").addText((txt) => {
      txt.inputEl.type = "number";
      txt.inputEl.setAttr("step", "0.01");
      txt.inputEl.setAttr("min", "0");
      txt.inputEl.addClass("ft-amount-input");
      if (this.amount != null) txt.setValue(String(this.amount));
      txt.setPlaceholder("0.00");
      txt.onChange((v) => (this.amount = v === "" ? null : parseFloat(v)));
      txt.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => txt.inputEl.focus(), 30);
    });

    // Date
    new Setting(contentEl).setName("Date").addText((txt) => {
      txt.inputEl.type = "date";
      txt.setValue(this.date);
      txt.onChange((v) => (this.date = v));
    });

    // Note
    new Setting(contentEl).setName("Note").addText((txt) => {
      txt.setValue(this.note);
      txt.setPlaceholder("Optional");
      txt.onChange((v) => (this.note = v));
    });

    // Actions
    const actions = contentEl.createDiv("ft-modal-actions");
    const saveBtn = actions.createEl("button", {
      text: this.editing ? "Save" : "Add",
      cls: "mod-cta",
    });
    saveBtn.onclick = () => this.submit();
    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();

    if (!this.category && this.type !== "transfer") {
      const cats = Object.keys(this.catMap());
      this.category = cats[0] ?? "";
      this.subcategory = (this.catMap()[this.category] ?? [])[0] ?? "";
    }
    this.renderDynamic();
  }

  /** Renders the category/sub-category or transfer account fields depending on type. */
  private renderDynamic() {
    const el = this.dynamicEl;
    el.empty();
    this.catSelect = null;
    this.subSelect = null;

    const accts = this.activeAccounts();

    if (this.type === "transfer") {
      new Setting(el).setName("From account").addDropdown((dd) => {
        accts.forEach((a) => dd.addOption(a.id, a.name));
        if (!this.account && accts[0]) this.account = accts[0].id;
        dd.setValue(this.account);
        dd.onChange((v) => (this.account = v));
      });
      new Setting(el).setName("To account").addDropdown((dd) => {
        accts.forEach((a) => dd.addOption(a.id, a.name));
        if (!this.toAccount) {
          const other = accts.find((a) => a.id !== this.account);
          this.toAccount = other?.id ?? "";
        }
        dd.setValue(this.toAccount);
        dd.onChange((v) => (this.toAccount = v));
      });
      return;
    }

    // Category
    new Setting(el)
      .setName("Category")
      .addDropdown((dd) => {
        this.catSelect = dd.selectEl;
        dd.onChange((v) => {
          this.category = v;
          this.subcategory = (this.catMap()[v] ?? [])[0] ?? "";
          this.refreshSubOptions();
        });
      })
      .addExtraButton((b) =>
        b
          .setIcon("plus")
          .setTooltip("Add new category")
          .onClick(() => this.addCategory())
      );
    // Sub-category
    new Setting(el)
      .setName("Sub-category")
      .addDropdown((dd) => {
        this.subSelect = dd.selectEl;
        dd.onChange((v) => (this.subcategory = v));
      })
      .addExtraButton((b) =>
        b
          .setIcon("plus")
          .setTooltip("Add new sub-category")
          .onClick(() => this.addSubcategory())
      );
    // Account
    new Setting(el).setName("Account").addDropdown((dd) => {
      if (accts.length === 0) {
        dd.addOption("", "(no accounts)");
        dd.setDisabled(true);
      } else {
        accts.forEach((a) => dd.addOption(a.id, a.name));
        if (!this.account) this.account = accts[0].id;
        dd.setValue(this.account);
      }
      dd.onChange((v) => (this.account = v));
    });

    this.refreshCategoryOptions();
    this.refreshSubOptions();
  }
  private addCategory() {
    if (this.type === "transfer") return;
    new PromptModal(this.app, "New category", "Category name", async (name) => {
      const map = this.plugin.settings.categories[this.type as CategoryType];
      if (!map[name]) map[name] = [];
      await this.plugin.saveSettings();
      this.category = name;
      this.subcategory = "";
      this.renderDynamic();
      new Notice(`Added category "${name}".`);
    }).open();
  }

  private addSubcategory() {
    if (this.type === "transfer") return;
    if (!this.category) {
      new Notice("Choose or add a category first.");
      return;
    }
    new PromptModal(
      this.app,
      `New sub-category in "${this.category}"`,
      "Sub-category name",
      async (name) => {
        const map = this.plugin.settings.categories[this.type as CategoryType];
        if (!map[this.category]) map[this.category] = [];
        if (!map[this.category].includes(name)) map[this.category].push(name);
        await this.plugin.saveSettings();
        this.subcategory = name;
        this.refreshSubOptions();
        new Notice(`Added sub-category "${name}".`);
      }
    ).open();
  }


  private refreshCategoryOptions() {
    if (!this.catSelect) return;
    this.catSelect.empty();
    const cats = Object.keys(this.catMap());
    for (const c of cats) {
      const opt = this.catSelect.createEl("option", { text: c, value: c });
      if (c === this.category) opt.selected = true;
    }
    if (!cats.includes(this.category)) this.category = cats[0] ?? "";
    this.catSelect.value = this.category;
  }

  private refreshSubOptions() {
    if (!this.subSelect) return;
    this.subSelect.empty();
    const subs = this.catMap()[this.category] ?? [];
    this.subSelect.createEl("option", { text: "—", value: "" });
    for (const s of subs) {
      const opt = this.subSelect.createEl("option", { text: s, value: s });
      if (s === this.subcategory) opt.selected = true;
    }
    if (!subs.includes(this.subcategory)) this.subcategory = subs[0] ?? "";
    this.subSelect.value = this.subcategory;
  }

  private async submit() {
    if (this.amount == null || isNaN(this.amount) || this.amount <= 0) {
      new Notice("Please enter a valid amount.");
      return;
    }

    if (this.type === "transfer") {
      if (!this.account || !this.toAccount) {
        new Notice("Please choose both accounts for the transfer.");
        return;
      }
      if (this.account === this.toAccount) {
        new Notice("From and To accounts must be different.");
        return;
      }
    } else if (!this.category) {
      new Notice("Please choose a category.");
      return;
    }

    const payload: Omit<Transaction, "id"> = {
      date: this.date || todayISO(),
      type: this.type,
      category: this.type === "transfer" ? "Transfer" : this.category,
      subcategory: this.type === "transfer" ? "" : this.subcategory,
      amount: Math.abs(this.amount),
      note: this.note.trim(),
      account: this.account || undefined,
      toAccount: this.type === "transfer" ? this.toAccount || undefined : undefined,
    };

    if (this.editing) {
      await this.plugin.store.update(this.editing.id, payload);
      new Notice("Transaction updated.");
    } else {
      await this.plugin.store.add(payload);
      new Notice("Transaction added.");
    }
    this.onSaved();
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
