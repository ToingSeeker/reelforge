"""Full phone-editor scenario against the scratch engine. Every step is checked on the Mac's timeline."""
import re
import sys
import time

from phone import PID, api, ensure_paired, launch, open_editor, shot, start_relay, stop_relay, sync_playwright, timeline

results = []


def check(name, cond, info=""):
    results.append((name, bool(cond), info))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{info}]" if info else ""), flush=True)


def clips(tl, kind="video"):
    v = [t["id"] for t in tl["tracks"] if t["kind"] == kind]
    return sorted([c for c in tl["clips"] if c["trackId"] in v], key=lambda c: c["start"])


def saved(page, timeout=15000):
    page.wait_for_function("() => document.querySelector('.ed-save')?.innerText.trim() === 'Saved'", timeout=timeout)


def rev():
    return timeline()["project"]["revision"]


def tap_clip(page, i):
    el = page.locator(".ed-lane.main .ed-clip").nth(i)
    el.scroll_into_view_if_needed()
    b = el.bounding_box()
    page.mouse.click(b["x"] + min(30, b["width"] / 2), b["y"] + b["height"] / 2)
    page.wait_for_timeout(250)


with sync_playwright() as p:
    ctx, page, errors = launch(p)
    ensure_paired(page)
    open_editor(page)
    check("entry from Session opens Edit with the project and revision in the URL", f"#/edit/{PID}/" in page.url, page.url)
    check("bottom Projects/Session/Exports dock is hidden", page.locator("nav.dock").count() == 0)
    page.wait_for_function("() => !document.querySelector('.ed-badge')?.dataset.extra", timeout=20000)
    check("exact still frame loads into the live preview", True)
    shot(page, "10-clip")

    # ── Clip: stepper taps coalesce into one edit ───────────────────────────
    base = timeline()
    r0 = base["project"]["revision"]
    tap_clip(page, 1)
    c1 = clips(base)[1]
    check("tap selects a clip (outline + handles)", page.locator(".ed-clip.sel .ed-handle").count() == 2)
    end_btn = page.get_by_role("button", name="End: one less")
    for _ in range(5):
        end_btn.click()
    saved(page)
    tl = timeline()
    nc1 = [c for c in tl["clips"] if c["id"] == c1["id"]][0]
    check("5 End taps = one trim of 5 frames, one revision", nc1["duration"] == c1["duration"] - 5 and tl["project"]["revision"] == r0 + 1, f"{c1['duration']}→{nc1['duration']} rev {r0}→{tl['project']['revision']}")

    # typed timecode
    end_in = page.get_by_label("End", exact=True)
    end_in.fill("00:20.00")
    end_in.press("Enter")
    saved(page)
    nc1 = [c for c in timeline()["clips"] if c["id"] == c1["id"]][0]
    check("typed End 00:20.00 lands on frame 600", nc1["start"] + nc1["duration"] == 600, str(nc1["start"] + nc1["duration"]))

    # drag the right handle (one gesture = one revision)
    r1 = rev()
    h = page.locator(".ed-clip.sel .ed-handle.r")
    h.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    hb = h.bounding_box()
    page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
    page.mouse.down()
    for k in range(1, 9):
        page.mouse.move(hb["x"] + hb["width"] / 2 - k * 6, hb["y"] + hb["height"] / 2)
        page.wait_for_timeout(16)
    page.mouse.up()
    saved(page)
    nc2 = [c for c in timeline()["clips"] if c["id"] == c1["id"]][0]
    check("handle drag = one trim, one revision", rev() == r1 + 1 and nc2["duration"] < nc1["duration"], f"dur {nc1['duration']}→{nc2['duration']} rev {r1}→{rev()}")

    # ── Split at the playhead, undo, redo ───────────────────────────────────
    b = page.locator(".ed-clip.sel").bounding_box()
    lo, hi = max(b["x"], 40), min(b["x"] + b["width"], 380)
    page.mouse.click((lo + hi) / 2, page.locator(".ed-ruler").bounding_box()["y"] + 10)
    page.wait_for_timeout(300)
    n0 = len(clips(timeline()))
    page.get_by_role("button", name="Split at").click()
    saved(page)
    check("Split at playhead adds a clip", len(clips(timeline())) == n0 + 1)
    shot(page, "11-after-split")
    page.get_by_role("button", name="Undo").click()
    saved(page)
    check("Undo removes the split", len(clips(timeline())) == n0)
    page.get_by_role("button", name="Redo").click()
    saved(page)
    check("Redo restores it", len(clips(timeline())) == n0 + 1)
    page.get_by_role("button", name="Undo").click()
    saved(page)

    # ── Delete (ripple) and undo ────────────────────────────────────────────
    tap_clip(page, 0)
    before = clips(timeline())
    page.get_by_role("button", name="Delete", exact=True).click()
    page.get_by_role("button", name="Delete and close the gap (ripple)").click()
    saved(page)
    after = clips(timeline())
    check("ripple delete removes the clip and shifts later ones on V1 only", len(after) == len(before) - 1 and after[0]["start"] == 0, f"{[c['start'] for c in after]}")
    music_before = clips(base, "audio")
    check("ripple leaves the music track alone", [c["start"] for c in clips(timeline(), "audio")] == [c["start"] for c in music_before])
    page.get_by_role("button", name="Undo").click()
    saved(page)
    check("Undo brings the deleted clip back", [c["id"] for c in clips(timeline())] == [c["id"] for c in before])

    # ── Reorder ─────────────────────────────────────────────────────────────
    order0 = [c["id"] for c in clips(timeline())]
    page.get_by_role("button", name="Reorder clips").click()
    page.locator(".sheet").get_by_role("button", name="down").first.click()
    shot(page, "12-reorder")
    page.get_by_role("button", name="Apply order").click()
    saved(page)
    order1 = [c["id"] for c in clips(timeline())]
    check("reorder swaps the first two clips, back to back", order1[:2] == [order0[1], order0[0]] and all(a["start"] + a["duration"] == b["start"] for a, b in zip(clips(timeline()), clips(timeline())[1:2])), str(order1))
    page.get_by_role("button", name="Undo").click()
    saved(page)
    check("one Undo restores the order (reorder was one step)", [c["id"] for c in clips(timeline())] == order0)

    # ── Frame ───────────────────────────────────────────────────────────────
    playhead_before = page.locator(".ed-ph-label").inner_text()
    page.get_by_role("button", name="Frame").click()
    page.wait_for_timeout(300)
    check("switching tools keeps the playhead", page.locator(".ed-ph-label").inner_text() == playhead_before, playhead_before)
    tap_clip(page, 1)
    wide = clips(timeline())[1]
    if page.get_by_role("button", name="Show it").count():
        page.get_by_role("button", name="Show it").click()
    page.wait_for_timeout(1500)
    page.get_by_role("radio", name="Fit").click()
    saved(page)
    shot(page, "13-frame-fit")
    check("Fit sets fit=contain", [c for c in timeline()["clips"] if c["id"] == wide["id"]][0]["props"].get("fit") == "contain")
    page.get_by_role("radio", name="Fill").click()
    saved(page)
    sc = page.get_by_label("Scale percent")
    sc.fill("115")
    sc.press("Enter")
    saved(page)
    for _ in range(3):
        page.get_by_role("button", name="Position X, percent of the frame width: one more").click()
    saved(page)
    pr = [c for c in timeline()["clips"] if c["id"] == wide["id"]][0]["props"]
    check("Scale 115% and X +3% stored as 1.15 / 0.03", abs(pr.get("scale", 1) - 1.15) < 1e-9 and abs(pr.get("x", 0) - 0.03) < 1e-9, str(pr))
    # drag on the preview
    r2 = rev()
    fb = page.locator(".ed-frame").bounding_box()
    page.mouse.move(fb["x"] + fb["width"] / 2, fb["y"] + fb["height"] / 2)
    page.mouse.down()
    for k in range(1, 11):
        page.mouse.move(fb["x"] + fb["width"] / 2 + k * 3, fb["y"] + fb["height"] / 2 + k * 2)
        page.wait_for_timeout(16)
    page.mouse.up()
    saved(page)
    pr2 = [c for c in timeline()["clips"] if c["id"] == wide["id"]][0]["props"]
    want_x = round(0.03 + 30 / fb["width"], 2)
    check("drag on preview = one framing edit in frame fractions (screen-size independent)", rev() == r2 + 1 and abs(pr2.get("x", 0) - want_x) < 0.011, f"x={pr2.get('x')} want≈{want_x} rev {r2}→{rev()}")
    shot(page, "14-frame")
    page.get_by_role("button", name="Reset").click()
    saved(page)
    pr3 = [c for c in timeline()["clips"] if c["id"] == wide["id"]][0]["props"]
    check("Reset framing clears fit/scale/x/y only", not any(k in pr3 for k in ("fit", "scale", "x", "y")), str(pr3))

    # ── Captions ────────────────────────────────────────────────────────────
    page.get_by_role("button", name="Captions").click()
    page.wait_for_timeout(300)
    check("caption lane appears in Captions mode", page.locator(".ed-lane.captions .ed-cap").count() == 6)
    page.locator(".ed-capnav").click()
    page.locator(".sheet").get_by_text("The spider trade strategy").click()
    page.wait_for_timeout(1200)
    shot(page, "15-captions")
    cap = [c for c in timeline()["captions"] if c["text"].startswith("The spider")][0]
    area = page.get_by_label("Caption text")
    area.fill("The spider trade strategy,\nexplained simply.")
    shot(page, "16-typing")
    page.locator(".ed-textdone").click()
    saved(page)
    cap2 = [c for c in timeline()["captions"] if c["id"] == cap["id"]][0]
    check("caption text saved (multi-line typed)", cap2["text"].startswith("The spider trade strategy,") and "simply" in cap2["text"], repr(cap2["text"]))
    page.get_by_role("button", name="End: one more").click()
    page.get_by_role("button", name="End: one more").click()
    saved(page)
    cap3 = [c for c in timeline()["captions"] if c["id"] == cap["id"]][0]
    check("caption End +2 frames", cap3["duration"] == cap2["duration"] + 2, f"{cap2['duration']}→{cap3['duration']}")
    page.get_by_role("radio", name="Bold").click()
    saved(page)
    st = [t for t in timeline()["tracks"] if t["kind"] == "caption"][0].get("captionStyle", {})
    check("Bold preset applied to the caption track", st.get("font") == "Anton", str(st))
    page.get_by_label("Caption position", exact=True).select_option("top")
    saved(page)
    st = [t for t in timeline()["tracks"] if t["kind"] == "caption"][0].get("captionStyle", {})
    check("position Top center → y 0.2", st.get("y") == 0.2, str(st.get("y")))
    page.get_by_label("Caption position", exact=True).select_option("bottom")
    page.get_by_role("radio", name="Clean").click()
    saved(page)
    page.get_by_role("button", name="Next caption").click()
    page.wait_for_timeout(500)
    check("next caption selects the following one", "4 of 6" in page.locator(".ed-capnav").inner_text())

    # ── Audio ───────────────────────────────────────────────────────────────
    page.get_by_role("button", name="Audio").click()
    tap_clip(page, 1)
    page.wait_for_timeout(300)
    g = page.get_by_label("Clip volume in decibels")
    g.fill("-6")
    g.dispatch_event("input")
    saved(page)
    pr = [c for c in timeline()["clips"] if c["id"] == wide["id"]][0]["props"]
    check("clip volume -6 dB stored", pr.get("gainDb") == -6, str(pr.get("gainDb")))
    page.get_by_role("switch", name="Mute A1").click()
    saved(page)
    check("music track mute stored", [t for t in timeline()["tracks"] if t["name"] == "Music"][0]["muted"] is True)
    shot(page, "17-audio")
    page.get_by_role("switch", name="Mute A1").click()
    saved(page)

    # ── Style ───────────────────────────────────────────────────────────────
    page.get_by_role("button", name="Style").click()
    vg = page.get_by_label("Vignette, percent")
    vg.fill("50")
    vg.dispatch_event("input")
    saved(page)
    pr = [c for c in timeline()["clips"] if c["id"] == wide["id"]][0]["props"]
    check("vignette 50% stored", pr.get("vignette") == 0.5, str(pr.get("vignette")))
    shot(page, "18-style")

    # ── Conflict: the desktop edits underneath ──────────────────────────────
    page.get_by_role("button", name="Clip").click()
    t = timeline()
    api(f"/v1/projects/{PID}/operations", "POST", {"baseRevision": t["project"]["revision"], "operations": [{"type": "clip.update", "clipId": clips(t)[2]["id"], "props": {"opacity": 0.9}}]})
    tap_clip(page, 1)
    page.get_by_role("button", name="End: one less").click()
    page.wait_for_function("() => document.querySelector('.ed-status')?.innerText.includes('Timeline changed')", timeout=15000)
    shot(page, "19-conflict")
    check("desktop edit underneath → conflict, nothing overwritten", [c for c in timeline()["clips"] if c["id"] == clips(t)[2]["id"]][0]["props"].get("opacity") == 0.9)
    page.get_by_role("button", name="Re-apply my changes on top").click()
    saved(page)
    t2 = timeline()
    check("re-applied on top: desktop change kept, phone trim applied", [c for c in t2["clips"] if c["id"] == clips(t)[2]["id"]][0]["props"].get("opacity") == 0.9 and [c for c in t2["clips"] if c["id"] == wide["id"]][0]["duration"] == [c for c in t["clips"] if c["id"] == wide["id"]][0]["duration"] - 1)

    # ── Edit queued while the Mac can't be reached, desktop edits meanwhile ─────
    tq = timeline()
    d0 = [c for c in tq["clips"] if c["id"] == wide["id"]][0]["duration"]
    page.route("**/api/command", lambda route: route.abort())
    tap_clip(page, 1)
    page.get_by_role("button", name="End: one less").click()
    page.wait_for_timeout(1500)
    check("queued while unreachable: not reported as saved", page.locator(".ed-save").inner_text().strip() != "Saved", page.locator(".ed-save").inner_text())
    api(f"/v1/projects/{PID}/operations", "POST", {"baseRevision": tq["project"]["revision"], "operations": [{"type": "clip.update", "clipId": clips(tq)[2]["id"], "props": {"opacity": 0.7}}]})
    stop_relay()
    time.sleep(0.5)
    start_relay()
    page.unroute("**/api/command")
    page.wait_for_function("() => document.querySelector('.ed-status')?.innerText.includes('Timeline changed')", timeout=60000)
    tc = timeline()
    check("reconnect after a desktop edit → conflict, the queued trim is NOT applied over it", [c for c in tc["clips"] if c["id"] == wide["id"]][0]["duration"] == d0 and [c for c in tc["clips"] if c["id"] == clips(tq)[2]["id"]][0]["props"].get("opacity") == 0.7)
    shot(page, "19b-offline-conflict")
    page.get_by_role("button", name="Use the Mac’s version, drop mine").click()
    page.wait_for_function("() => document.querySelector('.ed-status')?.innerText.includes('Manual editing')", timeout=20000)
    page.wait_for_timeout(1500)
    tc = timeline()
    check("Mac's version kept: trim dropped, desktop change stands", [c for c in tc["clips"] if c["id"] == wide["id"]][0]["duration"] == d0 and [c for c in tc["clips"] if c["id"] == clips(tq)[2]["id"]][0]["props"].get("opacity") == 0.7)

    # ── Connection loss keeps the draft ─────────────────────────────────────
    page.get_by_role("button", name="Captions").click()
    page.wait_for_timeout(300)
    stop_relay()
    page.wait_for_function("() => document.querySelector('.ed-status')?.innerText.includes('Reconnecting')", timeout=30000)
    shot(page, "20-offline")
    check("offline: controls disabled, Done disabled", page.locator(".ed-done").is_disabled())
    start_relay()
    page.wait_for_function("() => document.querySelector('.ed-status')?.innerText.includes('Manual editing')", timeout=60000)
    check("reconnect resumes the same edit session", True)

    # ── Done → Review of the manual revision → export ───────────────────────
    page.get_by_role("button", name="Done").click()
    page.wait_for_url("**/#/review/**/rev/**", timeout=20000)
    n = int(re.search(r"/rev/(\d+)", page.url).group(1))
    check("Done opens Review of the saved revision", n == rev(), f"url rev {n}, engine {rev()}")
    page.wait_for_timeout(1500)
    shot(page, "21-review-rev")
    body = page.locator("body").inner_text()
    check("Review lists the manual steps", "Trim clip" in body and "Caption text" in body, body[:300].replace("\n", " | "))
    page.get_by_role("button", name="Export this revision").click()
    page.wait_for_url("**/#/exports", timeout=20000)
    time.sleep(1)
    jobs = api(f"/v1/projects/{PID}/jobs")["jobs"]
    ex = [j for j in jobs if j["kind"] == "export"]
    check("export queued at the manual revision", ex and ex[0]["revision"] == n, str([(j['revision'], j['state']) for j in ex]))
    check("no page errors", not [e for e in errors if "pageerror" in e], str(errors))
    ctx.close()

fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
