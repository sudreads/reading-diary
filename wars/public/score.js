// Scoring: one photo = one point. Pure functions, shared by the app and the tests.

// playerId -> { total, byCat: { catId: n }, last: ts of the latest point }
export function scores(game) {
  const out = {};
  for (const e of game.entries) {
    const s = out[e.playerId] ||= { total: 0, byCat: {}, last: 0 };
    s.total++;
    s.byCat[e.cat] = (s.byCat[e.cat] || 0) + 1;
    if (e.ts > s.last) s.last = e.ts;
  }
  return out;
}

// Everyone who is in the game (or left with points), best first. Equal counts share a place.
export function ranking(game, catId = 'all') {
  const all = scores(game);
  const rows = game.players
    .filter((p) => p.status === 'in' || all[p.id])
    .map((p) => {
      const s = all[p.id];
      return { player: p, count: s ? (catId === 'all' ? s.total : s.byCat[catId] || 0) : 0 };
    })
    .sort((a, b) => b.count - a.count || a.player.name.localeCompare(b.player.name, 'he'));
  let place = 0, prev = null;
  rows.forEach((r, i) => {
    if (r.count !== prev) { place = i + 1; prev = r.count; }
    r.place = place;
  });
  return rows;
}

// For each category: who did it the most (ties share the title).
export function categoryWinners(game) {
  return game.categories.map((cat) => {
    const rows = ranking(game, cat.id);
    const count = rows[0]?.count || 0;
    return { cat, count, winners: count ? rows.filter((r) => r.count === count).map((r) => r.player) : [] };
  });
}
