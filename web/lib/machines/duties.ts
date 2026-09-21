/**
 * THE DUTY CLOCK: what a maker owes, when it is due, and what met it.
 *
 * WHY THIS EXISTS AS CODE RATHER THAN AS A POLICY DOCUMENT. Since 11 September 2026 the
 * EU Cyber Resilience Act expects a manufacturer that becomes aware of an actively
 * exploited vulnerability in a product with digital elements to report it, and the
 * reporting is on a clock measured from AWARENESS. A manufacturer that discovers this
 * at month end, while reading a spreadsheet, has already missed it. A row that knows
 * the instant awareness began and computes what is owed from that instant cannot miss
 * it, and the same row is public, so a customer can hold the maker to what it published.
 *
 * WHAT THIS IS NOT. It is not legal advice, it is not a certification, and it does not
 * tell anybody whether their product is in scope of the CRA. It is a clock over the
 * facts a maker entered, and every surface that shows it says exactly that. The
 * paragraph lengths below are the ones the Regulation states for the two categories it
 * distinguishes; a maker with a lawyer will have more obligations, not fewer.
 *
 * WHY THE DUTIES ARE DERIVED RATHER THAN TYPED. A duty recorded by hand is a duty
 * somebody can forget to record. Every duty here is computed from `first_aware_at`, the
 * instant awareness began, which is the one fact only the maker can supply.
 */

export type DutyName = "early_warning" | "notification" | "final_report" | "fix";

export const DUTY_LABELS: Record<DutyName, string> = {
  early_warning: "Early warning to the authority",
  notification: "Vulnerability notification",
  final_report: "Final report",
  fix: "Fix published",
};

/** The Regulation's paragraphs, in hours or days from the moment of awareness. */
export const CRA_PARAGRAPHS = {
  /** Actively exploited vulnerability in a product with digital elements. */
  vulnerability: { early_warning_hours: 24, notification_hours: 72, final_report_days: 14 },
  /** Severe incident having an impact on the security of the product. */
  severe_incident: { early_warning_hours: 24, notification_hours: 72, final_report_days: 30 },
} as const;

export type Vulnerability = {
  id: string;
  advisory_id: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  kind: "vulnerability" | "severe_incident";
  actively_exploited: boolean;
  state: "open" | "fixing" | "fixed" | "wontfix";
  first_aware_at: string;
  closed_at: string | null;
  fixed_in?: string | null;
};

export type DutyRow = {
  duty: DutyName;
  due_at: string;
  met_at: string | null;
  met_by: string | null;
  note?: string | null;
};

export type DutyState = "met" | "due" | "overdue";

export type DutyView = {
  duty: DutyName;
  label: string;
  dueAt: string;
  metAt: string | null;
  metBy: string | null;
  state: DutyState;
  /** How long is left, or how long ago it lapsed. Negative is late. */
  msRemaining: number;
  /** True when the duty only exists because the exploitation is active. */
  because: string;
};

/**
 * The duties an advisory owes, from its own facts.
 *
 * The short clock applies to an actively exploited vulnerability. A severe incident
 * carries the longer final report window. A vulnerability that is not known to be
 * exploited still owes the notification and the final report, because the paragraph
 * that sets them covers vulnerabilities generally, and it is not owed an early warning
 * about active exploitation because there is none to warn about.
 */
export function dutiesFor(v: Pick<Vulnerability, "kind" | "actively_exploited" | "first_aware_at">): { duty: DutyName; due_at: string; because: string }[] {
  const aware = Date.parse(v.first_aware_at);
  if (!Number.isFinite(aware)) return [];
  const paragraph = v.kind === "severe_incident" ? CRA_PARAGRAPHS.severe_incident : CRA_PARAGRAPHS.vulnerability;
  const out: { duty: DutyName; due_at: string; because: string }[] = [];

  if (v.actively_exploited) {
    out.push({
      duty: "early_warning",
      due_at: new Date(aware + paragraph.early_warning_hours * 3_600_000).toISOString(),
      because: `the vulnerability is known to be actively exploited, so the early warning is owed within ${paragraph.early_warning_hours} hours of awareness`,
    });
  }
  out.push({
    duty: "notification",
    due_at: new Date(aware + paragraph.notification_hours * 3_600_000).toISOString(),
    because: `a ${v.kind === "severe_incident" ? "severe incident" : "vulnerability"} is notified within ${paragraph.notification_hours} hours of awareness`,
  });
  out.push({
    duty: "final_report",
    due_at: new Date(aware + paragraph.final_report_days * 86_400_000).toISOString(),
    because: `the final report is owed inside ${paragraph.final_report_days} days of awareness`,
  });
  out.push({
    duty: "fix",
    due_at: new Date(aware + (v.kind === "severe_incident" ? paragraph.final_report_days : CRA_PARAGRAPHS.vulnerability.final_report_days) * 86_400_000).toISOString(),
    because: "the fix is not a regulatory paragraph but it is the only duty the operators of the hardware actually feel, so it is on the same clock as the final report",
  });
  return out;
}

