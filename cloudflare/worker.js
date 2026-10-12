// Lachine public appointment availability watcher. Cloudflare Workers cron trigger.
// Only reads publicly listed DATES. It does not check appointment times or book.

const API = 'https://api3.clicsante.ca/v3/establishments/8090/schedules/public';
const BOOKING_URL = 'https://clients3.clicsante.ca/8090/take-appt?portalPlace=20176&portalPostalCode=H8P%202S1&lang=fr&portalServicesUnified=11,353&portalEst=381644';
const START = '2026-11-05';
const END = '2026-11-19';
const KEY = 'lachine-available-dates-nov5-19-v1';

function montrealDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function checkAppointments(env) {
  if (!env.STATE || !env.NTFY_TOPIC) {
    throw new Error('Missing STATE KV binding or NTFY_TOPIC secret.');
  }
  const today = montrealDate();
  if (today > END) {
    console.log('Monitoring period ended. No API request made.');
    return;
  }
  const query = new URLSearchParams({
    dateStart: '2026-11-01', dateStop: '2026-12-01',
    service: '381644', timezone: 'America/Toronto', places: '20176',
    filter1: '0', gapMode: 'false'
  });
  const response = await fetch(`${API}?${query}`, {
    headers: {
      Accept: 'application/json',
      'x-trimoz-access-token': 'public',
      'x-trimoz-role': 'public',
      product: 'clicsante',
      Origin: 'https://clients3.clicsante.ca',
      Referer: 'https://clients3.clicsante.ca/'
    },
    cf: { cacheTtl: 0 }
  });
  if (!response.ok) throw new Error(`Clic Sante API HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.availabilities)) {
    throw new Error('Unexpected API response: availabilities array missing');
  }
  const dates = [...new Set(payload.availabilities.filter((d) =>
    typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    d >= START && d <= END && d >= today
  ))].sort();
  const previous = await env.STATE.get(KEY, { type: 'json' });
  if (previous !== null && !Array.isArray(previous)) {
    throw new Error('Stored state is invalid');
  }
  const oldDates = previous ?? [];
  const newlyAvailable = dates.filter((d) => !oldDates.includes(d));

  if (newlyAvailable.length) {
    const notify = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: env.NTFY_TOPIC,
        title: 'Clic Sante Lachine: dates available',
        message: `New date(s): ${newlyAvailable.join(', ')}. Times not verified; check quickly for 6:00-8:30 or after 17:30.`,
        click: BOOKING_URL,
        priority: 5
      })
    });
    if (!notify.ok) throw new Error(`ntfy HTTP ${notify.status}`);
    console.log(`ntfy alert sent for: ${newlyAvailable.join(', ')}`);
  }

  // Changes are saved only after alerts succeed, so failed alerts get retried.
  if (previous === null || JSON.stringify(oldDates) !== JSON.stringify(dates)) {
    await env.STATE.put(KEY, JSON.stringify(dates));
  }
  console.log(`Checked public calendar: ${dates.join(', ') || 'none'}; newly available: ${newlyAvailable.join(', ') || 'none'}`);
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(checkAppointments(env));
  },
  async fetch() {
    return new Response('Lachine appointment watcher deployed. Checks run via Cron Trigger; see Observability logs.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
};
