import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

/**
 * Thin i18n layer.
 *
 * The app previously hardcoded every English string in JSX. This module
 * introduces a string table keyed by domain (`app`, `cockpit`, `schedule`,
 * `settings`, `stage`, `scenes`, `recovery`) so translations can be added
 * without touching components. `useT()` returns a `t(key)` function that
 * looks up the current locale's table and falls back to English (then to the
 * key itself) when a key is missing — so partial translations are safe.
 *
 * Adding a language: drop a `xx` block into DICTS below with the keys you have
 * translated; missing keys fall back to `en` automatically.
 */

export type Locale = "en" | "es" | "fr";

type Dict = Record<string, string>;

const en: Dict = {
  "app.name": "Wordlyte",
  "app.setupIssues": "Setup Issues",
  "app.backendIssue": "Backend issue — click for logs",

  "cockpit.stage": "Stage",
  "cockpit.onAir": "On Air",
  "cockpit.goLive": "GO LIVE ↑",
  "cockpit.clear": "CLEAR",
  "cockpit.clearAll": "CLEAR ALL",
  "cockpit.upNext": "Up Next",
  "cockpit.send": "SEND",
  "cockpit.prev": "Prev",
  "cockpit.setlist": "Setlist",
  "cockpit.save": "SAVE",
  "cockpit.blkout": "BLKOUT",
  "cockpit.unblk": "UNBLK",
  "cockpit.bgLogo": "BG LOGO",
  "cockpit.noSetlist": "No items in setlist",

  "schedule.empty": "Schedule is empty. Add verses or media with + QUEUE.",
  "schedule.persistent": "LOOP",
  "schedule.oneshot": "ONCE",
  "schedule.items": "Items",
  "schedule.prevArrow": "← Prev",
  "schedule.nextArrow": "Next →",
  "schedule.confirmDelete": "Delete service \"{name}\"?",
  "schedule.renamePrompt": "Rename service:",

  "settings.output": "Output Settings",
  "settings.blankScreen": "BLANK SCREEN",
  "settings.screenBlanked": "SCREEN BLANKED",
  "settings.scriptureVerse": "Scripture Verse",
  "settings.fontSize": "Font Size",
  "settings.fontFamily": "Font Family",
  "settings.theme": "Theme",
  "settings.outputMonitor": "Output Monitor",
  "settings.autoMonitor": "Auto (first secondary)",
  "settings.primary": "Primary",
  "settings.stageDisplay": "Stage Display",
  "settings.stageSubtitle": "Second monitor for performers",
  "settings.toggle": "Toggle",
  "settings.stageThemed": "Use active theme on stage monitor",
  "settings.stageThemedDesc": "When off, stage uses a fixed dark palette.",
  "settings.operatorBehaviour": "Operator Behaviour",
  "settings.autoClearLogo": "Auto-hide background logo when going live",
  "settings.autoClearLogoDesc": "Clears the pre-service splash automatically on first slide. Turn off to keep it visible.",

  "stage.label": "Stage Display",
  "stage.nowLive": "Now Live",
  "stage.upNext": "Up Next ▶",
  "stage.ltOnAir": "Lower-Third On Air",
  "stage.cameraFeed": "Live Camera Feed",

  "scenes.title": "Scenes",
  "scenes.subtitle": "Recall a bundle of settings, props, and lower-third in one click. Capture the current state or build one from scratch.",
  "scenes.captureCurrent": "Capture Current",
  "scenes.namePlaceholder": "Scene name…",
  "scenes.empty": "No scenes saved yet.",
  "scenes.emptyHint": "Capture your current settings + props as a scene to recall them instantly.",
  "scenes.apply": "Apply",
  "scenes.delete": "Delete scene",

  "recovery.title": "Unsaved Session Found",
  "recovery.discard": "Discard",
  "recovery.restore": "Restore Session",
  "recovery.preview": "Schedule preview",

  "props.title": "Persistent Props",
  "props.image": "Image",
  "props.clock": "Clock",
  "props.clearAll": "Clear All",
  "props.confirmClear": "Remove all props?",
  "props.empty": "No props. Add an image logo or clock overlay above.",
  "props.position": "Position",
  "props.opacity": "Opacity",

  "toast.importing": "Importing media…",
  "toast.mediaAdded": "Media added to library",
  "toast.serviceSaved": "Service saved",
  "toast.addedToSchedule": "Added to schedule",
  "toast.sessionRestored": "Session restored successfully",
};

