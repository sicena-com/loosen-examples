// shop is a tiny server-rendered "apartment shop" (Go standard library only) for guide section 5.5: the visitor's filters live in
// the URL (?max_price=400&filter_town=Pully), every change reloads the page, and the results are rendered on the server, like a
// WooCommerce or Shopify collection page. The Loosen widget is mounted on the page; when nothing matches it reads the filters from
// location.search and applies a relaxation by navigating to the relaxed URL.
// Every URL in the page is relative ("../assets/...", an empty form action, "?" for reset), so the page works at the root of this
// program (http://localhost:8124/, where "../" stays at the root) and hosted at <prefix>/shop/ behind cmd/front, whose static files
// are one level up (https://loosen.sicena.com/demo/shop/ -> /demo/assets/...).
//
//	go run ./cmd/shop -addr 127.0.0.1:8124 -root .
package main

import (
	"encoding/json"
	"flag"
	"html/template"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type Apartment struct {
	ID              string   `json:"id"`
	Rent            int      `json:"rent"`
	Rooms           int      `json:"rooms"`
	MinutesToUnil   int      `json:"minutesToUnil"`
	MinutesToCentre int      `json:"minutesToCentre"`
	Town            string   `json:"town"`
	Furnished       int      `json:"furnished"`
	MetroM1         int      `json:"metroM1"`
	Parking         int      `json:"parking"`
	Features        []string `json:"features"`
}

// Filters are the URL parameters, WooCommerce style. A zero value means "not set".
type Filters struct {
	MaxPrice, MinRooms, MaxCentre int
	MinItems                      int // ?minItems=3: suggest changes when fewer than this many apartments match (default 1)
	Towns                         []string
	Furnished, Metro, Parking     bool
}

func parseFilters(q map[string][]string) Filters {
	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}
	num := func(k string) int { n, _ := strconv.Atoi(get(k)); return n }
	f := Filters{MaxPrice: num("max_price"), MinRooms: num("min_rooms"), MaxCentre: num("max_centre"),
		Furnished: get("furnished") == "1", Metro: get("metro") == "1", Parking: get("parking") == "1"}
	if f.MinItems = num("minItems"); f.MinItems < 1 {
		f.MinItems = 1
	}
	for _, v := range q["filter_town"] { // ?filter_town=Lausanne&filter_town=Pully  or  ?filter_town=Lausanne,Pully
		for _, t := range strings.Split(v, ",") {
			if t = strings.TrimSpace(t); t != "" {
				f.Towns = append(f.Towns, t)
			}
		}
	}
	return f
}

func (f Filters) match(a Apartment) bool {
	if f.MaxPrice > 0 && a.Rent > f.MaxPrice || f.MinRooms > 0 && a.Rooms < f.MinRooms || f.MaxCentre > 0 && a.MinutesToCentre > f.MaxCentre {
		return false
	}
	if f.Furnished && a.Furnished != 1 || f.Metro && a.MetroM1 != 1 || f.Parking && a.Parking != 1 {
		return false
	}
	if len(f.Towns) > 0 {
		in := false
		for _, t := range f.Towns {
			in = in || t == a.Town
		}
		return in
	}
	return true
}

func (f Filters) HasTown(t string) bool {
	for _, x := range f.Towns {
		if x == t {
			return true
		}
	}
	return false
}

