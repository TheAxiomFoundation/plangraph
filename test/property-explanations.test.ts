import { describe, it } from "vitest";
import { BROAD, EVERY_CARRIER_BINDS } from "./property/arbitraries";
import { clauseHolds } from "./property/clauses";
import { checkSchedule } from "./property/oracle";
import { TIMEOUT, expectCoverage } from "./property/run";

// P2, explanations: every start names the constraint that bound it (README: "why is this late"
// is an output), for scheduled items and for items beyond the horizon. The oracle recomputes
// the binding from the documented rules and replays leveling's search month by month, so it
// knows which months fit and which carrier was short at each.
//
// For an item beyond the horizon the documented reasons are, in order: a predecessor that never
// finishes; the horizon, when the run is longer than the months left after its readiness (the
// time cause); or else, when leveling pushed it out, the seat that last had no room. So the
// horizon binds exactly when the time cause holds. P2.binding holds one direction (time cause
// => horizon) and the capacity binding otherwise; P2.beyond-label holds the other (horizon =>
// time cause) as its own clause, since that is the label W104 turns into "its run would extend
// past the horizon". Concrete cases of both live in test/schedule-audit.test.ts (D1) and
// test/underway-beyond.test.ts. A leveled move or a capacity beyond is a hire binding when the
// carrier short of room had nobody hired yet; P2.hire checks what that promises, and
// test/hire-wait.test.ts has the concrete cases.

describe("P2 explanations, replayed against an independent oracle", () => {
  it("P2.binding: every binding names what bound the start, and for an item beyond the horizon, why it never fits", () => {
    // Scheduled: declared; else the first predecessor, in id order, with the latest readiness;
    // underway; or, when leveling moved it, a carrier short of room a month before the start
    // with the largest shortfall there, and a seat of the item that lands on it. Beyond the
    // horizon: the first beyond predecessor; the horizon when the time cause holds; else the
    // same capacity rule at the last start leveling tried and found short of room.
    const broad = clauseHolds("P2.binding", BROAD, checkSchedule);
    expectCoverage("a planned item leveling moved", broad.hits.leveledMoves, broad.runs, 0.03);
    expectCoverage("an item leveling kept beyond the horizon", broad.hits.beyondByCapacity, broad.runs, 0.08);
    expectCoverage("an item beyond the horizon after its predecessor", broad.hits.beyondByPredecessor, broad.runs, 0.13);
    expectCoverage("an item beyond the horizon for lack of time", broad.hits.beyondByTime, broad.runs, 0.2);
    // Where every internal carrier binds, leveling moves more, so capacity bindings get more cases.
    const every = clauseHolds("P2.binding", EVERY_CARRIER_BINDS, checkSchedule, true);
    expectCoverage("a planned item leveling moved", every.hits.leveledMoves, every.runs, 0.07);
    expectCoverage("an item leveling kept beyond the horizon", every.hits.beyondByCapacity, every.runs, 0.18);
  }, TIMEOUT);

  it("P2.earliest: no scheduled item could have started earlier: as planned it starts when ready, and leveled no earlier month from its readiness fits", () => {
    const broad = clauseHolds("P2.earliest", BROAD, checkSchedule);
    expectCoverage("a planned item leveling moved", broad.hits.leveledMoves, broad.runs, 0.03);
    const every = clauseHolds("P2.earliest", EVERY_CARRIER_BINDS, checkSchedule, true);
    expectCoverage("a planned item leveling moved", every.hits.leveledMoves, every.runs, 0.07);
  }, TIMEOUT);

  it("P2.complete: leveling puts an item beyond the horizon only when no start from its readiness fits", () => {
    const broad = clauseHolds("P2.complete", BROAD, checkSchedule);
    expectCoverage("an item leveling kept beyond the horizon", broad.hits.beyondByCapacity, broad.runs, 0.08);
    const every = clauseHolds("P2.complete", EVERY_CARRIER_BINDS, checkSchedule, true);
    expectCoverage("an item leveling kept beyond the horizon", every.hits.beyondByCapacity, every.runs, 0.18);
  }, TIMEOUT);

  it("P2.hire: a hire binding keeps its promise, scheduled or beyond the horizon", () => {
    // A leveled move or a capacity beyond is a hire, not a capacity, binding when, in the first
    // short month of the last start refused, the carrier shortest of room had nobody hired and
    // the item asked something of it (P2.binding checks the kind). Then nobody on the named
    // seat's fallback chain is hired by that month; for a scheduled item the first of them is
    // hired the month after it, at or after the start, and beyond the horizon none is hired in
    // time for the last month the run could start. W104's hire text says exactly this.
    const broad = clauseHolds("P2.hire", BROAD, checkSchedule);
    expectCoverage("a planned item leveling held for a hire", broad.hits.hireWaits, broad.runs, 0.02);
    expectCoverage("an item leveling kept beyond the horizon waiting for a hire", broad.hits.hireTooLate, broad.runs, 0.06);
    const every = clauseHolds("P2.hire", EVERY_CARRIER_BINDS, checkSchedule, true);
    expectCoverage("a planned item leveling held for a hire", every.hits.hireWaits, every.runs, 0.04);
    expectCoverage("an item leveling kept beyond the horizon waiting for a hire", every.hits.hireTooLate, every.runs, 0.13);
  }, TIMEOUT);

  it("P2.beyond-label: an item that capacity, not time, kept beyond the horizon is never labelled with the horizon", () => {
    const broad = clauseHolds("P2.beyond-label", BROAD, checkSchedule);
    expectCoverage("an item leveling kept beyond the horizon", broad.hits.beyondByCapacity, broad.runs, 0.08);
    const every = clauseHolds("P2.beyond-label", EVERY_CARRIER_BINDS, checkSchedule, true);
    expectCoverage("an item leveling kept beyond the horizon", every.hits.beyondByCapacity, every.runs, 0.18);
  }, TIMEOUT);
});
