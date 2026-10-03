import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface MaintenanceCrashScreenProps {
  className?: string;
  title?: string;
  description?: string;
  fullScreen?: boolean;
  onRetry?: () => void;
}

export function MaintenanceCrashScreen({
  className,
  title,
  description,
  fullScreen = true,
  onRetry,
}: MaintenanceCrashScreenProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center p-6 text-center select-none",
        fullScreen
          ? "fixed inset-0 z-50 min-h-dvh w-full bg-background/95 backdrop-blur-xs"
          : "min-h-[300px] w-full flex-1",
        className,
      )}
    >
      <div className="flex w-full max-w-xs items-center justify-center sm:max-w-sm">
        <DotLottieReact
          src="https://lottie.host/511a9e24-444c-4068-94c5-aefc9ad79475/qJQFT3bR9v.lottie"
          loop
          autoplay
        />
      </div>

      {(title || description) && (
        <div className="mt-4 flex max-w-md flex-col items-center gap-1.5">
          {title && (
            <h2 className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
              {title}
            </h2>
          )}
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      )}

      {/* The primitive, not a hand-copied copy of its chrome: the copy drifted (`rounded-md` against
          the recipe's `rounded-lg`, `ring-1` against `ring-3`) and had no `active` press. */}
      {onRetry && (
        <Button className="mt-4" onClick={onRetry} type="button">
          Try again
        </Button>
      )}
    </div>
  );
}

export default MaintenanceCrashScreen;