/** Fold duties and their rows into a view with the clock applied. */
export function dutyViews(input: { vulnerability: Vulnerability; rows: DutyRow[]; nowMs: number }): DutyView[] {
  const owed = dutiesFor(input.vulnerability);
  const byDuty = new Map(input.rows.map((r) => [r.duty, r]));
  return owed.map((o) => {
    const row = byDuty.get(o.duty);
    const due = row?.due_at ?? o.due_at;
    const dueMs = Date.parse(due);
    const met = row?.met_at ?? null;
    const state: DutyState = met ? "met" : Number.isFinite(dueMs) && input.nowMs > dueMs ? "overdue" : "due";
    return {
      duty: o.duty,
      label: DUTY_LABELS[o.duty],
      dueAt: due,
      metAt: met,
      metBy: row?.met_by ?? null,
      state,
      msRemaining: Number.isFinite(dueMs) ? dueMs - input.nowMs : Number.POSITIVE_INFINITY,
      because: o.because,
    };
  });
}

/** What is overdue right now, worst first. A pure read of the same clock the page shows. */
export function overdueDuties(views: DutyView[]): DutyView[] {
  return views.filter((v) => v.state === "overdue").sort((a, b) => a.msRemaining - b.msRemaining);
}

/** What is owed next, soonest first, ignoring the ones already met. */
export function nextDuties(views: DutyView[], limit = 3): DutyView[] {
  return views
    .filter((v) => v.state !== "met")
    .sort((a, b) => a.msRemaining - b.msRemaining)
    .slice(0, limit);
}

/**
 * The shapes a citation may take, and why it has to be one of them.
 *
 * A length check is not a rule: "we told them" is a sentence that passes any minimum
 * and names nothing. A reader has to be able to go somewhere with this string, so it is
 * either a URL or a reference to a row, and the accepted prefixes are the closed set of
 * things that actually exist on this platform. Anything else is prose, and prose is what
 * the record exists to replace.
 */
export const EVIDENCE_SHAPES: string[] = [
  "https://...",
  "advisory:<id>",
  "event:<id>",
  "release:<id>",
  "reading:<id>",
  "audit:<id>",
  "task:<id>",
  "cve:<CVE id>",
  "ghsa:<id>",
  "sha256:<hex>",
  "file:<path>",
];

const CITATION = /^(https?:\/\/\S{4,}|(advisory|event|release|reading|audit|task|cve|ghsa|sha256|file|report|row|commit|doc):\S{3,})$/i;

/** Whether a string is a citation a reader can follow, rather than a sentence. */
export function isCitation(value: unknown): boolean {
  const s = typeof value === "string" ? value.trim() : "";
  return s.length >= 8 && CITATION.test(s);
}

/**
 * Whether a duty may be marked met, and why not when it may not.
 *
 * The evidence rule is the whole point: a duty marked met without a citation is a
 * timeline entry nobody can check, and the timeline is the only part of this that a
 * regulator or a customer would ever read. A "fix" duty additionally needs the version
 * it landed in, because "fixed" without a version is not something a fleet can act on.
 */
export function mayMarkMet(input: {
  duty: DutyName;
  evidence: unknown;
  fixedIn?: unknown;
  vulnerabilityState: Vulnerability["state"];
}): { ok: true } | { ok: false; reason: string } {
  const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
  if (!isCitation(evidence)) {
    return {
      ok: false,
      reason: `Give the evidence as a citation a reader can follow, not a sentence: ${EVIDENCE_SHAPES.join(", ")}. A duty marked met without one is a claim nobody can check, and the timeline is the only part of this a customer would ever read.`,
    };
  }
  if (input.duty === "fix") {
    const fixedIn = typeof input.fixedIn === "string" ? input.fixedIn.trim() : "";
    if (!fixedIn) {
      return { ok: false, reason: "A fix names the version it landed in. \"Fixed\" without a version is not something a fleet can act on." };
    }
    if (input.vulnerabilityState !== "fixed") {
      return { ok: false, reason: "Mark the advisory fixed before marking the fix duty met, so the two cannot disagree." };
    }
  }
  return { ok: true };
}

/** A one line summary of where an advisory stands, for a feed row or a page. */
export function vulnerabilitySummary(v: Vulnerability, views: DutyView[]): string {
  const late = overdueDuties(views);
  if (v.state === "fixed") return `${v.advisory_id} fixed${v.fixed_in ? ` in ${v.fixed_in}` : ""}: ${v.title}`;
  if (late.length > 0) {
    const worst = late[0];
    const hours = Math.round(Math.abs(worst.msRemaining) / 3_600_000);
    return `${v.advisory_id} is ${late.length} dut${late.length === 1 ? "y" : "ies"} late: ${worst.label} was due ${hours} hour(s) ago. ${v.title}`;
  }
  const next = nextDuties(views, 1)[0];
  return next ? `${v.advisory_id} open, next: ${next.label} due ${next.dueAt}. ${v.title}` : `${v.advisory_id} open: ${v.title}`;
}
