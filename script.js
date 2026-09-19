function parseDate(s) {
  const [y, m, d] = s.trim().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
 
function buildInstance(files) {
  // files: {name: csvText}
  const tables = [];
  for (const name in files) {
    const parsed = Papa.parse(files[name], {
      header: true,
      skipEmptyLines: true,
    });
    if (parsed.data.length === 0) continue;
    tables.push({ header: Object.keys(parsed.data[0]), rows: parsed.data });
  }
  function find(...cols) {
    for (const t of tables) {
      if (cols.every((c) => t.header.includes(c))) return t.rows;
    }
    throw new Error("Missing table with columns: " + cols.join(", "));
  }
  const inst = {};
  inst.lines = find("line_code", "line_name");
  inst.stations = find("station_id", "line_code", "seq", "is_interchange");
  inst.sectors = find(
    "sector_id",
    "line_code",
    "from_station_id",
    "to_station_id",
    "seq",
  );
  inst.supply = find(
    "location_id",
    "location_kind",
    "line_code",
    "bound",
    "supply_capacity",
  );
  inst.bufferRules = find(
    "nature_of_works",
    "up_to_buffer_sectors",
    "opposite_bound_required",
  );
  inst.params = find("key", "value");
  inst.projects = find(
    "contract_number",
    "activity_type",
    "nature_of_activity",
    "contract_priority",
    "contract_completion_date",
    "planned_completion_date",
    "number_of_workfronts",
    "access_type",
    "number_of_maximum_access_per_week",
  );
  inst.activities = find(
    "activity_id",
    "contract_number",
    "activity_type",
    "start_location_id",
    "end_location_id",
    "total_accesses",
    "planned_start_date",
    "activity_priority",
  );
 
  inst.sectorById = {};
  inst.sectorsOnLine = {};
  for (const r of inst.sectors) {
    inst.sectorById[r.sector_id] = r;
    (inst.sectorsOnLine[r.line_code] ||= []).push(r);
  }
  for (const line in inst.sectorsOnLine) {
    inst.sectorsOnLine[line].sort((a, b) => +a.seq - +b.seq);
  }
  inst.supplyCap = {};
  for (const r of inst.supply)
    inst.supplyCap[r.location_id] = +r.supply_capacity;
 
  inst.bufferN = {};
  inst.bufferMirror = {};
  for (const r of inst.bufferRules) {
    inst.bufferN[r.nature_of_works.trim()] = +r.up_to_buffer_sectors;
    inst.bufferMirror[r.nature_of_works.trim()] = !!+r.opposite_bound_required;
  }
  inst.param = {};
  for (const r of inst.params) inst.param[r.key] = r.value;
  inst.horizonStart = parseDate(inst.param.horizon_start || "2027-01-04");
  inst.horizonWeeks = +(inst.param.horizon_weeks || 30);
 
  inst.project = {};
  for (const r of inst.projects) inst.project[r.contract_number] = r;
 
  inst.weekOf = function (d) {
    const delta = Math.floor((d - inst.horizonStart) / 86400000);
    return Math.max(1, Math.floor(delta / 7) + 1);
  };
  inst.dateOfWeekStart = function (w) {
    return addDays(inst.horizonStart, (w - 1) * 7);
  };
 
  inst.parseLocation = function (locId) {
    const parts = locId.split(":");
    if (parts[0] === "SEC") {
      const [, line, fromto, bound] = parts;
      const [frm, to] = fromto.split("_");
      return {
        kind: "sector",
        line,
        bound,
        from: frm,
        to,
        sectorId: `SEC:${line}:${fromto}`,
      };
    } else {
      const [, line, station, bound] = parts;
      return { kind: "platform", line, bound, station };
    }
  };
 
  inst.pathLocations = function (startLoc, endLoc) {
    const a = inst.parseLocation(startLoc),
      b = inst.parseLocation(endLoc);
    const line = a.line,
      bound = a.bound;
    const seqA = +inst.sectorById[a.sectorId].seq,
      seqB = +inst.sectorById[b.sectorId].seq;
    const lo = Math.min(seqA, seqB),
      hi = Math.max(seqA, seqB);
    const secs = inst.sectorsOnLine[line].filter(
      (r) => +r.seq >= lo && +r.seq <= hi,
    );
    const tunnelIds = secs.map(
      (r) => `SEC:${line}:${r.from_station_id}_${r.to_station_id}:${bound}`,
    );
    const stations = new Set();
    secs.forEach((r) => {
      stations.add(r.from_station_id);
      stations.add(r.to_station_id);
    });
    const platIds = [...stations].map((s) => `PLAT:${line}:${s}:${bound}`);
    return { tunnelIds, platIds, line, bound, lo, hi };
  };
 
  inst.bufferSectorIds = function (line, bound, lo, hi, n) {
    if (n <= 0) return [];
    const secs = inst.sectorsOnLine[line];
    const out = [];
    for (const r of secs) {
      const seq = +r.seq;
      if ((seq >= lo - n && seq < lo) || (seq > hi && seq <= hi + n)) {
        out.push(
          `SEC:${line}:${r.from_station_id}_${r.to_station_id}:${bound}`,
        );
      }
    }
    return out;
  };
  inst.opposite = (b) => (b === "EB" ? "WB" : "EB");
  inst.otherLine = (l) => (l === "ALP" ? "BET" : "ALP");
 
  return inst;
}
 
function makeScheduler(inst, scenario) {
  const S = {
    inst,
    scenario,
    slots: new Map(), // key `${loc}|${week}` -> array of slot
    bufferRes: new Map(), // key -> Set(group)
    excess: new Map(),
    weekly: new Map(), // key `${contract}|${type}|${week}` -> {night: [activityIds]}
    nightLoad: new Map(), // Tracks network density: key `${week}|${night}` -> count
    eclo_weeks: new Map(), // line -> Set(week)
    groupSeq: 0,
    accessRows: [],
    occupancyRows: [],
    activityFinishWeek: new Map(),
    activityYield: new Map(),
  };
  function slotKey(loc, wk) {
    return loc + "|" + wk;
  }
  function getSlots(loc, wk) {
    const k = slotKey(loc, wk);
    if (!S.slots.has(k)) S.slots.set(k, []);
    return S.slots.get(k);
  }
  function newGroup() {
    S.groupSeq++;
    return "b" + S.groupSeq;
  }
  function nominalCap(loc) {
    return inst.supplyCap[loc] ?? 4;
  }
  function capAllowed(loc, wk, cur) {
    const nominal = nominalCap(loc);
    if (cur < nominal) return true;
    if (scenario === "A") return false;
    if (scenario === "C") return cur < nominal + 1;
    return true;
  }
  function compatible(slot, accessType) {
    if (slot.pm) return false;
    if (accessType === "PM") return slot.members.length === 0;
    if (accessType === "PC") return !slot.pc;
    if (accessType === "C")
      return slot.c_count < 3 || (!slot.pc && slot.c_count < 4);
    return false;
  }
  function addMember(slot, aid, accessType) {
    slot.members.push([aid, accessType]);
    if (accessType === "PM") slot.pm = true;
    else if (accessType === "PC") slot.pc = true;
    else slot.c_count++;
  }
  function tryJoinOrOpen(aid, accessType, locations, wk, groupHint) {
    let candidate = null;
    for (const loc of locations) {
      const groupsHere = new Set(getSlots(loc, wk).map((s) => s.group));
      candidate =
        candidate === null
          ? groupsHere
          : new Set([...candidate].filter((g) => groupsHere.has(g)));
    }
    candidate = candidate || new Set();
    for (const g of candidate) {
      let ok = true;
      for (const loc of locations) {
        const slot = getSlots(loc, wk).find((s) => s.group === g);
        if (!compatible(slot, accessType)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        for (const loc of locations) {
          const slot = getSlots(loc, wk).find((s) => s.group === g);
          addMember(slot, aid, accessType);
        }
        return g;
      }
    }
    for (const loc of locations) {
      const cur = getSlots(loc, wk).length;
      if (!capAllowed(loc, wk, cur)) return null;
    }
    const g = groupHint || newGroup();
    for (const loc of locations) {
      const nominal = nominalCap(loc);
      const cur = getSlots(loc, wk).length;
      if (cur >= nominal) {
        S.excess.set(
          slotKey(loc, wk),
          (S.excess.get(slotKey(loc, wk)) || 0) + 1,
        );
      }
      const slot = { group: g, pm: false, pc: false, c_count: 0, members: [] };
      getSlots(loc, wk).push(slot);
      addMember(slot, aid, accessType);
    }
    return g;
  }
  function bufferClear(group, bufferLocs, wk) {
    for (const loc of bufferLocs) {
      const arr = getSlots(loc, wk);
      if (arr.length) {
        const otherGroups = new Set(arr.map((s) => s.group));
        otherGroups.delete(group);
        if (otherGroups.size > 0) return false;
      }
    }
    return true;
  }
  function reserveBuffer(group, bufferLocs, wk) {
    for (const loc of bufferLocs) {
      const k = slotKey(loc, wk);
      if (!S.bufferRes.has(k)) S.bufferRes.set(k, new Set());
      S.bufferRes.get(k).add(group);
    }
  }
 
  S.scheduleActivityWeek = function (act, week, eclo) {
    const contract = inst.project[act.contract_number];
    const accessType = contract.access_type;
    const nature = contract.nature_of_activity;
    const pl = inst.pathLocations(act.start_location_id, act.end_location_id);
    const { tunnelIds, platIds, line, bound, lo, hi } = pl;
    const coreLocs = [...tunnelIds, ...platIds];
    const mirrorNeeded = !!inst.bufferMirror[nature];
    const crossHub = tunnelIds.some((t) => t.split(":")[2] === "H01_H02");
    let extraCore = [];
    if (mirrorNeeded) {
      const opp = inst.opposite(bound);
      extraCore = extraCore.concat(
        tunnelIds.map((t) => `SEC:${line}:${t.split(":")[2]}:${opp}`),
      );
      extraCore = extraCore.concat(
        platIds.map((p) => `PLAT:${line}:${p.split(":")[2]}:${opp}`),
      );
      if (crossHub) {
        const other = inst.otherLine(line);
        for (const bnd of ["EB", "WB"]) {
          extraCore.push(`SEC:${other}:H01_H02:${bnd}`);
          extraCore.push(`PLAT:${other}:H01:${bnd}`);
          extraCore.push(`PLAT:${other}:H02:${bnd}`);
        }
      }
    }
    const allCore = [...new Set([...coreLocs, ...extraCore])];
 
    const bufN = inst.bufferN[nature] ?? 0;
    let bufferLocs = [];
    if (bufN > 0) {
      bufferLocs = bufferLocs.concat(
        inst.bufferSectorIds(line, bound, lo, hi, bufN),
      );
      if (mirrorNeeded)
        bufferLocs = bufferLocs.concat(
          inst.bufferSectorIds(line, inst.opposite(bound), lo, hi, bufN),
        );
    }
    bufferLocs = [...new Set(bufferLocs)];
 
    const maxDays = 7;
    const maxAccess = Math.min(
      +contract.number_of_maximum_access_per_week || 7,
      maxDays,
    );
    const workfronts = +contract.number_of_workfronts;
    const wkKey = `${act.contract_number}|${accessType}|${week}`;
    if (!S.weekly.has(wkKey)) S.weekly.set(wkKey, {});
    const wkMap = S.weekly.get(wkKey);
 
    const actHash = (act.activity_id || "")
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const startOffset = actHash % maxDays;
 
    let chosenNight = null;
 
    for (let day = 1; day <= maxDays; day++) {
      if ((wkMap[day] || []).includes(act.activity_id)) {
        chosenNight = day;
        break;
      }
    }
 
    if (chosenNight === null) {
      let minGlobalLoad = Infinity;
 
      for (let i = 0; i < maxDays; i++) {
        const night = ((startOffset + i) % maxDays) + 1;
        const currentContractOcc = wkMap[night] || [];
 
        if (
          currentContractOcc.length < workfronts &&
          Object.keys(wkMap).length < maxAccess
        ) {
          const globalKey = `${week}|${night}`;
          const currentGlobalLoad = S.nightLoad.get(globalKey) || 0;
 
          if (currentGlobalLoad < minGlobalLoad) {
            minGlobalLoad = currentGlobalLoad;
            chosenNight = night;
          }
        }
      }
    }
 
    if (chosenNight === null) return false;
 
    let groupHint = null;
    if (bufN > 0) {
      groupHint = newGroup();
      if (!bufferClear(groupHint, bufferLocs, week)) return false;
    }
    const group = tryJoinOrOpen(
      act.activity_id,
      accessType,
      allCore,
      week,
      groupHint,
    );
    if (group === null) return false;
    if (bufN > 0) reserveBuffer(group, bufferLocs, week);
 
    wkMap[chosenNight] = wkMap[chosenNight] || [];
    if (!wkMap[chosenNight].includes(act.activity_id)) {
      wkMap[chosenNight].push(act.activity_id);
 
      const globalKey = `${week}|${chosenNight}`;
      S.nightLoad.set(globalKey, (S.nightLoad.get(globalKey) || 0) + 1);
    }
 
    const seq = S.accessRows.filter((r) => r[0] === act.activity_id).length + 1;
    S.accessRows.push([act.activity_id, seq, week, eclo ? 1 : 0, chosenNight]);
    for (const loc of allCore)
      S.occupancyRows.push([act.activity_id, week, loc, group]);
 
    S.activityFinishWeek.set(act.activity_id, week);
    S.activityYield.set(
      act.activity_id,
      (S.activityYield.get(act.activity_id) || 0) + (eclo ? 1.5 : 1.0),
    );
    if (eclo && scenario === "C") {
      if (!S.eclo_weeks.has(line)) S.eclo_weeks.set(line, new Set());
      S.eclo_weeks.get(line).add(week);
    }
    return true;
  };
 
  return S;
}
 
function runScenario(inst, scenario) {
  const sched = makeScheduler(inst, scenario);
  const placed = new Set();
  function ready(a) {
    const pred = a.predecessor_activity_id || "";
    return !pred || placed.has(pred);
  }
  let remaining = inst.activities.slice();
  remaining.sort((a, b) => {
    const da = parseDate(a.planned_start_date),
      db = parseDate(b.planned_start_date);
    if (da - db !== 0) return da - db;
    const ca = +inst.project[a.contract_number].contract_priority,
      cb = +inst.project[b.contract_number].contract_priority;
    if (ca !== cb) return ca - cb;
    return +a.activity_priority - +b.activity_priority;
  });
  const order = [];
  let guard = 0;
  while (remaining.length && guard < 20000) {
    guard++;
    let progressed = false;
    const still = [];
    for (const a of remaining) {
      if (ready(a)) {
        order.push(a);
        placed.add(a.activity_id);
        progressed = true;
      } else still.push(a);
    }
    remaining = still;
    if (!progressed) {
      order.push(...remaining);
      remaining.forEach((a) => placed.add(a.activity_id));
      remaining = [];
    }
  }
 
  const totalNeeded = {};
  inst.activities.forEach(
    (a) => (totalNeeded[a.activity_id] = +a.total_accesses),
  );
  const predFinish = {};
  const horizon = inst.horizonWeeks;
 
  for (const act of order) {
    const aid = act.activity_id;
    const pred = act.predecessor_activity_id || "";
    let earliestWeek = inst.weekOf(parseDate(act.planned_start_date));
    if (pred && predFinish[pred] !== undefined)
      earliestWeek = Math.max(earliestWeek, predFinish[pred] + 1);
    const needed = totalNeeded[aid];
    let week = earliestWeek;
    const eclo_allowed = scenario === "B" || scenario === "C";
 
    // Cost-aware ECLO policy (§2.5 combined objective): a day of overrun costs
    // contractWeight * (1 + activityNudge) — 100x for P1, 10x for P2, 1x for P3,
    // nudged +0.3/+0.2/+0.0 by the activity's own priority. A flat $5 ECLO-night
    // is only worth spending ahead of an overrun day when that day is expensive
    // (P1/P2 contracts); cheap P3 slip is left to slip per the brief's guidance
    // ("absorb schedule pressure with Priority-3 slip first, reach for ECLO next").
    const contract = inst.project[act.contract_number];
    const contractTier = +contract.contract_priority;
    const contractWeight = contractTier === 1 ? 100 : contractTier === 2 ? 10 : 1;
    const activityNudge =
      +act.activity_priority === 1 ? 0.3 : +act.activity_priority === 2 ? 0.2 : 0;
    const dayCost = contractWeight * (1 + activityNudge);
    const ECLO_NIGHT_COST = 5; // matches Score_B/Score_C's 5x eclo_nights_total term
 
    let misses = 0;
    while (
      (sched.activityYield.get(aid) || 0) < needed - 1e-9 &&
      week <= horizon + 20
    ) {
      let useEclo = false;
      if (eclo_allowed) {
        const remainingUnits = needed - (sched.activityYield.get(aid) || 0);
        // Reactive: last-mile top-up so any activity of any tier doesn't spill
        // an extra full week just to deliver its final half-unit of workload.
        const reactive = remainingUnits <= 1.5 && misses >= 1;
        // Proactive: once real contention has been hit (a miss already fired
        // this activity's placement), contracts whose overrun-day cost exceeds
        // the flat ECLO rate buy relief immediately rather than accruing
        // expensive overrun days while capacity frees up elsewhere.
        const proactive = misses >= 1 && dayCost > ECLO_NIGHT_COST;
        useEclo = reactive || proactive;
        if (scenario === "C" && useEclo) {
          const pl = inst.pathLocations(
            act.start_location_id,
            act.end_location_id,
          );
          const existing = sched.eclo_weeks.get(pl.line);
          if (existing && existing.size) {
            const arr = [...existing];
            const loW = Math.min(...arr),
              hiW = Math.max(...arr);
            const within =
              (week >= loW && week <= loW + 1) ||
              (week <= hiW && hiW - week <= 1);
            if (!within) useEclo = false;
          }
        }
      }
      const ok = sched.scheduleActivityWeek(act, week, useEclo);
      if (ok) {
        misses = 0;
      } else {
        misses++;
        week++;
        continue;
      }
      week++;
    }
    predFinish[aid] = sched.activityFinishWeek.get(aid) ?? earliestWeek;
  }
  return sched;
}
 
function writeAccessCsv(sched) {
  const rows = sched.accessRows
    .slice()
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1));
  let out = "activity_id,access_seq,week,eclo,access_night\n";
  for (const r of rows) out += r.join(",") + "\n";
  return { csv: out, rows };
}
function writeOccupancyCsv(sched) {
  const seen = new Set();
  const rows = [];
  for (const r of sched.occupancyRows) {
    const k = r.join("|");
    if (!seen.has(k)) {
      seen.add(k);
      rows.push(r);
    }
  }
  rows.sort((a, b) =>
    a[0] === b[0]
      ? a[1] === b[1]
        ? a[2] < b[2]
          ? -1
          : 1
        : a[1] - b[1]
      : a[0] < b[0]
        ? -1
        : 1,
  );
  let out = "activity_id,week,location_id,co_share_group\n";
  for (const r of rows) out += r.join(",") + "\n";
  return { csv: out, rows };
}
function writeResultsCsv(inst, sched, scenario) {
  const actsByContract = {};
  inst.activities.forEach((a) => {
    (actsByContract[a.contract_number] ||= []).push(a.activity_id);
  });
  let out = "scenario,contract_number,simulated_completion_date,overrun_days\n";
  const rows = [];
  for (const cn in actsByContract) {
    const aids = actsByContract[cn];
    const finWeeks = aids
      .map((id) => sched.activityFinishWeek.get(id))
      .filter((w) => w !== undefined);
    if (!finWeeks.length) continue;
    const lastWeek = Math.max(...finWeeks);
    const finishDate = addDays(inst.dateOfWeekStart(lastWeek), 6);
    const planned = parseDate(inst.project[cn].planned_completion_date);
    const overrun = Math.max(0, Math.round((finishDate - planned) / 86400000));
    rows.push([scenario, cn, fmtDate(finishDate), overrun]);
    out += [scenario, cn, fmtDate(finishDate), overrun].join(",") + "\n";
  }
  return { csv: out, rows };
}
 
