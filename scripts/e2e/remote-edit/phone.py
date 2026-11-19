"""Shared phone-side helpers: a phone-sized Chromium with a persistent profile, pairing, engine API."""
import json
import os
import subprocess
import urllib.request

from playwright.sync_api import sync_playwright  # noqa: F401  (re-exported for the scenarios)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
WORK = os.environ["RF_E2E_WORK"]
TOK = os.environ["RF_E2E_TOKEN"]
ENGINE = f"http://127.0.0.1:{os.environ.get('ENGINE_PORT', '4402')}"
RELAY_PORT = os.environ.get("RELAY_PORT", "8791")
RELAY = f"http://127.0.0.1:{RELAY_PORT}"
PID = open(f"{WORK}/project").read().strip()


def api(path, method="GET", body=None):
    req = urllib.request.Request(
        f"{ENGINE}{path}",
        method=method,
        headers={"Authorization": f"Bearer {TOK}", "content-type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    return json.load(urllib.request.urlopen(req))


def timeline():
    return api(f"/v1/projects/{PID}/timeline")["timeline"]


def stop_relay():
    subprocess.run(["sh", "-c", f"lsof -ti tcp:{RELAY_PORT} -sTCP:LISTEN | xargs kill"], check=False)


def start_relay():
    auth = api("/v1/remote")["remote"]["relayAuth"]
    with open(f"{WORK}/relay.log", "a") as log:
        subprocess.Popen(["node", os.path.join(ROOT, "apps/remote/server.mjs")], env={**os.environ, "PORT": RELAY_PORT, "REELFORGE_REMOTE_AUTH": auth}, stdout=log, stderr=log, start_new_session=True)


def launch(p, width=390, height=844):
    ctx = p.chromium.launch_persistent_context(f"{WORK}/profile", viewport={"width": width, "height": height}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
    return ctx, page, errors


def pair(page):
    code = open(f"{WORK}/pairing.txt").read().strip()
    page.goto(f"{RELAY}/#/pair")
    page.get_by_label("Pairing code").fill(code)
    page.get_by_role("button", name="Continue").click()
    page.get_by_role("button", name="Pair", exact=True).click()
    page.wait_for_function("() => document.body.innerText.includes('Connected to')", timeout=20000)


def ensure_paired(page):
    page.goto(f"{RELAY}/#/projects")
    page.wait_for_timeout(1500)
    if "Spider trade" not in page.locator("body").inner_text():
        pair(page)
        page.goto(f"{RELAY}/#/projects")
    page.wait_for_function("() => document.body.innerText.includes('Spider trade')", timeout=20000)


def open_editor(page):
    page.goto(f"{RELAY}/#/session/{PID}")
    page.wait_for_timeout(1500)
    page.get_by_role("button", name="Edit the timeline by hand").click()
    page.wait_for_function("() => document.querySelector('.ed-status')?.innerText.includes('Manual editing')", timeout=20000)


def shot(page, name):
    page.screenshot(path=f"{WORK}/shots/{name}.png")
