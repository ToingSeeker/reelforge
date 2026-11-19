"""Trim auto-scroll, then a second finger lands (pinch): the scroll must stop and no stale trim/framing edit may land."""
import sys

from phone import ensure_paired, launch, open_editor, sync_playwright, timeline

with sync_playwright() as p:
    ctx, page, errors = launch(p)
    ensure_paired(page)
    open_editor(page)
    page.wait_for_timeout(1500)
    page.locator(".ed-lane.main .ed-clip").first.click()
    page.wait_for_timeout(400)
    rev0 = timeline()["project"]["revision"]
    res = page.evaluate("""async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const sc = document.querySelector('.ed-tl-scroll');
      const handle = document.querySelector('.ed-clip.sel .ed-handle[data-edge="end"]') || document.querySelector('.ed-handle[data-edge="end"]');
      const hb = handle.getBoundingClientRect(), sb = sc.getBoundingClientRect();
      const ev = (type, target, id, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y }));
      const y = hb.top + hb.height / 2;
      ev('pointerdown', handle, 1, hb.left + 2, y);
      ev('pointermove', sc, 1, sb.right - 5, y);           // into the right edge: auto-scroll starts
      await sleep(300);
      const scrolling = sc.scrollLeft;
      ev('pointerdown', sc, 2, sb.left + 40, y);          // second finger: pinch takes over
      await sleep(100);
      const a = sc.scrollLeft;
      await sleep(600);
      const b = sc.scrollLeft;
      const trimming = document.querySelector('.editor').classList.contains('trimming');
      ev('pointerup', sc, 2, sb.left + 40, y);
      ev('pointerup', sc, 1, sb.right - 5, y);
      await sleep(300);
      const frame = document.querySelector('.ed-frame'), fb = frame.getBoundingClientRect();
      ev('pointerdown', frame, 3, fb.left + 50, fb.top + 50);   // a plain tap on the preview afterwards
      ev('pointerup', frame, 3, fb.left + 50, fb.top + 50);
      await sleep(2500);
      return { scrolling, a, b, trimming, save: document.querySelector('.ed-save').innerText.trim() };
    }""")
    rev1 = timeline()["project"]["revision"]
    ok = [
        ("auto-scroll was running before the pinch", res["scrolling"] > 0),
        ("auto-scroll stops once the pinch starts", res["a"] == res["b"]),
        ("trimming state cleared", not res["trimming"]),
        ("no stale trim or 'Framing' edit landed", rev1 == rev0),
    ]
    for name, cond in ok:
        print(("PASS " if cond else "FAIL ") + name, res if not cond else "")
    # Synthetic PointerEvents have no real pointer behind them, so the editor's setPointerCapture
    # throws here; a real finger doesn't. Any other page error fails the run.
    page_errors = [e for e in errors if "pageerror" in e and "setPointerCapture" not in e]
    if page_errors:
        print("page errors:", page_errors)
    ctx.close()
    sys.exit(0 if all(c for _, c in ok) and not page_errors else 1)
