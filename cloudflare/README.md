# Cloudflare setup for Lachine watcher

1. In the free [Cloudflare Dashboard](https://dash.cloudflare.com/), go to **Workers & Pages > Create > Create Worker**. Deploy the starter Worker.
2. Open your Worker, **Edit code**, and paste the contents of [worker.js](worker.js). **Deploy**.
3. Create a KV namespace in **Storage & databases > KV**. Name it `lachine-watch-state`.
4. In the Worker's **Settings > Bindings**, add a KV namespace binding named exactly `STATE` pointing to that namespace, then deploy.
5. In **Settings > Variables and Secrets**, add secret **`NTFY_TOPIC`** with your existing ntfy topic name, then deploy. Do not add the topic to public code.
6. Add **Settings > Triggers > Cron Triggers**: `*/10 * * * *`. Save. Cron propagation can take up to 15 minutes.
7. Check **Observability > Logs** for scheduled invocations and `Checked public calendar`. Open the Worker website only to confirm deployment; it does not trigger a check.
8. After Cloudflare scheduled checks work, disable the old GitHub Actions workflow to avoid duplicate monitoring.

This checks public *dates* October 12–31, 2026, not times. It alerts through ntfy when a date appears or reappears, and doesn't book anything. Public endpoint access may change or be restricted; follow the provider's terms and rate limits.

Documentation: https://developers.cloudflare.com/workers/configuration/cron-triggers/
