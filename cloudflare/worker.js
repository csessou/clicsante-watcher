// Lachine public appointment availability watcher. Cloudflare Workers cron trigger.
// Only reads publicly listed DATES. It does not check appointment times or book.

const API = 'https://api3.clicsante.ca/v3/establishments/8090/schedules/public';
const BOOKING_URL = 'https://clients3.clicsante.ca/8090/take-appt?portalPlace=20176&portalPostalCode=H8P%202S1&lang=fr&portalServicesUnified=11,353&portalEst=381644';
const START = '2026-11-05';
const END = '2026-11-19';
const KEY = 'lachine-availability-state-nov5-19-v2';

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
  // Keep monitoring even if the push provider is down. Remember both
  // observed dates and successful alerts. Avoid a write on every check.
  const previous = await env.STATE.get(KEY, { type: 'json' });
  if (previous !== null && (
    !Array.isArray(previous.observedDates) ||
    !Array.isArray(previous.notifiedDates)
  )) {
    throw new Error('Unexpected KV state');
  }

  let notified = (previous?.notifiedDates ?? []).filter((day) => dates.includes(day));
  let retryAfterMs = previous?.retryAfterMs ?? 0;
  let failures = previous?.failedNotifications ?? 0;
  const pending = dates.filter((day) => !notified.includes(day));

  // Log availability BEFORE sending. This still appears if ntfy fails.
  console.log(`Checked public calendar: ${dates.join(', ') || 'none'}; awaiting notification: ${pending.join(', ') || 'none'}`);

  let notificationError = null;
  if (pending.length && Date.now() >= retryAfterMs) {
    let providerRetryMs = 0;
    try {
      const notify = await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: env.NTFY_TOPIC,
          title: 'Clic Sante Lachine: dates available',
          message: `New date(s): ${pending.join(', ')}. Times not verified; check quickly for 6:00-8:30 or after 17:30.`,
          click: BOOKING_URL,
          priority: 5
        })
      });
      if (!notify.ok) {
        // Respect provider rate-limit retry instructions if supplied.
        if (notify.status === 429) {
          const retry = notify.headers.get('Retry-After');
          const seconds = Number(retry);
          if (retry && Number.isFinite(seconds) && seconds > 0) {
            providerRetryMs = Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
          }
        }
        throw new Error(`ntfy HTTP ${notify.status}`);
      }
      notified = dates;
      failures = 0;
      retryAfterMs = 0;
      console.log(`ntfy alert delivered to service for: ${pending.join(', ')}`);
    } catch (error) {
      failures += 1;
      // Back off 1, 2, 4, 8, 15 minutes; keep checking Clic Sante.
      const exponentialMs = Math.min(15 * 60 * 1000, (2 ** Math.min(failures - 1, 4)) * 60 * 1000);
      retryAfterMs = Date.now() + Math.max(exponentialMs, providerRetryMs);
      notificationError = error;
      console.error(`Notification failed for ${pending.join(', ')}: ${error.message}. Next attempt after ${new Date(retryAfterMs).toISOString()}`);
    }
  } else if (pending.length) {
    console.warn(`Still available: ${pending.join(', ')}; ntfy retry paused until ${new Date(retryAfterMs).toISOString()}`);
  }

  // If dates vanish, they are removed from notified so reappearance alerts again.
  if (!pending.length) {
    failures = 0;
    retryAfterMs = 0;
  }
  const nextState = {
    observedDates: dates,
    notifiedDates: notified.sort(),
    retryAfterMs,
    failedNotifications: failures
  };
  if (JSON.stringify(previous) !== JSON.stringify(nextState)) {
    await env.STATE.put(KEY, JSON.stringify(nextState));
  }
  // Mark this particular run as failed after state is preserved.
  if (notificationError) throw notificationError;
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
