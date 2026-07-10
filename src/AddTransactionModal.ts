import { App, Modal, Notice, Setting } from "obsidian";
import { Account, CategoryMap, CategoryType, Transaction, TxnType, TYPE_LABELS, QuickFavorite } from "./types";
import { todayISO, nowTimeIST, formatCurrency } from "./util";
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
  private time: string = nowTimeIST();
  private note = "";
  private account = ""; // account id (source)
  private toAccount = ""; // account id (transfer destination)
  private event = ""; // life-event id (optional)
  private splitMode = false;
  private splitLines: { category: string; subcategory: string; amount: number | null }[] = [];

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
      this.time = editing.time ?? nowTimeIST();
      this.note = editing.note;
      this.account = editing.account ?? "";
      this.toAccount = editing.toAccount ?? "";
      this.event = editing.event ?? "";
    } else {
      // prefill from last-used (device-local) for faster entry
      const lu = plugin.settings.lastUsed;
      if (lu) {
        if (lu.type) this.type = lu.type;
        if (lu.account) this.account = lu.account;
        if (lu.category) this.category = lu.category;
        if (lu.subcategory) this.subcategory = lu.subcategory;
      }
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

    // Favorites quick-fill (only for new entries)
    if (!this.editing) {
      const favs = this.plugin.settings.favorites || [];
      if (favs.length > 0) {
        const favRow = contentEl.createDiv("ft-fav-row");
        favRow.createSpan({ cls: "ft-fav-label", text: "Quick:" });
        favs.forEach((f) => {
          const chip = favRow.createEl("button", { text: f.label, cls: "ft-chip" });
          chip.onclick = () => this.applyFavorite(f);
        });
      }
    }

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
        if (t === "transfer") this.splitMode = false;
        if (t !== "transfer") {
          const cats = Object.keys(this.catMap());
          this.category = cats[0] ?? "";
          this.subcategory = (this.catMap()[this.category] ?? [])[0] ?? "";
        }
        this.rerender();
      };
    });

    // Split toggle (new, non-transfer entries only)
    if (!this.editing && this.type !== "transfer") {
      const splitRow = contentEl.createDiv("ft-split-toggle");
      const lbl = splitRow.createEl("label");
      const cb = lbl.createEl("input");
      cb.type = "checkbox";
      cb.checked = this.splitMode;
      lbl.appendText(" Split across categories");
      cb.onchange = () => {
        this.splitMode = cb.checked;
        if (this.splitMode && this.splitLines.length === 0) {
          this.splitLines = [
            { category: this.category, subcategory: this.subcategory, amount: this.amount },
            { category: this.category, subcategory: "", amount: null },
          ];
        }
        this.rerender();
      };
    }

    this.dynamicEl = contentEl.createDiv("ft-dynamic");

    // Amount (single-entry only; split lines carry their own amounts)
    if (!this.splitMode) {
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
    }

    // Date
    new Setting(contentEl).setName("Date").addText((txt) => {
      txt.inputEl.type = "date";
      txt.setValue(this.date);
      txt.onChange((v) => (this.date = v));
    });

    // Time (24-hour, defaults to current IST time)
    new Setting(contentEl).setName("Time").addText((txt) => {
      txt.inputEl.type = "time";
      txt.inputEl.setAttr("step", "60");
      txt.setValue(this.time);
      txt.onChange((v) => (this.time = v));
    });

    // Note
    new Setting(contentEl).setName("Note").addText((txt) => {
      txt.setValue(this.note);
      txt.setPlaceholder("Optional");
      txt.onChange((v) => (this.note = v));
    });

    // Event (optional) — only for non-transfer types, when events exist
    const events = this.plugin.settings.events || [];
    if (events.length > 0 && this.type !== "transfer") {
      new Setting(contentEl)
        .setName("Life event")
        .setDesc("Optional — tag this to a wedding/home/etc.")
        .addDropdown((dd) => {
          dd.addOption("", "None");
          events.forEach((e) => dd.addOption(e.id, e.name + (e.capital ? " (capital)" : "")));
          dd.setValue(this.event);
          dd.onChange((v) => (this.event = v));
        });
    }

    // Actions
    const actions = contentEl.createDiv("ft-modal-actions");
    const saveBtn = actions.createEl("button", {
      text: this.editing ? "Save" : "Add",
      cls: "mod-cta",
    });
    saveBtn.onclick = () => this.submit();
    if (!this.editing && this.type !== "transfer") {
      const favBtn = actions.createEl("button", { text: "☆ Favorite" });
      favBtn.setAttr("aria-label", "Save current entry as a favorite");
      favBtn.onclick = () => this.saveAsFavorite();
    }
    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();

    if (!this.category && this.type !== "transfer") {
      const cats = Object.keys(this.catMap());
      this.category = cats[0] ?? "";
      this.subcategory = (this.catMap()[this.category] ?? [])[0] ?? "";
    }
    this.renderDynamic();
  }

  /** Full re-render of the modal (used on type/split toggle). */
  private rerender() {
    this.contentEl.empty();
    this.onOpen();
  }

  /** Fills the form from a saved favorite and re-renders. */
  private applyFavorite(f: QuickFavorite) {
    this.type = f.type;
    this.category = f.category;
    this.subcategory = f.subcategory;
    if (f.account) this.account = f.account;
    if (f.amount != null) this.amount = f.amount;
    this.contentEl.empty();
    this.onOpen();
  }

  private saveAsFavorite() {
    if (this.type === "transfer") {
      new Notice("Favorites are for income/expense/investment entries.");
      return;
    }
    if (!this.category) {
      new Notice("Choose a category first.");
      return;
    }
    const defaultLabel = this.subcategory || this.category;
    new PromptModal(this.app, "Save as favorite", `Label (e.g. ${defaultLabel})`, async (label) => {
      const fav: QuickFavorite = {
        id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        label: label || defaultLabel,
        type: this.type,
        category: this.category,
        subcategory: this.subcategory,
        account: this.account || undefined,
        amount: this.amount != null && !isNaN(this.amount) ? Math.abs(this.amount) : undefined,
      };
      this.plugin.settings.favorites.push(fav);
      await this.plugin.saveSettings();
      new Notice(`Saved favorite "${fav.label}".`);
    }).open();
  }

  /** Renders the split-lines editor (account + N category/amount rows). */
  private renderSplitLines(el: HTMLElement, accts: Account[]) {
    // shared account
    new Setting(el).setName("Account").addDropdown((dd) => {
      if (accts.length === 0) { dd.addOption("", "(no accounts)"); dd.setDisabled(true); }
      else {
        accts.forEach((a) => dd.addOption(a.id, a.name));
        if (!this.account) this.account = accts[0].id;
        dd.setValue(this.account);
      }
      dd.onChange((v) => (this.account = v));
    });

    const cats = Object.keys(this.catMap());
    el.createEl("div", { cls: "setting-item-description", text: "Split lines (each becomes its own transaction):" });
    this.splitLines.forEach((line, i) => {
      const row = el.createDiv("ft-split-line");
      const catSel = row.createEl("select");
      cats.forEach((c) => catSel.createEl("option", { text: c, value: c }));
      if (!line.category && cats[0]) line.category = cats[0];
      catSel.value = line.category;
      catSel.onchange = () => {
        line.category = catSel.value;
        line.subcategory = "";
        this.rerender();
      };
      const subSel = row.createEl("select");
      subSel.createEl("option", { text: "—", value: "" });
      (this.catMap()[line.category] ?? []).forEach((s) => subSel.createEl("option", { text: s, value: s }));
      subSel.value = line.subcategory;
      subSel.onchange = () => (line.subcategory = subSel.value);
      const amt = row.createEl("input");
      amt.type = "number";
      amt.placeholder = "0.00";
      amt.value = line.amount != null ? String(line.amount) : "";
      amt.oninput = () => (line.amount = amt.value === "" ? null : parseFloat(amt.value));
      const del = row.createEl("button", { text: "✕", cls: "ft-icon-btn" });
      del.onclick = () => {
        this.splitLines.splice(i, 1);
        this.rerender();
      };
    });

    const bar = el.createDiv("ft-split-bar");
    const addLine = bar.createEl("button", { text: "+ Add line" });
    addLine.onclick = () => {
      this.splitLines.push({ category: cats[0] ?? "", subcategory: "", amount: null });
      this.rerender();
    };
    const total = this.splitLines.reduce((s, l) => s + (l.amount || 0), 0);
    bar.createSpan({ cls: "ft-split-total", text: "Total: " + formatCurrency(total, this.plugin.settings) });
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

    if (this.splitMode) {
      this.renderSplitLines(el, accts);
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
    // Split mode: create one transaction per line sharing a splitId.
    if (this.splitMode && this.type !== "transfer") {
      const valid = this.splitLines.filter((l) => l.category && l.amount != null && !isNaN(l.amount) && l.amount > 0);
      if (valid.length === 0) {
        new Notice("Add at least one split line with a category and amount.");
        return;
      }
      const splitId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      for (const l of valid) {
        await this.plugin.store.add({
          date: this.date || todayISO(),
          time: this.time || nowTimeIST(),
          type: this.type,
          category: l.category,
          subcategory: l.subcategory,
          amount: Math.abs(l.amount!),
          note: this.note.trim(),
          account: this.account || undefined,
          event: this.event || undefined,
          splitId,
        });
      }
      new Notice(`Added split (${valid.length} lines).`);
      this.onSaved();
      this.close();
      return;
    }

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
      time: this.time || nowTimeIST(),
      type: this.type,
      category: this.type === "transfer" ? "Transfer" : this.category,
      subcategory: this.type === "transfer" ? "" : this.subcategory,
      amount: Math.abs(this.amount),
      note: this.note.trim(),
      account: this.account || undefined,
      toAccount: this.type === "transfer" ? this.toAccount || undefined : undefined,
      event: this.type === "transfer" ? undefined : this.event || undefined,
    };

    if (this.editing) {
      await this.plugin.store.update(this.editing.id, payload);
      new Notice("Transaction updated.");
    } else {
      await this.plugin.store.add(payload);
      new Notice("Transaction added.");
    }
    this.checkBudgetAlert(payload);
    // remember last-used for faster next entry (device-local)
    if (!this.editing) {
      this.plugin.settings.lastUsed = {
        type: this.type,
        account: this.account || undefined,
        category: this.type === "transfer" ? undefined : this.category,
        subcategory: this.type === "transfer" ? undefined : this.subcategory,
      };
      await this.plugin.saveLastUsed();
    }
    this.onSaved();
    this.close();
  }

  /** Warns when an expense pushes its category over (or near) the monthly budget. */
  private checkBudgetAlert(payload: Omit<Transaction, "id">) {
    if (payload.type !== "expense") return;
    const budget = this.plugin.settings.budgets?.[payload.category];
    if (!budget || budget <= 0) return;
    const ym = (payload.date || "").slice(0, 7);
    const spent = this.plugin.store
      .getAll()
      .filter((t) => t.type === "expense" && t.category === payload.category && (t.date || "").slice(0, 7) === ym)
      .reduce((s, t) => s + t.amount, 0);
    const fmt = (n: number) => formatCurrency(n, this.plugin.settings);
    if (spent > budget) {
      new Notice(`⚠ Over budget — ${payload.category}: ${fmt(spent)} of ${fmt(budget)} this month (${fmt(spent - budget)} over).`, 8000);
    } else if (spent >= budget * 0.8) {
      new Notice(`${payload.category} nearing budget: ${fmt(spent)} of ${fmt(budget)} (${((spent / budget) * 100).toFixed(0)}%).`, 6000);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
