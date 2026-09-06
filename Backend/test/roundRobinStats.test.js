const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBuildStats() {
  const filename = path.resolve(__dirname, "../../Frontend/JS/RoundRobin.js");
  const source = fs.readFileSync(filename, "utf8");
  const start = source.indexOf("function parsePlayerId");
  const end = source.indexOf("function collectPairings", start);
  const helperSource = source.slice(start, end).replace("export function buildStats", "function buildStats");
  const context = vm.createContext({});
  new vm.Script(`${helperSource}\nglobalThis.buildStats = buildStats;`, { filename }).runInContext(context);
  return context.buildStats;
}

const buildStats = loadBuildStats();
const header = ["BewerbID", "Spieler1ID", "Spieler2ID", "Spieler3ID", "Spieler4ID", "Ergebnis"];

function statsFor(row) {
  return buildStats([row], header, "cup-1").stats;
}

test("Round-Robin-Statistik behaelt regulaere Ergebnisse bei", () => {
  const stats = statsFor(["cup-1", "p1", "", "p2", "", "6-4/3-6/6-2"]);

  assert.deepEqual({ ...stats.p1 }, { siege: 1, saetzeW: 2, saetzeL: 1, gamesW: 15, gamesL: 12 });
  assert.deepEqual({ ...stats.p2 }, { siege: 0, saetzeW: 1, saetzeL: 2, gamesW: 12, gamesL: 15 });
});

test("Walkover zaehlt als Sieg und synthetisches 0-6/0-6 aus Verlierersicht", () => {
  const firstTeamLoses = statsFor(["cup-1", "p1 [wo]", "", "p2", "", ""]);
  assert.deepEqual({ ...firstTeamLoses.p1 }, { siege: 0, saetzeW: 0, saetzeL: 2, gamesW: 0, gamesL: 12 });
  assert.deepEqual({ ...firstTeamLoses.p2 }, { siege: 1, saetzeW: 2, saetzeL: 0, gamesW: 12, gamesL: 0 });

  const secondTeamLoses = statsFor(["cup-1", "p1", "", "p2 [wo]", "", "1-0"]);
  assert.deepEqual({ ...secondTeamLoses.p1 }, { siege: 1, saetzeW: 2, saetzeL: 0, gamesW: 12, gamesL: 0 });
  assert.deepEqual({ ...secondTeamLoses.p2 }, { siege: 0, saetzeW: 0, saetzeL: 2, gamesW: 0, gamesL: 12 });
});

test("Retirement behaelt Games und vergibt den gefuehrten unvollstaendigen Satz", () => {
  const stats = statsFor(["cup-1", "p1 [ret]", "", "p2", "", "6-4/2-3"]);

  assert.deepEqual({ ...stats.p1 }, { siege: 0, saetzeW: 1, saetzeL: 1, gamesW: 8, gamesL: 7 });
  assert.deepEqual({ ...stats.p2 }, { siege: 1, saetzeW: 1, saetzeL: 1, gamesW: 7, gamesL: 8 });
});

test("nur exakte Marker schliessen Matches ab und Doppelpartner bleiben erhalten", () => {
  const nonExact = statsFor(["cup-1", "p1 [WO]", "", "p2", "", ""]);
  assert.deepEqual({ ...nonExact }, {});

  const doubles = statsFor(["cup-1", "p1", "p2 [ret]", "p3", "p4", "4-2"]);
  assert.deepEqual({ ...doubles.p1 }, { siege: 0, saetzeW: 1, saetzeL: 0, gamesW: 4, gamesL: 2 });
  assert.deepEqual({ ...doubles.p3 }, { siege: 1, saetzeW: 0, saetzeL: 1, gamesW: 2, gamesL: 4 });
});
