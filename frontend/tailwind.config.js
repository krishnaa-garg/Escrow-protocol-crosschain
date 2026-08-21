/**
 * Design-token theme extension.
 *
 * Every color resolves to a CSS custom property declared once in
 * `src/index.css` (:root). No component is allowed to hardcode a raw
 * color — add a token here (and its value in :root) instead.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // --- Near-black canvas -------------------------------------
        canvas: "#000000",
        canvasElevated: "#06060a",
        canvasSunken: "#030305",

        // --- Paper: text on the frosted glass ----------------------
        ink: "#f5f6f8",
        inkSecondary: "#b0b9c5",
        inkTertiary: "#78808e",

        // --- Frosted glass fills (white alpha, over near-black) ----
        glassStrong: "rgba(255,255,255,0.10)",
        glassSoft: "rgba(255,255,255,0.055)",
        glassFaint: "rgba(255,255,255,0.035)",
        glassHairline: "rgba(255,255,255,0.12)",
        glassHairlineStrong: "rgba(255,255,255,0.22)",

        // --- Primary action: the iOS “white pill” -----------------
        cta: "rgba(245,246,248,0.96)",
        ctaInk: "#040406",

        // --- Accent halo: the only hue, kept subtle & behind ------
        accentBlue: "#5ac8fa",
        accentPurple: "#bf5af2",

        // --- Semantic signals: status only, nothing decorative ----
        signalGood: "#30d158",
        signalWarn: "#ffd60a",
        signalBad: "#ff453a",
        signalInfo: "#64d2ff",
      },
      fontFamily: {
        // Display / headings
        display: ["'Space Grotesk'", "'Inter'", "sans-serif"],
        // Body + UI labels
        body: ["'Inter'", "system-ui", "sans-serif"],
        // Addresses + amounts
        mono: ["'IBM Plex Mono'", "ui-monospace", "monospace"],
      },
      // --- Generous, Apple-shaped radii ----------------------------
      borderRadius: {
        panel: "1.75rem",
        card: "1.25rem",
        control: "0.875rem",
        soft: "0.625rem",
        pill: "9999px",
      },
      // --- Frosted-glass backdrop blurs ---------------------------
      backdropBlur: {
        panel: "34px",
        card: "24px",
        control: "18px",
        modal: "48px",
      },
      // --- Filter blur for the ambient color orbs -----------------
      blur: {
        orb: "90px",
        orbStrong: "110px",
      },
      // --- Elevation + halo shadows -------------------------------
      boxShadow: {
        glass: "0 24px 70px -20px rgba(0,0,0,0.7), 0 8px 30px -12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.11)",
        control: "inset 0 1px 0 rgba(255,255,255,0.07)",
        glowBlue: "0 0 28px -6px rgba(90,200,250,0.5)",
        glowPurple: "0 0 28px -6px rgba(191,90,242,0.5)",
        glowGood: "0 0 14px rgba(48,209,88,0.55)",
        glowWarn: "0 0 14px rgba(255,214,10,0.55)",
        glowBad: "0 0 14px rgba(255,69,58,0.55)",
        glowInfo: "0 0 14px rgba(100,210,255,0.55)",
        glowUnknown: "0 0 10px rgba(176,185,197,0.3)",
      },
    },
  },
  plugins: [],
};
