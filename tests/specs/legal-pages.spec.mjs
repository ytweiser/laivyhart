/* ============================================================
   LEGAL-1: /privacy.html exists, serves 200, and is actually reachable
   from the two places a visitor would look for it -- the homepage footer
   and the sign-in modal's consent line. Plain fetches against the local
   static server (no browser needed); see lib/server.mjs for the rewrites
   it mirrors from vercel.json.
   ============================================================ */
import { makeReporter } from '../lib/report.mjs';

export async function run(port) {
  const r = makeReporter('legal-pages.spec.mjs');
  const base = `http://localhost:${port}`;

  const privacyRes = await fetch(`${base}/privacy.html`);
  const privacyHtml = await privacyRes.text();
  r.check('/privacy.html returns 200', privacyRes.status === 200, privacyRes.status);
  r.check('/privacy.html has a Privacy <title>', /<title>Privacy Policy/.test(privacyHtml));
  r.check('/privacy.html is marked DRAFT for owner review', /DRAFT for owner legal review/.test(privacyHtml));

  const homeHtml = await (await fetch(`${base}/`)).text();
  const footer = (homeHtml.match(/<footer class="home-footer">[\s\S]*?<\/footer>/) || [''])[0];
  r.check('homepage footer links to /privacy.html', /href="\/privacy\.html"/.test(footer), footer);
  r.check('homepage footer still links to \/terms', /href="\/terms"/.test(footer), footer);

  const accountUiJs = await (await fetch(`${base}/js/account-ui.js`)).text();
  const modalFoot = (accountUiJs.match(/lv-modal-foot">\s*By continuing[\s\S]*?<\/p>/) || [''])[0];
  r.check('sign-in modal links to /privacy.html', /href="\/privacy\.html"/.test(modalFoot), modalFoot);

  const termsHtml = await (await fetch(`${base}/terms.html`)).text();
  r.check('terms.html privacy section links to /privacy.html', /href="\/privacy\.html"/.test(termsHtml));

  return r;
}
