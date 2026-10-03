/** Minimal config matching the CDN script's previous default behavior —
 * no custom theme/plugins were ever configured (confirmed: no
 * `tailwind.config = {...}` object existed in index.html), so this only
 * needs to point at every self-hosted HTML page that uses Tailwind classes
 * (all of them — CSP's script-src blocks cdn.tailwindcss.com site-wide,
 * so every page must build against this one shared, pre-built stylesheet). */
export default {
  content: ['./index.html', './terms.html', './privacy.html', './gdpr.html', './about.html'],
  theme: {
    extend: {}
  },
  plugins: []
};
