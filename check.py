"""10-minute Clic Santé public availability watcher for Lachine.

Only reads dates published by the public booking calendar. It does not reserve
appointments or bypass any access restrictions. Time-of-day filtering requires
a separate, verified source of appointment times.
"""

import json
import os
import sys
from datetime import date, datetime, timedelta
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

API_BASE = "https://api3.clicsante.ca/v3/establishments/8090/schedules/public"
BOOKING_URL = (
    "https://clients3.clicsante.ca/8090/take-appt"
    "?portalPlace=20176&portalPostalCode=H8P%202S1"
    "&lang=fr&portalServicesUnified=11,353&portalEst=381644"
)
PREFIX = "[Clic Santé Lachine] "
GH_API = "https://api.github.com"


def request_json(url, *, method="GET", payload=None, headers=None):
    h = {"Accept": "application/json", "User-Agent": "Lachine-appointment-watcher/1.0"}
    if headers:
        h.update(headers)
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    if body is not None:
        h["Content-Type"] = "application/json"
    req = Request(url, headers=h, data=body, method=method)
    try:
        with urlopen(req, timeout=20) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except HTTPError as exc:
        # Do not dump auth headers or credentials.
        raise RuntimeError(f"HTTP {exc.code} from {url.split('?')[0]}") from exc
    except URLError as exc:
        raise RuntimeError(f"Network error contacting {url.split('?')[0]}: {exc.reason}") from exc


def first_next_month(day):
    return (day.replace(day=28) + timedelta(days=4)).replace(day=1)


def month_starts(start, end):
    current = start.replace(day=1)
    while current <= end:
        yield current
        current = first_next_month(current)


def fetch_matching_dates(start, end):
    found = set()
    for month in month_starts(start, end):
        params = urlencode({
            "dateStart": month.isoformat(),
            "dateStop": first_next_month(month).isoformat(),
            "service": "381644",
            "timezone": "America/Toronto",
            "places": "20176",
            "filter1": "0",
            "gapMode": "false",
        })
        response = request_json(API_BASE + "?" + params, headers={
            "x-trimoz-access-token": "public",
            "x-trimoz-role": "public",
            "product": "clicsante",
            "Origin": "https://clients3.clicsante.ca",
            "Referer": "https://clients3.clicsante.ca/",
        })
        available = response.get("availabilities")
        if not isinstance(available, list):
            raise ValueError("Unexpected API response: availabilities is missing or not a list")
        for item in available:
            try:
                available_day = date.fromisoformat(item)
            except (ValueError, TypeError):
                raise ValueError("Unexpected availability date: " + repr(item))
            if start <= available_day <= end:
                found.add(available_day.isoformat())
    return found


def gh_request(path, *, method="GET", payload=None):
    return request_json(GH_API + path, method=method, payload=payload, headers={
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "X-GitHub-Api-Version": "2022-11-28",
    })


def get_watcher_issues(repo):
    # For this small, temporary project, 100 issues is more than sufficient.
    issues = gh_request(f"/repos/{repo}/issues?state=all&per_page=100")
    return {
        item["title"][len(PREFIX):]: item
        for item in issues
        if item.get("title", "").startswith(PREFIX) and "pull_request" not in item
    }


def notify_ntfy(day):
    """Send a phone push using ntfy's public-topic API, no bot account required."""
    topic = os.environ.get("NTFY_TOPIC", "").strip()
    if not topic:
        return False
    # Topics are public by default. Choose a hard-to-guess value and keep
    # it in a GitHub Actions secret rather than hard-coding it here.
    import re
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", topic):
        raise ValueError("NTFY_TOPIC must be 1-64 letters, numbers, '_' or '-'")
    request_json("https://ntfy.sh/", method="POST", payload={
        "topic": topic,
        "title": "Lachine: appointment date available",
        "message": (
            f"{day} is showing an available date. Open Clic Sante quickly "
            "to check whether the time fits 06:00-08:30 or after 17:30."
        ),
        "click": BOOKING_URL,
        "priority": 5,
    })
    print(f"Sent ntfy push alert for {day}")
    return True


def notify_telegram(day):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        print("Telegram not configured; GitHub issue created or reopened instead.")
        return
    message = (
        f"Clic Santé Lachine: {day} has at least one appointment date available!\n\n"
        "Appointment TIME is not confirmed. Open the calendar quickly and "
        "check 06:00–08:30 or after 17:30 before booking.\n\n"
        + BOOKING_URL
    )
    request_json(
        f"https://api.telegram.org/bot{token}/sendMessage",
        method="POST",
        payload={"chat_id": chat, "text": message, "disable_web_page_preview": True},
    )


def main():
    start = date.fromisoformat(os.getenv("WATCH_START", "2026-10-12"))
    end = date.fromisoformat(os.getenv("WATCH_END", "2026-10-26"))
    now = datetime.now(ZoneInfo("America/Toronto")).date()
    start = max(start, now)
    if start > end:
        print("The monitoring window has passed; nothing to check.")
        return

    available = fetch_matching_dates(start, end)
    print(f"Available dates from public calendar: {', '.join(sorted(available)) or 'none'}")
    repo = os.environ.get("GITHUB_REPOSITORY")
    token = os.environ.get("GITHUB_TOKEN")
    if not repo or not token:
        print("GitHub token/repository not set; showing results only, no persistent alerts.")
        return

    previous = get_watcher_issues(repo)
    # A closed issue marks a date that disappeared; re-open and re-alert if it returns.
    for day in sorted(available):
        existing = previous.get(day)
        if existing and existing["state"] == "open":
            continue
        if existing:
            gh_request(f"/repos/{repo}/issues/{existing['number']}",
                       method="PATCH", payload={"state": "open"})
            print(f"Reopened issue for {day}")
        else:
            gh_request(f"/repos/{repo}/issues", method="POST", payload={
                "title": PREFIX + day,
                "body": (
                    f"An available DATE appeared on Clic Santé for **{day}**.\n\n"
                    "The public date-level API does not provide appointment times. "
                    "Check for an acceptable time (06:00–08:30 or after 17:30) "
                    f"and book manually: {BOOKING_URL}\n\n"
                    "Automatically tracked by a 10-minute workflow."
                ),
            })
            print(f"Created issue for {day}")
        # ntfy is the simplest phone-alert option; Telegram is supported too.
        if not notify_ntfy(day):
            notify_telegram(day)

    for day, issue in previous.items():
        if issue["state"] == "open" and day not in available:
            gh_request(f"/repos/{repo}/issues/{issue['number']}",
                       method="PATCH", payload={"state": "closed"})
            print(f"Closed issue: {day} no longer shows availability")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, KeyError) as exc:
        print(f"Check failed: {exc}", file=sys.stderr)
        sys.exit(1)