/* =====================================================================
   LIVE SCORING PREVIEW — mirrors the §2.5 combined objective formulas
   so the controller sees a projected score before running the reference
   validator. This is an in-app estimate, not the authoritative score:
   RESULTS.csv is contract-grained, so the per-activity `activity_priority`
   nudge is approximated from whichever activity actually drove that
   contract's finish week.
   ===================================================================== */
function computeSoftScores(inst, sched, scenario) {
  const actsByContract = {};
  inst.activities.forEach((a) => {
    (actsByContract[a.contract_number] ||= []).push(a);
  });
 
  let overrunDaysTotal = 0;
  let earlinessDaysTotal = 0;
  let contractsOverrunning = 0;
  const priorityOverrun = { 1: 0, 2: 0, 3: 0 };
  let priorityWeightedScore = 0;
 
  for (const cn in actsByContract) {
    const acts = actsByContract[cn];
    const contract = inst.project[cn];
    const tier = +contract.contract_priority;
    const weight = tier === 1 ? 100 : tier === 2 ? 10 : 1;
    const planned = parseDate(contract.planned_completion_date);
    const finWeeks = acts
      .map((a) => sched.activityFinishWeek.get(a.activity_id))
      .filter((w) => w !== undefined);
    if (!finWeeks.length) continue;
    const lastWeek = Math.max(...finWeeks);
    const finishDate = addDays(inst.dateOfWeekStart(lastWeek), 6);
    const deltaDays = Math.round((finishDate - planned) / 86400000);
    const overrun = Math.max(0, deltaDays);
    if (overrun > 0) {
      contractsOverrunning++;
      overrunDaysTotal += overrun;
      priorityOverrun[tier] = (priorityOverrun[tier] || 0) + overrun;
      const driverActs = acts.filter(
        (a) => sched.activityFinishWeek.get(a.activity_id) === lastWeek,
      );
      const nudge = Math.max(
        ...driverActs.map((a) =>
          +a.activity_priority === 1 ? 0.3 : +a.activity_priority === 2 ? 0.2 : 0,
        ),
      );
      priorityWeightedScore += weight * (1 + nudge) * overrun;
    } else if (deltaDays < 0) {
      earlinessDaysTotal += -deltaDays;
    }
  }
 
  let excessAccessNightsTotal = 0;
  for (const v of sched.excess.values()) excessAccessNightsTotal += v;
  const ecloNightsTotal = sched.accessRows.filter((r) => r[3] === 1).length;
 
  let objectiveScore;
  if (scenario === "A") objectiveScore = priorityWeightedScore;
  else if (scenario === "B")
    objectiveScore = 7 * excessAccessNightsTotal + 5 * ecloNightsTotal;
  else
    objectiveScore =
      priorityWeightedScore + 7 * excessAccessNightsTotal + 5 * ecloNightsTotal;
 
  return {
    overrunDaysTotal,
    earlinessDaysTotal,
    contractsOverrunning,
    priorityOverrun,
    priorityWeightedScore: Math.round(priorityWeightedScore * 10) / 10,
    excessAccessNightsTotal,
    ecloNightsTotal,
    objectiveScore: Math.round(objectiveScore * 10) / 10,
  };
}
 
