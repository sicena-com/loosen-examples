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

  // The words of the result list. English is the default; francais.html passes UI.fr (CHF in fr-CH style, plural by Intl.PluralRules).
  const UI = {
    en: {count: (n, filtered) => `${n} apartment${n === 1 ? "" : "s"}${filtered ? "" : " (no filter)"}`, none: "No apartment matches these filters.",
         head: ["Rent", "Rooms", "Town", "To univ.", "To centre", "Tags"], rent: v => `${v} CHF`, min: v => `${v} min`, more: n => `and ${n} more`,
         tag: {metroM1: "M1", bus: "bus"}},
    fr: (() => {
      const plural = new Intl.PluralRules("fr"), chf = new Intl.NumberFormat("fr-CH", {style: "currency", currency: "CHF", maximumFractionDigits: 0});
      return {count: (n, filtered) => `${n.toLocaleString("fr-CH")} appartement${plural.select(n) === "other" ? "s" : ""}${filtered ? "" : " (aucun filtre)"}`,
        none: "Aucun appartement ne correspond à ces filtres.", head: ["Loyer", "Pièces", "Localité", "Univ.", "Centre", "Atouts"],
        rent: v => chf.format(v), min: v => `${v} min`, more: n => `et ${n} de plus`,
        tag: {furnished: "meublé", balcony: "balcon", view: "vue", quiet: "calme", parking: "parking", metroM1: "M1", bus: "bus"}};
    })(),
  };

  /** Renders "N apartments" and a table (at most `max` rows) into `el`. `ui` is one of UI (default English). */
  function render(el, rows, constraints, {max = 10, ui = UI.en} = {}) {
    const found = search(rows, constraints);
    el.replaceChildren();
    const count = document.createElement("p");
    count.className = "count"; count.id = "count";
    count.textContent = ui.count(found.length, constraints.length > 0);
    el.append(count);
    if (!found.length) { const p = document.createElement("p"); p.className = "muted"; p.textContent = ui.none; el.append(p); return found; }
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr>${ui.head.map(h => `<th>${h}</th>`).join("")}</tr></thead>`;
    const body = document.createElement("tbody");
    for (const r of found.slice(0, max)) {
      const tr = document.createElement("tr");
      const cells = [ui.rent(r.rent), r.rooms, r.town, ui.min(r.minutesToUnil), ui.min(r.minutesToCentre), tags.filter(t => r[t]).map(t => ui.tag[t] ?? t).join(", ")];
      for (const text of cells) { const td = document.createElement("td"); td.textContent = text; tr.append(td); }
      body.append(tr);
    }
    table.append(body);
    const wrap = document.createElement("div"); wrap.className = "table-wrap"; wrap.append(table);
    el.append(wrap);
    if (found.length > max) { const more = document.createElement("p"); more.className = "muted"; more.textContent = ui.more(found.length - max); el.append(more); }
    return found;
  }

  return {matches, search, render, UI};
})();
