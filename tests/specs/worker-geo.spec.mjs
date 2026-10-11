/* ============================================================
   HOME-1 -- worker/src/geo.js's resolveDisplayLocation(), exercised
   directly (no browser, no network): coordinates resolve to the nearest
   decent-size (population >= 100,000) city, missing coordinates fall back
   through cf.city then cf.region then country alone, and the module never
   touches a latitude, a longitude or an IP once it has returned.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReporter } from '../lib/report.mjs';
import { loadGeo } from '../lib/load-worker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Giv'at Shmuel itself is too small for the list (pop < 100,000); any of
// these neighboring Tel Aviv-metro cities is a correct "nearest decent-size
// city" answer -- the prompt's own wording ("such as Tel Aviv or Petah
// Tikva") signals this is about metro-area correctness, not one exact name.
const TEL_AVIV_METRO = ['Tel Aviv', 'Petah Tikva', 'Bnei Brak', 'Ramat Gan', 'Bat Yam', 'Holon'];

export async function run() {
  const r = makeReporter('worker-geo.spec.mjs');
  const G = await loadGeo();

  r.section('a decent-size city list is bundled');
  r.check('at least a few thousand cities (population >= 100,000)', G.CITY_COUNT > 1000, G.CITY_COUNT);

  r.section('real coordinates: nearest decent-size city by distance');
  {
    // A point near Giv'at Shmuel, Israel.
    const r1 = G.resolveDisplayLocation({ latitude: 32.0749, longitude: 34.8481, country: 'IL' });
    r.check('resolves to a Tel Aviv-metro city', TEL_AVIV_METRO.includes(r1.display_city), r1);
    r.check('country is IL', r1.display_country === 'IL', r1);

    // A US suburb (Mountain View, CA -- itself under 100,000, actual pop
    // ~82k) must resolve to a nearby city that IS on the list, not itself.
    const r2 = G.resolveDisplayLocation({ latitude: 37.3861, longitude: -122.0839, country: 'US' });
    r.check('a US suburb resolves to a real, different, nearby large city', !!r2.display_city && r2.display_city !== 'Mountain View', r2);
    r.check('country is US', r2.display_country === 'US', r2);

    // A city that is itself on the list should resolve to itself.
    const r3 = G.resolveDisplayLocation({ latitude: 42.8864, longitude: -78.8784, country: 'US' });
    r.check('Buffalo, NY resolves to itself', r3.display_city === 'Buffalo', r3);
  }

  r.section('missing coordinates: falls back to cf.city, then cf.region, then country alone');
  {
    // No coordinates, but cf.city exactly matches a listed city.
    const byCity = G.resolveDisplayLocation({ city: 'Buffalo', country: 'US' });
    r.check('matches by exact city name within country', byCity.display_city === 'Buffalo' && byCity.display_country === 'US', byCity);

    // No coordinates, city too small for the list, but region matches.
    const byRegion = G.resolveDisplayLocation({ city: 'Some Tiny Place', region: 'California', country: 'US' });
    r.check('falls back to a city in the same region', byRegion.display_city !== null, byRegion);
    r.check('region fallback stays within the right country', byRegion.display_country === 'US', byRegion);

    // Nothing matches at all: country alone, display_city null.
    const nothing = G.resolveDisplayLocation({ city: "Giv'at Shmuel", region: 'Tel Aviv District', country: 'IL' });
    r.check("Giv'at Shmuel itself (too small) and a region name the list doesn't carry: null city", nothing.display_city === null, nothing);
    r.check('country is still reported', nothing.display_country === 'IL', nothing);

    // cf entirely absent.
    const empty = G.resolveDisplayLocation(undefined);
    r.check('no cf at all: both null, no throw', empty.display_city === null && empty.display_country === null, empty);
  }

  r.section('never reads or returns a latitude, a longitude, or an IP');
  {
    const src = readFileSync(join(ROOT, 'worker', 'src', 'geo.js'), 'utf8');
    r.check('no "ip" property is ever read', !/\bcf\.ip\b/i.test(src) && !/headers\.get\(\s*['"]cf-connecting-ip['"]/i.test(src));
    const result = G.resolveDisplayLocation({ latitude: 32.0749, longitude: 34.8481, country: 'IL' });
    r.check('the returned object has only display_city/display_country', Object.keys(result).sort().join(',') === 'display_city,display_country', result);
  }

  return r;
}
