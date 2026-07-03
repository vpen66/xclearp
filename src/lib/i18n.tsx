/** i18n infrastructure for multi-language support */

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

export type Locale = "zh" | "en";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

interface I18nProviderProps {
  children: ReactNode;
}

export function I18nProvider({ children }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const saved = localStorage.getItem("xclearp_locale");
    if (saved === "zh" || saved === "en") {
      return saved;
    }
    // Default to English if browser language is English, otherwise Chinese
    const browserLang = navigator.language.toLowerCase();
    return browserLang.startsWith("en") ? "en" : "zh";
  });

  const [translations, setTranslations] = useState<Record<string, string>>({});

  useEffect(() => {
    // Load translation file dynamically
    import(`../locales/${locale}.json`)
      .then((module) => setTranslations(module.default))
      .catch((err) => {
        console.error(`Failed to load locale ${locale}:`, err);
        setTranslations({});
      });
  }, [locale]);

  const setLocale = (newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem("xclearp_locale", newLocale);
  };

  const t = (key: string): string => {
    return translations[key] || key;
  };

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
