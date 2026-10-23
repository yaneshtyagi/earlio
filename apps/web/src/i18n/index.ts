import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import hi from './hi.json';

/**
 * English text is the key: untranslated strings simply show in English, and a missing Hindi string can never break a screen.
 * Hindi covers the supplier-facing screens, offer summary, consent and notifications.
 */
export type Lang = 'en' | 'hi';
const KEY = 'earlio.lang';
export function storedLang(): Lang { try { return localStorage.getItem(KEY) === 'hi' ? 'hi' : 'en'; } catch { return 'en'; } }
export function setLang(l: Lang) { try { localStorage.setItem(KEY, l); } catch { /* private mode */ } document.documentElement.lang = l; void i18n.changeLanguage(l); }

void i18n.use(initReactI18next).init({
  lng: storedLang(), fallbackLng: 'en', resources: { hi: { translation: hi } },
  keySeparator: false, nsSeparator: false, interpolation: { escapeValue: false }, returnEmptyString: false,
});
document.documentElement.lang = storedLang();
export default i18n;
