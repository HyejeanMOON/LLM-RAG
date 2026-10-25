// 极简的中英文切换：文案直接写在代码里，t("中文", "English") 按当前语言返回其中一个。
// 切换语言时 App 会重新渲染，所有调用 t() 的组件随之更新；语言保存在 localStorage。
export type Lang = "zh" | "en";

const KEY = "rag-lang";

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* 隐私模式等情况下 localStorage 不可用 */
  }
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let current: Lang = initial();
document.documentElement.lang = current === "zh" ? "zh-CN" : "en";

export const getLang = () => current;

export function setLang(lang: Lang) {
  current = lang;
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* 忽略 */
  }
}

export const t = (zh: string, en: string) => (current === "en" ? en : zh);

/**
 * 模块级的文案表（标签、说明等）：每项写 [中文, English]，读取时按当前语言返回。
 * 用 Proxy 实现，所以 LABEL[k]、Object.entries(LABEL) 的写法都不用改。
 */
export function tr<K extends string>(table: Record<K, readonly [string, string]>): Record<K, string> {
  return new Proxy(table as unknown as Record<K, string>, {
    get(target, key) {
      const v = (target as unknown as Record<string | symbol, readonly [string, string] | undefined>)[key];
      return Array.isArray(v) ? t(v[0], v[1]) : v;
    },
  });
}