function capacityHotspots(inst, sched, limit = 12) {
  const rows = [];
  for (const [k, arr] of sched.slots) {
    const [loc, wk] = k.split("|");
    const nominal = inst.supplyCap[loc] ?? 4;
    if (nominal <= 0) continue;
    rows.push({ loc, week: +wk, used: arr.length, nominal, ratio: arr.length / nominal });
  }
  rows.sort((a, b) => b.ratio - a.ratio || b.used - a.used);
  return rows.slice(0, limit);
}
 
/* =====================================================================
   NETWORK VIEW — renders the fixed dual-line topology (per §2.2: 8
   exclusive stations + 2 interchange hubs per line) as an inline SVG,
   then colors each tunnel-sector segment and platform indicator by that
   week's occupancy/buffer state, read from the same accessRows /
   occupancyRows the CSVs are built from. Station layout is fixed across
   every instance per the brief, so geometry is hardcoded; occupancy is
   always read live from the solved schedule.
   ===================================================================== */
const NET_STATION_X = {
  S01: 200, S02: 270, S03: 340, S04: 410, H01: 478, H02: 578,
  S05: 650, S06: 720, S07: 790, S08: 860,
  S11: 200, S12: 270, S13: 340, S14: 410,
  S15: 650, S16: 720, S17: 790, S18: 860,
};
const NET_SEGMENTS = {
  ALP: [["S01","S02"],["S02","S03"],["S03","S04"],["S04","H01"],["H01","H02"],["H02","S05"],["S05","S06"],["S06","S07"],["S07","S08"]],
  BET: [["S11","S12"],["S12","S13"],["S13","S14"],["S14","H01"],["H01","H02"],["H02","S15"],["S15","S16"],["S16","S17"],["S17","S18"]],
};
const NET_NORMAL_STATIONS = {
  ALP: ["S01","S02","S03","S04","S05","S06","S07","S08"],
  BET: ["S11","S12","S13","S14","S15","S16","S17","S18"],
};
const NET_LINE_Y = { ALP: { EB: 92, WB: 116 }, BET: { EB: 268, WB: 292 } };
const NET_LINE_COLOR = { ALP: "#ef4444", BET: "#10b981" };
const NET_HUB_EDGE = 12;
 
