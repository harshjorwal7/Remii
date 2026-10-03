import { z } from "zod";
import {
  MASCOT_COLOR_IDS,
  MASCOT_SHAPE_IDS,
} from "../../../../shared/mascot-ids";

/**
 * Browser-side coworker form contract. Limits match the server parser so validation errors can be
 * shown next to fields before submit.
 */
export const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(80, "Name must be 80 characters or fewer."),
  title: z
    .string()
    .trim()
    .min(1, "Title is required.")
    .max(120, "Title must be 120 characters or fewer."),
  roleDescription: z
    .string()
    .trim()
    .min(1, "Role description is required.")
    .max(1000, "Role description must be 1000 characters or fewer."),
  // Strict per-user SaaS sandbox: public sharing is removed. Every
  // coworker is private to its owner.
  visibility: z.literal("private"),
  /**
   * The mascot this coworker should wear, or undefined for "not mentioned".
   *
   * Undefined is the default and the whole point. A coworker nobody has dressed must stay that way
   * across an unrelated edit: the server reads a missing `mascot` as untouched, so if the resolved
   * mascot were sent on every save then the first time somebody fixed a typo in a name the coworker
   * would stop being seeded and become a fixed choice, and the customizer's reset would stop working.
   * `{}` is how a person says "go back to being seeded", and it is a different thing from undefined.
   *
   * Every axis optional for the same reason one axis at a time is allowed: an axis left out is filled
   * from the avatar seed, so choosing only a colour gives coworkers that differ in shape.
   */
  mascot: z
    .object({
      shape: z.enum(MASCOT_SHAPE_IDS).optional(),
      color: z.enum(MASCOT_COLOR_IDS).optional(),
    })
    .optional(),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

export const emptyAgentForm: AgentFormValues = {
  name: "",
  title: "",
  roleDescription: "",
  visibility: "private",
  // Not `{}`. Empty is a deliberate reset, and the default state of the form is not a decision.
  mascot: undefined,
};

/** Convert form values to API input. */
export function agentInputFrom(values: AgentFormValues) {
  return {
    name: values.name,
    title: values.title,
    roleDescription: values.roleDescription,
    visibility: values.visibility,
    // Omitted rather than defaulted, for the reason on the schema field. `{}` is a reset and is
    // passed through, so the two stay distinguishable all the way to the route.
    ...(values.mascot === undefined ? {} : { mascot: values.mascot }),
  };
}
