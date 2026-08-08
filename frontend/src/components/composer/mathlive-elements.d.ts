import type { MathfieldElement } from "mathlive";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "math-field": {
        ref?: (element: MathfieldElement | null) => void;
        children?: React.ReactNode;
        class?: string;
        "aria-label"?: string;
      };
    }
  }
}

export {};