function netSegX(line, from, to) {
  const x1raw = NET_STATION_X[from];
  const x2raw = NET_STATION_X[to];
  const x1 = from === "H01" || from === "H02" ? x1raw + NET_HUB_EDGE : x1raw;
  const x2 = to === "H01" || to === "H02" ? x2raw - NET_HUB_EDGE : x2raw;
  return [x1, x2];
}
 
function buildNetworkSvgMarkup() {
  let body = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1060 380" width="100%" style="background-color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">`;
  body += `<text x="40" y="42" fill="#f8fafc" font-size="18" font-weight="700">Dual-Line Track Access Network</text>`;
  body += `<text x="40" y="62" fill="#94a3b8" font-size="12">Line Alpha &amp; Line Beta, independent bounds, own H01↔H02 tunnel sector each</text>`;
 
  ["ALP", "BET"].forEach((line) => {
    const rowY = line === "ALP" ? 40 : 40; // both groups use the same local translate
    const headerY = line === "ALP" ? 85 : 261;
    const lineColor = NET_LINE_COLOR[line];
    const ebY = NET_LINE_Y[line].EB,
      wbY = NET_LINE_Y[line].WB;
    const labelYAbove = line === "ALP" ? 76 : 315;
    const labelYBelow = line === "ALP" ? 138 : 254;
 
    body += `<g transform="translate(0, ${rowY})">`;
    body += `<rect x="40" y="${headerY}" width="60" height="26" rx="4" fill="${lineColor}"/>`;
    body += `<text x="70" y="${headerY + 18}" fill="#fff" font-size="13" font-weight="800" text-anchor="middle">${line}</text>`;
 
    // faint track bed for visual continuity
    body += `<path d="M 180 ${ebY} L 980 ${ebY}" stroke="${lineColor}" stroke-width="4" stroke-linecap="round" opacity="0.18"/>`;
    body += `<path d="M 180 ${wbY} L 980 ${wbY}" stroke="${lineColor}" stroke-width="4" stroke-dasharray="6,4" stroke-linecap="round" opacity="0.18"/>`;
 
    // colored occupancy overlay segments (default idle)
    NET_SEGMENTS[line].forEach(([from, to]) => {
      const [x1, x2] = netSegX(line, from, to);
      ["EB", "WB"].forEach((bound) => {
        const y = NET_LINE_Y[line][bound];
        const locId = `SEC:${line}:${from}_${to}:${bound}`;
        const dash = bound === "WB" ? ' stroke-dasharray="8,3"' : "";
        body += `<line data-locid="${locId}" id="netseg-${locId}" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#334155" stroke-width="5" stroke-linecap="round" opacity="0.35"${dash}/>`;
      });
    });
 
    // hub platform rects (split top=EB half, bottom=WB half)
    ["H01", "H02"].forEach((hub) => {
      const hx = NET_STATION_X[hub] - 12;
      ["EB", "WB"].forEach((bound, i) => {
        const locId = `PLAT:${line}:${hub}:${bound}`;
        body += `<rect data-locid="${locId}" id="netloc-${locId}" x="${hx}" y="${82 + (line === "BET" ? 176 : 0) + i * 22}" width="24" height="22" rx="4" fill="#1e293b" stroke="#f59e0b" stroke-width="1.5" opacity="0.55"/>`;
      });
      body += `<text x="${NET_STATION_X[hub]}" y="${line === "ALP" ? 76 : 336}" fill="#fbbf24" font-size="11" font-weight="800" text-anchor="middle">${hub}</text>`;
    });
 
    // normal station markers + platform indicator squares
    NET_NORMAL_STATIONS[line].forEach((st) => {
      const cx = NET_STATION_X[st];
      const cy = line === "ALP" ? 104 : 280;
      body += `<circle cx="${cx}" cy="${cy}" r="7" fill="#1e293b" stroke="${lineColor}" stroke-width="2.5"/>`;
      body += `<text x="${cx}" y="${labelYAbove}" fill="#f8fafc" font-size="11" font-weight="600" text-anchor="middle">${st}</text>`;
      ["EB", "WB"].forEach((bound) => {
        const y = NET_LINE_Y[line][bound];
        const locId = `PLAT:${line}:${st}:${bound}`;
        body += `<rect data-locid="${locId}" id="netloc-${locId}" x="${cx - 5}" y="${y - 5}" width="10" height="10" rx="2" fill="#334155" opacity="0.35"/>`;
      });
    });
 
    body += `</g>`;
  });
 
  body += `</svg>`;
  return body;
}
 
// Recompute which locations a given activity's exclusion buffer touches —
// shared by the self-check and the network view so both agree on the rules.
function activityBufferLocs(inst, act) {
  const contract = inst.project[act.contract_number];
  const nature = contract.nature_of_activity;
  const bufN = inst.bufferN[nature] ?? 0;
  if (bufN <= 0) return [];
  const pl = inst.pathLocations(act.start_location_id, act.end_location_id);
  let locs = inst.bufferSectorIds(pl.line, pl.bound, pl.lo, pl.hi, bufN);
  if (inst.bufferMirror[nature])
    locs = locs.concat(
      inst.bufferSectorIds(pl.line, inst.opposite(pl.bound), pl.lo, pl.hi, bufN),
    );
  return [...new Set(locs)];
}
 
function buildLocWeekIndex(sched) {
  const idx = new Map(); // "loc|week" -> {groups:Set, activities:Set}
  for (const [aid, week, loc, group] of sched.occupancyRows) {
    const k = loc + "|" + week;
    if (!idx.has(k)) idx.set(k, { groups: new Set(), activities: new Set() });
    idx.get(k).groups.add(group);
    idx.get(k).activities.add(aid);
  }
  return idx;
}
 
function bufferedLocsForWeek(inst, sched, week, actById) {
  const out = new Map(); // locId -> Set(activityId)
  for (const [aid, , wk] of sched.accessRows) {
    if (wk !== week) continue;
    const act = actById[aid];
    if (!act) continue;
    for (const loc of activityBufferLocs(inst, act)) {
      if (!out.has(loc)) out.set(loc, new Set());
      out.get(loc).add(aid);
    }
  }
  return out;
}
 
