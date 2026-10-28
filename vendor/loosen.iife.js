(function () {
"use strict";
const m_src_cbte = (() => {
const MAX_CONSTRAINTS = 64;
const DEFAULT_MAX_WORK = 20_000_000;
/** Thrown by `analyze` when the work budget is exceeded: reduce the constraints or set a smaller `maxSize`. */
class TooComplexError extends Error {
constructor() {
super("too complex: the query has too many conflicting combinations of constraints to explain; use fewer constraints or a smaller maxSize");
this.name = "TooComplexError";
this.code = "too_complex";
}
}
/** Counts the steps of the exponential search (null = polynomial steps, not counted). */
class Budget {
constructor(max) { this.left = max; }
spend(n) { this.left -= n; if (this.left < 0) throw new TooComplexError(); }
}
const NUMERIC_OPS = new Set(["=", "!=", "<=", ">=", "in", "not in"]);
const TEXT_OPS = new Set(["=", "!=", "in", "not in"]);
const SET_OPS = new Set(["allOf", "anyOf", "noneOf"]);
/** The bit-set algorithms, written once for numbers (up to 31 constraints, fast) and BigInt (up to 64): T = {ZERO, ONE, bit(j)}. */
function algorithms({ZERO, ONE, bit}) {
const indexes = mask => { const out = []; for (let j = 0, m = mask; m !== ZERO; j++, m >>= ONE) if ((m & ONE) !== ZERO) out.push(j); return out; };
const size = mask => { let count = 0; for (let m = mask; m !== ZERO; m &= m - ONE) count++; return count; };
const compare = (a, b) => {
if (a.size !== b.size) return a.size - b.size;
for (let i = 0; i < a.members.length; i++) if (a.members[i] !== b.members[i]) return a.members[i] - b.members[i];
return 0;
};
const sorted = masks => masks.map(mask => ({mask, size: size(mask), members: indexes(mask)})).sort(compare);
const sortMasks = masks => sorted(masks).map(entry => entry.mask);
/** The inclusion-minimal elements, duplicates removed, sorted. */
const minimalSets = (masks, budget) => {
const out = [];
let previous;
budget?.spend(masks.length * (1 + (32 - Math.clz32(masks.length))));      // the sort
next: for (const {mask} of sorted(masks)) {
if (previous !== undefined && previous === mask) continue;
previous = mask;
budget?.spend(1 + out.length);
for (const kept of out) if ((kept & mask) === kept) continue next;
out.push(mask);
}
return out;
};
/** The minimal sets that intersect every set of the family (Berge). */
const minimalTransversals = (family, budget) => {
let transversals = [ZERO];
for (const set of family) {
const next = [];
for (const t of transversals) {
if ((t & set) !== ZERO) { next.push(t); continue; }
for (let r = set; r !== ZERO; r &= r - ONE) next.push(t | (r & -r));
}
budget.spend(next.length);
transversals = minimalSets(next, budget);
}
return transversals;
};
/** The minimal sets satisfying a monotone predicate, size by size (Apriori). k constraints. */
const levelwise = (k, maxSize, groups, budget, predicate) => {
const found = [];
let previous = new Set();
let current = [];
for (let j = 0; j < k; j++) current.push(bit(j));
for (let level = 1; current.length > 0 && (maxSize === 0 || level <= maxSize); level++) {
const failed = new Set(), failedList = [];
budget.spend(current.length * (groups + 1));
for (const s of current) {
if (predicate(s)) found.push(s);
else { failed.add(s); failedList.push(s); }
}
previous = failed;
current = [];
const seen = new Set();
for (const s of failedList) {
let top = 0;
for (let m = s, j = 0; m !== ZERO; j++, m >>= ONE) if ((m & ONE) !== ZERO) top = j;
for (let b = top + 1; b < k; b++) {
const t = s | bit(b);
budget.spend(1 + size(t));
if (seen.has(t)) continue;
seen.add(t);
let ok = true;
for (let r = t; r !== ZERO; r &= r - ONE) if (!previous.has(t & ~(r & -r))) { ok = false; break; }
if (ok) current.push(t);
}
}
}
return found;
};
return {indexes, size, sortMasks, minimalSets, minimalTransversals, levelwise};
}
const NUMBERS = algorithms({ZERO: 0, ONE: 1, bit: j => 1 << j});
const BIGINTS = algorithms({ZERO: 0n, ONE: 1n, bit: j => 1n << BigInt(j)});
const isNull = value => value === null || value === undefined || (typeof value === "number" && Number.isNaN(value));
function compile(constraint, index, kind) {
const fail = message => { throw new Error(`constraint ${index} on "${constraint.attr}": ${message}`); };
const {op, value} = constraint;
const valid = kind === "numeric" ? NUMERIC_OPS : kind === "text" ? TEXT_OPS : SET_OPS;
if (!valid.has(op)) fail(`operator ${op} is not valid on a ${kind} attribute`);
const list = op === "in" || op === "not in" || kind === "set";
if (list) {
if (!Array.isArray(value) || value.length === 0) fail("the value must be a non-empty array");
if (value.some(item => kind === "numeric" ? typeof item !== "number" || Number.isNaN(item) : typeof item !== "string")) fail(`the values must be ${kind === "numeric" ? "numbers" : "strings"}`);
} else if (kind === "numeric" ? typeof value !== "number" || Number.isNaN(value) : typeof value !== "string") fail(`the value must be ${kind === "numeric" ? "a number" : "a string"}`);
const targets = list ? new Set(value) : null;
let violated;
switch (op) {
case "=": violated = v => v !== value; break;
case "!=": violated = v => v === value; break;
case "<=": violated = v => !(v <= value); break;
case ">=": violated = v => !(v >= value); break;
case "in": violated = v => !targets.has(v); break;
case "not in": violated = v => targets.has(v); break;
case "allOf": { const all = [...targets]; violated = v => !all.every(t => v.includes(t)); break; }
case "anyOf": violated = v => !v.some(x => targets.has(x)); break;
default: violated = v => v.some(x => targets.has(x));       // noneOf
}
return {attr: constraint.attr, kind, bound: value, adaptable: kind === "numeric" && (op === "<=" || op === ">="), le: op === "<=", violated};
}
/** The column of an attribute, converted once: numbers in a Float64Array (NaN = NULL); text and sets as they are (null = NULL). */
function column(rows, attr, kind) {
if (kind === "numeric") {
const out = new Float64Array(rows.length);
for (let i = 0; i < rows.length; i++) {
const v = rows[i][attr];
if (isNull(v)) out[i] = NaN;
else if (typeof v === "number") out[i] = v;
else if (typeof v === "boolean") out[i] = v ? 1 : 0;
else throw new Error(`attribute "${attr}" is numeric, got ${typeof v} in row ${i}`);
}
return out;
}
const out = new Array(rows.length);
for (let i = 0; i < rows.length; i++) {
const v = rows[i][attr] ?? null;
if (v !== null && (kind === "text" ? typeof v !== "string" : !Array.isArray(v) || v.some(x => typeof x !== "string"))) throw new Error(`attribute "${attr}" is ${kind === "text" ? "text" : "a set of strings"}, got ${typeof v} in row ${i}`);
out[i] = v;
}
return out;
}
function analyze(rows, schema, constraints, {minItems = 1, maxSize = 0, maxWork = DEFAULT_MAX_WORK, order = "canonical", adaptTo = (index, value) => value} = {}) {
if (order !== "canonical" && order !== "cost") throw new Error('order must be "canonical" or "cost"');
if (typeof adaptTo !== "function") throw new Error("adaptTo must be a function");
if (!Number.isInteger(minItems) || minItems < 1) throw new Error("minItems must be an integer >= 1");
if (!Number.isInteger(maxSize) || maxSize < 0) throw new Error("maxSize must be an integer >= 0");
if (maxWork !== Infinity && (!Number.isInteger(maxWork) || maxWork < 1)) throw new Error("maxWork must be an integer >= 1 or Infinity");
const budget = new Budget(maxWork);
const k = constraints.length;
if (k > MAX_CONSTRAINTS) throw new Error(`query has ${k} constraints, the maximum is ${MAX_CONSTRAINTS}`);
const columns = {};
const compiled = constraints.map((constraint, index) => {
const kind = schema[constraint.attr];
if (!kind) throw new Error(`constraint ${index}: unknown attribute "${constraint.attr}"`);
if (kind !== "numeric" && kind !== "text" && kind !== "set") throw new Error(`attribute "${constraint.attr}": unknown kind "${kind}"`);
const c = compile(constraint, index, kind);
c.values = columns[c.attr] ??= column(rows, c.attr, kind);
return c;
});
const n = rows.length;
const big = k > 31;
const low = new Int32Array(n), high = big ? new Int32Array(n) : null;
compiled.forEach((c, j) => {
const words = j < 32 ? low : high, bit = 1 << (j % 32);
const values = c.values, numeric = c.kind === "numeric", violated = c.violated;
for (let i = 0; i < n; i++) {
const v = values[i];
if (numeric ? Number.isNaN(v) || violated(v) : v === null || violated(v)) words[i] |= bit;
}
});
const groups = new Map();                      // profile -> {mask, rows: [row indexes]}
let lastKey, lastGroup;
for (let i = 0; i < n; i++) {
const key = big ? (BigInt(high[i] >>> 0) << 32n) | BigInt(low[i] >>> 0) : low[i];
if (key !== lastKey || !lastGroup) {
lastKey = key;
lastGroup = groups.get(key);
if (!lastGroup) groups.set(key, lastGroup = {mask: key, rows: []});
}
lastGroup.rows.push(i);
}
const T = big ? BIGINTS : NUMBERS;
const ZERO = big ? 0n : 0, ONE = big ? 1n : 1;
const result = {matching: groups.get(ZERO)?.rows.length ?? 0, success: false, grs: [], mcs: []};
if (result.matching >= minItems) { result.success = true; return result; }
if (n < minItems) throw new Error(`there are ${n} rows, fewer than minItems = ${minItems}: nothing can be relaxed`);
const glist = [...groups.values()];
let relaxations, conflicts;
if (minItems === 1) {
relaxations = T.minimalSets(glist.map(g => g.mask), null);      // polynomial: not budgeted
conflicts = T.minimalTransversals(relaxations, budget);
} else {
relaxations = T.levelwise(k, maxSize, glist.length, budget, r => { let count = 0; for (const g of glist) if ((g.mask & ~r) === ZERO) count += g.rows.length; return count >= minItems; });
conflicts = T.levelwise(k, maxSize, glist.length, budget, s => { let count = 0; for (const g of glist) if ((g.mask & s) === ZERO) count += g.rows.length; return count < minItems; });
}
relaxations = T.sortMasks(relaxations);
conflicts = T.sortMasks(conflicts);
const extremes = {};
const globalBounds = c => extremes[c.attr] ??= (() => {
let lo = Infinity, hi = -Infinity;
for (const v of c.values) if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
return {lo, hi};
})();
const bound = (j, keep) => {
const c = compiled[j], found = [];
for (const g of glist) if (keep(g.mask)) for (const i of g.rows) if (!Number.isNaN(c.values[i])) found.push(c.values[i]);
if (found.length < minItems) return null;
const {lo, hi} = globalBounds(c);
const values = Float64Array.from(found).sort();
if (c.le) { const v = values[minItems - 1]; return v !== hi ? v : null; }
const v = values[values.length - minItems];
return v !== lo ? v : null;
};
const adaptCost = (j, value) => {
const {lo, hi} = globalBounds(compiled[j]);
return hi > lo ? Math.min(1, Math.abs(value - compiled[j].bound) / (hi - lo)) : 1;
};
const clear = j => ({constraint: j, adapt: false, value: null, cost: 1});
const adapt = (j, value) => ({constraint: j, adapt: true, value, cost: adaptCost(j, value)});
const adaptedBound = (j, keep) => {
const value = bound(j, keep);
const effective = value === null ? null : adaptTo(j, value);
return effective === null || effective === undefined ? null : {value, effective};
};
for (const r of relaxations) {
const members = T.indexes(r);
if (maxSize > 0 && members.length > maxSize) continue;
const inside = mask => (mask & ~r) === ZERO;
const make = (changes, j, effective) => {
let results = 0;
for (const g of glist) {
if (!inside(g.mask)) continue;
if (j < 0) results += g.rows.length;
else for (const i of g.rows) { const x = compiled[j].values[i]; if (compiled[j].le ? x <= effective : x >= effective) results++; }      // NaN (NULL) fails both
}
let cost = 0;
for (const change of changes) cost += change.cost;
return {changes, results, cost};
};
const variants = [];
for (const j of members) {
if (!compiled[j].adaptable) continue;
const found = adaptedBound(j, inside);
if (found !== null) variants.push(make(members.map(t => t === j ? adapt(t, found.value) : clear(t)), j, found.effective));
}
result.grs.push(...(variants.length ? variants : [make(members.map(clear), -1, 0)]));
}
for (const s of conflicts) {
const members = T.indexes(s);
if (maxSize > 0 && members.length > maxSize) continue;
result.mcs.push({
constraints: members,
local: members.map(j => {
if (!compiled[j].adaptable) return clear(j);
const rest = s & ~(big ? 1n << BigInt(j) : 1 << j);
const found = adaptedBound(j, mask => (mask & rest) === ZERO);
return found === null ? clear(j) : adapt(j, found.value);
}),
});
}
if (order === "cost") {
const byCost = list => list.map((item, index) => ({item, index})).sort((a, b) => a.item.cost - b.item.cost || a.index - b.index).map(entry => entry.item);
result.grs = byCost(result.grs);
for (const conflict of result.mcs) conflict.local = byCost(conflict.local);
}
return result;
}
return {MAX_CONSTRAINTS, DEFAULT_MAX_WORK, TooComplexError, analyze};
})();
const m_src_engine = (() => {
const {analyze, MAX_CONSTRAINTS} = m_src_cbte;
const ENGINE_OPS = {eq: "=", ne: "!=", le: "<=", ge: ">=", in: "in", notIn: "not in", allOf: "allOf", anyOf: "anyOf", noneOf: "noneOf"};
const LIST_OPS = new Set(["in", "notIn", "allOf", "anyOf", "noneOf"]);
const KINDS = new Set(["numeric", "text", "set"]);
/** Checks the shape of the constraints the host returned; returns plain copies. */
function checkConstraints(constraints) {
if (!Array.isArray(constraints)) throw new Error("getConstraints() must return an array");
if (constraints.length > MAX_CONSTRAINTS) throw new Error(`at most ${MAX_CONSTRAINTS} constraints are supported, got ${constraints.length}`);
return constraints.map((c, i) => {
const where = `constraint ${i}`;
if (!c || typeof c.attr !== "string" || !c.attr) throw new Error(`${where}: attr must be a non-empty string`);
if (!Object.hasOwn(ENGINE_OPS, c.op)) throw new Error(`${where}: unknown op "${c.op}" (use ${Object.keys(ENGINE_OPS).join(", ")})`);
if (LIST_OPS.has(c.op)) {
if (!Array.isArray(c.values) || !c.values.length) throw new Error(`${where}: op "${c.op}" needs a non-empty "values" array`);
return {attr: c.attr, op: c.op, values: [...c.values]};
}
if (c.value === undefined || c.value === null || Array.isArray(c.value)) throw new Error(`${where}: op "${c.op}" needs a scalar "value"`);
return {attr: c.attr, op: c.op, value: c.value};
});
}
const toEngine = c => ({attr: c.attr, op: ENGINE_OPS[c.op], value: LIST_OPS.has(c.op) ? c.values : c.value});
const fromEngine = r => ({constraint: r.constraint, action: r.adapt ? "adapt" : "clear", value: r.adapt ? r.value : null, cost: r.cost});
/** Client mode: analyse `rows` (array of objects) with the vendored engine. `attributes[attr].kind` is numeric, text or set. Throws on a malformed query, and a `TooComplexError` when the work budget is exceeded. */
function analyzeRows(rows, attributes, constraints, {minItems = 1, maxSize = 0, maxWork, order = "cost"} = {}) {
const schema = {};
for (const c of constraints) {
const kind = attributes?.[c.attr]?.kind;
if (!KINDS.has(kind)) throw new Error(`attribute "${c.attr}" must be declared with kind numeric, text or set`);
schema[c.attr] = kind;
}
const result = analyze(rows, schema, constraints.map(toEngine), maxWork === undefined ? {minItems, maxSize, order} : {minItems, maxSize, order, maxWork});    // maxWork: the engine default unless a test sets it
return {
matching: result.matching, success: result.success,
relaxations: result.grs.map(g => ({changes: g.changes.map(fromEngine), results: g.results, cost: g.cost})),
conflicts: result.mcs.map(m => ({constraints: m.constraints, local: m.local.map(fromEngine)})),
};
}
/** Server mode: the JSON of POST .../explain, checked against the constraints that were sent. */
function normalizeServer(json, constraintCount) {
const bad = what => { throw new Error(`unexpected server response: ${what}`); };
if (!json || typeof json !== "object") bad("not an object");
if (typeof json.success !== "boolean") bad("missing success");
const index = i => Number.isInteger(i) && i >= 0 && i < constraintCount ? i : bad(`constraint index ${i} out of range`);
const change = r => {
if (!r || (r.action !== "clear" && r.action !== "adapt")) bad("relaxation action must be clear or adapt");
if (r.action === "adapt" && !Number.isFinite(r.value)) bad("an adapt relaxation needs a numeric value");
if (!Number.isFinite(r.cost) || r.cost < 0) bad("a relaxation needs a cost");
return {constraint: index(r.constraint), action: r.action, value: r.action === "adapt" ? r.value : null, cost: r.cost};
};
const relaxation = g => {
if (!g || !Number.isInteger(g.results) || g.results < 0) bad("a relaxation needs a results count");
return {changes: list(g.changes, "a relaxation's changes").map(change), results: g.results, cost: Number.isFinite(g.cost) ? g.cost : bad("a relaxation needs a cost")};
};
const list = (x, what) => Array.isArray(x ?? []) ? x ?? [] : bad(`${what} must be an array`);
return {
matching: json.matching ?? null, success: json.success, tookMs: json.tookMs ?? null,
relaxations: list(json.relaxations, "relaxations").map(relaxation),
conflicts: list(json.conflicts, "conflicts").map(k => ({constraints: list(k.constraints, "conflict constraints").map(index), local: list(k.local, "conflict local").map(change)})),
};
}
/** The constraints after a relaxation: cleared ones removed, adapted ones with their new bound. Pure helper for hosts that keep a filter state object. */
function relaxedConstraints(relaxation, constraints) {
const by = new Map(relaxation.changes.map(c => [c.index, c]));
return constraints.flatMap((c, i) => {
const change = by.get(i);
return !change ? [c] : change.action === "clear" ? [] : [{...c, value: change.value}];
});
}
return {LIST_OPS, KINDS, checkConstraints, analyzeRows, normalizeServer, relaxedConstraints};
})();
const m_src_locales_en = (() => {
const en = {
region: "Search help",
action: "Any of these changes gives results:",
actionMin: {one: "Any of these changes gives at least {minItems} result:", other: "Any of these changes gives at least {minItems} results:"},
why: "Why?",
none: "No results with {list}",
noneMin: {one: "Fewer than {minItems} result with {list}", other: "Fewer than {minItems} results with {list}"},
and: "and", or: "or", plus: "+",
clear: "Clear {what}",
change: "{to} (instead of {from})",
was: "was {from}",
more: "and {count} more",
results: {one: "{count} result", other: "{count} results"},
applied: "Applied: {text}", undo: "Undo", undone: "Filters restored",
eq: "{label} is {value}", ne: "{label} is not {value}",
le: "{label} ≤ {value}", ge: "{label} ≥ {value}",
in: "{label} is {values}", notIn: "{label} is none of {values}",
allOf: "{label}: {values}", anyOf: "{label}: {values}", noneOf: "{label}: none of {values}",
minBefore: "Warn me if fewer than", minAfter: {one: "result", other: "results"}, minTitle: "Minimum number of results before the explanation appears",
unlicensed: "Unlicensed copy",
rowsLimit: "Too many rows to analyse in the browser ({rows} > {max}).",
failed: "The explanation is unavailable right now.",
tooComplex: "These filters are too complex to explain. Remove a few and try again.",
};
return {en};
})();
const m_src_locales_ca = (() => {
const ca = {
region: "Ajuda per a la cerca",
action: "Qualsevol d'aquests canvis dona resultats:",
actionMin: {one: "Qualsevol d'aquests canvis dona almenys {minItems} resultat:", many: "Qualsevol d'aquests canvis dona almenys {minItems} de resultats:", other: "Qualsevol d'aquests canvis dona almenys {minItems} resultats:"},
why: "Per què?",
none: "Cap resultat amb {list}",
noneMin: {one: "Menys de {minItems} resultat amb {list}", many: "Menys de {minItems} de resultats amb {list}", other: "Menys de {minItems} resultats amb {list}"},
and: "i", or: "o", plus: "+",
clear: "Esborra {what}",
change: "{to} (en lloc de {from})",
was: "era {from}",
more: "i {count} més",
results: {one: "{count} resultat", many: "{count} de resultats", other: "{count} resultats"},
applied: "Aplicat: {text}", undo: "Desfés", undone: "Filtres restaurats",
eq: "{label} és {value}", ne: "{label} no és {value}",
le: "{label} ≤ {value}", ge: "{label} ≥ {value}",
in: "{label} és {values}", notIn: "{label} no és cap de {values}",
allOf: "{label}: {values}", anyOf: "{label}: {values}", noneOf: "{label}: cap de {values}",
minBefore: "Avisa'm si hi ha menys de", minAfter: {one: "resultat", many: "resultats", other: "resultats"}, minTitle: "Nombre mínim de resultats per sota del qual apareix l'explicació",
unlicensed: "Còpia sense llicència",
rowsLimit: "Hi ha massa files per analitzar al navegador ({rows} > {max}).",
failed: "L'explicació no està disponible ara mateix.",
tooComplex: "Aquests filtres són massa complexos per explicar-los. Prova de treure'n alguns.",
};
return {ca};
})();
const m_src_locales_es = (() => {
const es = {
region: "Ayuda para la búsqueda",
action: "Cualquiera de estos cambios da resultados:",
actionMin: {one: "Cualquiera de estos cambios da al menos {minItems} resultado:", many: "Cualquiera de estos cambios da al menos {minItems} de resultados:", other: "Cualquiera de estos cambios da al menos {minItems} resultados:"},
why: "¿Por qué?",
none: "Ningún resultado con {list}",
noneMin: {one: "Menos de {minItems} resultado con {list}", many: "Menos de {minItems} de resultados con {list}", other: "Menos de {minItems} resultados con {list}"},
and: "y", or: "o", plus: "+",
clear: "Borrar {what}",
change: "{to} (en lugar de {from})",
was: "era {from}",
more: "y {count} más",
results: {one: "{count} resultado", many: "{count} de resultados", other: "{count} resultados"},
applied: "Aplicado: {text}", undo: "Deshacer", undone: "Filtros restaurados",
eq: "{label} es {value}", ne: "{label} no es {value}",
le: "{label} ≤ {value}", ge: "{label} ≥ {value}",
in: "{label} es {values}", notIn: "{label} no es ninguno de {values}",
allOf: "{label}: {values}", anyOf: "{label}: {values}", noneOf: "{label}: ninguno de {values}",
minBefore: "Avísame si hay menos de", minAfter: {one: "resultado", many: "resultados", other: "resultados"}, minTitle: "Número mínimo de resultados por debajo del cual aparece la explicación",
unlicensed: "Copia sin licencia",
rowsLimit: "Hay demasiadas filas para analizar en el navegador ({rows} > {max}).",
failed: "La explicación no está disponible en este momento.",
tooComplex: "Estos filtros son demasiado complejos para explicarlos. Prueba a quitar algunos.",
};
return {es};
})();
const m_src_locales_fr = (() => {
const fr = {
region: "Aide à la recherche",
action: "L'un de ces changements donne des résultats :",
actionMin: {one: "L'un de ces changements donne au moins {minItems} résultat :", many: "L'un de ces changements donne au moins {minItems} de résultats :", other: "L'un de ces changements donne au moins {minItems} résultats :"},
why: "Pourquoi ?",
none: "Aucun résultat avec {list}",
noneMin: {one: "Moins de {minItems} résultat avec {list}", many: "Moins de {minItems} de résultats avec {list}", other: "Moins de {minItems} résultats avec {list}"},
and: "et", or: "ou", plus: "+",
clear: "Effacer {what}",
change: "{to} (au lieu de {from})",
was: "était {from}",
more: "et {count} de plus",
results: {one: "{count} résultat", many: "{count} de résultats", other: "{count} résultats"},
applied: "Appliqué : {text}", undo: "Annuler", undone: "Filtres rétablis",
eq: "{label} est {value}", ne: "{label} n'est pas {value}",
le: "{label} ≤ {value}", ge: "{label} ≥ {value}",
in: "{label} est {values}", notIn: "{label} n'est aucun de {values}",
allOf: "{label} : {values}", anyOf: "{label} : {values}", noneOf: "{label} : aucun de {values}",
minBefore: "Me prévenir s'il y a moins de", minAfter: {one: "résultat", many: "résultats", other: "résultats"}, minTitle: "Nombre minimal de résultats en dessous duquel l'explication apparaît",
unlicensed: "Copie sans licence",
rowsLimit: "Trop de lignes à analyser dans le navigateur ({rows} > {max}).",
failed: "L'explication n'est pas disponible pour le moment.",
tooComplex: "Ces filtres sont trop complexes à expliquer. Essayez d'en retirer quelques-uns.",
};
return {fr};
})();
const m_src_locales_pt = (() => {
const pt = {
region: "Ajuda para a busca",
action: "Qualquer uma destas mudanças gera resultados:",
actionMin: {one: "Qualquer uma destas mudanças gera pelo menos {minItems} resultado:", many: "Qualquer uma destas mudanças gera pelo menos {minItems} de resultados:", other: "Qualquer uma destas mudanças gera pelo menos {minItems} resultados:"},
why: "Por quê?",
none: "Nenhum resultado com {list}",
noneMin: {one: "Menos de {minItems} resultado com {list}", many: "Menos de {minItems} de resultados com {list}", other: "Menos de {minItems} resultados com {list}"},
and: "e", or: "ou", plus: "+",
clear: "Limpar {what}",
change: "{to} (em vez de {from})",
was: "era {from}",
more: "e mais {count}",
results: {one: "{count} resultado", many: "{count} de resultados", other: "{count} resultados"},
applied: "Aplicado: {text}", undo: "Desfazer", undone: "Filtros restaurados",
eq: "{label} é {value}", ne: "{label} não é {value}",
le: "{label} ≤ {value}", ge: "{label} ≥ {value}",
in: "{label} é {values}", notIn: "{label} não é nenhum de {values}",
allOf: "{label}: {values}", anyOf: "{label}: {values}", noneOf: "{label}: nenhum de {values}",
minBefore: "Avise-me se houver menos de", minAfter: {one: "resultado", many: "resultados", other: "resultados"}, minTitle: "Número mínimo de resultados abaixo do qual a explicação aparece",
unlicensed: "Cópia sem licença",
rowsLimit: "Há linhas demais para analisar no navegador ({rows} > {max}).",
failed: "A explicação não está disponível no momento.",
tooComplex: "Esses filtros são complexos demais para explicar. Tente remover alguns.",
};
return {pt};
})();
const m_src_locales_zh = (() => {
const zh = {
region: "搜索帮助",
action: "任意一项调整都会带来结果：",
actionMin: "任意一项调整都至少带来 {minItems} 个结果：",
why: "为什么？",
none: "{list} 没有结果",
noneMin: "{list} 的结果少于 {minItems} 个",
and: "和", or: "或", plus: "+",
clear: "清除{what}",
change: "{to}（原为 {from}）",
was: "原为 {from}",
more: "另有 {count} 项",
results: "{count} 个结果",
applied: "已应用：{text}", undo: "撤销", undone: "已恢复筛选条件",
eq: "{label}为 {value}", ne: "{label}不是 {value}",
le: "{label} ≤ {value}", ge: "{label} ≥ {value}",
in: "{label}为 {values}", notIn: "{label}不是 {values} 中的任何一个",
allOf: "{label}：{values}", anyOf: "{label}：{values}", noneOf: "{label}：不含 {values} 中任何一项",
minBefore: "结果少于", minAfter: "个时提醒我", minTitle: "低于该结果数量时才显示说明",
unlicensed: "未授权副本",
rowsLimit: "行数过多，无法在浏览器中分析（{rows} > {max}）。",
failed: "暂时无法提供说明。",
tooComplex: "这些筛选条件过于复杂，无法解释。请删除几个后重试。",
};
return {zh};
})();
const m_src_locales_ja = (() => {
const ja = {
region: "検索のヒント",
action: "次のどの変更でも結果が表示されます：",
actionMin: "次のどの変更でも{minItems}件以上の結果が表示されます：",
why: "なぜ？",
none: "{list}では結果がありません",
noneMin: "{list}では結果が{minItems}件未満です",
and: "と", or: "または", plus: "+",
clear: "{what}をクリア",
change: "{to}（変更前：{from}）",
was: "元：{from}",
more: "ほか{count}件",
results: "{count}件",
applied: "適用しました：{text}", undo: "元に戻す", undone: "絞り込み条件を元に戻しました",
eq: "{label}は{value}", ne: "{label}は{value}以外",
le: "{label} ≤ {value}", ge: "{label} ≥ {value}",
in: "{label}が{values}のいずれか", notIn: "{label}が{values}のいずれでもない",
allOf: "{label}：{values}", anyOf: "{label}：{values}", noneOf: "{label}：{values}のいずれも含まない",
minBefore: "結果が", minAfter: "件未満のとき通知する", minTitle: "この件数を下回ると説明が表示されます",
unlicensed: "ライセンスのないコピー",
rowsLimit: "行数が多すぎるため、ブラウザーでは分析できません（{rows} > {max}）。",
failed: "現在、説明を表示できません。",
tooComplex: "絞り込み条件が複雑すぎて説明できません。いくつか外して、もう一度お試しください。",
};
return {ja};
})();
const m_src_locales_ar = (() => {
const ar = {
region: "مساعدة البحث",
action: "أي من هذه التعديلات يعطي نتائج:",
actionMin: {zero: "أي من هذه التعديلات يعطي {minItems} نتيجة على الأقل:", one: "أي من هذه التعديلات يعطي نتيجة واحدة على الأقل:", two: "أي من هذه التعديلات يعطي نتيجتين على الأقل:", few: "أي من هذه التعديلات يعطي {minItems} نتائج على الأقل:", many: "أي من هذه التعديلات يعطي {minItems} نتيجة على الأقل:", other: "أي من هذه التعديلات يعطي {minItems} نتيجة على الأقل:"},
why: "لماذا؟",
none: "لا توجد نتائج مع {list}",
noneMin: {zero: "أقل من {minItems} نتيجة مع {list}", one: "أقل من نتيجة واحدة مع {list}", two: "أقل من نتيجتين مع {list}", few: "أقل من {minItems} نتائج مع {list}", many: "أقل من {minItems} نتيجة مع {list}", other: "أقل من {minItems} نتيجة مع {list}"},
and: "و", or: "أو", plus: "+",
clear: "مسح {what}",
change: "{to} (بدلاً من {from})",
was: "كان {from}",
more: {zero: "و{count} أخرى", one: "وواحدة أخرى", two: "واثنتان أخريان", few: "و{count} أخرى", many: "و{count} أخرى", other: "و{count} أخرى"},
results: {zero: "لا توجد نتائج", one: "نتيجة واحدة", two: "نتيجتان", few: "{count} نتائج", many: "{count} نتيجة", other: "{count} نتيجة"},
applied: "تم التطبيق: {text}", undo: "تراجع", undone: "تمت استعادة المرشحات",
eq: "{label} هو {value}", ne: "{label} ليس {value}",
le: "{label} ⁦≤ {value}⁩", ge: "{label} ⁦≥ {value}⁩",
in: "{label} هو {values}", notIn: "{label} ليس أياً من {values}",
allOf: "{label}: {values}", anyOf: "{label}: {values}", noneOf: "{label}: لا شيء من {values}",
minBefore: "نبّهني إذا كان عدد النتائج أقل من", minAfter: "", minTitle: "الحد الأدنى لعدد النتائج الذي يظهر دونه الشرح",
unlicensed: "نسخة بدون ترخيص",
rowsLimit: "عدد الصفوف كبير جداً للتحليل في المتصفح (⁦{rows} > {max}⁩).",
failed: "الشرح غير متاح حالياً.",
tooComplex: "هذه المرشحات معقدة جداً لشرحها. أزل بعضها وحاول مرة أخرى.",
};
return {ar};
})();
const m_src_texts = (() => {
const {en} = m_src_locales_en;
const {ca} = m_src_locales_ca;
const {es} = m_src_locales_es;
const {fr} = m_src_locales_fr;
const {pt} = m_src_locales_pt;
const {zh} = m_src_locales_zh;
const {ja} = m_src_locales_ja;
const {ar} = m_src_locales_ar;
const TEXTS = {en, ca, es, fr, pt, zh, ja, ar};
const LANGUAGES = Object.keys(TEXTS);
const RTL_LANGUAGES = ["ar"];
const DEFAULT_TEXTS = en;
/** The parameter whose value chooses the plural form of a key. Only these keys may be plural objects. */
const PLURAL_PARAM = {actionMin: "minItems", noneMin: "minItems", minAfter: "minItems", more: "count", results: "count"};
const CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
/** "fr-CH" -> "fr", "ZH_hant" -> "zh", an unknown or missing language -> "en". */
function resolveLang(tag) {
if (tag === undefined || tag === null || tag === "") return "en";
if (typeof tag !== "string") throw new Error(`Loosen: option lang must be a language tag such as "fr" (got ${typeof tag})`);
const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
return LANGUAGES.includes(primary) ? primary : "en";
}
const isRtl = lang => RTL_LANGUAGES.includes(lang);
/** The locale for numbers: the explicit one, else the language tag when Intl knows it, else the resolved language. */
function resolveLocale(locale, tag, lang) {
if (locale) return locale;
try { if (typeof tag === "string" && tag.trim()) return Intl.getCanonicalLocales(tag.trim().replace(/_/g, "-"))[0]; } catch { /* not a valid tag */ }
return lang;
}
/** Numbers are always written with Latin digits (also in Arabic), so a count reads the same as in the host's data. */
const numberFormat = locale => {
try { return new Intl.NumberFormat(locale || undefined, {numberingSystem: "latn"}); }
catch { return new Intl.NumberFormat(undefined, {numberingSystem: "latn"}); }
};
function check(overrides) {
for (const [key, value] of Object.entries(overrides)) {
if (!Object.hasOwn(DEFAULT_TEXTS, key)) throw new Error(`unknown text "${key}" (known: ${Object.keys(DEFAULT_TEXTS).join(", ")})`);
if (typeof value === "string" || typeof value === "function") continue;
if (value && typeof value === "object" && !Array.isArray(value)) {
if (!Object.hasOwn(PLURAL_PARAM, key)) throw new Error(`text "${key}" cannot be an object: only ${Object.keys(PLURAL_PARAM).join(", ")} have plural forms`);
for (const category of Object.keys(value)) if (!CATEGORIES.includes(category)) throw new Error(`text "${key}": unknown plural category "${category}" (use ${CATEGORIES.join(", ")})`);
if (typeof value.other !== "string") throw new Error(`text "${key}": the plural form "other" is required`);
continue;
}
throw new Error(`text "${key}" must be a string, a function or (for ${Object.keys(PLURAL_PARAM).join(", ")}) an object of plural forms`);
}
}
/** -> t(key, params): the text for a key in the language, with {placeholders} filled in. `count` and `minItems` are numbers: they choose the plural form and are written in the locale's format. */
function makeTexts(overrides = {}, lang = "en", locale) {
check(overrides);
const all = {...TEXTS[lang], ...overrides}, rules = new Intl.PluralRules(lang), number = numberFormat(locale ?? lang);
return (key, params = {}) => {
let text = all[key];
if (typeof text === "function") return text(params);
if (typeof text === "object") { const form = text[rules.select(params[PLURAL_PARAM[key]])]; text = form ?? text.other; }
return text.replace(/\{(\w+)\}/g, (_, name) => { const v = params[name]; return typeof v === "number" && (name === "count" || name === "minItems") ? number.format(v) : String(v ?? ""); });
};
}
return {TEXTS, LANGUAGES, RTL_LANGUAGES, DEFAULT_TEXTS, PLURAL_PARAM, resolveLang, isRtl, resolveLocale, numberFormat, makeTexts};
})();
const m_src_present = (() => {
const {LIST_OPS} = m_src_engine;
const {numberFormat} = m_src_texts;
const SYMBOL = {le: "≤", ge: "≥"};
/** -> {format(attr, value), label(attr), describe(constraint), clauses(constraint)}: how attribute values and constraints read. */
function formatter(attributes, t, locale, rtl = false) {
const number = numberFormat(locale);
const label = attr => attributes?.[attr]?.label ?? attr;
const format = (attr, value) => attributes?.[attr]?.format ? attributes[attr].format(value) : typeof value === "number" ? number.format(value) : String(value);
const joiner = {in: t("or"), anyOf: t("or"), allOf: t("and")};
const describe = c => {
if (LIST_OPS.has(c.op)) return t(c.op, {label: label(c.attr), values: c.values.map(v => format(c.attr, v)).join(joiner[c.op] ? ` ${joiner[c.op]} ` : ", ")});
return t(c.op, {label: label(c.attr), value: format(c.attr, c.value)});
};
const isolate = text => rtl ? `\u2066${text}\u2069` : text;
return {format, label, describe, isolate};
}
/**
* -> {kind, text, label, was, changes, results}: one chip. `text` is the concise wording ("Rent ≤ 706 CHF"); `was` the original bounds ("was ≤ 500 CHF", "" when nothing was adapted);
* `label` the full phrase for assistive technology ("Rent ≤ 706 CHF (instead of ≤ 500 CHF)"). `changes[i] = {index, attr, op, action, value, from}`; `from` is the old bound of an adapted constraint, else null.
* `results` is the number of items the query would give if the chip were applied (global chips only, `null` for a local one or when `results` is not given).
* An adapt relaxation of anything but le / ge is turned into a clear (the host cannot be asked to invent a value).
*/
function chip(kind, relaxation, constraints, fmt, t, results = null) {
const counts = new Map();
for (const c of constraints) counts.set(c.attr, (counts.get(c.attr) ?? 0) + 1);
const changes = relaxation.map(r => {
const c = constraints[r.constraint], adapt = r.action === "adapt" && c.op in SYMBOL;
return {index: r.constraint, attr: c.attr, op: c.op, action: adapt ? "adapt" : "clear", value: adapt ? r.value : null, from: adapt ? c.value : null};
});
const adapted = changes.filter(ch => ch.action === "adapt").length;
const parts = changes.map(ch => {
if (ch.action === "adapt") {
const symbol = SYMBOL[ch.op], to = `${fmt.label(ch.attr)} ${fmt.isolate(`${symbol} ${fmt.format(ch.attr, ch.value)}`)}`, from = fmt.isolate(`${symbol} ${fmt.format(ch.attr, ch.from)}`);
return {short: to, full: t("change", {to, from}), was: adapted > 1 ? `${fmt.label(ch.attr)} ${from}` : from};
}
const text = t("clear", {what: counts.get(ch.attr) === 1 ? fmt.label(ch.attr) : fmt.describe(constraints[ch.index])});
return {short: text, full: text, was: null};
});
const join = key => parts.map(p => p[key]).join(` ${t("plus")} `);
const was = parts.filter(p => p.was).map(p => p.was).join(", ");
return {kind, text: join("short"), label: join("full"), was: was ? t("was", {from: was}) : "", changes, results};
}
/** "1 result", "12 results", "1,234 results": the plural form of the language, the number in the locale's format (both done by `t`). */
const resultsText = (count, t) => t("results", {count});
/** The whole panel model, or null when there is nothing to show. */
function present(result, constraints, {attributes, t, locale, rtl = false, minItems, limit = 8, why = "collapsed", showResults = true}) {
const fmt = formatter(attributes, t, locale, rtl);
const relaxations = result.relaxations.map(r => chip("global", r.changes, constraints, fmt, t, showResults ? r.results : null));
const conflicts = why === "hidden" ? [] : result.conflicts.filter(k => k.constraints.length >= 2).map(k => {
const list = k.constraints.map(i => fmt.describe(constraints[i])).join(` ${t("and")} `);
return {
text: minItems === 1 ? t("none", {list}) : t("noneMin", {minItems, list}),
local: k.local.map(r => chip("local", [r], constraints, fmt, t)),         // no result count: a local relaxation answers a sub-query (see the guide)
};
});
if (!relaxations.length && !conflicts.length) return null;
return {
action: !relaxations.length ? "" : minItems === 1 ? t("action") : t("actionMin", {minItems}),
relaxations: relaxations.slice(0, limit), moreRelaxations: Math.max(0, relaxations.length - limit),
why: conflicts.length ? t("why") : "",
conflicts: conflicts.slice(0, limit), moreConflicts: Math.max(0, conflicts.length - limit),
};
}
return {formatter, chip, resultsText, present};
})();
const m_src_licence = (() => {
const PRODUCTION_PUBLIC_KEY = "WEinOKoIJTTP3JSWx_tJ16tRPZ2WRAjAhVEfHtb11Sg";   // the public key of the production licence key (32 raw bytes, base64url). The private key is held by the Loosen shop (loosen.sicena.com), never by this repository.
const UNLICENSED_MAX_ITEMS = 1000;
const enc = new TextEncoder();
function b64uDecode(text) {
if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");      // strict: no padding, no '+' or '/'
const s = text.replace(/-/g, "+").replace(/_/g, "/");
const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
return Uint8Array.from(bin, c => c.charCodeAt(0));
}
const publicKeyBytes = key => {
const bytes = /^[0-9a-f]{64}$/i.test(key) ? Uint8Array.from(key.match(/../g), h => parseInt(h, 16)) : b64uDecode(key.trim().replace(/=+$/, ""));
if (bytes.length !== 32) throw new Error("public key must be 32 bytes");
return bytes;
};
const M64 = (1n << 64n) - 1n;
function iroot(n, k) {                                   // floor(n^(1/k)) by Newton's method
const K = BigInt(k);
let x = 1n << BigInt(Math.ceil(n.toString(2).length / k) + 1);
for (;;) { const y = ((K - 1n) * x + n / x ** (K - 1n)) / K; if (y >= x) return x; x = y; }
}
const PRIMES = []; for (let n = 2; PRIMES.length < 80; n++) if (PRIMES.every(p => n % p)) PRIMES.push(n);
const SHA_K = PRIMES.map(p => iroot(BigInt(p) << 192n, 3) & M64);
const SHA_H = PRIMES.slice(0, 8).map(p => iroot(BigInt(p) << 128n, 2) & M64);
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M64;
function sha512(message) {
const len = message.length, padded = new Uint8Array(Math.ceil((len + 17) / 128) * 128);
padded.set(message); padded[len] = 0x80;
new DataView(padded.buffer).setBigUint64(padded.length - 8, BigInt(len) * 8n);
const H = SHA_H.slice(), view = new DataView(padded.buffer), w = new Array(80);
for (let off = 0; off < padded.length; off += 128) {
for (let i = 0; i < 16; i++) w[i] = view.getBigUint64(off + i * 8);
for (let i = 16; i < 80; i++) {
const s0 = rotr(w[i - 15], 1n) ^ rotr(w[i - 15], 8n) ^ (w[i - 15] >> 7n), s1 = rotr(w[i - 2], 19n) ^ rotr(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
}
let [a, b, c, d, e, f, g, h] = H;
for (let i = 0; i < 80; i++) {
const t1 = (h + (rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n)) + ((e & f) ^ (~e & M64 & g)) + SHA_K[i] + w[i]) & M64;
const t2 = ((rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & M64;
h = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
}
[a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) & M64; });
}
const out = new Uint8Array(64), dv = new DataView(out.buffer);
H.forEach((v, i) => dv.setBigUint64(i * 8, v));
return out;
}
const P = (1n << 255n) - 19n, L = (1n << 252n) + 27742317777372353535851937790883648493n;
const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
const pow = (b, e, m = P) => { let r = 1n; b = mod(b, m); for (; e > 0n; e >>= 1n, b = b * b % m) if (e & 1n) r = r * b % m; return r; };
const inv = a => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n)), SQRT_M1 = pow(2n, (P - 1n) / 4n);
const leToInt = bytes => bytes.reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);
function decodePoint(bytes) {
const sign = bytes[31] >> 7, y = leToInt(Uint8Array.from(bytes, (b, i) => i === 31 ? b & 0x7f : b));
if (y >= P) return null;
const y2 = y * y % P, x2 = mod((y2 - 1n) * inv(D * y2 + 1n));
let x = pow(x2, (P + 3n) / 8n);
if (mod(x * x - x2) !== 0n) x = x * SQRT_M1 % P;
if (mod(x * x - x2) !== 0n) return null;
if (x === 0n && sign) return null;
if (Number(x & 1n) !== sign) x = P - x;
return [x, y, 1n, x * y % P];
}
function add([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) {
const A = (Y1 - X1) * (Y2 - X2) % P, B = (Y1 + X1) * (Y2 + X2) % P, C = T1 * 2n * D * T2 % P, E0 = Z1 * 2n * Z2 % P;
const E = mod(B - A), F = mod(E0 - C), G = E0 + C, H = B + A;
return [E * F % P, G * H % P, F * G % P, E * H % P];
}
function multiply(point, n) {
let result = [0n, 1n, 1n, 0n];
for (; n > 0n; n >>= 1n, point = add(point, point)) if (n & 1n) result = add(result, point);
return result;
}
const samePoint = (a, b) => mod(a[0] * b[2] - b[0] * a[2]) === 0n && mod(a[1] * b[2] - b[1] * a[2]) === 0n;
const BASE = decodePoint(Uint8Array.from([0x58, ...new Array(31).fill(0x66)]));
/** Ed25519 verification in pure JS (RFC 8032, cofactorless equation as in Go's crypto/ed25519). */
function verifyEd25519Js(publicKey, message, signature) {
if (signature.length !== 64 || publicKey.length !== 32) return false;
const A = decodePoint(publicKey), R = decodePoint(signature.subarray(0, 32)), S = leToInt(signature.subarray(32));
if (!A || !R || S >= L) return false;
const hash = sha512(Uint8Array.from([...signature.subarray(0, 32), ...publicKey, ...message]));
return samePoint(multiply(BASE, S), add(R, multiply(A, leToInt(hash) % L)));
}
async function verifyEd25519(publicKey, message, signature, {pureJs = false} = {}) {
if (!pureJs && globalThis.crypto?.subtle) {
try {
const key = await crypto.subtle.importKey("raw", publicKey, {name: "Ed25519"}, false, ["verify"]);
return await crypto.subtle.verify({name: "Ed25519"}, key, signature, message);
} catch { /* no Ed25519 in this browser: use the fallback */ }
}
return verifyEd25519Js(publicKey, message, signature);
}
/** Exact host, or `*.x` = any subdomain of x but not x itself. `localhost`, `127.0.0.1` and `*.local` are always allowed. */
function domainAllowed(hostname, domains) {
const host = String(hostname).toLowerCase();
if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) return true;
return (domains ?? []).some(raw => {
const d = String(raw).toLowerCase();
return d.startsWith("*.") ? host.endsWith(d.slice(1)) && host.length > d.length - 1 : host === d;
});
}
const PLANS = new Set(["starter", "business", "trial", "dev"]);
/**
* -> {valid, reason, payload, plan, maxItems, badge}. `reason` is "ok" or one of missing, nokey, format, badsig, expired, domain.
* `badge` is true when the "Powered by Loosen" link must be shown: always for the starter plan, else when payload.badge is true.
* Never throws.
*/
async function verifyLicence(token, publicKey, {hostname = globalThis.location?.hostname ?? "", now = Date.now() / 1000, pureJs = false} = {}) {
const fail = reason => ({valid: false, reason, payload: null, plan: null, maxItems: UNLICENSED_MAX_ITEMS, badge: false});
if (token == null) return fail("missing");
if (!publicKey) return fail("nokey");
let payload, key, signature;
const parts = String(token).split(".");
try {
if (parts.length !== 3 || parts[0] !== "LSN1") return fail("format");
payload = JSON.parse(new TextDecoder().decode(b64uDecode(parts[1])));
signature = b64uDecode(parts[2]);
key = publicKeyBytes(publicKey);
} catch { return fail("format"); }
if (!payload || payload.v !== 1 || !PLANS.has(payload.plan) || !Array.isArray(payload.domains) || !Number.isFinite(payload.exp) || !Number.isFinite(payload.maxItems)) return fail("format");
if (!await verifyEd25519(key, enc.encode(`${parts[0]}.${parts[1]}`), signature, {pureJs})) return fail("badsig");
if (payload.exp < now) return {...fail("expired"), payload};
if (!domainAllowed(hostname, payload.domains)) return {...fail("domain"), payload};
return {valid: true, reason: "ok", payload, plan: payload.plan, maxItems: payload.maxItems, badge: payload.plan === "starter" || payload.badge === true};
}
const LICENCE_FETCH_TIMEOUT_MS = 3000;
const MAX_TOKEN_CHARS = 4096;
const pageFetches = new WeakMap();             // fetch function -> {licenceUrl -> promise of the body}: one request per page load, however many widgets share the URL
/** The body of `url` if it looks like a token, else null. One plain GET: no credentials, no custom headers, no body; never throws. */
async function fetchToken(url, {fetch, setTimeout, clearTimeout, timeoutMs}) {
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
try {
const response = await fetch(url, {method: "GET", credentials: "omit", cache: "no-store", signal: controller.signal});
if (!response.ok) return null;
const body = (await response.text()).trim();
return body.length <= MAX_TOKEN_CHARS && /^LSN1\.[\w-]+\.[\w-]+$/.test(body) ? body : null;
} catch { return null; }
finally { clearTimeout(timer); }
}
/**
* The licence verdict of the embedded token, replaced by a newer valid one when `licenceUrl` is given: candidates are the embedded token, the one cached in localStorage
* (key `loosen-licence:<licenceUrl>`) and the one fetched now; each is verified exactly like the embedded one (key, domain, expiry) and the valid one with the latest `exp` wins
* (the embedded one on a tie). Any failure (network, timeout, bad body, blocked storage) leaves the others. Resolves to a verdict of verifyLicence plus `source`:
* "embedded", "cache" or "url". Never throws.
*/
async function resolveLicence({token, licenceUrl, publicKey, hostname, now, fetch, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, timeoutMs = LICENCE_FETCH_TIMEOUT_MS, storage = globalThis.localStorage}) {
const check = (candidate, source) => verifyLicence(candidate, publicKey, {hostname, now}).then(verdict => ({...verdict, source}));
const embedded = await check(token, "embedded");
if (!licenceUrl) return embedded;
const key = `loosen-licence:${licenceUrl}`;
let cached = null;
try { cached = storage?.getItem(key) ?? null; } catch { /* storage blocked */ }
let fetched = null;
try {
const requests = pageFetches.get(fetch) ?? pageFetches.set(fetch, new Map()).get(fetch);
if (!requests.has(licenceUrl)) requests.set(licenceUrl, fetchToken(licenceUrl, {fetch, setTimeout, clearTimeout, timeoutMs}));
fetched = await requests.get(licenceUrl);
} catch { /* no fetch in this browser: the others remain */ }
const fromCache = cached === null ? null : await check(cached, "cache");
const fromUrl = fetched === null ? null : await check(fetched, "url");
if (fromUrl?.valid && !(fromCache?.valid && fromCache.payload.exp >= fromUrl.payload.exp)) {
try { storage?.setItem(key, fetched); } catch { /* storage blocked or full: not cached */ }
}
let best = embedded;
for (const candidate of [fromCache, fromUrl]) if (candidate?.valid && (!best.valid || candidate.payload.exp > best.payload.exp)) best = candidate;
return best;
}
return {PRODUCTION_PUBLIC_KEY, UNLICENSED_MAX_ITEMS, b64uDecode, sha512, verifyEd25519Js, domainAllowed, verifyLicence, LICENCE_FETCH_TIMEOUT_MS, resolveLicence};
})();
const m_src_core = (() => {
const {analyzeRows, checkConstraints, normalizeServer} = m_src_engine;
const {present} = m_src_present;
const {PRODUCTION_PUBLIC_KEY, UNLICENSED_MAX_ITEMS, resolveLicence} = m_src_licence;
const {TooComplexError} = m_src_cbte;
const WHY = ["collapsed", "expanded", "hidden"];
const ORIGINAL = ["auto", "tooltip", "inline", "none"];
const ORDER = ["cost", "canonical"];
const REASONS = {
missing: "no licence key was given", nokey: "no publicKey was given", format: "the licence key is malformed", badsig: "the licence key signature is invalid",
expired: "the licence key has expired", domain: "the licence key is not valid for this domain",
};
const browserFetch = globalThis.fetch?.bind(globalThis);          // one bound function, so that widgets on a page share the licenceUrl request
function createCore(options, {render, emit, t, undoChanged = () => {}, fetch = browserFetch, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
hostname = globalThis.location?.hostname ?? "", schedule = globalThis.requestAnimationFrame?.bind(globalThis) ?? (fn => queueMicrotask(fn)), now = () => Date.now() / 1000, performanceNow = () => globalThis.performance?.now() ?? Date.now(), warn = console.warn.bind(console)}) {
const o = {minItems: 1, maxSize: 3, limit: 8, debounceMs: 200, timeoutMs: 8000, autoUpdate: true, locale: undefined, ...options};
o.why ??= "collapsed"; o.original ??= "auto"; o.order ??= "cost"; o.showResults ??= true;
if (!ORDER.includes(o.order)) throw new Error(`Loosen: option order must be ${ORDER.map(w => `"${w}"`).join(" or ")}`);
if (typeof o.showResults !== "boolean") throw new Error("Loosen: option showResults must be true or false");
for (const name of ["restoreConstraints", "onPreview"]) if (o[name] !== undefined && typeof o[name] !== "function") throw new Error(`Loosen: option ${name} must be a function`);
if (!WHY.includes(o.why)) throw new Error(`Loosen: option why must be ${WHY.map(w => `"${w}"`).join(", ")}`);
if (!ORIGINAL.includes(o.original)) throw new Error(`Loosen: option original must be ${ORIGINAL.map(w => `"${w}"`).join(", ")}`);
if (o.licenceUrl !== undefined && (typeof o.licenceUrl !== "string" || !/^https?:\/\//.test(o.licenceUrl))) throw new Error("Loosen: option licenceUrl must be an http(s) URL");
if (typeof o.autoUpdate !== "boolean") throw new Error("Loosen: option autoUpdate must be true or false");
if (typeof o.getConstraints !== "function") throw new Error("Loosen: option getConstraints is required");
const serverMode = !!o.server;
if (serverMode) {
if (!o.server.endpoint || !o.server.catalog) throw new Error("Loosen: server needs endpoint and catalog");
if (o.server.key !== undefined && (typeof o.server.key !== "string" || !/^[\x21-\x7e]{8,128}$/.test(o.server.key))) throw new Error("Loosen: server.key must be the catalog's read key (8 to 128 printable characters)");
if (o.data !== undefined) throw new Error("Loosen: give either data (client mode) or server (server mode), not both");
} else if (o.data === undefined) throw new Error("Loosen: give data (client mode) or server (server mode)");
if (!serverMode && !o.attributes) throw new Error("Loosen: option attributes is required in client mode");
let minItems = o.minItems, seq = 0, destroyed = false, abort = null, timer = null, cancelDebounce = null, lastKey = null, rowsPromise = null;
const doFetch = o.fetch ?? fetch;
const licence = resolveLicence({token: o.licence, licenceUrl: o.licenceUrl, publicKey: o.publicKey ?? PRODUCTION_PUBLIC_KEY, hostname: o.hostname ?? hostname, now: now(), fetch: doFetch, setTimeout, clearTimeout}).then(verdict => {
if (!verdict.valid) warn(`[Loosen] Unlicensed copy: ${REASONS[verdict.reason]}. The widget works, but shows a notice and analyses at most ${UNLICENSED_MAX_ITEMS} rows in the browser.`);
emit({type: "licence", status: verdict.valid ? "valid" : "unlicensed", reason: verdict.reason, plan: verdict.plan, badge: verdict.badge});
return verdict;
});
const finish = (mine, view, event) => {
if (mine !== seq || destroyed) return null;
const key = JSON.stringify([view.kind, view.code, view.model, view.rows]);
render(view);
if (key !== lastKey) { lastKey = key; if (event) emit(event); }
return view;
};
const fail = (mine, code, error) => {
const tooComplex = error instanceof TooComplexError || error?.serverCode === "too_complex";     // the work budget of the engine, in the browser or on the server
return finish(mine, {kind: "error", code: tooComplex ? "too_complex" : code, message: t(tooComplex ? "tooComplex" : "failed")},
{type: "error", code: tooComplex ? "too_complex" : code, message: String(error?.message ?? error)});
};
function loadRows() {
rowsPromise ??= (async () => {
const d = o.data;
const rows = typeof d === "function" ? await d() : typeof d === "string" ? await doFetch(d).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} for ${d}`); return r.json(); }) : d;
if (!Array.isArray(rows)) throw new Error("data must be (or load as) an array of objects");
return rows;
})();
return rowsPromise;
}
async function explainOnServer(constraints, mine) {
abort?.abort();
const controller = abort = new AbortController();
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, o.timeoutMs);
const url = `${o.server.endpoint.replace(/\/+$/, "")}/v1/catalogs/${encodeURIComponent(o.server.catalog)}/explain`;
try {
const response = await doFetch(url, {method: "POST", headers: {"Content-Type": "application/json", ...(o.server.key ? {"X-Loosen-Key": o.server.key} : {})}, body: JSON.stringify({constraints, minItems, maxSize: o.maxSize, order: o.order}), signal: controller.signal, credentials: "omit"});
if (!response.ok) {
let detail = "", serverCode;
try { const j = await response.json(); if (j?.error) { serverCode = j.error; detail = ` (${j.error})`; } } catch { /* no JSON body: the status is enough */ }
throw Object.assign(new Error(`the server answered HTTP ${response.status}${detail}`), {serverCode});
}
return normalizeServer(await response.json(), constraints.length);
} catch (error) {
if (mine !== seq) return null;                           // aborted because a newer update started: not an error
throw timedOut ? new Error(`the server did not answer within ${o.timeoutMs} ms`) : error;
} finally { clearTimeout(timeout); if (abort === controller) abort = null; }
}
async function update() {
const mine = ++seq;
abort?.abort(); cancelDebounce?.();
let constraints;
try { constraints = checkConstraints(o.getConstraints()); } catch (error) { return fail(mine, "constraints", error); }
if (undo && JSON.stringify(constraints) !== undo.appliedKey) forgetUndo();          // the filters were changed by other means: the undo no longer restores "the previous state"
if (!constraints.length) return finish(mine, {kind: "none"});
const verdict = await licence;
if (mine !== seq) return null;
try {
const started = performanceNow();
let result;
if (serverMode) {
if (o.debounceMs > 0 && !await new Promise(resolve => { timer = setTimeout(() => resolve(true), o.debounceMs); cancelDebounce = () => { clearTimeout(timer); resolve(false); }; })) return null;
cancelDebounce = null;
result = await explainOnServer(constraints, mine);
if (!result || mine !== seq) return null;
} else {
let rows;
try { rows = await loadRows(); } catch (error) { rowsPromise = null; return fail(mine, "data", error); }
if (mine !== seq) return null;
const max = verdict.valid ? verdict.maxItems : UNLICENSED_MAX_ITEMS;
if (rows.length > max) return finish(mine, {kind: "limit", rows: rows.length, max}, {type: "error", code: "rows_limit", rows: rows.length, max});
if (rows.length < minItems) return finish(mine, {kind: "none"});     // nothing could give that many results
result = analyzeRows(rows, o.attributes, constraints, {minItems, maxSize: o.maxSize, order: o.order});
}
result.tookMs ??= Math.round((performanceNow() - started) * 10) / 10;
if (result.success) return finish(mine, {kind: "none"});
const model = present(result, constraints, {attributes: o.attributes, t, locale: o.locale, rtl: o.rtl, minItems, limit: o.limit, why: o.why, showResults: o.showResults});
if (!model) return finish(mine, {kind: "none"});
return finish(mine, {kind: "panel", model, result, constraints},
{type: "panel_shown", constraints, relaxations: result.relaxations, conflicts: result.conflicts, mode: serverMode ? "server" : "client", tookMs: result.tookMs});
} catch (error) { return fail(mine, serverMode ? "server" : "analysis", error); }
}
let undo = null;
const forgetUndo = () => { if (undo) { undo = null; undoChanged(null); } };
let autoPending = false;
function afterHostChange(before) {
if (!o.autoUpdate || destroyed || autoPending) return;
autoPending = true;
schedule(() => { autoPending = false; if (!destroyed && seq === before) update(); });
}
async function apply(chip, constraints) {
const before = seq;
let previous = null;
if (o.restoreConstraints) try { previous = checkConstraints(o.getConstraints()); } catch { /* unreadable now: no undo below */ }       // the state as it is at the click, which is what Undo must give back
await o.applyRelaxation(chip, constraints);
if (o.restoreConstraints && !destroyed) {
try { if (!previous) throw new Error("no previous state"); undo = {previous, appliedKey: JSON.stringify(checkConstraints(o.getConstraints())), text: chip.text, changes: chip.changes}; undoChanged({text: chip.text, changes: chip.changes}); }
catch { forgetUndo(); }                                   // the host's state cannot be read now: no undo rather than a wrong one
}
afterHostChange(before);
}
/** Restores the constraints from before the last applied chip. Resolves to `{text, changes}` of the chip that was undone, or null when there was nothing to undo. */
async function undoLast() {
if (!undo) return null;
const done = undo, before = seq;
forgetUndo();
await o.restoreConstraints(JSON.parse(JSON.stringify(done.previous)));
afterHostChange(before);
return {text: done.text, changes: done.changes};
}
return {
update,
apply,
undo: undoLast,
get undoable() { return undo ? {text: undo.text, changes: undo.changes} : null; },
licence,
setData(rows) { if (serverMode) throw new Error("Loosen: setData is only for client mode"); o.data = rows; rowsPromise = null; lastKey = null; },
setMinItems(n) { if (!Number.isInteger(n) || n < 1) throw new Error("minItems must be an integer >= 1"); minItems = n; },
get minItems() { return minItems; },
destroy() { destroyed = true; seq++; abort?.abort(); cancelDebounce?.(); },
};
}
return {WHY, ORIGINAL, ORDER, createCore};
})();
const m_src_styles = (() => {
const CSS = `
:host { display: block; font: var(--loosen-font, inherit); color: var(--loosen-fg, inherit); }
*, *::before, *::after { box-sizing: border-box; }
.panel { background: var(--loosen-bg, #fff); border: 1px solid var(--loosen-border, #d0d5dd); border-radius: var(--loosen-radius, 8px); padding: var(--loosen-padding, 12px 14px); margin: 8px 0; line-height: 1.4; }
.title { margin-block: 0 6px; margin-inline: 0; font-weight: 600; }
.title:not(:first-child) { margin-block-start: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font: inherit; font-size: .95em; cursor: pointer; border: 1px solid var(--loosen-accent, #2563eb); background: var(--loosen-chip-bg, #eff4ff); color: var(--loosen-chip-fg, #1d4ed8); border-radius: 999px; padding: 4px 12px; text-align: start; max-width: 100%; overflow-wrap: anywhere; }
.chip { position: relative; }
.chip:hover { background: var(--loosen-accent, #2563eb); color: var(--loosen-accent-fg, #fff); }
.chip:focus-visible, .min input:focus-visible, .badge:focus-visible { outline: 2px solid var(--loosen-accent, #2563eb); outline-offset: 2px; }
.count { opacity: .8; font-size: .9em; white-space: nowrap; }
.undo { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; font-size: .9em; color: var(--loosen-muted, #667085); }
.undo button { font: inherit; cursor: pointer; border: 0; background: none; padding-block: 2px; padding-inline: 4px; color: var(--loosen-chip-fg, #1d4ed8); text-decoration: underline; }
.undo button:focus-visible { outline: 2px solid var(--loosen-accent, #2563eb); outline-offset: 2px; }
.undo:empty { display: none; }
.was { color: inherit; opacity: .75; font-size: .85em; }
.tip { display: none; position: absolute; inset-inline-start: 0; bottom: calc(100% + 4px); z-index: 1; white-space: nowrap; padding: 2px 8px; font-size: .85em; border-radius: 4px; background: var(--loosen-fg, #101828); color: var(--loosen-bg, #fff); pointer-events: none; }
.chip:focus-visible .tip { display: block; }
.why-toggle { font: inherit; cursor: pointer; border: 0; background: none; padding-block: 2px; padding-inline: 0; margin-block-start: 10px; text-align: start; color: var(--loosen-chip-fg, #1d4ed8); text-decoration: underline; }
.why-toggle::after { content: " ▸"; }
[dir=rtl] .why-toggle::after { content: " ◂"; }          /* the disclosure arrow points the way the text reads */
.why-toggle.open::after { content: " ▾"; }
.why-toggle:focus-visible { outline: 2px solid var(--loosen-accent, #2563eb); outline-offset: 2px; }
.why[hidden] { display: none; }
.why { list-style: none; margin: 0; padding: 0; }
.why li { margin: 0 0 8px; }
.why li > span { display: block; margin-bottom: 4px; }
.more { color: var(--loosen-muted, #667085); font-size: .9em; align-self: center; }
.note { margin: 8px 0; color: var(--loosen-muted, #667085); font-size: .9em; }
.foot { margin-block-start: 10px; text-align: end; font-size: .8em; }
.badge { color: var(--loosen-muted, #667085); unicode-bidi: isolate; direction: ltr; }
.unlicensed { margin: 6px 0; padding: 2px 8px; display: inline-block; font-size: .8em; color: var(--loosen-warn, #b42318); border: 1px dashed var(--loosen-warn, #b42318); border-radius: 4px; }
.min { display: block; margin: 4px 0; font-size: .9em; color: var(--loosen-muted, #667085); }
.min input { width: 4em; font: inherit; margin-inline: 4px; }
/* scripts: Arabic must not be letter-spaced (it would break the joins); Arabic and CJK read better with a taller line; the CJK glyph variants come from the lang attribute and the system fonts (no webfonts) */
[lang=ar] { letter-spacing: normal; }
[lang=ar] .panel, [lang=zh] .panel, [lang=ja] .panel { line-height: 1.6; }
[lang=zh], [lang=ja] { word-break: normal; line-break: strict; }
`;
return {CSS};
})();
const m_src_brand = (() => {
const BADGE_TEXT = "Loosen by Sicena";
const BADGE_URL = "https://loosen.sicena.com/";
return {BADGE_TEXT, BADGE_URL};
})();
const m_src_mount = (() => {
const {createCore} = m_src_core;
const {makeTexts, resolveLang, resolveLocale, isRtl} = m_src_texts;
const {CSS} = m_src_styles;
const {BADGE_TEXT, BADGE_URL} = m_src_brand;
const {resultsText} = m_src_present;
const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text) e.textContent = text; return e; };
/** Every option mount() understands; anything else is a typo and fails fast. docs/INTEGRATION.md must describe each of them (checked by a test). */
const OPTION_NAMES = ["licence", "publicKey", "attributes", "data", "server", "getConstraints", "applyRelaxation", "minItems", "maxSize", "limit", "userMinItems", "storageKey",
"why", "original", "showResults", "order", "restoreConstraints", "onPreview", "licenceUrl", "lang", "locale", "texts", "onEvent", "debounceMs", "timeoutMs", "autoUpdate", "fetch", "hostname"];
const PREVIEW_MS = 150;                                   // a chip must stay hovered or focused this long before `relaxation_previewed` is emitted (the onPreview callback itself is immediate)
let sheet;                                                // one constructable stylesheet shared by all widgets (also fine under a strict CSP)
function mount(element, options = {}) {
if (!(element instanceof Element)) throw new Error("Loosen: mount(element, options) needs a DOM element");
for (const name of Object.keys(options)) if (!OPTION_NAMES.includes(name)) throw new Error(`Loosen: unknown option "${name}" (known: ${OPTION_NAMES.join(", ")})`);
if (typeof options.applyRelaxation !== "function") throw new Error("Loosen: option applyRelaxation is required");
const tag = options.lang ?? document.documentElement.lang, lang = resolveLang(tag), rtl = isRtl(lang), locale = resolveLocale(options.locale, tag, lang);
const t = makeTexts(options.texts, lang, locale);
const storageKey = options.storageKey ?? (element.id ? `loosen-minItems:${element.id}` : null);
const storage = { get() { try { return storageKey && Number(localStorage.getItem(storageKey)) || null; } catch { return null; } },
set(n) { try { if (storageKey) localStorage.setItem(storageKey, String(n)); } catch { /* blocked or full: it just lasts until the page closes */ } } };
const minItems = (options.userMinItems ? storage.get() : null) ?? options.minItems ?? 1;
const host = el("div"), shadow = host.attachShadow({mode: "open"});
host.setAttribute("data-loosen", "");
if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in shadow) { sheet ??= new CSSStyleSheet(); if (!sheet.cssRules.length) sheet.replaceSync(CSS); shadow.adoptedStyleSheets = [sheet]; }
else shadow.append(Object.assign(el("style"), {textContent: CSS}));
const root = el("div"), live = el("div"), undoBox = el("div", "undo"), notice = el("div");
live.setAttribute("aria-live", "polite"); live.setAttribute("role", "region"); live.setAttribute("aria-label", t("region"));
undoBox.setAttribute("role", "status");                            // "Applied: ... Undo" and "Filters restored" are announced when they appear
root.lang = lang; root.dir = rtl ? "rtl" : "ltr";                 // lang chooses the CJK glyph variants; dir is explicit so a host page in the other direction cannot flip the panel
root.append(live, undoBox, notice);
shadow.append(root);
element.append(host);
let verdict = null, view = {kind: "none"}, whyOpen = false, whyCount = 0;
const emit = event => { try { options.onEvent?.(event); } catch (error) { console.error("[Loosen] onEvent threw", error); } };
const mode = options.original ?? "auto";
const inline = () => mode === "inline" || (mode === "auto" && !!globalThis.matchMedia?.("(hover: none)").matches);
let tips = 0, chipHadFocus = false, refocus = false, drawn = 0;
let previewed = null, previewTimer = null, previewConstraints = null;
const setPreview = (chip, constraints) => {
if (previewed === chip) return;
clearTimeout(previewTimer);
previewed = chip; previewConstraints = constraints;
if (chip) previewTimer = setTimeout(() => { if (previewed === chip) emit({type: "relaxation_previewed", kind: chip.kind, text: chip.text, changes: chip.changes}); }, PREVIEW_MS);
try { options.onPreview?.(chip, constraints); } catch (error) { console.error("[Loosen] onPreview threw", error); }
};
const clearPreview = () => { if (previewed) setPreview(null, previewConstraints); };
function chipButton(chip, constraints) {
const b = el("button", "chip", chip.text);
b.type = "button";
if (chip.results !== null) {
const count = el("span", "count", ` · ${resultsText(chip.results, t)}`);
b.append(count);
}
const name = chip.results !== null ? `${chip.label}, ${resultsText(chip.results, t)}` : chip.label;
if (chip.was && mode !== "none") {
b.setAttribute("aria-label", name);                             // the name always has the full phrase, whatever is shown
if (inline()) b.append(" ", el("span", "was", `(${chip.was})`));
else {
b.title = chip.was;
const tip = el("span", "tip", chip.was);
tip.setAttribute("aria-hidden", "true");                        // the name already says it; this one is for sighted keyboard users (title shows on hover only)
b.append(tip);
}
} else if (chip.was || chip.results !== null) b.setAttribute("aria-label", name);
let hover = false, focus = false;
const drawing = drawn;                                            // a chip of a panel that has been redrawn is gone: the blur that removing it may fire must not preview it again
let used = false;
const sync = () => { if (used || drawing !== drawn) return; if (hover || focus) setPreview(chip, constraints); else if (previewed === chip) setPreview(null, constraints); };
b.addEventListener("pointerenter", e => { if (e.pointerType !== "touch") { hover = true; sync(); } });
b.addEventListener("pointerleave", () => { hover = false; sync(); });
b.addEventListener("focus", () => { focus = true; sync(); });
b.addEventListener("blur", () => { focus = false; sync(); });
b.addEventListener("click", async () => {
used = true;                                                    // an applied chip previews no more (moving the focus to Undo blurs it while the pointer is still on it)
clearPreview();
chipHadFocus = shadow.activeElement === b;
emit({type: "relaxation_applied", kind: chip.kind, text: chip.text, changes: chip.changes});
try { await core.apply(chip, constraints); }
catch (error) { emit({type: "error", code: "apply", message: String(error?.message ?? error)}); }
chipHadFocus = false;
});
return b;
}
const chipList = (chips, more, constraints) => {
const box = el("div", "chips");
box.append(...chips.map(c => chipButton(c, constraints)));
if (more) box.append(el("span", "more", t("more", {count: more})));
return box;
};
function draw() {
drawn++;
clearPreview();                                                   // the chips are about to be replaced: nothing stays highlighted
live.replaceChildren();
if (view.kind === "panel") {
const {model, constraints} = view, panel = el("div", "panel");
panel.dir = root.dir;
if (model.action) panel.append(el("p", "title", model.action), chipList(model.relaxations, model.moreRelaxations, constraints));
if (model.why) {
const list = el("ul", "why"), expanded = options.why === "expanded";
list.id = `loosen-why-${++whyCount}`;
for (const conflict of model.conflicts) {
const item = el("li"), text = el("span", "", conflict.text);
item.append(text, chipList(conflict.local, 0, constraints));
list.append(item);
}
if (model.moreConflicts) list.append(el("li", "more", t("more", {count: model.moreConflicts})));
if (expanded) panel.append(el("p", "title", model.why), list);
else {
const toggle = el("button", "why-toggle", model.why);
toggle.type = "button";
toggle.setAttribute("aria-controls", list.id);
const show = open => { whyOpen = open; toggle.setAttribute("aria-expanded", String(open)); list.hidden = !open; toggle.classList.toggle("open", open); };
show(whyOpen);
toggle.addEventListener("click", () => show(!whyOpen));
panel.append(toggle, list);
}
}
if (verdict?.badge) {
const foot = el("div", "foot"), a = el("a", "badge", BADGE_TEXT);
a.dir = "ltr"; a.lang = "en";                                  // the brand name stays left to right
a.href = BADGE_URL; a.target = "_blank"; a.rel = "noopener";
foot.append(a); panel.append(foot);
}
live.append(panel);
} else if (view.kind === "error") live.append(el("p", "note", view.message));
else if (view.kind === "limit") live.append(el("p", "note", t("rowsLimit", {rows: view.rows, max: view.max})));
notice.replaceChildren();
if (verdict && !verdict.valid) notice.append(el("p", "unlicensed", t("unlicensed")));
}
let restoredTimer = null;
function drawUndo(state) {
clearTimeout(restoredTimer);
undoBox.replaceChildren();
if (!state) return;
const button = el("button", "", t("undo"));
button.type = "button";
button.addEventListener("click", async () => {
clearPreview();
let done = null;
try { done = await core.undo(); }
catch (error) { emit({type: "error", code: "restore", message: String(error?.message ?? error)}); return; }
if (!done) return;
emit({type: "relaxation_undone", text: done.text, changes: done.changes});
undoBox.replaceChildren(el("span", "", t("undone")));            // announced by the status region, then removed
restoredTimer = setTimeout(() => undoBox.replaceChildren(), 4000);
refocus = true;
});
undoBox.append(el("span", "", t("applied", {text: state.text})), button);
if (chipHadFocus) { button.focus(); chipHadFocus = false; }          // the chip that was clicked is gone: keep the keyboard user's place
}
const core = createCore({...options, minItems, locale, rtl}, {render: v => { view = v; whyOpen = false; draw(); if (refocus) { refocus = false; live.querySelector(".chip")?.focus(); } }, emit, t, undoChanged: drawUndo});
core.licence.then(v => { verdict = v; draw(); });
if (options.userMinItems) {
const label = el("label", "min"), input = el("input");
input.type = "number"; input.min = "1"; input.step = "1"; input.value = String(core.minItems);
label.title = t("minTitle");
const after = document.createTextNode(t("minAfter", {minItems: core.minItems}));
label.append(t("minBefore"), input, after);
input.addEventListener("input", () => { const n = Math.floor(Number(input.value)); if (n >= 1) after.data = t("minAfter", {minItems: n}); });      // the plural form follows what is typed
input.addEventListener("change", () => {
const n = Math.floor(Number(input.value));
if (!(n >= 1)) { input.value = String(core.minItems); after.data = t("minAfter", {minItems: core.minItems}); return; }
core.setMinItems(n); storage.set(n); widget.update();
});
root.prepend(label);
}
const widget = {
/** Re-reads getConstraints() and re-analyses. Resolves to "none" | "panel" | "error" | "limit" (what is shown), or null if a newer update superseded this one. Never rejects. */
update: () => core.update().then(v => v?.kind ?? null),
setData: rows => { core.setData(rows); },
destroy: () => { clearPreview(); clearTimeout(restoredTimer); core.destroy(); host.remove(); },
/** Resolves to the licence verdict {valid, reason, plan, maxItems, badge} (for tests and diagnostics). */
licence: core.licence,
get element() { return host; },
};
return widget;
}
return {OPTION_NAMES, mount};
})();
const m_src_form = (() => {
const isList = op => ["in", "notIn", "allOf", "anyOf", "noneOf"].includes(op);
function fromForm(form, map) {
const fields = name => [...form.querySelectorAll(`[name="${CSS.escape(name)}"]`)];
const entries = Object.entries(map);
for (const [name, spec] of entries) {
if (!spec.attr || !spec.op) throw new Error(`fromForm: "${name}" needs attr and op`);
if (!fields(name).length) throw new Error(`fromForm: the form has no field named "${name}"`);
}
const numeric = (spec, els) => spec.number ?? els.some(e => e.type === "number" || e.type === "range");
const convert = (spec, els, v) => numeric(spec, els) ? Number(v) : v;
function read(name, spec) {
const els = fields(name), first = els[0];
if (isList(spec.op)) {
const values = first.tagName === "SELECT" ? [...first.selectedOptions].map(o => o.value) : els.filter(e => e.checked).map(e => e.value);
return values.length ? {attr: spec.attr, op: spec.op, values: values.map(v => convert(spec, els, v))} : null;
}
if (first.type === "checkbox") return first.checked ? {attr: spec.attr, op: spec.op, value: spec.value ?? 1} : null;
if (first.type === "radio") { const on = els.find(e => e.checked); return on ? {attr: spec.attr, op: spec.op, value: convert(spec, els, on.value)} : null; }
const raw = first.value.trim();
if (raw === "") return null;
const value = convert(spec, els, raw);
if (typeof value === "number" && Number.isNaN(value)) return null;
return {attr: spec.attr, op: spec.op, value};
}
function clear(els) {
for (const e of els) {
if (e.type === "checkbox" || e.type === "radio") e.checked = false;
else if (e.tagName === "SELECT") { for (const o of e.options) o.selected = false; if (!e.multiple) e.value = ""; if (!e.multiple && e.selectedIndex < 0) e.selectedIndex = 0; }
else e.value = "";
}
}
/** Puts one field back to the constraint `c` (null: no constraint). */
function write(name, spec, c) {
const els = fields(name), first = els[0];
clear(els);
if (!c) return;
if (isList(spec.op)) {
const wanted = c.values.map(String);
if (first.tagName === "SELECT") for (const o of first.options) o.selected = wanted.includes(o.value);
else for (const e of els) e.checked = wanted.includes(e.value);
} else if (first.type === "checkbox") first.checked = true;
else if (first.type === "radio") { for (const e of els) e.checked = e.value === String(c.value); }
else first.value = String(c.value);
}
let marked = [];
return {
getConstraints() { return entries.map(([name, spec]) => read(name, spec)).filter(Boolean); },
/** Applies a relaxation (as passed to `applyRelaxation`) to the form. `constraints` are the ones the widget analysed (same as `getConstraints()` returned). */
applyRelaxation(relaxation, constraints) {
for (const change of relaxation.changes) {
const c = constraints[change.index];
const entry = entries.find(([name, spec]) => spec.attr === c.attr && spec.op === c.op && read(name, spec));
if (!entry) throw new Error(`fromForm: no field for ${c.attr} ${c.op}`);
const els = fields(entry[0]);
if (change.action === "adapt") els[0].value = String(change.value); else clear(els);
}
},
/**
* For the widget's `onPreview` option: while a chip is hovered or focused, the fields it would change get the attribute `data-loosen-preview` (removed again on leave);
* style it in your CSS, e.g. `[data-loosen-preview] { outline: 2px solid #2563eb; }`.
*/
onPreview(relaxation, constraints) {
for (const element of marked) element.removeAttribute("data-loosen-preview");
marked = [];
if (!relaxation) return;
for (const change of relaxation.changes) {
const c = constraints[change.index];
const entry = entries.find(([name, spec]) => spec.attr === c.attr && spec.op === c.op && read(name, spec));
if (entry) for (const element of fields(entry[0])) { element.setAttribute("data-loosen-preview", ""); marked.push(element); }
}
},
/** Puts the form back to exactly `constraints` (the array `getConstraints()` returned earlier): the fields of `constraints` get their value, every other mapped field is cleared. */
restoreConstraints(constraints) {
const left = [...constraints];
for (const [name, spec] of entries) {
const at = left.findIndex(c => c.attr === spec.attr && c.op === spec.op);
write(name, spec, at < 0 ? null : left.splice(at, 1)[0]);
}
if (left.length) throw new Error(`fromForm: no field for ${left.map(c => `${c.attr} ${c.op}`).join(", ")}`);
},
};
}
return {fromForm};
})();
const m_loosen = (() => {
const {mount, OPTION_NAMES} = m_src_mount;
const {BADGE_URL, BADGE_TEXT} = m_src_brand;
const {fromForm} = m_src_form;
const {relaxedConstraints} = m_src_engine;
const {verifyLicence, domainAllowed, PRODUCTION_PUBLIC_KEY} = m_src_licence;
const VERSION = "0.5.1";
return {VERSION, mount, OPTION_NAMES, BADGE_URL, BADGE_TEXT, fromForm, relaxedConstraints, verifyLicence, domainAllowed, PRODUCTION_PUBLIC_KEY};
})();
window.Loosen = m_loosen;
})();
