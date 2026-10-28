// The attribute declaration shared by every example (guide section 3). `kind` is required in client mode;
// `label` and `format` only change how the panel reads. Booleans are numeric 0/1, towns are text, `features` is a set.
const yesNo = v => (v ? "yes" : "no");
window.APARTMENT_ATTRIBUTES = {
  rent:            {kind: "numeric", label: "Rent", format: v => `${v} CHF`},
  rooms:           {kind: "numeric", label: "Rooms"},
  minutesToUnil:   {kind: "numeric", label: "Minutes to the university", format: v => `${v} min`},
  minutesToCentre: {kind: "numeric", label: "Minutes to the centre", format: v => `${v} min`},
  town:            {kind: "text",    label: "Town"},
  furnished:       {kind: "numeric", label: "Furnished", format: yesNo},
  kitchen:         {kind: "numeric", label: "Kitchen", format: yesNo},
  sharedKitchen:   {kind: "numeric", label: "Shared kitchen", format: yesNo},
  fittedKitchen:   {kind: "numeric", label: "Fitted kitchen", format: yesNo},
  bathroom:        {kind: "numeric", label: "Bathroom", format: yesNo},
  sharedBathroom:  {kind: "numeric", label: "Shared bathroom", format: yesNo},
  bathtub:         {kind: "numeric", label: "Bathtub", format: yesNo},
  quiet:           {kind: "numeric", label: "Quiet", format: yesNo},
  balcony:         {kind: "numeric", label: "Balcony", format: yesNo},
  view:            {kind: "numeric", label: "View", format: yesNo},
  bus:             {kind: "numeric", label: "Bus stop nearby", format: yesNo},
  parking:         {kind: "numeric", label: "Parking", format: yesNo},
  metroM1:         {kind: "numeric", label: "Metro M1", format: yesNo},
  features:        {kind: "set",     label: "Features"},
};
