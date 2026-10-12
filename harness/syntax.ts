import { transform } from "sucrase";

export function checkSyntax(code: string): string | null {
  try {
    transform(code, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "classic" });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
