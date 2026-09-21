// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// The app is a fully static site: every screen is a prerendered shell that
// hydrates itself against the *visitor's own* Supabase project at runtime.
// Nothing about this build is coupled to any particular Supabase instance,
// which is what makes the same deployment reusable by other people.
export default defineConfig({
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
});
