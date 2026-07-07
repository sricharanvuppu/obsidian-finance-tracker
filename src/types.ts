/** Types that use categories. */
export type CategoryType = "income" | "expense" | "investment";
/** All transaction types (transfer moves money between accounts). */
export type TxnType = CategoryType | "transfer";

export const CATEGORY_TYPES: CategoryType[] = ["income", "expense", "investment"];

export interface Account {
  id: string;
  name: string;
  initialBalance: number;
  active: boolean;
}

export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD
  type: TxnType;
  category: string;
  subcategory: string;
  amount: number; // always stored as a positive number
  note: string;
  account?: string; // account id (source account for income/expense/investment/transfer-from)
  toAccount?: string; // account id, only for transfers (destination)
  recurringId?: string; // set when auto-generated from a recurring rule
}

export interface FinanceData {
  version: number;
  transactions: Transaction[];
  loans: Loan[];
}

export type LoanDirection = "lent" | "borrowed";

export const LOAN_DIRECTION_LABELS: Record<LoanDirection, string> = {
  lent: "Lent (they owe me)",
  borrowed: "Borrowed (I owe them)",
};

export interface Repayment {
  id: string;
  date: string; // YYYY-MM-DD
  principal: number; // principal portion of this repayment
  interest: number; // interest portion of this repayment
  account?: string; // cash account the money moved to/from
  note?: string;
}

export interface Loan {
  id: string;
  counterparty: string; // person/entity
  direction: LoanDirection;
  principal: number; // original amount lent/borrowed
  date: string; // date lent/borrowed (YYYY-MM-DD)
  interestRate?: number; // agreed annual % (informational)
  dueDate?: string; // expected settlement / reminder date
  account?: string; // cash account the principal moved from/to
  note?: string;
  repayments: Repayment[];
}

export type Frequency = "weekly" | "monthly" | "yearly";

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

export interface RecurringRule {
  id: string;
  type: CategoryType;
  category: string;
  subcategory: string;
  amount: number;
  note: string;
  account?: string; // account id to post into/from
  frequency: Frequency;
  startDate: string; // YYYY-MM-DD, first occurrence
  lastPosted: string | null; // last date materialized, null if never
  active: boolean;
}

/** Expense category -> monthly budget amount. */
export type BudgetMap = Record<string, number>;

/** Category -> list of sub-categories, kept per transaction type. */
export type CategoryMap = Record<string, string[]>;

export interface CategoryConfig {
  income: CategoryMap;
  expense: CategoryMap;
  investment: CategoryMap;
}

export interface FinanceSettings {
  dataFilePath: string;
  currency: string;
  locale: string;
  categories: CategoryConfig;
  recurring: RecurringRule[];
  budgets: BudgetMap;
  accounts: Account[];
}

export const TYPE_LABELS: Record<TxnType, string> = {
  income: "Income",
  expense: "Expense",
  investment: "Investment",
  transfer: "Transfer",
};

export const DEFAULT_CATEGORIES: CategoryConfig = {
  income: {
    Salary: ["Monthly Salary", "Bonus", "Reimbursement"],
    Refunds: ["Purchase Refund", "Tax Refund", "Cashback"],
    "Mutual Funds Withdrawal": ["Redemption", "Dividend"],
    Interest: ["Savings Account", "Fixed Deposit", "Bonds"],
    Other: ["Gift", "Misc"],
  },
  expense: {
    Groceries: ["Vegetables", "Fruits", "Provisions", "Dairy", "Meat"],
    "Home Rent": ["Monthly Rent"],
    Mortgage: ["EMI", "Principal", "Interest"],
    "Utility Bills": ["Electricity", "Water", "Gas", "Internet", "Mobile", "DTH"],
    "Home Maintenance": ["Repairs", "Cleaning", "Society Fees", "Appliances"],
    Vehicle: ["Petrol", "Servicing", "Insurance", "Parking", "Toll"],
    "Food & Dining": ["Restaurants", "Food Delivery", "Cafe"],
    Health: ["Medicines", "Doctor", "Insurance", "Gym"],
    Shopping: ["Clothing", "Electronics", "Household"],
    Entertainment: ["Subscriptions", "Movies", "Events"],
    Travel: ["Flights", "Hotels", "Cabs", "Train"],
    Other: ["Misc"],
  },
  investment: {
    "Mutual Funds": ["SIP", "Lumpsum"],
    Stocks: ["Equity", "ETF"],
    "Fixed Deposit": ["New FD", "Recurring Deposit"],
    Gold: ["Physical", "Digital", "Sovereign Gold Bond"],
    "Retirement": ["PPF", "NPS", "EPF"],
    Other: ["Real Estate", "Crypto", "Misc"],
  },
};

export const DEFAULT_SETTINGS: FinanceSettings = {
  dataFilePath: "_finance/finance-data.json",
  currency: "INR",
  locale: "en-IN",
  categories: DEFAULT_CATEGORIES,
  recurring: [],
  budgets: {},
  accounts: [],
};
