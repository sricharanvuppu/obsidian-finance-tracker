import { App, Modal, Notice, Setting } from "obsidian";
import { Loan, LoanDirection, LOAN_DIRECTION_LABELS } from "./types";
import { formatCurrency, loanOutstanding, loanInterestTotal, todayISO } from "./util";
import type FinanceTrackerPlugin from "./main";

export class LoanModal extends Modal {
  private plugin: FinanceTrackerPlugin;
  private onChanged: () => void;

  private editingId: string | null = null;
  // loan form state
  private counterparty = "";
  private direction: LoanDirection = "lent";
  private principal: number | null = null;
  private date = todayISO();
  private interestRate: number | null = null;
  private dueDate = "";
  private account = "";
  private note = "";

  private listEl!: HTMLElement;
  private formEl!: HTMLElement;

  constructor(app: App, plugin: FinanceTrackerPlugin, onChanged: () => void) {
    super(app);
    this.plugin = plugin;
    this.onChanged = onChanged;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ft-modal", "ft-loan-modal");
    contentEl.createEl("h2", { text: "Lending & borrowing" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Track money you lend out or borrow. Principal moves cash between accounts but is not counted as expense/income; interest is tracked separately.",
    });
    this.listEl = contentEl.createDiv("ft-loan-list");
    this.formEl = contentEl.createDiv("ft-loan-form");
    this.renderList();
    this.renderForm();
  }

  private accountName(id?: string): string {
    if (!id) return "—";
    return this.plugin.settings.accounts.find((a) => a.id === id)?.name ?? "(deleted)";
  }

  private renderList() {
    this.listEl.empty();
    const loans = this.plugin.store.getLoans();
    if (loans.length === 0) {
      this.listEl.createDiv({ cls: "ft-empty", text: "No loans yet." });
      return;
    }
    const table = this.listEl.createEl("table", { cls: "ft-table" });
    const hr = table.createEl("thead").createEl("tr");
    ["Person", "Dir", "Principal", "Outstanding", "Interest", "Due", ""].forEach((h) =>
      hr.createEl("th", { text: h })
    );
    const tbody = table.createEl("tbody");
    for (const l of loans) {
      const tr = tbody.createEl("tr");
      const outstanding = loanOutstanding(l);
      if (outstanding <= 0) tr.addClass("ft-inactive");
      tr.createEl("td", { text: l.counterparty });
      tr.createEl("td", { text: l.direction === "lent" ? "→ lent" : "← borrowed" });
      tr.createEl("td", { text: formatCurrency(l.principal, this.plugin.settings) }).addClass("ft-amount");
      tr.createEl("td", { text: formatCurrency(outstanding, this.plugin.settings) }).addClass("ft-amount");
      tr.createEl("td", { text: formatCurrency(loanInterestTotal(l), this.plugin.settings) }).addClass("ft-amount");
      tr.createEl("td", { text: l.dueDate || "—" });
      const act = tr.createEl("td");
      const edit = act.createEl("button", { text: "✎", cls: "ft-icon-btn" });
      edit.onclick = () => this.loadIntoForm(l);
      const del = act.createEl("button", { text: "🗑", cls: "ft-icon-btn" });
      del.onclick = async () => {
        await this.plugin.store.removeLoan(l.id);
        if (this.editingId === l.id) this.resetForm();
        this.renderList();
        this.renderForm();
        this.onChanged();
      };
    }
  }

  private loadIntoForm(l: Loan) {
    this.editingId = l.id;
    this.counterparty = l.counterparty;
    this.direction = l.direction;
    this.principal = l.principal;
    this.date = l.date;
    this.interestRate = l.interestRate ?? null;
    this.dueDate = l.dueDate ?? "";
    this.account = l.account ?? "";
    this.note = l.note ?? "";
    this.renderForm();
  }

  private resetForm() {
    this.editingId = null;
    this.counterparty = "";
    this.direction = "lent";
    this.principal = null;
    this.date = todayISO();
    this.interestRate = null;
    this.dueDate = "";
    this.account = "";
    this.note = "";
  }

