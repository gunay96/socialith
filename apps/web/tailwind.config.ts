import type { Config } from "tailwindcss";

// Dark-first baseline from Phase 01 (docs/architecture.md), extended in
// Phase 03 with the one accent color the dashboard shell/nav needs for
// active states and primary actions. Still no @socialith/ui-backed
// component library — that stays deferred until there's enough shared UI
// surface across pages to justify it.
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#0a0a0a",
        surface: "#141414",
        border: "#262626",
        foreground: "#fafafa",
        muted: "#a3a3a3",
        accent: "#3b82f6",
      },
      borderRadius: {
        DEFAULT: "12px",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
