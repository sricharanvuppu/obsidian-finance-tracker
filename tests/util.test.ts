/* Unit tests for the pure calc engine in src/util.ts. Run with: npm test */
import {
  computeBalances,
  cashTotal,
  netWorth,
  totalReceivable,
  totalPayable,
  loanOutstanding,
  loanInterestTotal,
  lendingNetCashInRange,
  interestEarnedInRange,
  dueOccurrences,
  advanceDate,
  transactionsToCSV,
  parseTransactionsCSV,
  sumByType,
  monthKey,
  dateTimeKey,
  computeRange,
  inRange,
} from "../src/util";

let passed = 0;
let failed = 0;
function eq(name: string, actual: any, expected: any) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL: ${name}\n   expected ${e}\n   got      ${a}`); }
}
function ok(name: string, cond: boolean) {
  if (cond) passed++; else { failed++; console.error(`FAIL: ${name}`); }
}

const accounts = [
  { id: "bank", name: "Bank", initialBalance: 100000, active: true },
  { id: "cash", name: "Cash", initialBalance: 5000, active: true },
];
const S = { currency: "INR", locale: "en-IN" } as any;

// ── balances ──
{
  const txns: any[] = [
    { id: "1", date: "2026-07-01", type: "income", category: "Salary", subcategory: "", amount: 50000, note: "", account: "bank" },
    { id: "2", date: "2026-07-02", type: "expense", category: "Food", subcategory: "", amount: 2000, note: "", account: "cash" },
    { id: "3", date: "2026-07-03", type: "investment", category: "MF", subcategory: "", amount: 10000, note: "", account: "bank" },
    { id: "4", date: "2026-07-04", type: "transfer", category: "Transfer", subcategory: "", amount: 3000, note: "", account: "bank", toAccount: "cash" },
  ];
  const bal = computeBalances(accounts, txns);
  eq("bank balance", bal.find((b) => b.account.id === "bank")!.balance, 100000 + 50000 - 10000 - 3000);
  eq("cash balance", bal.find((b) => b.account.id === "cash")!.balance, 5000 - 2000 + 3000);
  eq("cash total (transfers net zero)", cashTotal(accounts, txns), 105000 + 50000 - 2000 - 10000);
  eq("sumByType income", sumByType(txns, "income"), 50000);
  eq("sumByType expense", sumByType(txns, "expense"), 2000);
}

// ── loans + net worth ──
{
  const loans: any[] = [
    { id: "L1", counterparty: "Ravi", direction: "lent", principal: 20000, date: "2026-07-01", account: "bank",
      repayments: [{ id: "r1", date: "2026-07-20", principal: 8000, interest: 500, account: "bank" }] },
    { id: "L2", counterparty: "X", direction: "borrowed", principal: 10000, date: "2026-07-05", account: "cash", repayments: [] },
  ];
  eq("loan outstanding (lent, partial)", loanOutstanding(loans[0]), 12000);
  eq("loan interest total", loanInterestTotal(loans[0]), 500);
  eq("total receivable", totalReceivable(loans), 12000);
  eq("total payable", totalPayable(loans), 10000);
  const bal = computeBalances(accounts, [], loans);
  // bank: 100000 -20000(lent) +8500(repay) = 88500 ; cash: 5000 +10000(borrowed) = 15000
  eq("bank after loans", bal.find((b) => b.account.id === "bank")!.balance, 88500);
  eq("cash after loans", bal.find((b) => b.account.id === "cash")!.balance, 15000);
  eq("net worth", netWorth(accounts, [], loans), 88500 + 15000 + 12000 - 10000);
  const range = { from: "2026-07-01", to: "2026-07-31" };
  eq("interest earned in range", interestEarnedInRange(loans, range), 500);
  // lending net cash: -20000 + 8500 (lent) + 10000 (borrowed in) = -1500
  eq("lending net cash in range", lendingNetCashInRange(loans, range), -1500);
}

// ── recurrence ──
{
  eq("monthly backfill", dueOccurrences("2026-04-15", null, "monthly", new Date(2026, 6, 7)),
     ["2026-04-15", "2026-05-15", "2026-06-15"]);
  eq("monthly already posted", dueOccurrences("2026-04-15", "2026-06-15", "monthly", new Date(2026, 6, 7)), []);
  eq("weekly", dueOccurrences("2026-06-20", null, "weekly", new Date(2026, 6, 7)),
     ["2026-06-20", "2026-06-27", "2026-07-04"]);
  // Jan 31 + 1 month clamps to Feb 28 (2026 not leap)
  eq("month-end clamp", advanceDate(new Date(2026, 0, 31), "monthly").getDate(), 28);
}

// ── CSV round trip ──
{
  const txns: any[] = [
    { id: "1", date: "2026-07-01", time: "09:30", type: "expense", category: "Food, Dining", subcategory: "Cafe", amount: 250, note: 'said "hi"', account: "bank" },
    { id: "2", date: "2026-07-02", type: "income", category: "Salary", subcategory: "", amount: 50000, note: "", account: "bank" },
  ];
  const csv = transactionsToCSV(txns, accounts);
  ok("csv has header", csv.split("\n")[0].startsWith("date,time,type,category,sub-category,amount,account"));
  const { rows, skipped } = parseTransactionsCSV(csv);
  eq("csv parse count", rows.length, 2);
  eq("csv parse skipped", skipped, 0);
  eq("csv escaped category preserved", rows[0].category, "Food, Dining");
  eq("csv quoted note preserved", rows[0].note, 'said "hi"');
  eq("csv amount", rows[0].amount, 250);
  eq("csv account name", rows[0].accountName, "Bank");
}

// ── CSV skips bad rows ──
{
  const bad = "date,type,category,amount\nnot-a-date,expense,X,100\n2026-07-01,expense,Y,abc\n2026-07-02,expense,Z,300\n";
  const { rows, skipped } = parseTransactionsCSV(bad);
  eq("csv skips invalid", rows.length, 1);
  eq("csv skipped count", skipped, 2);
  eq("csv valid row amount", rows[0].amount, 300);
}

// ── aggregation helpers ──
{
  eq("monthKey", monthKey("2026-07-15"), "2026-07");
  eq("dateTimeKey with time", dateTimeKey({ date: "2026-07-01", time: "14:30" }), "2026-07-01T14:30");
  eq("dateTimeKey no time", dateTimeKey({ date: "2026-07-01" }), "2026-07-01T00:00");
  ok("inRange inside", inRange("2026-07-15", { from: "2026-07-01", to: "2026-07-31" }));
  ok("inRange outside", !inRange("2026-08-01", { from: "2026-07-01", to: "2026-07-31" }));
  const r = computeRange("this-year", []);
  ok("computeRange this-year spans year", r.from.endsWith("-01-01") && r.to.endsWith("-12-31"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
