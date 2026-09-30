/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: {
          950: "#070e1c",
          900: "#0B1A33",
          800: "#102040",
          700: "#16305c",
          600: "#1B3A7A",
        },
        gold: {
          300: "#E8D48B",
          400: "#D4B84A",
          500: "#C9A227",
          600: "#A7841C",
        },
      },
      fontFamily: {
        serif: ["Cinzel", "Playfair Display", "Georgia", "serif"],
        sans: ["Manrope", "system-ui", "sans-serif"],
      },
      boxShadow: {
        gold: "0 0 0 1px rgba(201,162,39,0.45), 0 18px 50px rgba(0,0,0,0.45)",
        insetGold: "inset 0 1px 0 rgba(232,212,139,0.25)",
      },
    },
  },
  plugins: [],
};
