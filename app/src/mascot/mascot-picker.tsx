import { IconDice5, IconRestore } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MASCOT_COLOR_SWATCHES, shapeLabel } from "@/mascot/ids";
import { MascotAvatar } from "@/mascot/mascot-avatar";
import { mergeMascotChoice } from "@/mascot/seed";
import {
  MASCOT_SHAPE_IDS,
  type MascotChoice,
  type MascotShapeId,
} from "../../../shared/mascot-ids";

/**
 * Choose a coworker's mascot.
 *
 * Two rows, a shape and a colour, and the face is not one of them. There used to be a third row of
 * sixteen expressions here and it was the wrong control: a mascot's face is what the coworker is doing,
 * not how it looks, so choosing one meant choosing how it would look while it was stuck, while it was
 * streaming an answer, and while it had failed. The face now follows the agent's state — see
 * `mascotExpressionFor` — and its resting face is hashed from the coworker's id like everything else
 * about it. What is left here is the part that is genuinely a matter of taste: which silhouette, and
 * which colour.
 *
 * Every row is independent and the whole thing is optional, which is the design rather than an
 * accident. There are 96 mascots, so requiring a choice would mean picking one out of a list
 * nobody would otherwise touch, and an undressed coworker already looks distinct because it is seeded
 * from its own id. So the default state of this control is "no choice at all", and the reset button
 * gets you back to it.
 *
 * That is also why it reports `undefined` for "nothing chosen" rather than an empty object. The
 * server reads a missing mascot as untouched and a present one as a replacement, so an empty object
 * has to mean "reset", and collapsing the two would freeze every coworker the first time somebody
 * edited a name.
 */
export function MascotPicker({
  seed,
  value,
  onChange,
  className,
}: {
  /** The agent id, which fills in whatever has not been chosen. */
  seed: string;
  /** Currently chosen axes. Undefined for "nothing chosen". */
  value: Partial<MascotChoice> | undefined;
  onChange: (next: Partial<MascotChoice> | undefined) => void;
  className?: string;
}) {
  const resolved = mergeMascotChoice(value, seed);

  const pick = (axis: keyof MascotChoice, chosen: string) => {
    onChange({ ...value, [axis]: chosen } as Partial<MascotChoice>);
  };

  const surprise = () => {
    const pickOne = <T,>(items: readonly T[]) =>
      items[Math.floor(Math.random() * items.length)];
    onChange({
      shape: pickOne(MASCOT_SHAPE_IDS),
      color: pickOne(MASCOT_COLOR_SWATCHES.map((entry) => entry.id)),
    });
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-3">
        {/*
         * The one mascot on this screen that actually moves, and deliberately the only one: it is the
         * preview, and a preview that blinks and breathes is what makes a mascot look like a character
         * rather than a swatch. Everything below it is a still frame, so the eight shape swatches cost
         * eight one-time paints instead of eight engines.
         */}
        <MascotAvatar
          name="Mascot preview"
          seed={seed}
          choice={resolved}
          size={72}
        />
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted-foreground">
            {value ? shapeLabel(resolved.shape) : "Not chosen"}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={surprise}
            >
              <IconDice5 aria-hidden="true" />
              Surprise me
            </Button>
            {/*
             * Always enabled, and always a no-op when there is nothing to undo. Hiding it would make
             * the control's presence depend on state that the row above already shows, and a person
             * who has just picked a colour should be able to reach for reset without hunting.
             */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(undefined)}
            >
              <IconRestore aria-hidden="true" />
              Reset
            </Button>
          </div>
        </div>
      </div>

      <SwatchRow legend="Shape">
        {MASCOT_SHAPE_IDS.map((shape: MascotShapeId) => (
          <Swatch
            key={shape}
            label={shapeLabel(shape)}
            selected={resolved.shape === shape}
            onSelect={() => pick("shape", shape)}
          >
            {/* The chosen colour, so a shape is judged against the mascot it will actually be worn by
                rather than against a neutral default. The face is the mascot's own, and there is
                nothing to choose about it. */}
            <MascotAvatar
              name={shapeLabel(shape)}
              seed={seed}
              choice={{ ...resolved, shape }}
              size={30}
              animated={false}
            />
          </Swatch>
        ))}
      </SwatchRow>

      {/*
       * Colour is the one axis drawn as flat hex rather than as mascots. Twelve small shapes would
       * read as twelve different creatures rather than as twelve colours, and the question this row
       * asks is "which colour", which a circle answers faster than a face does.
       */}
      <SwatchRow legend="Colour">
        {MASCOT_COLOR_SWATCHES.map(({ id, hex }) => (
          <button
            key={id}
            type="button"
            aria-label={id}
            aria-pressed={resolved.color === id}
            onClick={() => pick("color", id)}
            className={cn(
              "size-7 rounded-full ring-offset-1 ring-offset-background transition",
              resolved.color === id && "ring-1 ring-foreground",
            )}
            style={{ backgroundColor: hex }}
          />
        ))}
      </SwatchRow>

      {/*
       * Said here rather than left to be wondered about, because the row that used to be here was a
       * row of faces and somebody will look for it. The face is not a preference: it is what the
       * coworker is doing while it works, and its resting face is decided by its id along with
       * everything else.
       */}
      <p className="text-xs text-muted-foreground">
        Anything you leave alone stays decided by this coworker&apos;s own id,
        so their coworkers still look different from each other. Their face
        follows the work rather than your taste.
      </p>
    </div>
  );
}

/**
 * One labelled row of swatches.
 *
 * A `fieldset` with a real `legend` rather than a `div` with `role="group"` and an `aria-labelledby`
 * pointing at a span. A screen reader ends up with the same grouping either way, but the fieldset is
 * what carries it when somebody tabs into the row: the first swatch announces which of the three it
 * belongs to without a separate stop. It also drops the generated id this control otherwise needed.
 */
function SwatchRow({
  legend,
  children,
}: {
  legend: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-xs text-muted-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-1">{children}</div>
    </fieldset>
  );
}

/**
 * One option, wrapped so the button owns the accessible name and the mascot inside is decorative.
 *
 * The visible name sits under the drawing rather than in an `aria-label` only, because eight silhouettes
 * are not learnable from eight mystery shapes.
 */
function Swatch({
  label,
  selected,
  onSelect,
  children,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-center gap-0.5 rounded-md p-1 text-[10px] text-muted-foreground transition",
        "hover:bg-muted",
        selected && "bg-muted text-foreground",
      )}
    >
      {children}
      <span className="max-w-full truncate">{label}</span>
    </button>
  );
}