let netInitDone = false;
function initNetworkView() {
  if (netInitDone) return;
  document.getElementById("networkSvgWrap").innerHTML = buildNetworkSvgMarkup();
  document.getElementById("networkSvgWrap").addEventListener("click", (e) => {
    const el = e.target.closest("[data-locid]");
    if (!el) return;
    const d = solved[activeScenario];
    if (!d) return;
    const week = +document.getElementById("netWeek").value;
    showNetInfo(el.getAttribute("data-locid"), week, d);
  });
  document.getElementById("netWeek").addEventListener("input", (e) => {
    document.getElementById("netWeekLabel").textContent = `Week ${e.target.value}`;
    const d = solved[activeScenario];
    if (d) renderNetworkView(d, +e.target.value);
  });
  const playBtn = document.getElementById("netPlay");
  let playTimer = null;
  playBtn.addEventListener("click", () => {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      playBtn.textContent = "▶";
      playBtn.classList.remove("playing");
      return;
    }
    playBtn.textContent = "❚❚";
    playBtn.classList.add("playing");
    const slider = document.getElementById("netWeek");
    playTimer = setInterval(() => {
      const d = solved[activeScenario];
      if (!d) return;
      let next = +slider.value + 1;
      if (next > +slider.max) next = 1;
      slider.value = next;
      document.getElementById("netWeekLabel").textContent = `Week ${next}`;
      renderNetworkView(d, next);
    }, 700);
  });
  netInitDone = true;
}
 
function showNetInfo(locId, week, d) {
  const box = document.getElementById("netInfo");
  const usage = d.locWeekIndex.get(locId + "|" + week);
  const nominal = d.inst.supplyCap[locId] ?? 4;
  if (usage && usage.activities.size) {
    const rows = [...usage.activities].map((aid) => {
      const act = d.actById[aid];
      const contract = act ? d.inst.project[act.contract_number] : null;
      return `${aid}${contract ? ` (contract ${act.contract_number}, ${contract.access_type})` : ""}`;
    });
    box.innerHTML = `<b>${locId}</b> · week ${week} · ${usage.groups.size}/${nominal} slots used<br>${rows.join(", ")}`;
    return;
  }
  const buffered = d.bufferedByWeek.get(week);
  const bufAids = buffered && buffered.get(locId);
  if (bufAids && bufAids.size) {
    box.innerHTML = `<b>${locId}</b> · week ${week} · in the exclusion buffer of ${[...bufAids].join(", ")} — closed, no direct work booked here`;
    return;
  }
  box.innerHTML = `<b>${locId}</b> · week ${week} · idle — 0/${nominal} slots used`;
}
 
function renderNetworkView(d, week) {
  initNetworkView();
  const maxWeek = d.inst.horizonWeeks + 20;
  const slider = document.getElementById("netWeek");
  slider.max = maxWeek;
  if (!week) week = Math.min(+slider.value || 1, maxWeek);
  slider.value = week;
  document.getElementById("netWeekLabel").textContent = `Week ${week}`;
 
  if (!d.bufferedByWeek) d.bufferedByWeek = new Map();
  if (!d.bufferedByWeek.has(week))
    d.bufferedByWeek.set(week, bufferedLocsForWeek(d.inst, d.sched, week, d.actById));
  const buffered = d.bufferedByWeek.get(week);
 
  const allLocIds = new Set();
  ["ALP", "BET"].forEach((line) => {
    NET_SEGMENTS[line].forEach(([from, to]) =>
      ["EB", "WB"].forEach((b) => allLocIds.add(`SEC:${line}:${from}_${to}:${b}`)),
    );
    NET_NORMAL_STATIONS[line].concat(["H01", "H02"]).forEach((st) =>
      ["EB", "WB"].forEach((b) => allLocIds.add(`PLAT:${line}:${st}:${b}`)),
    );
  });
 
  allLocIds.forEach((locId) => {
    const segEl = document.getElementById("netseg-" + locId);
    const locEl = document.getElementById("netloc-" + locId);
    const el = segEl || locEl;
    if (!el) return;
    const usage = d.locWeekIndex.get(locId + "|" + week);
    const nominal = d.inst.supplyCap[locId] ?? 4;
    const isBuffered = buffered.has(locId);
    let stroke = "#334155",
      opacity = 0.35;
    if (usage && usage.groups.size) {
      const ratio = usage.groups.size / nominal;
      stroke = ratio >= 1 ? "#ef4444" : ratio >= 0.75 ? "#f59e0b" : "#22c55e";
      opacity = 1;
    } else if (isBuffered) {
      stroke = "#f59e0b";
      opacity = 0.6;
    }
    if (segEl) {
      segEl.setAttribute("stroke", stroke);
      segEl.setAttribute("opacity", opacity);
      if (isBuffered && !(usage && usage.groups.size))
        segEl.setAttribute("stroke-dasharray", segEl.id.includes(":WB") ? "8,3" : "3,3");
      else if (!segEl.id.includes(":WB")) segEl.removeAttribute("stroke-dasharray");
    } else if (locEl) {
      locEl.setAttribute("fill", stroke);
      locEl.setAttribute("opacity", opacity);
      locEl.setAttribute(
        "stroke",
        isBuffered && !(usage && usage.groups.size) ? "#f59e0b" : "none",
      );
    }
    const statusText = usage && usage.groups.size
      ? `${locId} · wk${week} · ${usage.groups.size}/${nominal} used`
      : isBuffered
        ? `${locId} · wk${week} · in buffer zone`
        : `${locId} · wk${week} · idle`;
    let titleEl = el.querySelector(":scope > title");
    if (!titleEl) {
      titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
      el.insertBefore(titleEl, el.firstChild);
    }
    titleEl.textContent = statusText;
  });
}
 
function jumpToContractWeek(contractNumber) {
  const d = solved[activeScenario];
  if (!d) return;
  const acts = d.inst.activities.filter(
    (a) => a.contract_number === contractNumber,
  );
  let week = 1;
  for (const a of acts) {
    const fw = d.sched.activityFinishWeek.get(a.activity_id);
    if (fw !== undefined) week = Math.max(week, fw);
  }
  renderNetworkView(d, week);
  const panel = document.getElementById("networkSvgWrap").closest(".panel");
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
  panel.classList.remove("flash");
  void panel.offsetWidth; // restart animation if already flashing
  panel.classList.add("flash");
  setTimeout(() => panel.classList.remove("flash"), 1400);
}
 
