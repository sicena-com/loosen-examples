// gen-apartments rebuilds data/apartments.json, data/apartments.csv and data/apartments.loosend.json from the two SQL dumps of the thesis.
//
//	go run ./scripts/gen-apartments -dump-dir source
//
// source/ must hold appartement.sql and timeFromZipCode.sql (MySQL 4.1 dumps, latin1). They are NOT part of this repository:
// they are in the private repository of the Loosen project (testdata/). Only the anonymous result is committed.
//
// ONLY these columns are read from the dump: loyer, nbrpieces, localite, npa (to look up the travel times, then discarded),
// meuble, cuisine, cuisine_partagee, cuisine_agencee, salle_bain, salle_bain_partagee, salle_bain_baignore,
// tranquilite, balcon, vue, bus, stationnement, metrom1. The columns id, dateoffre, nbrpersones, remarque (free text),
// adresse (street), npa (postcode, kept only for the join), salle_bain_douche (constant 0 in this data), proprietaire_prive and gerance are never copied. The ids of the
// output (apt-001 ...) are sequential numbers made here; nothing links them to the source.
package main

import (
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type table struct {
	cols []string
	rows [][]any
}

// attribute order of the output (JSON key order and CSV column order)
var booleans = []struct{ out, col string }{
	{"furnished", "meuble"}, {"kitchen", "cuisine"}, {"sharedKitchen", "cuisine_partagee"}, {"fittedKitchen", "cuisine_agencee"},
	{"bathroom", "salle_bain"}, {"sharedBathroom", "salle_bain_partagee"}, {"bathtub", "salle_bain_baignore"},
	{"quiet", "tranquilite"}, {"balcony", "balcon"}, {"view", "vue"}, {"bus", "bus"}, {"parking", "stationnement"}, {"metroM1", "metrom1"},
}

// features is the same information as a multi-valued ("set") attribute, to show allOf / anyOf / noneOf.
var features = []struct{ col, name string }{
	{"balcon", "balcony"}, {"vue", "view"}, {"tranquilite", "quiet"}, {"bus", "bus stop"},
	{"cuisine_agencee", "fitted kitchen"}, {"salle_bain_baignore", "bathtub"},
}

var townSuffix = regexp.MustCompile(`(\s+(VD|Distribution|\d+))+$`)

func main() {
	dir := flag.String("dump-dir", "source", "folder with appartement.sql and timeFromZipCode.sql")
	out := flag.String("out", "data", "output folder")
	flag.Parse()
	ap, err := readTable(filepath.Join(*dir, "appartement.sql"), "appartement")
	check(err)
	tz, err := readTable(filepath.Join(*dir, "timeFromZipCode.sql"), "timeFromZipCode")
	check(err)
	type times struct{ unil, centre float64 }
	byZip := map[float64][]times{}
	for _, r := range tz.rows {
		if r[0] != nil {
			byZip[r[0].(float64)] = append(byZip[r[0].(float64)], times{num(r[1]), num(r[2])})
		}
	}
	idx := map[string]int{}
	for i, c := range ap.cols {
		idx[c] = i
	}
	get := func(r []any, col string) any { return r[idx[col]] }
	isOne := func(r []any, col string) bool { f, ok := toNum(get(r, col)); return ok && f == 1 }

	var rows []map[string]any
	for _, r := range ap.rows {
		zip, ok := 0.0, false
		if s, isStr := get(r, "npa").(string); isStr && s != "" {
			if z, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
				zip, ok = float64(z), true
			}
		}
		ms := byZip[zip]
		if !ok || len(ms) == 0 {
			ms = []times{{math.NaN(), math.NaN()}}
		}
		for _, m := range ms {
			row := map[string]any{"id": fmt.Sprintf("apt-%03d", len(rows)+1)}
			row["rent"], row["rooms"] = anyNum(get(r, "loyer")), anyNum(get(r, "nbrpieces"))
			row["minutesToUnil"], row["minutesToCentre"] = anyNum(m.unil), anyNum(m.centre)
			if loc, isStr := get(r, "localite").(string); isStr && strings.TrimSpace(loc) != "" {
				row["town"] = townSuffix.ReplaceAllString(strings.TrimSpace(loc), "")
			} else {
				row["town"] = nil
			}
			for _, b := range booleans {
				row[b.out] = boolean(r, idx, b.col)
			}
			set := []string{}
			for _, f := range features {
				if isOne(r, f.col) {
					set = append(set, f.name)
				}
			}
			row["features"] = set
			rows = append(rows, row)
		}
	}
	writeJSON(filepath.Join(*out, "apartments.json"), rows)
	writeCSV(filepath.Join(*out, "apartments.csv"), rows)
	writeLoosend(filepath.Join(*out, "apartments.loosend.json"), rows)
	fmt.Fprintf(os.Stderr, "%d apartments\n", len(rows))
}

// boolean: 1 -> 1, 0 -> 0, NULL -> 0 for the "sub-options" that only exist when the parent is 1 (shared/fitted kitchen, shared bathroom,
// bathtub); NULL -> null (unknown) for the others.
func boolean(r []any, idx map[string]int, col string) any {
	f, ok := toNum(r[idx[col]])
	switch {
	case ok:
		return f
	case col == "cuisine_partagee" || col == "cuisine_agencee" || col == "salle_bain_partagee" || col == "salle_bain_baignore":
		return 0.0
	}
	return nil
}