const es: Dict = {
  "app.name": "Wordlyte",
  "app.setupIssues": "Problemas de configuración",
  "app.backendIssue": "Problema del backend — clic para ver registros",
  "cockpit.stage": "Escenario",
  "cockpit.onAir": "En vivo",
  "cockpit.goLive": "EN VIVO ↑",
  "cockpit.clear": "LIMPIAR",
  "cockpit.clearAll": "LIMPIAR TODO",
  "cockpit.upNext": "Siguiente",
  "cockpit.send": "ENVIAR",
  "cockpit.prev": "Ant.",
  "cockpit.setlist": "Lista",
  "cockpit.save": "GUARDAR",
  "cockpit.blkout": "NEGRO",
  "cockpit.unblk": "MOSTRAR",
  "cockpit.bgLogo": "LOGO FONDO",
  "cockpit.noSetlist": "Sin elementos en la lista",
  "schedule.empty": "El programa está vacío. Añade versículos o medios con + COLA.",
  "schedule.persistent": "BUCLE",
  "schedule.oneshot": "UNA VEZ",
  "schedule.items": "Elementos",
  "schedule.prevArrow": "← Ant.",
  "schedule.nextArrow": "Siguiente →",
  "settings.output": "Ajustes de salida",
  "settings.blankScreen": "PANTALLA NEGRA",
  "settings.screenBlanked": "PANTALLA EN NEGRO",
  "settings.scriptureVerse": "Versículo",
  "settings.fontSize": "Tamaño de fuente",
  "settings.fontFamily": "Familia tipográfica",
  "settings.theme": "Tema",
  "stage.label": "Pantalla de escenario",
  "stage.nowLive": "Ahora en vivo",
  "stage.upNext": "Siguiente ▶",
  "stage.ltOnAir": "Lower-third en vivo",
  "stage.cameraFeed": "Cámara en vivo",
  "recovery.title": "Sesión sin guardar encontrada",
  "recovery.discard": "Descartar",
  "recovery.restore": "Restaurar sesión",
  "toast.importing": "Importando medios…",
  "toast.mediaAdded": "Medios añadidos a la biblioteca",
  "toast.serviceSaved": "Servicio guardado",
  "toast.addedToSchedule": "Añadido al programa",
  "toast.sessionRestored": "Sesión restaurada con éxito",
};

const fr: Dict = {
  "app.name": "Wordlyte",
  "app.setupIssues": "Problèmes de configuration",
  "app.backendIssue": "Problème backend — cliquer pour les journaux",
  "cockpit.stage": "Scène",
  "cockpit.onAir": "En direct",
  "cockpit.goLive": "EN DIRECT ↑",
  "cockpit.clear": "EFFACER",
  "cockpit.clearAll": "TOUT EFFACER",
  "cockpit.upNext": "Suivant",
  "cockpit.send": "ENVOYER",
  "cockpit.prev": "Préc.",
  "cockpit.setlist": "Programme",
  "cockpit.save": "SAUVER",
  "cockpit.blkout": "NOIR",
  "cockpit.unblk": "AFFICHER",
  "cockpit.bgLogo": "LOGO FOND",
  "cockpit.noSetlist": "Aucun élément au programme",
  "stage.label": "Écran de scène",
  "stage.nowLive": "En direct",
  "stage.upNext": "Suivant ▶",
  "stage.ltOnAir": "Lower-third en direct",
  "stage.cameraFeed": "Caméra en direct",
  "recovery.title": "Session non enregistrée trouvée",
  "recovery.discard": "Annuler",
  "recovery.restore": "Restaurer la session",
  "toast.importing": "Importation des médias…",
  "toast.mediaAdded": "Média ajouté à la bibliothèque",
  "toast.serviceSaved": "Service enregistré",
  "toast.addedToSchedule": "Ajouté au programme",
  "toast.sessionRestored": "Session restaurée avec succès",
};

const DICTS: Record<Locale, Dict> = { en, es, fr };

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem("pref_locale") : null;
    return (saved as Locale) || "en";
  });

  const setLocaleAndPersist = useCallback((l: Locale) => {
    setLocale(l);
    try { localStorage.setItem("pref_locale", l); } catch { /* ignore */ }
  }, []);

  const t = useCallback((key: string, vars?: Record<string, string | number>) => {
    const table = DICTS[locale];
    let s = table[key] ?? DICTS.en[key] ?? key;
    if (vars) {
      for (const k of Object.keys(vars)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(vars[k]));
      }
    }
    return s;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale: setLocaleAndPersist, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (e.g. windows).
    return {
      locale: "en",
      setLocale: () => {},
      t: (key) => DICTS.en[key] ?? key,
    };
  }
  return ctx;
}

export function useT() {
  return useI18n().t;
}