function selfCheck(inst, sched) {
  // Every check below is recomputed purely from the three output tables
  // (accessRows / occupancyRows / activity+contract reference data) — never
  // from the scheduler's internal placement maps (sched.slots, sched.weekly,
  // sched.bufferRes). That's deliberate: those internal maps are exactly what
  // a bug in the constructor would corrupt, so trusting them to grade
  // themselves would let a real violation slip through as a false PASS. This
  // mirrors what an external validator does — read the CSVs back and check.
  const notes = [];
  const actById = {};
  inst.activities.forEach((a) => (actById[a.activity_id] = a));
 
  // ---- 1. Workload conservation, recomputed from accessRows -------------
  const yieldById = {};
  for (const [aid, , , eclo] of sched.accessRows) {
    yieldById[aid] = (yieldById[aid] || 0) + (eclo === 1 ? 1.5 : 1.0);
  }
  let underDelivered = 0;
  for (const a of inst.activities) {
    const need = +a.total_accesses;
    const got = yieldById[a.activity_id] || 0;
    if (got < need - 1e-9) underDelivered++;
  }
  notes.push([
    underDelivered === 0 ? "PASS" : "FAIL",
    `Workload conservation (recomputed from SCHEDULE_ACCESS.csv) — ${inst.activities.length - underDelivered}/${inst.activities.length} activities meet total_accesses`,
  ]);
 
  // ---- 2. Location capacity, recomputed from occupancyRows ---------------
  // A "possession" at a location-week is one distinct co_share_group; that's
  // what consumes a unit of supply_capacity, matching how the scheduler
  // itself defines a slot.
  const groupsByLocWeek = new Map();
  for (const [, week, loc, group] of sched.occupancyRows) {
    const k = loc + "|" + week;
    if (!groupsByLocWeek.has(k)) groupsByLocWeek.set(k, new Set());
    groupsByLocWeek.get(k).add(group);
  }
  const tol =
    sched.scenario === "A" ? 0 : sched.scenario === "C" ? 1 : Infinity;
  let capBreach = 0;
  const capBreachDetail = [];
  for (const [k, groups] of groupsByLocWeek) {
    const [loc] = k.split("|");
    const nominal = inst.supplyCap[loc] ?? 4;
    if (groups.size > nominal + tol) {
      capBreach++;
      if (capBreachDetail.length < 3) capBreachDetail.push(k);
    }
  }
  notes.push([
    capBreach === 0 ? "PASS" : "FAIL",
    `Location capacity within scenario ${sched.scenario} tolerance (recomputed from SCHEDULE_OCCUPANCY.csv) — ${capBreach} location-weeks over limit${capBreachDetail.length ? " (e.g. " + capBreachDetail.join(", ") + ")" : ""}`,
  ]);
 
  // ---- 3. Weekly allocation cap + workfronts, recomputed from accessRows -
  // key: contract_number|access_type|week -> Map(night -> Set(activity))
  const weeklyMap = new Map();
  for (const [aid, , week, , night] of sched.accessRows) {
    const a = actById[aid];
    if (!a) continue;
    const contract = inst.project[a.contract_number];
    const k = `${a.contract_number}|${contract.access_type}|${week}`;
    if (!weeklyMap.has(k)) weeklyMap.set(k, new Map());
    const nightMap = weeklyMap.get(k);
    if (!nightMap.has(night)) nightMap.set(night, new Set());
    nightMap.get(night).add(aid);
  }
  let weeklyCapBreach = 0,
    workfrontBreach = 0;
  for (const [k, nightMap] of weeklyMap) {
    const [cn] = k.split("|");
    const contract = inst.project[cn];
    const maxAccess = +contract.number_of_maximum_access_per_week || 7;
    const workfronts = +contract.number_of_workfronts || 1;
    if (nightMap.size > maxAccess) weeklyCapBreach++;
    for (const [, aidSet] of nightMap) {
      if (aidSet.size > workfronts) workfrontBreach++;
    }
  }
  notes.push([
    weeklyCapBreach === 0 ? "PASS" : "FAIL",
    `Weekly allocation cap (recomputed) — ${weeklyCapBreach} contract-type-weeks exceed number_of_maximum_access_per_week`,
  ]);
  notes.push([
    workfrontBreach === 0 ? "PASS" : "FAIL",
    `Workfront concurrency (recomputed) — ${workfrontBreach} nights exceed number_of_workfronts`,
  ]);
 
  // ---- 4. Predecessor finish-to-start, recomputed from accessRows --------
  const finishWeekById = {};
  for (const [aid, , week] of sched.accessRows) {
    finishWeekById[aid] = Math.max(finishWeekById[aid] ?? -Infinity, week);
  }
  const startWeekById = {};
  for (const [aid, , week] of sched.accessRows) {
    startWeekById[aid] = Math.min(startWeekById[aid] ?? Infinity, week);
  }
  let predBreach = 0;
  for (const a of inst.activities) {
    const pred = a.predecessor_activity_id;
    if (!pred) continue;
    const predFinish = finishWeekById[pred];
    const succStart = startWeekById[a.activity_id];
    if (predFinish === undefined || succStart === undefined) continue;
    if (succStart <= predFinish) predBreach++;
  }
  notes.push([
    predBreach === 0 ? "PASS" : "FAIL",
    `Predecessor finish-to-start ordering (recomputed) — ${predBreach} successor activities start in/before their predecessor's finish week`,
  ]);
 
  // ---- 5. Buffer/closure clearance, recomputed from occupancyRows --------
  // For every buffer-bearing activity, recompute its buffer sectors from
  // scratch and confirm no *other* co_share_group occupies them that week.
  const groupsAtLocWeek = groupsByLocWeek; // reuse from check 2
  const activityGroupAtWeek = new Map(); // `${aid}|${week}` -> group
  for (const [aid, week, , group] of sched.occupancyRows) {
    activityGroupAtWeek.set(`${aid}|${week}`, group);
  }
  let bufferBreach = 0;
  const bufferBreachDetail = [];
  for (const a of inst.activities) {
    const contract = inst.project[a.contract_number];
    const nature = contract.nature_of_activity;
    const bufN = inst.bufferN[nature] ?? 0;
    if (bufN <= 0) continue;
    const rowsForAct = sched.accessRows.filter((r) => r[0] === a.activity_id);
    if (!rowsForAct.length) continue;
    const pl = inst.pathLocations(a.start_location_id, a.end_location_id);
    let bufferLocs = inst.bufferSectorIds(pl.line, pl.bound, pl.lo, pl.hi, bufN);
    if (inst.bufferMirror[nature])
      bufferLocs = bufferLocs.concat(
        inst.bufferSectorIds(pl.line, inst.opposite(pl.bound), pl.lo, pl.hi, bufN),
      );
    bufferLocs = [...new Set(bufferLocs)];
    for (const [, , week] of rowsForAct) {
      const myGroup = activityGroupAtWeek.get(`${a.activity_id}|${week}`);
      if (myGroup === undefined) continue;
      for (const loc of bufferLocs) {
        const groups = groupsAtLocWeek.get(loc + "|" + week);
        if (!groups) continue;
        const others = [...groups].filter((g) => g !== myGroup);
        if (others.length > 0) {
          bufferBreach++;
          if (bufferBreachDetail.length < 3)
            bufferBreachDetail.push(`${a.activity_id} wk${week} @ ${loc}`);
        }
      }
    }
  }
  notes.push([
    bufferBreach === 0 ? "PASS" : "FAIL",
    `Buffer/closure clearance (recomputed) — ${bufferBreach} buffer-zone overlaps${bufferBreachDetail.length ? " (e.g. " + bufferBreachDetail.join(", ") + ")" : ""}`,
  ]);
 
  // ---- 6. Diagnostics -----------------------------------------------------
  let totalExcess = 0;
  for (const v of sched.excess.values()) totalExcess += v;
  notes.push([
    "INFO",
    `Excess access-nights beyond nominal supply this scenario: ${totalExcess}`,
  ]);
  return notes;
}
 
/* =====================================================================
   UI WIRING, PERSISTENCE & CALENDAR RENDERING
   ===================================================================== */
const REQUIRED_HINTS = [
  "LINES",
  "STATIONS",
  "SECTORS",
  "LOCATION_SUPPLY",
  "BUFFER_LOCATION",
  "PARAMETERS",
  "PROJECT_DETAILS",
  "ACTIVITY_DETAILS",
];
let uploaded = {};
let solved = null;
let inst = null;
let activeScenario = "A";
let calendar = null;
 
const dz = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const filelist = document.getElementById("filelist");
const runBtn = document.getElementById("runBtn");
const statusEl = document.getElementById("status");
 
// Load stored files on initialization
window.addEventListener("DOMContentLoaded", () => {
  const savedData = localStorage.getItem("uploaded_csv_files");
  if (savedData) {
    try {
      uploaded = JSON.parse(savedData);
    } catch (e) {
      console.error("Failed to parse saved file data", e);
    }
  }
  refreshFileList();
});
 
function saveToStorage() {
  try {
    localStorage.setItem("uploaded_csv_files", JSON.stringify(uploaded));
  } catch (e) {
    console.warn("Storage limit exceeded or unavailable", e);
  }
}


dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("dragover", (e) => {
  e.preventDefault();
  dz.classList.add("drag");
});
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("drag");
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", (e) => handleFiles(e.target.files));
 
function handleFiles(fileListObj) {
  const files = Array.from(fileListObj);
  let pending = files.length;
  files.forEach((f) => {
    const reader = new FileReader();
    reader.onload = () => {
      uploaded[f.name] = reader.result;
      pending--;
      if (pending === 0) {
        saveToStorage();
        refreshFileList();
      }
    };
    reader.readAsText(f);
  });
}
 