  private renderForm() {
    const el = this.formEl;
    el.empty();
    el.createEl("h3", { text: this.editingId ? "Edit loan" : "Add loan" });

    new Setting(el).setName("Direction").addDropdown((dd) => {
      (Object.keys(LOAN_DIRECTION_LABELS) as LoanDirection[]).forEach((d) =>
        dd.addOption(d, LOAN_DIRECTION_LABELS[d])
      );
      dd.setValue(this.direction);
      dd.onChange((v) => (this.direction = v as LoanDirection));
    });

    new Setting(el).setName("Counterparty").addText((t) => {
      t.setValue(this.counterparty);
      t.setPlaceholder("Person or entity");
      t.onChange((v) => (this.counterparty = v));
    });

    new Setting(el).setName("Principal amount").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.setAttr("min", "0");
      t.inputEl.setAttr("step", "0.01");
      if (this.principal != null) t.setValue(String(this.principal));
      t.onChange((v) => (this.principal = v === "" ? null : parseFloat(v)));
    });

    const accts = this.plugin.settings.accounts.filter((a) => a.active || a.id === this.account);
    new Setting(el)
      .setName("Account")
      .setDesc("Cash account the principal moves from (lent) / into (borrowed).")
      .addDropdown((dd) => {
        dd.addOption("", "(none)");
        accts.forEach((a) => dd.addOption(a.id, a.name));
        dd.setValue(this.account);
        dd.onChange((v) => (this.account = v));
      });

    new Setting(el).setName("Date").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(this.date);
      t.onChange((v) => (this.date = v));
    });

    new Setting(el).setName("Interest rate % (optional)").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.setAttr("step", "0.01");
      if (this.interestRate != null) t.setValue(String(this.interestRate));
      t.setPlaceholder("Annual %");
      t.onChange((v) => (this.interestRate = v === "" ? null : parseFloat(v)));
    });

    new Setting(el).setName("Due / reminder date (optional)").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(this.dueDate);
      t.onChange((v) => (this.dueDate = v));
    });

    new Setting(el).setName("Note").addText((t) => {
      t.setValue(this.note);
      t.setPlaceholder("Optional");
      t.onChange((v) => (this.note = v));
    });

    const actions = el.createDiv("ft-modal-actions");
    const save = actions.createEl("button", {
      text: this.editingId ? "Save loan" : "Add loan",
      cls: "mod-cta",
    });
    save.onclick = () => this.saveLoan();
    if (this.editingId) {
      const nw = actions.createEl("button", { text: "New" });
      nw.onclick = () => {
        this.resetForm();
        this.renderForm();
      };
    }

    if (this.editingId) this.renderRepayments(el);
  }

  private renderRepayments(el: HTMLElement) {
    const loan = this.plugin.store.getLoans().find((l) => l.id === this.editingId);
    if (!loan) return;

    el.createEl("h3", { text: "Repayments" });
    const outstanding = loanOutstanding(loan);
    el.createDiv({
      cls: "setting-item-description",
      text: `Outstanding principal: ${formatCurrency(outstanding, this.plugin.settings)} · Interest so far: ${formatCurrency(
        loanInterestTotal(loan),
        this.plugin.settings
      )}`,
    });

    if (loan.repayments.length > 0) {
      const table = el.createEl("table", { cls: "ft-table" });
      const hr = table.createEl("thead").createEl("tr");
      ["Date", "Principal", "Interest", "Account", ""].forEach((h) => hr.createEl("th", { text: h }));
      const tbody = table.createEl("tbody");
      for (const r of loan.repayments) {
        const tr = tbody.createEl("tr");
        tr.createEl("td", { text: r.date });
        tr.createEl("td", { text: formatCurrency(r.principal, this.plugin.settings) }).addClass("ft-amount");
        tr.createEl("td", { text: formatCurrency(r.interest, this.plugin.settings) }).addClass("ft-amount");
        tr.createEl("td", { text: this.accountName(r.account || loan.account) });
        const del = tr.createEl("td").createEl("button", { text: "🗑", cls: "ft-icon-btn" });
        del.onclick = async () => {
          await this.plugin.store.removeRepayment(loan.id, r.id);
          this.renderForm();
          this.renderList();
          this.onChanged();
        };
      }
    }

    // add-repayment form
    let rpDate = todayISO();
    let rpPrincipal: number | null = outstanding > 0 ? outstanding : null;
    let rpInterest: number | null = null;
    let rpAccount = loan.account ?? "";

    const wrap = el.createDiv("ft-repay-form");
    new Setting(wrap).setName("Repayment date").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(rpDate);
      t.onChange((v) => (rpDate = v));
    });
    new Setting(wrap).setName("Principal").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.setAttr("min", "0");
      t.inputEl.setAttr("step", "0.01");
      if (rpPrincipal != null) t.setValue(String(rpPrincipal));
      t.onChange((v) => (rpPrincipal = v === "" ? null : parseFloat(v)));
    });
    new Setting(wrap).setName("Interest").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.setAttr("min", "0");
      t.inputEl.setAttr("step", "0.01");
      t.setPlaceholder("0");
      t.onChange((v) => (rpInterest = v === "" ? null : parseFloat(v)));
    });
    const accts = this.plugin.settings.accounts.filter((a) => a.active || a.id === rpAccount);
    new Setting(wrap).setName("Account").addDropdown((dd) => {
      dd.addOption("", "(none)");
      accts.forEach((a) => dd.addOption(a.id, a.name));
      dd.setValue(rpAccount);
      dd.onChange((v) => (rpAccount = v));
    });
    const addBtn = wrap.createEl("button", { text: "Add repayment", cls: "mod-cta" });
    addBtn.onclick = async () => {
      const p = rpPrincipal ?? 0;
      const i = rpInterest ?? 0;
      if (p <= 0 && i <= 0) {
        new Notice("Enter a principal and/or interest amount.");
        return;
      }
      await this.plugin.store.addRepayment(loan.id, {
        date: rpDate || todayISO(),
        principal: Math.abs(p),
        interest: Math.abs(i),
        account: rpAccount || undefined,
      });
      this.renderForm();
      this.renderList();
      this.onChanged();
      new Notice("Repayment recorded.");
    };
  }

  private async saveLoan() {
    if (!this.counterparty.trim()) {
      new Notice("Please enter a counterparty.");
      return;
    }
    if (this.principal == null || isNaN(this.principal) || this.principal <= 0) {
      new Notice("Please enter a valid principal amount.");
      return;
    }
    const payload = {
      counterparty: this.counterparty.trim(),
      direction: this.direction,
      principal: Math.abs(this.principal),
      date: this.date || todayISO(),
      interestRate: this.interestRate ?? undefined,
      dueDate: this.dueDate || undefined,
      account: this.account || undefined,
      note: this.note.trim() || undefined,
    };
    if (this.editingId) {
      await this.plugin.store.updateLoan(this.editingId, payload);
      new Notice("Loan updated.");
    } else {
      const created = await this.plugin.store.addLoan(payload);
      this.editingId = created.id; // keep editing so repayments can be added
      new Notice("Loan added.");
    }
    this.renderList();
    this.renderForm();
    this.onChanged();
  }

  onClose() {
    this.contentEl.empty();
  }
}
