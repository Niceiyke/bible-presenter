/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'bible-indigo': '#1E1B4B',
        'bible-gold': '#FACC15',
      },
      fontFamily: {
        'serif': ['Crimson Pro', 'serif'],
        'sans': ['Inter', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