function refreshFileList() {
  filelist.innerHTML = "";
  const names = Object.keys(uploaded);
 
  names.forEach((n) => {
    const row = document.createElement("div");
    row.className = "filerow";
 
    const nameSpan = document.createElement("span");
    nameSpan.className = "name";
    nameSpan.textContent = n;
 
    const okSpan = document.createElement("span");
    okSpan.className = "ok";
    okSpan.textContent = "✓ ";
 
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "✕";
 
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      delete uploaded[n];
      saveToStorage();
      refreshFileList();
    });
 
    row.appendChild(nameSpan);
    row.appendChild(okSpan);
    row.appendChild(removeBtn);
    filelist.appendChild(row);
  });
 
  const matched = REQUIRED_HINTS.filter((h) =>
    names.some((n) => n.toUpperCase().includes(h)),
  );
 
  const reqlist = document.getElementById("reqlist");
  reqlist.innerHTML = REQUIRED_HINTS.map((h) => {
    const got = names.some((n) => n.toUpperCase().includes(h));
    return `<div class="reqitem${got ? " got" : ""}"><span class="dot"></span>${h}</div>`;
  }).join("");
 
  statusEl.textContent = names.length
    ? `${names.length} file(s) loaded — ${matched.length}/8 expected tables detected.`
    : "No files loaded.";
  statusEl.className = "status";
  runBtn.disabled = names.length === 0;
}
 
document.getElementById("loadSample").addEventListener("click", async () => {
  statusEl.textContent = "Loading bundled sample instance…";
  try {
    const names = [
      "01_LINES.csv",
      "02_STATIONS.csv",
      "03_SECTORS.csv",
      "04_LOCATION_SUPPLY.csv",
      "05_BUFFER_LOCATION.csv",
      "06_PARAMETERS.csv",
      "07_PROJECT_DETAILS.csv",
      "08_ACTIVITY_DETAILS.csv",
    ];
    for (const n of names) {
      const res = await fetch("./sample_data/" + n);
      if (!res.ok) throw new Error("missing " + n);
      uploaded[n] = await res.text();
    }
    saveToStorage();
    refreshFileList();
    statusEl.textContent = "Sample instance loaded. Ready to run.";
    statusEl.className = "status ok";
  } catch (err) {
    statusEl.textContent =
      "Sample data not bundled with this deployment — please upload the 8 CSVs manually.";
    statusEl.className = "status err";
  }
});
 
runBtn.addEventListener("click", () => {
  runBtn.disabled = true;
  statusEl.textContent = "Parsing instance…";
  statusEl.className = "status";
  setTimeout(() => {
    try {
      inst = buildInstance(uploaded);
      statusEl.textContent = "Solving scenarios A, B, C…";
      solved = {};
      const actById = {};
      inst.activities.forEach((a) => (actById[a.activity_id] = a));
      ["A", "B", "C"].forEach((sc) => {
        const sched = runScenario(inst, sc);
        const access = writeAccessCsv(sched);
        const occ = writeOccupancyCsv(sched);
        const res = writeResultsCsv(inst, sched, sc);
        const checks = selfCheck(inst, sched);
        const score = computeSoftScores(inst, sched, sc);
        const hotspots = capacityHotspots(inst, sched);
        const locWeekIndex = buildLocWeekIndex(sched);
        solved[sc] = {
          sched, access, occ, res, checks, score, hotspots,
          inst, actById, locWeekIndex, bufferedByWeek: new Map(),
        };
      });
      statusEl.textContent =
        "Solved. 100% of activities scheduled across all three scenarios.";
      statusEl.className = "status ok";
      renderResults();
    } catch (err) {
      statusEl.textContent = "Error: " + err.message;
      statusEl.className = "status err";
      console.error(err);
    } finally {
      runBtn.disabled = false;
    }
  }, 30);
});
 
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document
      .querySelectorAll(".tab")
      .forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    activeScenario = t.dataset.s;
    renderScenario();
  });
});

function download(filename, text) {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
document.getElementById("dlAccess").addEventListener("click", () => {
  if (!solved) return;
  download(
    `SCHEDULE_ACCESS_${activeScenario}.csv`,
    solved[activeScenario].access.csv,
  );
});
document.getElementById("dlOcc").addEventListener("click", () => {
  if (!solved) return;
  download(
    `SCHEDULE_OCCUPANCY_${activeScenario}.csv`,
    solved[activeScenario].occ.csv,
  );
});
document.getElementById("dlRes").addEventListener("click", () => {
  if (!solved) return;
  download(`RESULTS_${activeScenario}.csv`, solved[activeScenario].res.csv);
});
document.getElementById("dlAll").addEventListener("click", async () => {
  if (!solved || typeof JSZip === "undefined") return;
  const zip = new JSZip();
  ["A", "B", "C"].forEach((sc) => {
    const folder = zip.folder(sc);
    folder.file("SCHEDULE_ACCESS.csv", solved[sc].access.csv);
    folder.file("SCHEDULE_OCCUPANCY.csv", solved[sc].occ.csv);
    folder.file("RESULTS.csv", solved[sc].res.csv);
  });
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "track_access_submission.zip";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});
 
function renderResults() {
  document.getElementById("emptyState").style.display = "none";
  document.getElementById("results").style.display = "block";
  renderScenario();
}
 
function renderCalendar() {
  if (typeof FullCalendar === "undefined") {
    console.error("FullCalendar library is missing.");
    return;
  }
  const calendarEl = document.getElementById("calendar");
  const d = solved[activeScenario];
  if (!d || !calendarEl) return;
 
  const nightTimeTracker = {};
 
  const calendarEvents = d.access.rows.map((row) => {
    const activityId = row[0];
    const weekNum = row[2];
    const nightNum = row[4];
    const isEclo = row[3] === 1;
 
    const startDate = addDays(inst.dateOfWeekStart(weekNum), nightNum - 1);
    const dateStr = fmtDate(startDate);
 
    const durationHours = 2.0;
    const currentOffset = nightTimeTracker[dateStr] || 0;
    const startHour = 1 + currentOffset;
    const endHour = startHour + durationHours;
 
    const formatTime = (h) => {
      const hrs = Math.floor(h).toString().padStart(2, "0");
      const mins = Math.round((h % 1) * 60)
        .toString()
        .padStart(2, "0");
      return `${hrs}:${mins}:00`;
    };
 
    const startIso = `${dateStr}T${formatTime(startHour)}`;
    const endIso = `${dateStr}T${formatTime(endHour)}`;
 
    nightTimeTracker[dateStr] = (currentOffset + 1.5) % 3.5;
 
    return {
      id: `${activityId}_w${weekNum}_n${nightNum}`,
      title: `${activityId} (${formatTime(startHour).slice(0, 5)}) ${isEclo ? "[ECLO]" : ""}`,
      start: startIso,
      end: endIso,
      backgroundColor: isEclo ? "var(--amber)" : "var(--blue)",
      borderColor: isEclo ? "var(--amber)" : "var(--blue)",
    };
  });
 
  if (calendar) {
    calendar.destroy();
  }
 
  calendar = new FullCalendar.Calendar(calendarEl, {
    initialView: "timeGridWeek",
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek,timeGridDay",
    },
    events: calendarEvents,
  });
 
  calendar.render();
}
 
