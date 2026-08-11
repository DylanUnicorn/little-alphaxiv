// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));

vi.mock("../lib/textlayer", () => ({
  renderTextLayer: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
}));

vi.mock("./HighlightLayer", () => ({ HighlightLayer: () => null }));
vi.mock("./AnnotLayer", () => ({ AnnotLayer: () => null }));

import { renderTextLayer } from "../lib/textlayer";
import { PdfPage } from "./PdfViewer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type DeferredRender = {
  promise: Promise<void>;
  resolve: () => void;
  cancel: ReturnType<typeof vi.fn>;
};

type DeferredTextRender = DeferredRender;

function deferredRender(): DeferredRender {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve, cancel: vi.fn() };
}

describe("PdfPage zoom rendering", () => {
  let container: HTMLDivElement;
  let root: Root;
  let renders: DeferredRender[];

  beforeEach(() => {
    renders = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    vi.stubGlobal("IntersectionObserver", class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        this.callback([{
          isIntersecting: true,
          target: element,
        } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("cancels an outdated canvas render before a new zoom render can take ownership", async () => {
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 200 * scale,
      }),
      render: vi.fn(() => {
        const task = deferredRender();
        renders.push(task);
        return task;
      }),
      getTextContent: vi.fn(async () => ({ items: [] })),
      cleanup: vi.fn(),
    };
    const doc = { getPage: vi.fn(async () => page) };

    await act(async () => {
      root.render(
        <PdfPage
          doc={doc as never}
          pageNumber={1}
          zoom={1}
          containerWidth={224}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renders).toHaveLength(1);

    await act(async () => {
      root.render(
        <PdfPage
          doc={doc as never}
          pageNumber={1}
          zoom={1.2}
          containerWidth={224}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renders).toHaveLength(2);
    expect(renders[0].cancel).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLCanvasElement>("canvas")?.style.width).toBe("240px");

    await act(async () => {
      renders[0].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(page.cleanup).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>(".pdf-textlayer")?.style.width).not.toBe("200px");
  });

  it("does not let a cancelled text render clean up the page used by its successor", async () => {
    const textRenders: DeferredTextRender[] = [];
    vi.mocked(renderTextLayer).mockImplementation(() => {
      const task = deferredRender();
      textRenders.push(task);
      return task;
    });
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 200 * scale,
      }),
      render: vi.fn(() => {
        const task = deferredRender();
        renders.push(task);
        return task;
      }),
      getTextContent: vi.fn(async () => ({ items: [] })),
      cleanup: vi.fn(),
    };
    const doc = { getPage: vi.fn(async () => page) };

    await act(async () => {
      root.render(<PdfPage doc={doc as never} pageNumber={1} zoom={1} containerWidth={224} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      renders[0].resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textRenders).toHaveLength(1);

    await act(async () => {
      root.render(<PdfPage doc={doc as never} pageNumber={1} zoom={1.2} containerWidth={224} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textRenders[0].cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      textRenders[0].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(page.cleanup).not.toHaveBeenCalled();
  });
});
