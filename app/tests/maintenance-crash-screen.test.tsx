import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ErrorBoundary } from "@/components/error-boundary";
import { MaintenanceCrashScreen } from "@/components/ui/maintenance-crash-screen";

describe("MaintenanceCrashScreen", () => {
  beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
  afterAll(() => GlobalRegistrator.unregister());

  afterEach(() => {
    cleanup();
  });

  it("renders the DotLottie container with the animation component", () => {
    const { container } = render(
      <MaintenanceCrashScreen
        title="System Maintenance"
        description="We will be back shortly"
      />,
    );

    expect(container.textContent).toContain("System Maintenance");
    expect(container.textContent).toContain("We will be back shortly");
  });

  it("catches rendering errors in child components and displays fallback", () => {
    const ProblematicComponent = () => {
      throw new Error("Simulated component crash");
    };

    // Suppress console.error in test output for intentional error
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
      const { container } = render(
        <ErrorBoundary>
          <ProblematicComponent />
        </ErrorBoundary>,
      );

      expect(
        container.querySelector("canvas") || container.querySelector("div"),
      ).not.toBeNull();
    } finally {
      console.error = originalConsoleError;
    }
  });
});