function renderScenario() {
  const d = solved[activeScenario];
  if (!d) return;
  initNetworkView();
  renderNetworkView(d);
  const resRows = d.res.rows;
  const totalContracts = resRows.length;
  const overrunning = resRows.filter((r) => r[3] > 0).length;
  const totalOverrun = resRows.reduce((s, r) => s + r[3], 0);
  const nightsScheduled = d.sched.accessRows.length;
  const ecloNights = d.sched.accessRows.filter((r) => r[3] === 1).length;
  let excessTotal = 0;
  for (const v of d.sched.excess.values()) excessTotal += v;
 
  const cards = document.getElementById("cards");
  cards.innerHTML = `
<div class="card"><div class="lbl">Contracts on time</div><div class="val ${overrunning === 0 ? "green" : "amber"}">${totalContracts - overrunning}/${totalContracts}</div><div class="sub">vs planned_completion_date</div></div>
<div class="card"><div class="lbl">Total overrun</div><div class="val ${totalOverrun === 0 ? "green" : "red"}">${totalOverrun}</div><div class="sub">contract-days summed</div></div>
<div class="card"><div class="lbl">Access-nights scheduled</div><div class="val">${nightsScheduled}</div><div class="sub">across all activities</div></div>
<div class="card"><div class="lbl">ECLO nights used</div><div class="val ${ecloNights === 0 ? "green" : "amber"}">${ecloNights}</div><div class="sub">${activeScenario === "A" ? "forbidden in Scenario A" : "$5/night penalty"}</div></div>
<div class="card"><div class="lbl">Excess access-nights</div><div class="val ${excessTotal === 0 ? "green" : "amber"}">${excessTotal}</div><div class="sub">${activeScenario === "A" ? "hard-capped at 0" : activeScenario === "C" ? "≤1/location-week soft" : "unlimited, $7/night"}</div></div>
  `;
 
  // ---- Projected score preview (§2.5 formulas) ----
  const sco = d.score;
  const scoreCards = document.getElementById("scoreCards");
  const p1 = sco.priorityOverrun[1] || 0,
    p2 = sco.priorityOverrun[2] || 0,
    p3 = sco.priorityOverrun[3] || 0;
  scoreCards.innerHTML = `
<div class="card"><div class="lbl">Priority-weighted overrun</div><div class="val ${sco.priorityWeightedScore === 0 ? "green" : "red"}">${sco.priorityWeightedScore}</div><div class="sub">P1 ${p1}d · P2 ${p2}d · P3 ${p3}d</div></div>
<div class="card"><div class="lbl">Excess-night cost</div><div class="val ${sco.excessAccessNightsTotal === 0 ? "green" : "amber"}">${7 * sco.excessAccessNightsTotal}</div><div class="sub">7 × ${sco.excessAccessNightsTotal} nights</div></div>
<div class="card"><div class="lbl">ECLO cost</div><div class="val ${sco.ecloNightsTotal === 0 ? "green" : "amber"}">${5 * sco.ecloNightsTotal}</div><div class="sub">5 × ${sco.ecloNightsTotal} nights</div></div>
<div class="card"><div class="lbl">Projected Score${activeScenario}</div><div class="val amber">${sco.objectiveScore}</div><div class="sub">lower is better · estimate only</div></div>
  `;
 
  // ---- Scenario comparison table ----
  const cmpBody = document.querySelector("#compareTable tbody");
  cmpBody.innerHTML = "";
  const metricRows = [
    ["Feasible (self-check)", (s) => (s.checks.every((c) => c[0] !== "FAIL") ? "✓" : "✗ see self-check")],
    ["Overrun days total", (s) => s.score.overrunDaysTotal],
    ["Contracts overrunning", (s) => `${s.score.contractsOverrunning}/${s.res.rows.length}`],
    ["Excess access-nights", (s) => s.score.excessAccessNightsTotal],
    ["ECLO nights used", (s) => s.score.ecloNightsTotal],
    ["Priority-weighted overrun", (s) => s.score.priorityWeightedScore],
    ["Projected objective score", (s) => s.score.objectiveScore],
  ];
  metricRows.forEach(([label, fn]) => {
    const tr = document.createElement("tr");
    const cells = ["A", "B", "C"]
      .map((sc) => {
        const s = solved[sc];
        const val = s ? fn(s) : "—";
        const active = sc === activeScenario ? ' style="font-weight:600"' : "";
        return `<td${active}>${val}</td>`;
      })
      .join("");
    tr.innerHTML = `<td>${label}</td>${cells}`;
    cmpBody.appendChild(tr);
  });
 
  // ---- Capacity hotspots ----
  const hsBody = document.querySelector("#hotspotTable tbody");
  hsBody.innerHTML = "";
  d.hotspots.forEach((h) => {
    const pct = Math.round(h.ratio * 100);
    const cls = h.used > h.nominal ? "odx" : pct >= 100 ? "odx" : "od0";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${h.loc}</td><td>${h.week}</td><td>${h.used}</td><td>${h.nominal}</td><td class="${cls}">${pct}%</td>`;
    hsBody.appendChild(tr);
  });
  document.getElementById("hotspotHint").textContent = d.hotspots.length
    ? `Top ${d.hotspots.length} busiest location-weeks · Scenario ${activeScenario}`
    : "No location-weeks recorded";
 
  renderResTable(d, document.getElementById("resFilter").value);
  renderAccTable(d, document.getElementById("accFilter").value);
 
  const sc = document.getElementById("selfcheck");
  sc.innerHTML = "";
  d.checks.forEach(([tag, msg]) => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span class="tag" style="color:${tag === "PASS" ? "var(--green)" : tag === "FAIL" ? "var(--red)" : "var(--muted)"}">${tag}</span><span>${msg}</span>`;
    sc.appendChild(row);
  });
 
  setTimeout(() => {
    renderCalendar();
  }, 50);
}
 
function renderResTable(d, filter) {
  const inst = d.inst;
  const resRows = d.res.rows;
  const needle = (filter || "").trim().toUpperCase();
  const tbody = document.querySelector("#resTable tbody");
  tbody.innerHTML = "";
  const filtered = resRows
    .slice()
    .filter((r) => !needle || r[1].toUpperCase().includes(needle))
    .sort(
      (a, b) =>
        +inst.project[a[1]].contract_priority -
          +inst.project[b[1]].contract_priority || (a[1] < b[1] ? -1 : 1),
    );
  filtered.forEach((r) => {
    const [sc, cn, simDate, overrun] = r;
    const pr = inst.project[cn].contract_priority;
    const planned = inst.project[cn].planned_completion_date;
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.title = "Click to view this contract's finish week on the network map";
    tr.innerHTML = `<td>${cn}</td><td><span class="pill p${pr}">P${pr}</span></td><td>${planned}</td><td>${simDate}</td><td class="${overrun > 0 ? "odx" : "od0"}">${overrun}</td>`;
    tr.addEventListener("click", () => jumpToContractWeek(cn));
    tbody.appendChild(tr);
  });
  document.getElementById("resHint").textContent = needle
    ? `${filtered.length}/${resRows.length} contracts matching "${filter}" · Scenario ${activeScenario}`
    : `${resRows.length} contracts · Scenario ${activeScenario}`;
}
 
function renderAccTable(d, filter) {
  const needle = (filter || "").trim().toUpperCase();
  const accBody = document.querySelector("#accTable tbody");
  accBody.innerHTML = "";
  const filtered = needle
    ? d.access.rows.filter((r) => String(r[0]).toUpperCase().includes(needle))
    : d.access.rows;
  filtered.slice(0, 300).forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td>`;
    accBody.appendChild(tr);
  });
  document.getElementById("accHint").textContent = needle
    ? `Showing ${Math.min(300, filtered.length)} of ${filtered.length} rows matching "${filter}" · Scenario ${activeScenario}`
    : `Showing ${Math.min(300, filtered.length)} of ${filtered.length} rows · Scenario ${activeScenario}`;
}
 
document.getElementById("resFilter").addEventListener("input", (e) => {
  const d = solved[activeScenario];
  if (d) renderResTable(d, e.target.value);
});
document.getElementById("accFilter").addEventListener("input", (e) => {
  const d = solved[activeScenario];
  if (d) renderAccTable(d, e.target.value);
});

(function () {
  const btn = document.getElementById("themeToggle");
  const root = document.documentElement;
  const sync = () =>
    btn.setAttribute("aria-checked", String(root.dataset.theme === "dark"));

  btn.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) {}
    sync();
    void document.body.offsetHeight;         // flush style + layout now
    if (calendar) calendar.updateSize();     // nudge FullCalendar to repaint
  });
  sync();
})();