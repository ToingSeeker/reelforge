import { test } from "node:test";
import assert from "node:assert/strict";
import { captionRequest } from "../src/caption-intent.ts";

test("caption requests go to the engine, other caption edits to the model", () => {
  assert.deepEqual(captionRequest("Buat caption dari voiceover dengan gaya Bold"), { style: "bold" });
  assert.deepEqual(captionRequest("bikin subtitle otomatis"), {});
  assert.deepEqual(captionRequest("Add captions in the clean style"), { style: "clean" });
  assert.deepEqual(captionRequest("tambahkan takarir gaya kotak"), { style: "boxed" });
  assert.deepEqual(captionRequest("auto transkrip lalu kasih caption"), {});
  assert.equal(captionRequest("ubah warna caption jadi kuning"), null);
  assert.equal(captionRequest("hapus semua caption"), null);
  assert.equal(captionRequest("Potong klip video mengikuti beat musik"), null);
  assert.equal(captionRequest("tambah teks judul di awal"), null);
});
