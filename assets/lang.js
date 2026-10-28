// Language of the examples (not part of the Loosen integration). Loaded synchronously in <head>, before any script mounts the widget.
// The widget takes its language from <html lang> when no `lang` option is given, so choosing a language here means: set <html lang dir>
// (and ?lang= in the URL), then tell the page to mount the widget again ("loosen-lang" event; the widget has no language setter).
(() => {
  const LANGUAGES = {ca: "Català", es: "Español", en: "English", fr: "Français", pt: "Português", zh: "中文", ja: "日本語", ar: "العربية"};
  const apply = code => { document.documentElement.lang = code; document.documentElement.dir = code === "ar" ? "rtl" : "ltr"; };
  const fromUrl = new URLSearchParams(location.search).get("lang");
  apply(fromUrl in LANGUAGES ? fromUrl : document.documentElement.lang || "en");   // without ?lang= the page keeps its own <html lang> (en, or fr on francais.html)
  window.LoosenLang = {
    LANGUAGES,
    current: () => document.documentElement.lang,
    set(code) {
      if (!(code in LANGUAGES)) throw new Error(`unknown language ${code}`);
      apply(code);
      const url = new URL(location.href); url.searchParams.set("lang", code);
      history.replaceState(null, "", url);
      document.dispatchEvent(new CustomEvent("loosen-lang", {detail: {lang: code}}));
    },
  };
})();
