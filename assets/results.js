// The host page's OWN search and result list. Loosen does not search for you: your shop has its own backend or filter code.
// These examples have none, so this file filters the 186 rows in the browser, with the same meaning as the constraint operators.
window.Apt = (() => {
  const matches = (row, c) => {
    const v = row[c.attr];
    if (v == null) return false;                       // unknown never satisfies a constraint
    switch (c.op) {
      case "eq": return v === c.value;      case "ne": return v !== c.value;
      case "le": return v <= c.value;       case "ge": return v >= c.value;
      case "in": return c.values.includes(v);  case "notIn": return !c.values.includes(v);
      case "allOf": return c.values.every(x => v.includes(x));  case "anyOf": return c.values.some(x => v.includes(x));
      case "noneOf": return !c.values.some(x => v.includes(x));
    }
    throw new Error(`unknown op ${c.op}`);
  };
  const search = (rows, constraints) => rows.filter(row => constraints.every(c => matches(row, c)));

  const tags = ["furnished", "balcony", "view", "quiet", "parking", "metroM1", "bus"];
  const tagName = {metroM1: "M1", bus: "bus"};

  /** Renders "N apartments" and a table (at most `max` rows) into `el`. */
  function render(el, rows, constraints, {max = 10} = {}) {
    const found = search(rows, constraints);
    el.replaceChildren();
    const count = document.createElement("p");
    count.className = "count"; count.id = "count";
    count.textContent = `${found.length} apartment${found.length === 1 ? "" : "s"}${constraints.length ? "" : " (no filter)"}`;
    el.append(count);
    if (!found.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = "No apartment matches these filters."; el.append(p); return found; }
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>Rent</th><th>Rooms</th><th>Town</th><th>To univ.</th><th>To centre</th><th>Tags</th></tr></thead>";
    const body = document.createElement("tbody");
    for (const r of found.slice(0, max)) {
      const tr = document.createElement("tr");
      const cells = [`${r.rent} CHF`, r.rooms, r.town, `${r.minutesToUnil} min`, `${r.minutesToCentre} min`, tags.filter(t => r[t]).map(t => tagName[t] ?? t).join(", ")];
      for (const text of cells) { const td = document.createElement("td"); td.textContent = text; tr.append(td); }
      body.append(tr);
    }
    table.append(body);
    const wrap = document.createElement("div"); wrap.className = "table-wrap"; wrap.append(table);
    el.append(wrap);
    if (found.length > max) { const more = document.createElement("p"); more.className = "muted"; more.textContent = `and ${found.length - max} more`; el.append(more); }
    return found;
  }

  return {matches, search, render};
})();
