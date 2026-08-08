import { describe, it, expect } from "vitest";
import { canSubmitComposer, pickImageFiles } from "./chatComposer";

describe("canSubmitComposer", () => {
  it("allows text, images, or selected-text context while idle", () => {
    expect(canSubmitComposer("question", 0, false, false)).toBe(true);
    expect(canSubmitComposer("", 1, false, false)).toBe(true);
    expect(canSubmitComposer("", 0, true, false)).toBe(true);
  });

  it("rejects an empty or busy composer", () => {
    expect(canSubmitComposer("", 0, false, false)).toBe(false);
    expect(canSubmitComposer("question", 1, true, true)).toBe(false);
  });
});

describe("pickImageFiles", () => {
  const img = (name: string, type = "image/png") => new File(["x"], name, { type });
  const other = (name: string, type = "text/plain") =>
    new File(["x"], name, { type });

  it("keeps all images, rejects nothing, when every file is an image", () => {
    const { images, rejected } = pickImageFiles([img("a.png"), img("b.jpg")]);
    expect(images.map((f) => f.name)).toEqual(["a.png", "b.jpg"]);
    expect(rejected).toEqual([]);
  });

  it("rejects all non-images", () => {
    const { images, rejected } = pickImageFiles([other("a.txt"), other("b.pdf", "application/pdf")]);
    expect(images).toEqual([]);
    expect(rejected.map((f) => f.name)).toEqual(["a.txt", "b.pdf"]);
  });

  it("partitions a mixed list, preserving input order within each bucket", () => {
    const { images, rejected } = pickImageFiles([
      img("a.png"),
      other("b.txt"),
      img("c.gif", "image/gif"),
    ]);
    expect(images.map((f) => f.name)).toEqual(["a.png", "c.gif"]);
    expect(rejected.map((f) => f.name)).toEqual(["b.txt"]);
  });

  it("returns empty buckets for an empty list", () => {
    const { images, rejected } = pickImageFiles([]);
    expect(images).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it("treats a file with an empty MIME type as rejected", () => {
    const blank = new File(["x"], "no-mime.bin", { type: "" });
    const { images, rejected } = pickImageFiles([blank]);
    expect(images).toEqual([]);
    expect(rejected.map((f) => f.name)).toEqual(["no-mime.bin"]);
  });
});
