import { mountHeroPixelField } from "./hero-pixel-field";
import { SITE_THEMES } from "./site-themes";

const themeSelect = document.querySelector<HTMLSelectElement>("#theme-select");
const themeHint = document.querySelector<HTMLElement>("#theme-hint");
if (themeSelect) {
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  const themes = new Set(SITE_THEMES.map((theme) => theme.id));
  let selected = "matte-black";
  try {
    selected = localStorage.getItem("omarchy-site-theme") ?? selected;
  } catch {}
  if (selected !== "system" && !themes.has(selected)) selected = "matte-black";
  themeSelect.replaceChildren(
    new Option("System", "system"),
    ...SITE_THEMES.map((theme) => new Option(theme.name, theme.id)),
  );
  themeSelect.value = selected;
  const applyTheme = () => {
    document.documentElement.dataset.theme =
      selected === "system"
        ? systemTheme.matches
          ? "matte-black"
          : "white"
        : selected;
  };
  applyTheme();
  const dismissHint = () => {
    if (themeHint) themeHint.hidden = true;
    try {
      sessionStorage.setItem("omarchy-site-theme-tip", "dismissed");
    } catch {}
  };
  if (themeHint) {
    try {
      themeHint.hidden =
        sessionStorage.getItem("omarchy-site-theme-tip") === "dismissed";
    } catch {
      themeHint.hidden = false;
    }
  }
  themeSelect.addEventListener("change", () => {
    selected = themeSelect.value;
    applyTheme();
    dismissHint();
    try {
      localStorage.setItem("omarchy-site-theme", selected);
    } catch {}
  });
  systemTheme.addEventListener("change", () => {
    if (selected === "system") applyTheme();
  });
  const openThemes = () => {
    themeSelect.focus();
    themeSelect.showPicker?.();
  };
  document
    .querySelector("#theme-hint-open")
    ?.addEventListener("click", openThemes);
  document
    .querySelector("#theme-hint-dismiss")
    ?.addEventListener("click", dismissHint);
  document.addEventListener("keydown", (event) => {
    if (
      event.key.toLowerCase() !== "t" ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      (event.target instanceof Element &&
        event.target.closest("input,textarea,select,[contenteditable=true]"))
    )
      return;
    event.preventDefault();
    openThemes();
  });
}

const field = document.querySelector<HTMLCanvasElement>("#hero-field");
const wordmark = document.querySelector<HTMLElement>("[data-hero-wordmark]");
const motionToggle =
  document.querySelector<HTMLButtonElement>("#motion-toggle");
if (field && wordmark) {
  const dispose = mountHeroPixelField(field, wordmark);
  import.meta.hot?.dispose(dispose);
  if (motionToggle) {
    motionToggle.hidden = false;
    motionToggle.addEventListener("click", () => {
      const paused = field.dataset.paused !== "true";
      field.dataset.paused = String(paused);
      motionToggle.setAttribute("aria-pressed", String(paused));
      motionToggle.textContent = paused ? "Resume pixels" : "Pause pixels";
    });
  }
}

const menuToggle = document.querySelector<HTMLButtonElement>("#menu-toggle");
const mobileNav = document.querySelector<HTMLElement>("#mobile-nav");
if (menuToggle && mobileNav) {
  menuToggle.hidden = false;
  const closeMenu = () => {
    mobileNav.hidden = true;
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.textContent = "Menu";
  };
  menuToggle.addEventListener("click", () => {
    const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
    mobileNav.hidden = isOpen;
    menuToggle.setAttribute("aria-expanded", String(!isOpen));
    menuToggle.textContent = isOpen ? "Menu" : "Close";
  });
  mobileNav.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a"))
      closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !mobileNav.hidden) {
      closeMenu();
      menuToggle.focus();
    }
  });
  window
    .matchMedia("(min-width: 768px)")
    .addEventListener("change", (event) => {
      if (event.matches) closeMenu();
    });
}