type page struct {
	F      Filters
	Found  []Apartment
	Shown  []Apartment
	Towns  []string
	Source template.HTML
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8124", "listen address")
	root := flag.String("root", ".", "root of the examples repository (for assets/, vendor/, data/)")
	landing := flag.Bool("landing", false, "serve the examples landing page (index.html) at / instead of the shop: a static server for machines without python3")
	flag.Parse()

	raw, err := os.ReadFile(filepath.Join(*root, "data", "apartments.json"))
	if err != nil {
		log.Fatal(err)
	}
	var all []Apartment
	if err := json.Unmarshal(raw, &all); err != nil {
		log.Fatal(err)
	}
	counts := map[string]int{}
	for _, a := range all {
		counts[a.Town]++
	}
	towns := make([]string, 0, len(counts))
	for t := range counts {
		towns = append(towns, t)
	}
	sort.Slice(towns, func(i, j int) bool {
		return counts[towns[i]] > counts[towns[j]] || counts[towns[i]] == counts[towns[j]] && towns[i] < towns[j]
	})
	if len(towns) > 7 {
		towns = towns[:7]
	}
	tpl := template.Must(template.New("shop").Funcs(template.FuncMap{"minus": func(a, b int) int { return a - b }, "checked": func(b bool) string {
		if b {
			return "checked"
		}
		return ""
	}}).Parse(shopHTML))

	mux := http.NewServeMux()
	// static files: only what the pages need (never .git, source/, .run, ...)
	files := http.FileServer(http.Dir(*root))
	for _, p := range []string{"/assets/", "/vendor/", "/data/", "/examples/", "/cmd/shop/"} {
		mux.Handle(p, noCache(files))
	}
	for _, p := range []string{"/config.js", "/index.html"} {
		mux.Handle(p, noCache(files))
	}
	mux.HandleFunc("/{$}", func(w http.ResponseWriter, r *http.Request) {
		if *landing {
			w.Header().Set("Cache-Control", "no-store")
			http.ServeFile(w, r, filepath.Join(*root, "index.html"))
			return
		}
		f := parseFilters(r.URL.Query())
		var found []Apartment
		for _, a := range all {
			if f.match(a) {
				found = append(found, a)
			}
		}
		shown := found
		if len(shown) > 12 {
			shown = shown[:12]
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if err := tpl.Execute(w, page{F: f, Found: found, Shown: shown, Towns: towns}); err != nil {
			log.Print(err)
		}
	})
	log.Printf("shop on http://%s/ (root %s, %d apartments)", *addr, *root, len(all))
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if strings.HasSuffix(r.URL.Path, ".mjs") {
			w.Header().Set("Content-Type", "text/javascript")
		}
		h.ServeHTTP(w, r)
	})
}

const shopHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Server-rendered shop, filters in the URL - Loosen examples</title>
<link rel="stylesheet" href="../assets/examples.css">
<script src="../config.js"></script>
<script src="../assets/attributes.js"></script>
<script type="module" src="../assets/chrome.js"></script>
</head>
<body data-title="Server-rendered shop: filters in the URL"
      data-lead="A classic WooCommerce-like flow. The filters are query parameters, the Go server renders the results, every change reloads the page. The widget reads the filters from location.search and applies a relaxation by navigating to the relaxed URL; the browser's Back button is the Undo."
      data-guide="url" data-guide-label="5.5 Filters in the URL" data-source-extra="cmd/shop/main.go assets/attributes.js">
