/* ============================================================
   HOME-1: nearest decent-size city, from cities.json (GeoNames
   cities15000, filtered to population >= 100,000; see
   scripts/build-cities.mjs for how it was built and how to refresh it).

   6,281 entries -- a plain linear scan over squared-degree distance (no
   trig, no grid index) finds the nearest one in well under a millisecond
   on a Worker, so no index is needed at this size. This comment is here so
   nobody adds one speculatively later without re-checking that it still
   holds; if the list ever grows an order of magnitude, that is the time to
   revisit it.

   The one thing this module guarantees: nothing here ever reads, stores or
   returns a latitude or a longitude to its caller, or an IP address --
   only a city name and a country code, or null. request.cf's coordinates
   stay local to nearestCityByCoords() and are discarded the moment it
   returns.
   ============================================================ */
import CITIES from './cities.json';

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function nearestCityByCoords(lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const c of CITIES) {
    const dLat = c.a - lat;
    const dLon = c.o - lon;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function cityByNameAndCountry(name, country) {
  if (!name || !country) return null;
  const n = name.toLowerCase();
  for (const c of CITIES) {
    if (c.c === country && c.n.toLowerCase() === n) return c;
  }
  return null;
}

function cityByRegionAndCountry(region, country) {
  if (!region || !country) return null;
  const r = region.toLowerCase();
  for (const c of CITIES) {
    if (c.c === country && c.r && c.r.toLowerCase() === r) return c;
  }
  return null;
}

/* The one export anything else calls. `cf` is the Worker's own
   request.cf, read here as data and nowhere else in this module.

   Resolution order, each one falling through to the next only when the
   one before it found nothing:
     1. Real coordinates -- nearest of the 6,281 cities by straight-line
        distance in degree-space.
     2. cf.city, matched by exact name within cf.country (e.g. Cloudflare
        says "Giv'at Shmuel", which is not decent-size enough to be in the
        list itself, but a nearby entry might share the exact name of a
        larger metro GeoNames also filed under that name).
     3. cf.region, matched within cf.country -- some city in that region.
     4. Neither matched: display_city is null (the UI shows country
        alone), display_country is still whatever cf.country said.
   Returns { display_city, display_country }; both can be null if cf
   itself carried nothing usable. */
export function resolveDisplayLocation(cf) {
  cf = cf || {};
  const country = typeof cf.country === 'string' ? cf.country : null;

  const lat = toNum(cf.latitude);
  const lon = toNum(cf.longitude);
  if (lat !== null && lon !== null) {
    const city = nearestCityByCoords(lat, lon);
    if (city) return { display_city: city.n, display_country: city.c };
  }

  const byCity = cityByNameAndCountry(typeof cf.city === 'string' ? cf.city : null, country);
  if (byCity) return { display_city: byCity.n, display_country: byCity.c };

  const byRegion = cityByRegionAndCountry(typeof cf.region === 'string' ? cf.region : null, country);
  if (byRegion) return { display_city: byRegion.n, display_country: byRegion.c };

  return { display_city: null, display_country: country };
}

export const CITY_COUNT = CITIES.length;