var keyOrder = []string{"id", "rent", "rooms", "minutesToUnil", "minutesToCentre", "town"}

func columns() []string {
	c := append([]string{}, keyOrder...)
	for _, b := range booleans {
		c = append(c, b.out)
	}
	return append(c, "features")
}

func writeJSON(path string, rows []map[string]any) {
	var sb strings.Builder
	sb.WriteString("[\n")
	for i, r := range rows {
		sb.WriteString("  {")
		for j, c := range columns() {
			b, _ := json.Marshal(r[c])
			if j > 0 {
				sb.WriteString(", ")
			}
			fmt.Fprintf(&sb, "%q: %s", c, b)
		}
		sb.WriteString("}")
		if i < len(rows)-1 {
			sb.WriteString(",")
		}
		sb.WriteString("\n")
	}
	sb.WriteString("]\n")
	check(os.WriteFile(path, []byte(sb.String()), 0o644))
}

// The body of POST /v1/catalogs/{name}/items: [{"id": ..., "values": {...}}]; unknown values are left out.
func writeLoosend(path string, rows []map[string]any) {
	var items []map[string]any
	for _, r := range rows {
		values := map[string]any{}
		for _, c := range columns()[1:] {
			if r[c] != nil {
				values[c] = r[c]
			}
		}
		items = append(items, map[string]any{"id": r["id"], "values": values})
	}
	b, err := json.Marshal(items)
	check(err)
	check(os.WriteFile(path, append(b, '\n'), 0o644))
}

// CSV: header row, empty cell = unknown, sets joined with "|" (loosend's default setSeparator).
func writeCSV(path string, rows []map[string]any) {
	f, err := os.Create(path)
	check(err)
	defer f.Close()
	w := csv.NewWriter(f)
	check(w.Write(columns()))
	for _, r := range rows {
		var rec []string
		for _, c := range columns() {
			switch v := r[c].(type) {
			case nil:
				rec = append(rec, "")
			case float64:
				rec = append(rec, strconv.FormatFloat(v, 'f', -1, 64))
			case string:
				rec = append(rec, v)
			case []string:
				rec = append(rec, strings.Join(v, "|"))
			}
		}
		check(w.Write(rec))
	}
	w.Flush()
	check(w.Error())
}

func toNum(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, !math.IsNaN(x)
	case string: // DECIMAL columns are quoted in the dump
		f, err := strconv.ParseFloat(x, 64)
		return f, err == nil
	}
	return 0, false
}
func num(v any) float64 { f, _ := toNum(v); return f }
func anyNum(v any) any {
	if f, ok := toNum(v); ok {
		return f
	}
	return nil
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// ---- a tiny reader for mysqldump files (CREATE TABLE and INSERT ... VALUES), latin1 -> UTF-8 ----

var colRe = regexp.MustCompile("(?m)^\\s+`([^`]+)`\\s")

func readTable(path, name string) (*table, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%w\n(get the dumps from the Loosen project: testdata/appartement.sql and testdata/timeFromZipCode.sql)", err)
	}
	rs := make([]rune, len(b))
	for i, c := range b {
		rs[i] = rune(c)
	}
	s := string(rs)
	hdr := "CREATE TABLE `" + name + "` ("
	h := strings.Index(s, hdr)
	if h < 0 {
		return nil, fmt.Errorf("%s: table %q not found", path, name)
	}
	end := strings.Index(s[h:], ") ENGINE")
	t := &table{}
	for _, m := range colRe.FindAllStringSubmatch(s[h+len(hdr):h+end], -1) {
		t.cols = append(t.cols, m[1])
	}
	ins := "INSERT INTO `" + name + "` VALUES "
	for p := 0; ; {
		i := strings.Index(s[p:], ins)
		if i < 0 {
			break
		}
		p += i + len(ins)
		n, err := t.parseTuples(s[p:])
		if err != nil {
			return nil, err
		}
		p += n
	}
	return t, nil
}

func (t *table) parseTuples(s string) (int, error) {
	i := 0
	for {
		if s[i] != '(' {
			return 0, fmt.Errorf("expected '(' at %q", s[i:min(i+20, len(s))])
		}
		i++
		var row []any
		for {
			switch {
			case s[i] == '\'':
				i++
				var sb strings.Builder
				for ; s[i] != '\''; i++ {
					if s[i] == '\\' {
						i++
					}
					sb.WriteByte(s[i])
				}
				i++
				row = append(row, sb.String())
			case strings.HasPrefix(s[i:], "NULL"):
				i += 4
				row = append(row, nil)
			default:
				j := i
				for s[j] != ',' && s[j] != ')' {
					j++
				}
				f, err := strconv.ParseFloat(s[i:j], 64)
				if err != nil {
					return 0, err
				}
				row = append(row, f)
				i = j
			}
			if s[i] == ',' {
				i++
				continue
			}
			i++
			break
		}
		if len(row) != len(t.cols) {
			return 0, fmt.Errorf("row has %d values, table has %d columns", len(row), len(t.cols))
		}
		t.rows = append(t.rows, row)
		if s[i] == ',' {
			i++
			continue
		}
		return i + 1, nil
	}
}