<main>
  <div class="presets">
    <span>Try a conflicting search:</span>
    <a class="btn" href="?max_price=400&amp;metro=1&amp;parking=1">rent &le; 400, metro M1, parking</a>
    <a class="btn" href="?max_price=600&amp;max_centre=5&amp;parking=1">rent &le; 600, centre &le; 5 min, parking</a>
    <a class="btn" href="?max_price=1200&amp;min_rooms=3&amp;minItems=3">rent &le; 1200, rooms &ge; 3, at least 3 results</a>
    <a class="btn" href="?">reset</a>
  </div>
  <section class="card">
    <form id="filters" class="filters" method="get" action="">
      <label class="field">Max rent (CHF) <input type="number" name="max_price" min="0" step="10" value="{{if .F.MaxPrice}}{{.F.MaxPrice}}{{end}}"></label>
      <label class="field">Min rooms <input type="number" name="min_rooms" min="1" value="{{if .F.MinRooms}}{{.F.MinRooms}}{{end}}"></label>
      <label class="field">Max minutes to the centre <input type="number" name="max_centre" min="0" value="{{if .F.MaxCentre}}{{.F.MaxCentre}}{{end}}"></label>
      <label><input type="checkbox" name="furnished" value="1" {{checked .F.Furnished}}> Furnished</label>
      <label><input type="checkbox" name="metro" value="1" {{checked .F.Metro}}> Metro M1</label>
      <label><input type="checkbox" name="parking" value="1" {{checked .F.Parking}}> Parking</label>
      <fieldset class="wide"><legend>Town</legend><div class="checks">{{range .Towns}}
        <label><input type="checkbox" name="filter_town" value="{{.}}" {{if $.F.HasTown .}}checked{{end}}> {{.}}</label>{{end}}
      </div></fieldset>
      <label class="field wide">Suggest changes when fewer than <input type="number" name="minItems" min="1" step="1" value="{{.F.MinItems}}" style="width:5rem"> results</label>
      <div class="wide"><button class="btn" type="submit">Apply filters</button> <span class="muted">(a normal GET form: the page reloads)</span></div>
    </form>
  </section>
  <div id="loosen" class="slot"></div>
  <section class="card" id="results">
    <p class="count" id="count">{{len .Found}} apartment{{if ne (len .Found) 1}}s{{end}}</p>
    {{if .Found}}<div class="table-wrap"><table><thead><tr><th>Rent</th><th>Rooms</th><th>Town</th><th>To univ.</th><th>To centre</th></tr></thead><tbody>
    {{range .Shown}}<tr><td>{{.Rent}} CHF</td><td>{{.Rooms}}</td><td>{{.Town}}</td><td>{{.MinutesToUnil}} min</td><td>{{.MinutesToCentre}} min</td></tr>
    {{end}}</tbody></table></div>{{if gt (len .Found) 12}}<p class="muted">and {{minus (len .Found) 12}} more</p>{{end}}
    {{else}}<p class="muted">No apartment matches these filters.</p>{{end}}
  </section>
</main>

<script type="module" id="code">
import {mount} from "../vendor/loosen.mjs";

// The URL parameters of the shop, as constraints (guide 5.5). WooCommerce uses max_price and filter_<attribute>;
// Shopify storefront filtering uses filter.v.price.lte and filter.v.option.<name>: adapt this table to your theme.
const PARAMS = [
  {param: "max_price",   attr: "rent",            op: "le", number: true},
  {param: "min_rooms",   attr: "rooms",           op: "ge", number: true},
  {param: "max_centre",  attr: "minutesToCentre", op: "le", number: true},
  {param: "furnished",   attr: "furnished",       op: "eq", number: true},
  {param: "metro",       attr: "metroM1",         op: "eq", number: true},
  {param: "parking",     attr: "parking",         op: "eq", number: true},
  {param: "filter_town", attr: "town",            op: "in", list: true},
];

const getConstraints = () => {
  const query = new URLSearchParams(location.search), out = [];
  for (const p of PARAMS) {
    const raw = p.list ? query.getAll(p.param).flatMap(v => v.split(",")).filter(Boolean) : query.get(p.param);
    if (p.list ? raw.length : raw) out.push(p.list ? {attr: p.attr, op: p.op, values: raw} : {attr: p.attr, op: p.op, value: p.number ? Number(raw) : raw});
  }
  return out;
};

const relaxedUrl = (relaxation, constraints) => {
  const query = new URLSearchParams(location.search);          // keeps every other parameter, minItems included
  for (const change of relaxation.changes) {
    const p = PARAMS.find(x => x.attr === constraints[change.index].attr);
    if (change.action === "adapt") query.set(p.param, String(change.value)); else query.delete(p.param);
  }
  return ` + "`${location.pathname}?${query}`" + `;
};

const widget = mount(document.getElementById("loosen"), {
  licence: window.LOOSEN_LICENCE,
  attributes: APARTMENT_ATTRIBUTES,
  data: "../data/apartments.json",                          // client mode, as a URL (a real shop would send its catalogue or use server mode)
  getConstraints,
  minItems: Number(new URLSearchParams(location.search).get("minItems")) || 1,   // ?minItems=3: explain when fewer than 3 apartments match (guide 5.8)
  autoUpdate: false,                                     // the page is replaced: nothing to update
  applyRelaxation: (relaxation, constraints) => location.assign(relaxedUrl(relaxation, constraints)),
  // no restoreConstraints: the page reloads, so there is no panel to hold an Undo button. The Back button undoes it.
});
widget.update();
</script>
</body>
</html>
`
