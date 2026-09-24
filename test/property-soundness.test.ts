import { describe, it } from "vitest";
import { BROAD, EVERY_CARRIER_BINDS } from "./property/arbitraries";
import { clauseHolds, type Check } from "./property/clauses";
import { checkFinalCapacity, checkMovable, checkSchedule } from "./property/oracle";
import { TIMEOUT, expectCoverage } from "./property/run";

// P1, soundness: every schedule the engine produces obeys the documented rules. Each clause is
// checked by replaying the schedule against an independent oracle (test/property/oracle.ts)
// over generated plans with every feature on: fallbacks, leadership seats, underway and
// standing work, profiles, priorities, lags, two circles, levelOn, and every scenario knob.
// A clause that fails prints its own shrunk counterexample.

const replay: Check = checkSchedule;

describe("P1 soundness, replayed against an independent oracle", () => {
  it("P1.order: items book contiguously, underway items first, then planned items in priority order with predecessors pulled ahead", () => {
    const { runs, hits } = clauseHolds("P1.order", BROAD, replay);
    expectCoverage("an underway item", hits.underway, runs, 0.15);
    expectCoverage("a planned item with a predecessor", hits.withPredecessor, runs, 0.06);
  }, TIMEOUT);

  it("P1.hires: the schedule's hires and hire indices are the plan's after the scenario's drops and delays", () => {
    const { runs, hits } = clauseHolds("P1.hires", BROAD, replay);
    expectCoverage("a scenario that drops or delays a hire", hits.hiresChanged, runs, 0.3);
  }, TIMEOUT);

  it("P1.declared: no item starts before its declared month, and an underway item starts exactly there", () => {
    const { runs, hits } = clauseHolds("P1.declared", BROAD, replay);
    expectCoverage("an underway item", hits.underway, runs, 0.15);
  }, TIMEOUT);

  it("P1.pred: a planned item starts no earlier than each predecessor's end plus lag, or a standing predecessor's start plus one", () => {
    const { runs, hits } = clauseHolds("P1.pred", BROAD, replay);
    expectCoverage("a planned item with a predecessor", hits.withPredecessor, runs, 0.06);
    expectCoverage("a standing predecessor", hits.standingPredecessor, runs, 0.015);
  }, TIMEOUT);

  it("P1.horizon: durations and ends follow the documented rule, and no finite run passes the horizon", () => {
    const { runs, hits } = clauseHolds("P1.horizon", BROAD, replay);
    expectCoverage("an item beyond the horizon for lack of time", hits.beyondByTime, runs, 0.2);
  }, TIMEOUT);

  it("P1.beyond: an item beyond the horizon or dropped books nothing, and only leveling or a time cause puts an item beyond", () => {
    const { runs, hits } = clauseHolds("P1.beyond", BROAD, replay);
    expectCoverage("an item beyond the horizon for lack of time", hits.beyondByTime, runs, 0.2);
    expectCoverage("an item leveling kept beyond the horizon", hits.beyondByCapacity, runs, 0.08);
    expectCoverage("an item beyond the horizon after its predecessor", hits.beyondByPredecessor, runs, 0.13);
    expectCoverage("a dropped item", hits.dropped, runs, 0.1);
  }, TIMEOUT);

  it("P1.bookings: an item's bookings are exactly its demands, month by month, on the carrier of that month", () => {
    const { runs, hits } = clauseHolds("P1.bookings", BROAD, replay);
    expectCoverage("a booking carried by a fallback seat", hits.fallbackBookings, runs, 0.05);
    expectCoverage("a booking carried externally", hits.externalBookings, runs, 0.08);
  }, TIMEOUT);

  it("P1.cap-asbooked: when leveling, each planned item had room on every carrier it waits for when it was booked", () => {
    // Near-tautological by construction: the oracle's binds(), which decides the carriers an
    // item waits for, is copied from the engine's fits(). This clause catches a booking that
    // ignores the rule's verdict or counts load wrongly, not a wrong rule. The two clauses
    // below check capacity without going through binds().
    const { runs, hits } = clauseHolds("P1.cap-asbooked", BROAD, replay);
    expectCoverage("a planned item leveling moved", hits.leveledMoves, runs, 0.03);
  }, TIMEOUT);

  it("P1.movable: when every internal carrier binds, demand minus fixed load never exceeds capacity", () => {
    // The final-state invariant test/engine.test.ts asserts: leveling cannot move fixed load
    // (underway work, and work carried for an unhired seat), but everything else fits.
    const check: Check = (plan, sc, S) => ({ violations: checkMovable(plan, sc, S), coverage: checkSchedule(plan, sc, S).coverage });
    const { runs, hits } = clauseHolds("P1.movable", EVERY_CARRIER_BINDS, check, true);
    expectCoverage("a planned item leveling moved", hits.leveledMoves, runs, 0.07);
  }, TIMEOUT);

  it("P1.cap-final: when every internal carrier binds, no leveled planned item runs on a carrier in a month that ends over capacity", () => {
    // Stronger than P1.movable: the load booked after a planned item cannot overload a month it
    // occupies either. It held only once underway work booked first; before that, underway work
    // booked in priority order could land on top of planned work leveling had already placed.
    const check: Check = (plan, sc, S) => ({ violations: checkFinalCapacity(plan, sc, S), coverage: checkSchedule(plan, sc, S).coverage });
    const { runs, hits } = clauseHolds("P1.cap-final", EVERY_CARRIER_BINDS, check, true);
    expectCoverage("a planned item held back by underway load", hits.heldByUnderway, runs, 0.05);
  }, TIMEOUT);
});
