import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

import "@testing-library/jest-dom/vitest";

// `test.globals` is off (test files import describe/it/expect explicitly), so
// @testing-library/react's own auto-cleanup — which detects a global
// `afterEach` — never registers. Do it explicitly instead.
afterEach(() => {
  cleanup();
});
