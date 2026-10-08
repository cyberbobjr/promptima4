// Time source for blinking and idle animations. Tests (?seed=N) switch to a manual clock that
// only moves with the game ticks (window.__tick), so screenshots do not depend on timing.
let manual: number | null = null;

export const now = (): number => manual ?? performance.now();

export function useManualClock(): void { manual = 0; }

/** True under the test driver's manual clock (?seed=N). */
export const isManualClock = (): boolean => manual !== null;

/** Advances the manual clock (no effect on the real one). */
export function advanceClock(ms: number): void { if (manual !== null) manual += ms; }
