# The apartments catalogue

186 apartment listings from the Lausanne area, used by every example. Three files with the same data:

| File | Use |
|---|---|
| `apartments.json` | the examples (client mode, the shop), one flat object per apartment |
| `apartments.csv` | a feed for `loosend` (`format: csv`, id column `id`, sets separated by `\|`); see `server/loosend.feed.json` |
| `apartments.loosend.json` | the body of `POST /v1/catalogs/apartments/items` (`[{id, values}]`), used by `scripts/load-catalog.sh` |

## Provenance

The listings were collected in 2004 for the author's PhD research at EPFL, and joined with the travel time from the postcode of
each flat to the university and to the centre of Lausanne. The thesis: <https://doi.org/10.5075/epfl-thesis-3737>. The same data is
the running example of Loosen's documentation.

## No personal data

The files contain **only anonymous attributes**: a rent, a number of rooms, two travel times, the name of the locality and yes/no
equipment flags. They do **not** contain street addresses, the free-text remarks of the advertisements, the dates of the offers,
postcodes, the identifiers of the source, anything about the owner or the agency (private owner / agency flags are dropped too), or
the number of people the advertisement was for. Ids (`apt-001`...) are sequential numbers made by the generator; they link to nothing.
The source SQL dumps are **not** published (they hold the street addresses); `scripts/gen-apartments` documents which columns it reads.

## Fields

| Field | Kind | Meaning |
|---|---|---|
| `id` | text | `apt-001` ... `apt-186` (loosend needs an id; the widget ignores it) |
| `rent` | numeric | monthly rent in CHF (300 to 2,110) |
| `rooms` | numeric | number of rooms (1 to 4) |
| `minutesToUnil` | numeric | travel minutes to the university (UNIL/EPFL campus) from the postcode (5 to 49) |
| `minutesToCentre` | numeric | travel minutes to the centre of Lausanne (0 to 49) |
| `town` | text | locality name (31 different; 89 are Lausanne), postcode and "VD" suffixes removed |
| `furnished` | numeric 0/1 | furnished |
| `kitchen`, `sharedKitchen`, `fittedKitchen` | numeric 0/1 | has a kitchen, shared kitchen, fitted kitchen |
| `bathroom`, `sharedBathroom`, `bathtub` | numeric 0/1 | has a bathroom, shared bathroom, bathtub |
| `quiet`, `balcony`, `view` | numeric 0/1 | quiet, balcony, view |
| `bus` | numeric 0/1 | bus stop nearby |
| `parking` | numeric 0/1 | parking |
| `metroM1` | numeric 0/1 | near the Lausanne M1 metro line |
| `features` | set | the same facts as words, for the multi-valued examples: `balcony`, `view`, `quiet`, `bus stop`, `fitted kitchen`, `bathtub` |

Notes. In the source, "sub-options" (shared or fitted kitchen, shared bathroom, bathtub) are NULL when the parent does not exist;
they are written as 0. Every other value is known (no NULL in the published data). The thesis column for showers is 0 for all
186 flats and was dropped. Prices are 2004 prices.

## Regenerating

```sh
mkdir source   # put appartement.sql and timeFromZipCode.sql here (not in this repository)
go run ./scripts/gen-apartments -dump-dir source
```

The output is deterministic: the same dumps give byte-identical files.
