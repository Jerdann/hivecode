export interface Tally { counts: number[]; reject: number; yes: number; total: number }
export interface Rules { min_votes: number; approve_pct: number }

// choice is an option index, or -1 for "reject".
export function tally(votes: { choice: number }[], options: number): Tally {
  const counts = new Array<number>(options).fill(0);
  let reject = 0;
  for (const { choice } of votes) {
    if (choice < 0) reject++;
    else if (choice < options) counts[choice]++;
  }
  const yes = counts.reduce((a, b) => a + b, 0);
  return { counts, reject, yes, total: yes + reject };
}

// approve_pct 0 means simple majority. With a vote minimum set, an idea passes the moment it
// clears both bars; without one, nothing is decided until the window closes.
export function verdict(t: Tally, r: Rules, closed: boolean): 'pass' | 'fail' | 'open' {
  const yesOk = r.approve_pct ? t.yes * 100 >= r.approve_pct * t.total : t.yes > t.reject;
  const pass = t.total > 0 && t.total >= r.min_votes && yesOk;
  if (pass && (closed || r.min_votes > 0)) return 'pass';
  return closed ? 'fail' : 'open';
}

// Most votes wins; ties go to the earlier option.
export const winner = (counts: number[]) => counts.indexOf(Math.max(...counts));
